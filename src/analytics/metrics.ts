import { createRng } from "../core/rng.js";
import { bootstrapMeanInterval, meanConfidenceInterval95, median, stdev, type Interval } from "../core/stats.js";
import type { ClosedTrade } from "../core/types.js";
import {
  BREAKDOWN_DIMENSIONS,
  bucketOf,
  isCategoricalDimension,
  type BreakdownDimension,
  type BucketOptions
} from "./dimensions.js";
import { finiteOrNull, lamportsToSol } from "./units.js";

export type EdgeVerdict = "insufficient_data" | "no_edge" | "edge";
export type EdgeSignificance = "positive" | "negative" | "inconclusive";
export type BucketAction = "scale" | "lean_scale" | "lean_cut" | "cut" | "insufficient";

export const DEFAULT_MIN_TRADES = 100;
export const DEFAULT_MIN_TRADES_PER_BUCKET = 30;
export const DEFAULT_BOOTSTRAP_ITERATIONS = 2_000;
export const DEFAULT_BOOTSTRAP_SEED = "snypra-edge-analytics";
export const DEFAULT_MAX_EQUITY_POINTS = 400;
const MAX_BOOTSTRAP_WORK = 20_000_000;
const MIN_BOOTSTRAP_ITERATIONS = 200;
const Z_95 = 1.96;

export interface SummaryOptions {
  minTrades?: number;
  bootstrapIterations?: number;
  seed?: string | number;
}

export interface TradeSummary {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  lossRate: number | null;
  avgWinSol: number | null;
  avgLossSol: number | null;
  expectancySol: number | null;
  sdSol: number | null;
  expectancyCi95: Interval | null;
  bootstrapCi95: Interval | null;
  decisionCi95: Interval | null;
  expectancyPctOfStake: number | null;
  profitFactor: number | null;
  grossWinSol: number;
  grossLossSol: number;
  totalPnlSol: number;
  totalCostSol: number;
  totalFeesSol: number;
  pnlExBestSol: number | null;
  bestTradeSol: number | null;
  worstTradeSol: number | null;
  maxDrawdownSol: number;
  avgHoldSec: number | null;
  medianHoldSec: number | null;
  firstClosedAtMs: number | null;
  lastClosedAtMs: number | null;
  minTrades: number;
  verdict: EdgeVerdict;
  significance: EdgeSignificance;
  tradesNeeded: number | null;
  moreTradesNeeded: number | null;
}

export interface CoreStats {
  n: number;
  wins: number;
  losses: number;
  grossWin: bigint;
  grossLoss: bigint;
  totalPnl: bigint;
  pnlsSol: number[];
}

export interface EquityPoint {
  index: number;
  atMs: number;
  equitySol: number;
  pnlSol: number;
  drawdownSol: number;
  positionId: string | null;
  mint: string | null;
}

export interface EquityOptions {
  maxPoints?: number;
}

export interface BreakdownOptions extends BucketOptions {
  minTradesPerBucket?: number;
}

export interface BreakdownRow {
  key: string;
  label: string;
  n: number;
  wins: number;
  winRate: number | null;
  avgWinSol: number | null;
  avgLossSol: number | null;
  expectancySol: number | null;
  ci95: Interval | null;
  totalPnlSol: number;
  profitFactor: number | null;
  avgHoldSec: number | null;
  shareOfTrades: number;
  action: BucketAction;
}

