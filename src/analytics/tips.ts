import type { ClosedTrade } from "../core/types.js";
import type { Interval } from "../core/stats.js";
import { breakdown, summarizeTrades, type BreakdownRow, type TradeSummary } from "./metrics.js";
import { lamportsToSol } from "./units.js";

export type TipTone = "good" | "warn" | "bad" | "info";
export type TipConfidence = "low" | "medium" | "high";
export type TipStage = "waiting" | "early" | "building" | "solid";

export interface Tip {
  id: string;
  tone: TipTone;
  title: string;
  detail: string;
  confidence: TipConfidence;
  basedOn: number;
}

export interface SizingRow {
  multiplier: number;
  betSol: number;
  pnlSol: number;
  worstDipSol: number;
  allowed: boolean;
}

export interface TipSettings {
  startingBankrollSol: number;
  fractionPerTrade: number;
  maxPositionSol: number;
  minPositionSol: number;
  maxConcurrent: number;
  dailyLossLimitFraction: number;
  fixedCostPerTradeSol: number;
}

export interface TipsReport {
  stage: TipStage;
  trades: number;
  tradesPerHour: number | null;
  tips: Tip[];
  sizing: SizingRow[];
}

export const TIP_EARLY_TRADES = 10;
export const TIP_BUILDING_TRADES = 30;
export const TIP_SOLID_TRADES = 100;
const TIP_BUCKET_MIN = 5;
const SIZING_MULTIPLIERS = [0.5, 1, 1.5, 2] as const;
const HOUR_MS = 3_600_000;
const PERCENT = 100;

const EXIT_NAMES: Readonly<Record<string, string>> = {
  time_stop: "the 5 minute time stop",
  stop_loss: "the stop loss",
  trailing_stop: "the trailing stop",
  moonbag_trail: "the moonbag",
  take_profit: "take-profits",
  dev_sold: "dev sell exits",
  insider_sold: "insider sell exits",
  smart_exit: "smart wallet exits",
  max_hold: "the max hold timer",
  kill_switch: "the kill switch",
  migration: "migration exits"
};

function exitName(reason: string): string {
  return EXIT_NAMES[reason] ?? reason.split("_").join(" ");
}

function sol(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  return `${sign}${magnitude >= 1 ? magnitude.toFixed(3) : magnitude.toFixed(4)} SOL`;
}

function plainSol(value: number): string {
  return `${Math.abs(value) >= 1 ? value.toFixed(3) : value.toFixed(4)} SOL`;
}

function pct(value: number): string {
  return `${Math.round(value * PERCENT)}%`;
}

function confidenceFor(n: number, interval: Interval | null = null): TipConfidence {
  if (n >= TIP_SOLID_TRADES && interval !== null && (interval.low > 0 || interval.high < 0)) {
    return "high";
  }
  return n >= TIP_BUILDING_TRADES ? "medium" : "low";
}

function stageOf(n: number): TipStage {
  if (n >= TIP_SOLID_TRADES) {
    return "solid";
  }
  if (n >= TIP_BUILDING_TRADES) {
    return "building";
  }
  return n >= TIP_EARLY_TRADES ? "early" : "waiting";
}

function tradesPerHourOf(trades: readonly ClosedTrade[]): number | null {
  if (trades.length < 2) {
    return null;
  }
  const first = Math.min(...trades.map((trade) => trade.openedAtMs));
  const last = Math.max(...trades.map((trade) => trade.closedAtMs));
  const hours = (last - first) / HOUR_MS;
  return hours > 0 ? trades.length / hours : null;
}

function averageBetSol(trades: readonly ClosedTrade[]): number {
  if (trades.length === 0) {
    return 0;
  }
  return trades.reduce((sum, trade) => sum + lamportsToSol(trade.cost), 0) / trades.length;
}

function scaledPnls(trades: readonly ClosedTrade[], multiplier: number, fixedCostSol: number): number[] {
  return trades.map((trade) => (lamportsToSol(trade.pnl) + fixedCostSol) * multiplier - fixedCostSol);
}

function worstDip(pnls: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    worst = Math.max(worst, peak - equity);
  }
  return worst;
}

