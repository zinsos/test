import type { ScorerConfig, SignalsConfig, TrackerConfig } from "../config/strategy.js";
import type { RiskEvent, SignalRejection } from "../core/bus.js";
import type { LaunchScore, Position, Pubkey, Signal } from "../core/types.js";
import { realizedPnlOf } from "../trader/accounting.js";
import { formatDuration, formatSol } from "./format.js";
import type { LivePositionView } from "./liveSeries.js";
import { lamportsRatio, lamportsToSol } from "./units.js";

export type LiveCategory = "score" | "signal" | "trade" | "system";
export type LiveTone = "good" | "bad" | "warn" | "info" | "neutral";
export type LiveKind = "score" | "signal" | "rejected" | "skipped" | "entering" | "opened" | "partial" | "closed" | "position" | "risk";

export interface LiveEventDraft {
  kind: LiveKind;
  category: LiveCategory;
  tone: LiveTone;
  atMs: number;
  mint: Pubkey | null;
  symbol: string | null;
  text: string;
  data: Record<string, unknown>;
}

export interface LiveEvent extends LiveEventDraft {
  id: number;
  strategy: string | null;
}

export interface LiveThresholds {
  scorerMaxRisk: number;
  momentum: SignalsConfig["scoreMomentum"];
  convergence: TrackerConfig["convergence"];
}

export interface OpenedContext {
  symbol: string | null;
  entryMcapMultiple: number | null;
  referencePrice: number | null;
  signalAtMs: number | null;
}

const TOP_ITEMS = 3;
const BPS = 10_000;
const PERCENT = 100;
const SHORT_MINT_LENGTH = 12;
const MAX_ERROR_LENGTH = 80;

const EXIT_REASON_LABELS: Readonly<Record<string, string>> = {
  take_profit: "take profit",
  trailing_stop: "trailing stop",
  moonbag_trail: "moonbag trailing stop",
  stop_loss: "stop loss",
  time_stop: "time stop (went nowhere)",
  max_hold: "max hold time",
  migration_max_hold: "max hold after migration",
  migration_exit: "migration exit",
  dev_sold: "dev sold",
  insider_sold: "insiders sold",
  smart_exit: "smart wallets sold",
  kill_switch: "kill switch",
  entry_failed: "buy failed",
  external_or_unknown_exit: "sold outside the bot"
};

const SKIP_REASON_LABELS: Readonly<Record<string, string>> = {
  max_concurrent: "max open positions reached",
  already_holding_mint: "already holding it",
  dev_daily_limit: "dev's daily entry limit reached",
  killed: "kill switch is on",
  halted_daily_loss: "daily loss limit hit",
  size_below_min: "position size below minimum",
  insufficient_balance: "wallet balance too low",
  incomplete_data: "data gap on this launch",
  awaiting_migration: "curve complete, waiting for migration",
  no_price: "no usable price",
  launch_not_in_memory: "launch not in memory",
  quote_mint_not_tradable: "not SOL-quoted",
  trader_stopped: "trader stopped"
};

export function thresholdsOf(config: { scorer: Pick<ScorerConfig, "maxRisk">; signals: Pick<SignalsConfig, "scoreMomentum">; tracker: Pick<TrackerConfig, "convergence"> }): LiveThresholds {
  return {
    scorerMaxRisk: config.scorer.maxRisk,
    momentum: config.signals.scoreMomentum,
    convergence: config.tracker.convergence
  };
}

export function readable(value: string): string {
  return value.split("_").join(" ");
}