export interface Breakdown {
  dimension: BreakdownDimension;
  minTradesPerBucket: number;
  n: number;
  rows: BreakdownRow[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortByClose(trades: readonly ClosedTrade[]): ClosedTrade[] {
  return [...trades].sort((a, b) => a.closedAtMs - b.closedAtMs || compareText(a.positionId, b.positionId));
}

export function coreStats(trades: readonly ClosedTrade[]): CoreStats {
  let wins = 0;
  let losses = 0;
  let grossWin = 0n;
  let grossLoss = 0n;
  const pnlsSol: number[] = [];
  for (const trade of trades) {
    if (trade.pnl > 0n) {
      wins += 1;
      grossWin += trade.pnl;
    } else {
      losses += 1;
      grossLoss -= trade.pnl;
    }
    pnlsSol.push(lamportsToSol(trade.pnl));
  }
  return { n: trades.length, wins, losses, grossWin, grossLoss, totalPnl: grossWin - grossLoss, pnlsSol };
}

function rate(count: number, total: number): number | null {
  return total > 0 ? count / total : null;
}

function average(total: bigint, count: number): number | null {
  return count > 0 ? lamportsToSol(total) / count : null;
}

export function profitFactorOf(grossWin: bigint, grossLoss: bigint): number | null {
  if (grossLoss <= 0n) {
    return null;
  }
  return Number(grossWin) / Number(grossLoss);
}

export function tradesNeededFor(meanSol: number | null, sdSol: number | null, minTrades: number = DEFAULT_MIN_TRADES): number | null {
  if (meanSol === null || sdSol === null || !Number.isFinite(meanSol) || !Number.isFinite(sdSol) || meanSol === 0) {
    return null;
  }
  const raw = Math.ceil(((Z_95 * sdSol) / Math.abs(meanSol)) ** 2);
  return Math.max(minTrades, raw);
}

function bootstrapIterationsFor(n: number, requested: number): number {
  if (n === 0) {
    return 0;
  }
  const budget = Math.floor(MAX_BOOTSTRAP_WORK / n);
  return Math.max(Math.min(requested, MIN_BOOTSTRAP_ITERATIONS), Math.min(requested, budget));
}

export function conservativeInterval(a: Interval | null, b: Interval | null): Interval | null {
  if (a && b) {
    return { low: Math.min(a.low, b.low), high: Math.max(a.high, b.high) };
  }
  return a ?? b;
}

export function edgeVerdict(n: number, minTrades: number, interval: Interval | null): EdgeVerdict {
  if (n < minTrades || interval === null) {
    return "insufficient_data";
  }
  return interval.low > 0 ? "edge" : "no_edge";
}

export function edgeSignificance(interval: Interval | null): EdgeSignificance {
  if (interval === null) {
    return "inconclusive";
  }
  if (interval.low > 0) {
    return "positive";
  }
  return interval.high < 0 ? "negative" : "inconclusive";
}

export function equityWalk(sorted: readonly ClosedTrade[]): { equity: bigint[]; drawdown: bigint[]; maxDrawdown: bigint } {
  const equity: bigint[] = [];
  const drawdown: bigint[] = [];
  let running = 0n;
  let peak = 0n;
  let maxDrawdown = 0n;
  for (const trade of sorted) {
    running += trade.pnl;
    if (running > peak) {
      peak = running;
    }
    const current = peak - running;
    if (current > maxDrawdown) {
      maxDrawdown = current;
    }
    equity.push(running);
    drawdown.push(current);
  }
  return { equity, drawdown, maxDrawdown };
}

function finiteHolds(trades: readonly ClosedTrade[]): number[] {
  return trades.map((trade) => trade.holdSec).filter((value) => Number.isFinite(value));
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

function returnPcts(trades: readonly ClosedTrade[]): number[] {
  return trades.filter((trade) => trade.cost > 0n).map((trade) => (Number(trade.pnl) / Number(trade.cost)) * 100);
}

function extremes(trades: readonly ClosedTrade[]): { best: bigint | null; worst: bigint | null } {
  let best: bigint | null = null;
  let worst: bigint | null = null;
  for (const trade of trades) {
    best = best === null || trade.pnl > best ? trade.pnl : best;
    worst = worst === null || trade.pnl < worst ? trade.pnl : worst;
  }
  return { best, worst };
}

function bootstrapInterval(pnls: readonly number[], options: SummaryOptions): Interval | null {
  const iterations = bootstrapIterationsFor(pnls.length, options.bootstrapIterations ?? DEFAULT_BOOTSTRAP_ITERATIONS);
  if (iterations <= 0) {
    return null;
  }
  return bootstrapMeanInterval(pnls, createRng(options.seed ?? DEFAULT_BOOTSTRAP_SEED), iterations);
}

export function summarizeTrades(trades: readonly ClosedTrade[], options: SummaryOptions = {}): TradeSummary {
  const minTrades = options.minTrades ?? DEFAULT_MIN_TRADES;
  const sorted = sortByClose(trades);
  const core = coreStats(sorted);
  const { n, wins, losses, grossWin, grossLoss, totalPnl, pnlsSol } = core;
  const expectancySol = average(totalPnl, n);
  const sdSol = stdev(pnlsSol);
  const expectancyCi95 = meanConfidenceInterval95(pnlsSol);
  const bootstrapCi95 = bootstrapInterval(pnlsSol, options);
  const decisionCi95 = conservativeInterval(expectancyCi95, bootstrapCi95);
  const holds = finiteHolds(sorted);
  const { best, worst } = extremes(sorted);
  const tradesNeeded = tradesNeededFor(expectancySol, sdSol, minTrades);
  let totalCost = 0n;
  let totalFees = 0n;
  for (const trade of sorted) {
    totalCost += trade.cost;
    totalFees += trade.fees;
  }
  return {
    n,
    wins,
    losses,
    winRate: rate(wins, n),
    lossRate: rate(losses, n),
    avgWinSol: average(grossWin, wins),
    avgLossSol: average(grossLoss, losses),
    expectancySol,
    sdSol,
    expectancyCi95,
    bootstrapCi95,
    decisionCi95,
    expectancyPctOfStake: finiteOrNull(meanOf(returnPcts(sorted))),
    profitFactor: profitFactorOf(grossWin, grossLoss),
    grossWinSol: lamportsToSol(grossWin),
    grossLossSol: lamportsToSol(grossLoss),
    totalPnlSol: lamportsToSol(totalPnl),
    totalCostSol: lamportsToSol(totalCost),
    totalFeesSol: lamportsToSol(totalFees),
    pnlExBestSol: best === null ? null : lamportsToSol(totalPnl - best),
    bestTradeSol: best === null ? null : lamportsToSol(best),
    worstTradeSol: worst === null ? null : lamportsToSol(worst),
    maxDrawdownSol: lamportsToSol(equityWalk(sorted).maxDrawdown),
    avgHoldSec: meanOf(holds),
    medianHoldSec: median(holds),
    firstClosedAtMs: sorted[0]?.closedAtMs ?? null,
    lastClosedAtMs: sorted[sorted.length - 1]?.closedAtMs ?? null,
    minTrades,
    verdict: edgeVerdict(n, minTrades, decisionCi95),
    significance: edgeSignificance(decisionCi95),
    tradesNeeded,
    moreTradesNeeded: tradesNeeded === null ? null : Math.max(0, tradesNeeded - n)
  };
}

function pickExtremes(points: readonly EquityPoint[], start: number, end: number): EquityPoint[] {
  let low: EquityPoint | undefined;
  let high: EquityPoint | undefined;
  for (let index = start; index < end; index += 1) {
    const point = points[index];
    if (!point) {
      continue;
    }
    if (!low || point.equitySol < low.equitySol) {
      low = point;
    }
    if (!high || point.equitySol > high.equitySol) {
      high = point;
    }
  }
  if (!low || !high) {
    return [];
  }
  if (low === high) {
    return [low];
  }
  return low.index < high.index ? [low, high] : [high, low];
}

export function downsampleEquity(points: readonly EquityPoint[], maxPoints: number = DEFAULT_MAX_EQUITY_POINTS): EquityPoint[] {
  const limit = Math.max(4, Math.floor(maxPoints));
  if (points.length <= limit) {
    return [...points];
  }
  const first = points[0];
  const last = points[points.length - 1];
  const innerEnd = points.length - 1;
  const bucketCount = Math.floor((limit - 2) / 2);
  const size = (innerEnd - 1) / bucketCount;
  const result: EquityPoint[] = first ? [first] : [];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor(bucket * size);
    const end = bucket === bucketCount - 1 ? innerEnd : 1 + Math.floor((bucket + 1) * size);
    result.push(...pickExtremes(points, start, end));
  }
  if (last) {
    result.push(last);
  }
  return result;
}

export function equitySeries(trades: readonly ClosedTrade[], options: EquityOptions = {}): EquityPoint[] {
  const sorted = sortByClose(trades);
  const firstTrade = sorted[0];
  if (!firstTrade) {
    return [];
  }
  const walk = equityWalk(sorted);
  const points: EquityPoint[] = [
    { index: 0, atMs: firstTrade.closedAtMs, equitySol: 0, pnlSol: 0, drawdownSol: 0, positionId: null, mint: null }
  ];
  sorted.forEach((trade, index) => {
    points.push({
      index: index + 1,
      atMs: trade.closedAtMs,
      equitySol: lamportsToSol(walk.equity[index] ?? 0n),
      pnlSol: lamportsToSol(trade.pnl),
      drawdownSol: lamportsToSol(walk.drawdown[index] ?? 0n),
      positionId: trade.positionId,
      mint: trade.mint
    });
  });
  return downsampleEquity(points, options.maxPoints ?? DEFAULT_MAX_EQUITY_POINTS);
}

export function bucketAction(n: number, expectancySol: number | null, ci: Interval | null, minTrades: number): BucketAction {
  if (n < minTrades || expectancySol === null) {
    return "insufficient";
  }
  if (ci && ci.high < 0) {
    return "cut";
  }
  if (ci && ci.low > 0) {
    return "scale";
  }
  return expectancySol > 0 ? "lean_scale" : "lean_cut";
}

interface BucketAccumulator {
  key: string;
  label: string;
  order: number;
  trades: ClosedTrade[];
}

function breakdownRow(bucket: BucketAccumulator, total: number, minTrades: number): BreakdownRow {
  const core = coreStats(bucket.trades);
  const expectancySol = average(core.totalPnl, core.n);
  const ci95 = meanConfidenceInterval95(core.pnlsSol);
  return {
    key: bucket.key,
    label: bucket.label,
    n: core.n,
    wins: core.wins,
    winRate: rate(core.wins, core.n),
    avgWinSol: average(core.grossWin, core.wins),
    avgLossSol: average(core.grossLoss, core.losses),
    expectancySol,
    ci95,
    totalPnlSol: lamportsToSol(core.totalPnl),
    profitFactor: profitFactorOf(core.grossWin, core.grossLoss),
    avgHoldSec: meanOf(finiteHolds(bucket.trades)),
    shareOfTrades: total > 0 ? core.n / total : 0,
    action: bucketAction(core.n, expectancySol, ci95, minTrades)
  };
}

export function breakdown(
  trades: readonly ClosedTrade[],
  dimension: BreakdownDimension,
  options: BreakdownOptions = {}
): Breakdown {
  const minTradesPerBucket = options.minTradesPerBucket ?? DEFAULT_MIN_TRADES_PER_BUCKET;
  const buckets = new Map<string, BucketAccumulator>();
  for (const trade of trades) {
    const bucket = bucketOf(trade, dimension, options);
    const existing = buckets.get(bucket.key);
    if (existing) {
      existing.trades.push(trade);
    } else {
      buckets.set(bucket.key, { ...bucket, trades: [trade] });
    }
  }
  const categorical = isCategoricalDimension(dimension);
  const ordered = [...buckets.values()].sort(
    (a, b) =>
      a.order - b.order || (categorical ? b.trades.length - a.trades.length : 0) || compareText(a.key, b.key)
  );
  return {
    dimension,
    minTradesPerBucket,
    n: trades.length,
    rows: ordered.map((bucket) => breakdownRow(bucket, trades.length, minTradesPerBucket))
  };
}

export function allBreakdowns(trades: readonly ClosedTrade[], options: BreakdownOptions = {}): Breakdown[] {
  return BREAKDOWN_DIMENSIONS.map((dimension) => breakdown(trades, dimension, options));
}

export {
  comparePaperLive,
  DEFAULT_MIN_PAIRS,
  type FillSummary,
  type PaperLiveComparison,
  type PaperLivePair,
  type PairDetail,
  type PaperLiveVerdict,
  type WeeklyGap
} from "./compare.js";