export function sizingTable(trades: readonly ClosedTrade[], settings: TipSettings): SizingRow[] {
  const ordered = [...trades].sort((a, b) => a.closedAtMs - b.closedAtMs);
  const bet = averageBetSol(ordered);
  return SIZING_MULTIPLIERS.map((multiplier) => {
    const pnls = scaledPnls(ordered, multiplier, settings.fixedCostPerTradeSol);
    const betSol = bet * multiplier;
    return {
      multiplier,
      betSol,
      pnlSol: pnls.reduce((sum, value) => sum + value, 0),
      worstDipSol: worstDip(pnls),
      allowed: betSol <= settings.maxPositionSol && betSol >= settings.minPositionSol
    };
  });
}

function intervalOf(summary: TradeSummary): Interval | null {
  return summary.decisionCi95 ?? summary.expectancyCi95;
}

function sampleTip(n: number, perHour: number | null): Tip {
  const target = n < TIP_BUILDING_TRADES ? TIP_BUILDING_TRADES : TIP_SOLID_TRADES;
  const remaining = Math.max(0, target - n);
  const eta = perHour !== null && perHour > 0 && remaining > 0 ? ` At the current pace of ${perHour.toFixed(1)} trades an hour that is about ${Math.ceil(remaining / perHour)} more hours.` : "";
  const detail =
    n < TIP_BUILDING_TRADES
      ? `Every number below is a hint, not a result. ${remaining} more closed trades are needed before the patterns mean much, and about ${TIP_SOLID_TRADES} before deciding on real money.${eta}`
      : `Patterns are starting to mean something. About ${TIP_SOLID_TRADES} trades are needed before trusting them with real money; ${remaining} to go.${eta}`;
  return { id: "sample", tone: "info", title: `${n} closed paper trades so far`, detail, confidence: confidenceFor(n), basedOn: n };
}

function edgeTip(summary: TradeSummary): Tip | null {
  if (summary.n === 0 || summary.expectancySol === null) {
    return null;
  }
  const interval = intervalOf(summary);
  const each = sol(summary.expectancySol);
  const range = interval ? ` (likely range ${sol(interval.low)} to ${sol(interval.high)} per trade)` : "";
  const confidence = confidenceFor(summary.n, interval);
  if (interval && interval.low > 0) {
    return { id: "edge", tone: "good", title: `Making money: ${each} per trade`, detail: `Over ${summary.n} trades the bot made ${sol(summary.totalPnlSol)} in total${range}. Even the low end of the range is positive, so this is unlikely to be luck.`, confidence, basedOn: summary.n };
  }
  if (interval && interval.high < 0) {
    return { id: "edge", tone: "bad", title: `Losing money: ${each} per trade`, detail: `Over ${summary.n} trades the bot lost ${sol(summary.totalPnlSol)}${range}. Even the best case in the range is a loss, so these settings should not go live.`, confidence, basedOn: summary.n };
  }
  const tone: TipTone = summary.expectancySol >= 0 ? "info" : "warn";
  const more = summary.moreTradesNeeded !== null && summary.moreTradesNeeded > 0 ? ` Roughly ${summary.moreTradesNeeded} more trades would settle it.` : "";
  return {
    id: "edge",
    tone,
    title: `${summary.expectancySol >= 0 ? "Ahead" : "Behind"} so far: ${each} per trade, not proven yet`,
    detail: `Total ${sol(summary.totalPnlSol)} over ${summary.n} trades${range}. The range still includes both winning and losing, so it could be luck either way.${more}`,
    confidence,
    basedOn: summary.n
  };
}