export function shortMint(mint: Pubkey): string {
  return mint.length > SHORT_MINT_LENGTH ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

export function coinTag(symbol: string | null, mint: Pubkey): string {
  return symbol ? `$${symbol}` : shortMint(mint);
}

export function exitReasonLabel(reason: string | null | undefined): string {
  if (!reason) {
    return "unknown reason";
  }
  return EXIT_REASON_LABELS[reason] ?? readable(reason);
}

export function skipReasonLabel(reason: string | null): string {
  if (!reason) {
    return "the trader did not enter (reason not recorded yet, see the Signals tab)";
  }
  return SKIP_REASON_LABELS[reason] ?? readable(reason);
}

export function formatMultiple(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "?x";
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}x`;
}

const SMALL_SOL = 0.001;

export function formatSmallSol(value: number): string {
  if (value === 0 || Math.abs(value) >= SMALL_SOL) {
    return formatSol(value, false);
  }
  return Number(value.toPrecision(2)).toFixed(9).replace(/0+$/, "");
}

function formatNumber(value: number, decimals: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(decimals);
}

function signedPct(fraction: number): string {
  const pct = fraction * PERCENT;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function numberMeta(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function topContributions(score: LaunchScore): Array<{ name: string; value: number }> {
  return Object.entries(score.contributions)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ITEMS)
    .map(([name, value]) => ({ name, value: Math.round(value * 1000) / 1000 }));
}

export function scoreEvent(score: LaunchScore, symbol: string | null, thresholds: LiveThresholds): LiveEventDraft {
  const flags = score.flags.slice(0, TOP_ITEMS);
  const top = topContributions(score);
  const rounded = Math.round(score.score);
  const passes = !score.hardBlocked && score.score <= thresholds.scorerMaxRisk;
  const reasons = flags.length > 0 ? flags.map(readable) : passes ? ["clean"] : top.map((item) => readable(item.name));
  const detail = reasons.length > 0 ? reasons.join(", ") : "no flags";
  const tag = coinTag(symbol, score.mint);
  const text = score.hardBlocked
    ? `Blocked ${tag} ${score.checkpointSec}s: hard block (${detail})`
    : `Scored ${tag} ${score.checkpointSec}s: ${rounded} (${detail})`;
  return {
    kind: "score",
    category: "score",
    tone: score.hardBlocked ? "bad" : passes ? "good" : "neutral",
    atMs: score.computedAtMs,
    mint: score.mint,
    symbol,
    text,
    data: {
      checkpointSec: score.checkpointSec,
      score: Math.round(score.score * 10) / 10,
      hardBlocked: score.hardBlocked,
      passes,
      flags,
      top
    }
  };
}

export function signalEvent(signal: Signal, symbol: string | null): LiveEventDraft {
  const mcapSol = numberMeta(signal.meta, "mcapSol");
  const parts = [readable(signal.type)];
  if (signal.riskScore !== null) {
    parts.push(`risk ${Math.round(signal.riskScore)}`);
  }
  if (signal.type === "smart_convergence") {
    parts.push(`${signal.wallets.length} tracked wallets`);
  }
  if (mcapSol !== null) {
    parts.push(`mcap ${Math.round(mcapSol)} SOL`);
  }
  return {
    kind: "signal",
    category: "signal",
    tone: "info",
    atMs: signal.atMs,
    mint: signal.mint,
    symbol,
    text: `Signal ${coinTag(symbol, signal.mint)}: ${parts.join(", ")}`,
    data: {
      type: signal.type,
      riskScore: signal.riskScore,
      wallets: signal.wallets.length,
      mcapSol,
      launchAgeSec: numberMeta(signal.meta, "launchAgeSec")
    }
  };
}

function riskLimitFor(signal: Signal, thresholds: LiveThresholds): number {
  return signal.type === "score_momentum" ? thresholds.momentum.maxRiskScore : thresholds.convergence.maxRiskScore;
}

export function rejectionText(signal: Signal, reason: string, thresholds: LiveThresholds): string {
  const meta = signal.meta;
  const momentum = thresholds.momentum;
  switch (reason) {
    case "risk_too_high":
      return `risk ${signal.riskScore === null ? "?" : Math.round(signal.riskScore)} above ${riskLimitFor(signal, thresholds)}`;
    case "hard_blocked": {
      const flags = stringList(meta.scoreFlags).slice(0, 2).map(readable);
      return flags.length > 0 ? `hard-blocked (${flags.join(", ")})` : "hard-blocked by the scorer";
    }
    case "no_score":
      return "no score yet";
    case "low_buyer_rate": {
      const rate = numberMeta(meta, "uniqueBuyersPerMin");
      return `${rate === null ? "?" : formatNumber(rate, 1)} buyers a minute, needs ${momentum.minUniqueBuyersPerMin}`;
    }
    case "low_buy_sell_ratio": {
      const ratio = numberMeta(meta, "buySellCountRatio");
      return `buys only ${ratio === null ? "?" : ratio.toFixed(2)}x sells, needs ${momentum.minBuySellRatio}x`;
    }
    case "mcap_out_of_band": {
      const mcap = numberMeta(meta, "mcapSol");
      return `mcap ${mcap === null ? "?" : Math.round(mcap)} SOL outside ${momentum.minMcapSol} to ${momentum.maxMcapSol}`;
    }
    case "launch_too_old": {
      const age = numberMeta(meta, "launchAgeSec");
      return `launch ${formatDuration(age)} old, limit ${formatDuration(thresholds.convergence.maxLaunchAgeSec)}`;
    }
    case "quote_mint_not_allowed":
    case "not_sol_quoted":
      return "not SOL-quoted";
    case "buyers_exited":
      return "the tracked buyers already sold";
    case "cooldown":
      return "cooling down after a recent signal";
    default:
      return readable(reason);
  }
}

export function rejectedEvent(rejection: SignalRejection, symbol: string | null, thresholds: LiveThresholds, atMs: number): LiveEventDraft {
  const { signal, reason } = rejection;
  return {
    kind: "rejected",
    category: "signal",
    tone: "neutral",
    atMs,
    mint: signal.mint,
    symbol,
    text: `Rejected ${coinTag(symbol, signal.mint)}: ${rejectionText(signal, reason, thresholds)}`,
    data: { type: signal.type, reason, riskScore: signal.riskScore }
  };
}

export function skippedEvent(signal: Signal, reason: string | null, symbol: string | null, atMs: number): LiveEventDraft {
  return {
    kind: "skipped",
    category: "signal",
    tone: "warn",
    atMs,
    mint: signal.mint,
    symbol,
    text: `Skipped ${coinTag(symbol, signal.mint)}: ${skipReasonLabel(reason)}`,
    data: { type: signal.type, reason }
  };
}

function lamportsDetail(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

export function enteringEvent(event: RiskEvent, mint: Pubkey, symbol: string | null): LiveEventDraft {
  const size = lamportsDetail(event.detail.sizeLamports);
  const signalType = typeof event.detail.signalType === "string" ? event.detail.signalType : null;
  const sizeSol = size === null ? null : lamportsToSol(size);
  const sizeText = sizeSol === null ? "" : ` ${formatSol(sizeSol, false)} SOL`;
  return {
    kind: "entering",
    category: "trade",
    tone: "info",
    atMs: event.atMs,
    mint,
    symbol,
    text: `Buying ${coinTag(symbol, mint)}${sizeText}${signalType ? ` (${readable(signalType)})` : ""}`,
    data: { sizeSol, signalType }
  };
}

export function openedEvent(position: Position, context: OpenedContext): LiveEventDraft {
  const costSol = lamportsToSol(position.entryCost);
  const feesSol = lamportsToSol(position.feesPaid);
  const signalAtMs = context.signalAtMs;
  const latencyMs = signalAtMs === null ? null : Math.max(0, position.openedAtMs - signalAtMs);
  const reference = context.referencePrice;
  const slippageBps =
    reference !== null && reference > 0 && position.entryPrice > 0 ? Math.round((position.entryPrice / reference - 1) * BPS) : null;
  const parts = [`Bought ${coinTag(context.symbol, position.mint)} ${formatSol(costSol, false)} SOL`];
  if (context.entryMcapMultiple !== null && Number.isFinite(context.entryMcapMultiple)) {
    parts.push(`at ${formatMultiple(context.entryMcapMultiple)}`);
  }
  if (latencyMs !== null) {
    parts.push(`latency ${(latencyMs / 1000).toFixed(1)}s`);
  }
  if (slippageBps !== null) {
    parts.push(`slippage ${signedPct(slippageBps / BPS)}`);
  }
  parts.push(`fees ${formatSmallSol(feesSol)} SOL`);
  return {
    kind: "opened",
    category: "trade",
    tone: "info",
    atMs: position.openedAtMs,
    mint: position.mint,
    symbol: context.symbol,
    text: parts.join(" "),
    data: {
      positionId: position.id,
      mode: position.mode,
      costSol,
      entryPrice: position.entryPrice,
      entryMcapMultiple: context.entryMcapMultiple,
      latencyMs,
      slippageBps,
      feesSol,
      signalType: position.signalType,
      riskScore: position.riskScore
    }
  };
}

export function signalTimeOf(position: Position): number | null {
  const signal = position.meta.signal;
  if (signal !== null && typeof signal === "object" && !Array.isArray(signal)) {
    const atMs = (signal as Record<string, unknown>).atMs;
    return typeof atMs === "number" && Number.isFinite(atMs) ? atMs : null;
  }
  return null;
}

export function partialEvent(previous: Position, next: Position, symbol: string | null, price: number | null, reason: string | null, atMs: number): LiveEventDraft | null {
  const soldTokens = previous.tokensHeld - next.tokensHeld;
  if (soldTokens <= 0n) {
    return null;
  }
  const base = next.entryTokens > 0n ? next.entryTokens : previous.tokensHeld;
  const soldPct = (lamportsRatio(soldTokens, base) ?? 0) * PERCENT;
  const proceedsSol = lamportsToSol(next.proceeds - previous.proceeds);
  const multiple = price !== null && next.entryPrice > 0 ? price / next.entryPrice : null;
  const tag = coinTag(symbol, next.mint);
  const at = multiple === null ? "" : ` at ${formatMultiple(multiple)}`;
  const amount = `${Math.round(soldPct)}%${at} for ${formatSol(proceedsSol, false)} SOL`;
  const text =
    reason === "take_profit"
      ? `Took profit on ${tag}: sold ${amount}`
      : reason
        ? `Sold ${tag} (${exitReasonLabel(reason)}): ${amount}`
        : `Sold ${tag}: ${amount}`;
  return {
    kind: "partial",
    category: "trade",
    tone: reason === "take_profit" || (multiple !== null && multiple >= 1) ? "good" : "warn",
    atMs,
    mint: next.mint,
    symbol,
    text,
    data: { positionId: next.id, soldPctOfInitial: soldPct, multiple, proceedsSol, reason }
  };
}

function shortError(position: Position): string | null {
  const error = position.meta.entryError;
  if (typeof error !== "string" || error.length === 0) {
    return null;
  }
  return error.length > MAX_ERROR_LENGTH ? `${error.slice(0, MAX_ERROR_LENGTH)}…` : error;
}

export function closedEvent(position: Position, symbol: string | null): LiveEventDraft {
  const closedAtMs = position.closedAtMs ?? position.openedAtMs;
  const pnlSol = lamportsToSol(realizedPnlOf(position));
  const costSol = lamportsToSol(position.entryCost);
  const holdSec = Math.max(0, (closedAtMs - position.openedAtMs) / 1000);
  const peakMultiple = position.entryPrice > 0 && position.peakPrice > 0 ? position.peakPrice / position.entryPrice : null;
  const tag = coinTag(symbol, position.mint);
  const data = {
    positionId: position.id,
    pnlSol,
    pnlPct: costSol > 0 ? (pnlSol / costSol) * PERCENT : null,
    exitReason: position.exitReason,
    holdSec,
    peakMultiple,
    costSol,
    proceedsSol: lamportsToSol(position.proceeds)
  };
  if (position.exitReason === "entry_failed") {
    const error = shortError(position);
    return {
      kind: "closed",
      category: "trade",
      tone: "bad",
      atMs: closedAtMs,
      mint: position.mint,
      symbol,
      text: `Buy failed ${tag}${error ? `: ${error}` : ""}, fees ${formatSmallSol(lamportsToSol(position.feesPaid))} SOL`,
      data
    };
  }
  const pct = data.pnlPct === null ? "" : ` (${signedPct(data.pnlPct / PERCENT)})`;
  return {
    kind: "closed",
    category: "trade",
    tone: pnlSol > 0 ? "good" : pnlSol < 0 ? "bad" : "neutral",
    atMs: closedAtMs,
    mint: position.mint,
    symbol,
    text: `Closed ${tag}: ${formatSol(pnlSol)} SOL${pct}, ${exitReasonLabel(position.exitReason)} after ${formatDuration(holdSec)}`,
    data
  };
}

export function riskEventDraft(event: RiskEvent): LiveEventDraft | null {
  const base = { category: "system" as const, atMs: event.atMs, mint: null, symbol: null, data: { kind: event.kind } };
  switch (event.kind) {
    case "kill_switch": {
      const peak = lamportsDetail(event.detail.peakEquityLamports);
      const equity = lamportsDetail(event.detail.equityLamports);
      const drawdown = peak !== null && equity !== null && peak > 0n ? lamportsRatio(peak - equity, peak) : null;
      const limit = typeof event.detail.thresholdFraction === "number" ? event.detail.thresholdFraction : null;
      const detail = drawdown === null ? "" : `: drawdown ${(drawdown * PERCENT).toFixed(1)}% from peak${limit === null ? "" : ` (limit ${(limit * PERCENT).toFixed(0)}%)`}`;
      return { ...base, kind: "risk", tone: "bad", text: `Kill switch tripped${detail}. New entries are blocked until it is reset.` };
    }
    case "daily_loss_halt":
      return { ...base, kind: "risk", tone: "warn", text: "Daily loss limit hit. Entries pause until the next trading day." };
    case "kill_reset":
      return { ...base, kind: "risk", tone: "info", text: "Kill switch reset. Entries can resume." };
    case "day_roll":
      return { ...base, kind: "risk", tone: "neutral", text: "New trading day started." };
    default:
      return null;
  }
}

export function positionEvent(view: LivePositionView, atMs: number): LiveEventDraft {
  const pnl = view.pnlEstimateSol === null ? "" : `, PnL est. ${formatSol(view.pnlEstimateSol)} SOL`;
  return {
    kind: "position",
    category: "trade",
    tone: view.pnlEstimateSol === null ? "neutral" : view.pnlEstimateSol >= 0 ? "good" : "bad",
    atMs,
    mint: view.mint,
    symbol: view.symbol,
    text: `${coinTag(view.symbol, view.mint)} ${formatMultiple(view.multiple)}${pnl}`,
    data: { ...view }
  };
}