function sizingTip(summary: TradeSummary, rows: readonly SizingRow[], settings: TipSettings): Tip | null {
  const current = rows.find((row) => row.multiplier === 1);
  const double = rows.find((row) => row.multiplier === 2);
  const half = rows.find((row) => row.multiplier === 0.5);
  if (!current || !double || !half || summary.n < 3) {
    return null;
  }
  const interval = intervalOf(summary);
  const proven = interval !== null && interval.low > 0;
  const losing = summary.totalPnlSol < 0;
  const nextFraction = Math.min(settings.fractionPerTrade * 1.5, 0.25);
  if (proven) {
    return {
      id: "sizing",
      tone: "good",
      title: `Bigger bets would have made more: ${sol(double.pnlSol)} at 2x instead of ${sol(current.pnlSol)}`,
      detail: `The edge is positive even at the low end, so size can go up step by step. At 1.5x the result would be ${sol(rows.find((row) => row.multiplier === 1.5)?.pnlSol ?? 0)} with a worst dip of ${plainSol(rows.find((row) => row.multiplier === 1.5)?.worstDipSol ?? 0)}. Raising the bet fraction from ${pct(settings.fractionPerTrade)} to ${pct(nextFraction)} of the bankroll is that step; the worst dip grows by the same factor.`,
      confidence: confidenceFor(summary.n, interval),
      basedOn: summary.n
    };
  }
  if (losing) {
    return {
      id: "sizing",
      tone: "bad",
      title: `Bigger bets would have lost more: ${sol(double.pnlSol)} at 2x`,
      detail: `With the current results, doubling the bet doubles the loss and the worst dip (${plainSol(double.worstDipSol)}). Half-size bets would be at ${sol(half.pnlSol)}. Keep the size until the per-trade result turns positive.`,
      confidence: confidenceFor(summary.n, interval),
      basedOn: summary.n
    };
  }
  return {
    id: "sizing",
    tone: "warn",
    title: `2x bets would show ${sol(double.pnlSol)} instead of ${sol(current.pnlSol)}, but it is not proven`,
    detail: `Bigger bets multiply wins and losses alike: the worst dip would go from ${plainSol(current.worstDipSol)} to ${plainSol(double.worstDipSol)}. Since the edge could still be luck, raising the bet now mostly raises the risk. Wait until the edge tip turns green.`,
    confidence: confidenceFor(summary.n, interval),
    basedOn: summary.n
  };
}

function feeTip(trades: readonly ClosedTrade[], summary: TradeSummary, settings: TipSettings): Tip | null {
  if (summary.n < 3) {
    return null;
  }
  const bet = averageBetSol(trades);
  if (bet <= 0) {
    return null;
  }
  const feesPerTrade = summary.totalFeesSol / summary.n;
  const share = feesPerTrade / bet;
  const fixedShare = settings.fixedCostPerTradeSol / bet;
  const eatsProfit = summary.grossWinSol > 0 ? summary.totalFeesSol / summary.grossWinSol : null;
  const tone: TipTone = share > 0.06 ? "warn" : "info";
  const profitText = eatsProfit !== null ? ` Fees took ${pct(eatsProfit)} of everything the winners made.` : "";
  return {
    id: "fees",
    tone,
    title: `Fees are about ${pct(share)} of each bet (${plainSol(feesPerTrade)} per trade)`,
    detail: `Most of that is pump.fun's own 1.25% per side, which no setting can avoid. About ${plainSol(settings.fixedCostPerTradeSol)} per trade is fixed network fees (${pct(fixedShare)} of a ${plainSol(bet)} bet), which shrinks as a share when bets get bigger.${profitText}`,
    confidence: confidenceFor(summary.n),
    basedOn: summary.n
  };
}

function concentrationTip(trades: readonly ClosedTrade[], summary: TradeSummary): Tip | null {
  if (summary.n < 5 || summary.totalPnlSol <= 0) {
    return null;
  }
  const best = trades.map((trade) => lamportsToSol(trade.pnl)).sort((a, b) => b - a).slice(0, 3);
  const top = best.reduce((sum, value) => sum + value, 0);
  if (top < summary.totalPnlSol * 0.8) {
    return null;
  }
  const withoutTop = summary.totalPnlSol - top;
  return {
    id: "runners",
    tone: "warn",
    title: `The top 3 trades made ${sol(top)} of the ${sol(summary.totalPnlSol)} total`,
    detail: `Without them the result would be ${sol(withoutTop)}. This strategy lives on rare runners, so keep the moonbag and wide trailing stops, and expect long stretches of small losses between big wins.`,
    confidence: confidenceFor(summary.n),
    basedOn: summary.n
  };
}

function rowsWithData(rows: readonly BreakdownRow[]): BreakdownRow[] {
  return rows.filter((row) => row.n >= TIP_BUCKET_MIN && row.expectancySol !== null);
}

function exitTips(trades: readonly ClosedTrade[]): Tip[] {
  const rows = rowsWithData(breakdown(trades, "exitReason", { minTradesPerBucket: TIP_BUCKET_MIN }).rows);
  if (rows.length === 0) {
    return [];
  }
  const tips: Tip[] = [];
  const worst = [...rows].sort((a, b) => a.totalPnlSol - b.totalPnlSol)[0];
  if (worst && worst.totalPnlSol < 0) {
    tips.push({
      id: "exit-worst",
      tone: "warn",
      title: `${capitalise(exitName(worst.key))} cost ${sol(worst.totalPnlSol)} over ${worst.n} trades`,
      detail: `${sol(worst.expectancySol ?? 0)} per trade on average. ${exitAdvice(worst.key)}`,
      confidence: confidenceFor(worst.n, worst.ci95),
      basedOn: worst.n
    });
  }
  const bestRow = [...rows].sort((a, b) => b.totalPnlSol - a.totalPnlSol)[0];
  if (bestRow && bestRow.totalPnlSol > 0) {
    tips.push({
      id: "exit-best",
      tone: "good",
      title: `${capitalise(exitName(bestRow.key))} made ${sol(bestRow.totalPnlSol)} over ${bestRow.n} trades`,
      detail: `${sol(bestRow.expectancySol ?? 0)} per trade on average. This is where the profit comes from, so avoid settings that would cut these trades short.`,
      confidence: confidenceFor(bestRow.n, bestRow.ci95),
      basedOn: bestRow.n
    });
  }
  return tips;
}

function exitAdvice(reason: string): string {
  switch (reason) {
    case "time_stop":
      return "These are coins that went nowhere for 5 minutes and were sold slightly down, mostly paying fees. The research found changing the time stop did not help, so the fix is entering fewer flat coins.";
    case "stop_loss":
      return "These coins fell 35% before the stop sold them. Tighter stops tested worse in replays (more small losses), so better entries are the lever here.";
    case "dev_sold":
      return "The developer dumped and the price gapped down before the exit landed. Lower risk scores (dev still holding less) are the main defence.";
    case "insider_sold":
      return "Early insiders sold. These exits usually save money compared with holding on.";
    default:
      return "Watch whether this keeps happening as more trades come in.";
  }
}

function capitalise(text: string): string {
  return text.length > 0 ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function riskTip(trades: readonly ClosedTrade[]): Tip | null {
  const rows = rowsWithData(breakdown(trades, "riskBucket", { minTradesPerBucket: TIP_BUCKET_MIN }).rows).filter((row) => row.key !== "unscored");
  if (rows.length < 2) {
    return null;
  }
  const sorted = [...rows].sort((a, b) => (a.expectancySol ?? 0) - (b.expectancySol ?? 0));
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];
  if (!worst || !best || (worst.expectancySol ?? 0) >= 0) {
    return null;
  }
  return {
    id: "risk",
    tone: "warn",
    title: `Risk score ${worst.label} is the weak spot: ${sol(worst.expectancySol ?? 0)} per trade`,
    detail: `${worst.n} trades in that range lost ${sol(worst.totalPnlSol)} in total, while ${best.label} made ${sol(best.expectancySol ?? 0)} per trade over ${best.n}. If this holds past 30 trades per range, lowering the maximum risk score would cut those entries.`,
    confidence: confidenceFor(Math.min(worst.n, best.n), worst.ci95),
    basedOn: worst.n + best.n
  };
}

function hourTip(trades: readonly ClosedTrade[]): Tip | null {
  const rows = rowsWithData(breakdown(trades, "hourUtc", { minTradesPerBucket: TIP_BUCKET_MIN }).rows);
  if (rows.length < 2) {
    return null;
  }
  const sorted = [...rows].sort((a, b) => (a.expectancySol ?? 0) - (b.expectancySol ?? 0));
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];
  if (!worst || !best || worst.key === best.key) {
    return null;
  }
  return {
    id: "hours",
    tone: "info",
    title: `Best hour so far ${best.label} UTC, worst ${worst.label} UTC`,
    detail: `${best.label}: ${sol(best.expectancySol ?? 0)} per trade over ${best.n}. ${worst.label}: ${sol(worst.expectancySol ?? 0)} per trade over ${worst.n}. Hour patterns need several days of data before they are worth acting on.`,
    confidence: "low",
    basedOn: worst.n + best.n
  };
}

function payoffTip(summary: TradeSummary): Tip | null {
  if (summary.n < 5 || summary.winRate === null || summary.avgWinSol === null || summary.avgLossSol === null || summary.avgLossSol === 0) {
    return null;
  }
  const ratio = Math.abs(summary.avgWinSol / summary.avgLossSol);
  const breakEven = 1 / (1 + ratio);
  const healthy = summary.winRate >= breakEven;
  return {
    id: "payoff",
    tone: healthy ? "good" : "warn",
    title: `Wins ${pct(summary.winRate)} of trades; an average win is ${ratio.toFixed(1)}x an average loss`,
    detail: `With wins ${ratio.toFixed(1)}x the size of losses, the bot only needs to win ${pct(breakEven)} of trades to break even, and it ${healthy ? "is above that" : "is below that"}. Judge it by this balance, not by the win rate alone.`,
    confidence: confidenceFor(summary.n),
    basedOn: summary.n
  };
}

function limitTip(summary: TradeSummary, settings: TipSettings): Tip | null {
  if (summary.avgLossSol === null || summary.losses === 0) {
    return null;
  }
  const bankroll = settings.startingBankrollSol + summary.totalPnlSol;
  const dailyLimit = bankroll * settings.dailyLossLimitFraction;
  const avgLoss = Math.abs(summary.avgLossSol);
  if (avgLoss <= 0) {
    return null;
  }
  const losers = Math.max(1, Math.floor(dailyLimit / avgLoss));
  return {
    id: "limits",
    tone: "info",
    title: `The daily loss limit allows about ${losers} average losing trades`,
    detail: `It pauses buying after ${plainSol(dailyLimit)} of losses in a day (${pct(settings.dailyLossLimitFraction)} of ${plainSol(bankroll)}), and an average loser costs ${plainSol(avgLoss)}. Up to ${settings.maxConcurrent} trades can be open at once, so a bad burst can hit the limit quickly; that is the point of it.`,
    confidence: confidenceFor(summary.n),
    basedOn: summary.n
  };
}

export function buildTips(trades: readonly ClosedTrade[], settings: TipSettings): TipsReport {
  const summary = summarizeTrades(trades);
  const perHour = tradesPerHourOf(trades);
  const sizing = sizingTable(trades, settings);
  const tips: Tip[] = [sampleTip(summary.n, perHour)];
  const candidates = [
    edgeTip(summary),
    sizingTip(summary, sizing, settings),
    concentrationTip(trades, summary),
    payoffTip(summary),
    ...exitTips(trades),
    riskTip(trades),
    feeTip(trades, summary, settings),
    limitTip(summary, settings),
    hourTip(trades)
  ];
  for (const tip of candidates) {
    if (tip) {
      tips.push(tip);
    }
  }
  return { stage: stageOf(summary.n), trades: summary.n, tradesPerHour: perHour, tips, sizing: summary.n > 0 ? sizing : [] };
}

const LAMPORTS_PER_SOL = 1_000_000_000;

export function tipSettingsOf(config: {
  risk: { startingBankrollSol: number; fractionPerTrade: number; maxPositionSol: number; minPositionSol: number; maxConcurrent: number; dailyLossLimitFraction: number };
  execution: { priorityFeeLamports: number; baseFeeLamports: number };
}): TipSettings {
  return {
    startingBankrollSol: config.risk.startingBankrollSol,
    fractionPerTrade: config.risk.fractionPerTrade,
    maxPositionSol: config.risk.maxPositionSol,
    minPositionSol: config.risk.minPositionSol,
    maxConcurrent: config.risk.maxConcurrent,
    dailyLossLimitFraction: config.risk.dailyLossLimitFraction,
    fixedCostPerTradeSol: (2 * (config.execution.priorityFeeLamports + config.execution.baseFeeLamports)) / LAMPORTS_PER_SOL
  };
}
