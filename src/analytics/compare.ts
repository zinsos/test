import { meanConfidenceInterval95, median, type Interval } from "../core/stats.js";
import type { ClosedTrade, OrderSide } from "../core/types.js";
import { lamportsToSol } from "./units.js";

export type PaperLiveVerdict = "insufficient_data" | "paper_too_optimistic" | "paper_too_pessimistic" | "consistent";

export const DEFAULT_MIN_PAIRS = 20;
export const DEFAULT_PAIR_DETAIL_LIMIT = 50;
const BPS = 10_000;
const DAY_MS = 86_400_000;

export interface FillSummary {
  side: OrderSide;
  success: boolean;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  requestedAtMs: number;
  filledAtMs: number | null;
  attempts: number;
}

export interface PaperLivePair {
  live: ClosedTrade;
  paper: ClosedTrade;
  liveFills: readonly FillSummary[];
  paperFills: readonly FillSummary[];
}

export interface PairDetail {
  livePositionId: string;
  paperPositionId: string;
  mint: string;
  closedAtMs: number;
  livePnlSol: number;
  paperPnlSol: number;
  diffSol: number;
  entryGapBps: number | null;
  exitGapBps: number | null;
  liveExitReason: string;
  paperExitReason: string;
}

export interface GapStats {
  n: number;
  meanBps: number | null;
  medianBps: number | null;
}

export interface SideRates {
  live: number | null;
  paper: number | null;
}

export interface WeeklyGap {
  weekStartMs: number;
  n: number;
  meanLiveSol: number;
  meanPaperSol: number;
  meanDiffSol: number;
}

export interface PaperLiveComparison {
  n: number;
  minPairs: number;
  meanLiveSol: number | null;
  meanPaperSol: number | null;
  meanDiffSol: number | null;
  medianDiffSol: number | null;
  diffCi95: Interval | null;
  totalLiveSol: number;
  totalPaperSol: number;
  paperBetterShare: number | null;
  liveWinRate: number | null;
  paperWinRate: number | null;
  entryGap: GapStats;
  exitGap: GapStats;
  fillFailureRate: SideRates;
  meanFillLatencyMs: SideRates;
  exitReasonMismatchShare: number | null;
  verdict: PaperLiveVerdict;
  byWeek: WeeklyGap[];
  pairs: PairDetail[];
}

export interface CompareOptions {
  minPairs?: number;
  detailLimit?: number;
}

export function volumeWeightedPrice(fills: readonly FillSummary[], side: OrderSide): number | null {
  let quote = 0n;
  let tokens = 0n;
  for (const fill of fills) {
    if (fill.side === side && fill.success && fill.tokenAmount > 0n) {
      quote += fill.userQuote;
      tokens += fill.tokenAmount;
    }
  }
  if (tokens <= 0n || quote <= 0n) {
    return null;
  }
  return Number(quote) / Number(tokens);
}

export function entryGapBps(liveFills: readonly FillSummary[], paperFills: readonly FillSummary[]): number | null {
  const live = volumeWeightedPrice(liveFills, "buy");
  const paper = volumeWeightedPrice(paperFills, "buy");
  if (live === null || paper === null) {
    return null;
  }
  return (live / paper - 1) * BPS;
}

export function exitGapBps(liveFills: readonly FillSummary[], paperFills: readonly FillSummary[]): number | null {
  const live = volumeWeightedPrice(liveFills, "sell");
  const paper = volumeWeightedPrice(paperFills, "sell");
  if (live === null || paper === null) {
    return null;
  }
  return (1 - live / paper) * BPS;
}

export function weekStartUtc(atMs: number): number {
  const date = new Date(atMs);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - daysSinceMonday * DAY_MS;
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

function gapStats(values: readonly (number | null)[]): GapStats {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return { n: present.length, meanBps: meanOf(present), medianBps: median(present) };
}

function failureRate(fills: readonly FillSummary[]): number | null {
  if (fills.length === 0) {
    return null;
  }
  return fills.filter((fill) => !fill.success).length / fills.length;
}

function meanLatencyMs(fills: readonly FillSummary[]): number | null {
  const latencies = fills
    .filter((fill) => fill.success && fill.filledAtMs !== null)
    .map((fill) => (fill.filledAtMs ?? fill.requestedAtMs) - fill.requestedAtMs);
  return meanOf(latencies);
}

export function paperLiveVerdict(n: number, minPairs: number, diffCi95: Interval | null): PaperLiveVerdict {
  if (n < minPairs || diffCi95 === null) {
    return "insufficient_data";
  }
  if (diffCi95.high < 0) {
    return "paper_too_optimistic";
  }
  if (diffCi95.low > 0) {
    return "paper_too_pessimistic";
  }
  return "consistent";
}

function pairDetail(pair: PaperLivePair): PairDetail {
  const livePnlSol = lamportsToSol(pair.live.pnl);
  const paperPnlSol = lamportsToSol(pair.paper.pnl);
  return {
    livePositionId: pair.live.positionId,
    paperPositionId: pair.paper.positionId,
    mint: pair.live.mint,
    closedAtMs: pair.live.closedAtMs,
    livePnlSol,
    paperPnlSol,
    diffSol: lamportsToSol(pair.live.pnl - pair.paper.pnl),
    entryGapBps: entryGapBps(pair.liveFills, pair.paperFills),
    exitGapBps: exitGapBps(pair.liveFills, pair.paperFills),
    liveExitReason: pair.live.exitReason,
    paperExitReason: pair.paper.exitReason
  };
}

function weeklyGaps(details: readonly PairDetail[]): WeeklyGap[] {
  const weeks = new Map<number, PairDetail[]>();
  for (const detail of details) {
    const week = weekStartUtc(detail.closedAtMs);
    const list = weeks.get(week) ?? [];
    list.push(detail);
    weeks.set(week, list);
  }
  return [...weeks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekStartMs, list]) => ({
      weekStartMs,
      n: list.length,
      meanLiveSol: meanOf(list.map((item) => item.livePnlSol)) ?? 0,
      meanPaperSol: meanOf(list.map((item) => item.paperPnlSol)) ?? 0,
      meanDiffSol: meanOf(list.map((item) => item.diffSol)) ?? 0
    }));
}

function shareOf<T>(items: readonly T[], predicate: (item: T) => boolean): number | null {
  return items.length === 0 ? null : items.filter(predicate).length / items.length;
}

export function comparePaperLive(pairs: readonly PaperLivePair[], options: CompareOptions = {}): PaperLiveComparison {
  const minPairs = options.minPairs ?? DEFAULT_MIN_PAIRS;
  const detailLimit = options.detailLimit ?? DEFAULT_PAIR_DETAIL_LIMIT;
  const details = pairs.map(pairDetail);
  const diffs = details.map((detail) => detail.diffSol);
  const diffCi95 = meanConfidenceInterval95(diffs);
  let totalLive = 0n;
  let totalPaper = 0n;
  for (const pair of pairs) {
    totalLive += pair.live.pnl;
    totalPaper += pair.paper.pnl;
  }
  const liveFills = pairs.flatMap((pair) => pair.liveFills);
  const paperFills = pairs.flatMap((pair) => pair.paperFills);
  return {
    n: pairs.length,
    minPairs,
    meanLiveSol: meanOf(details.map((detail) => detail.livePnlSol)),
    meanPaperSol: meanOf(details.map((detail) => detail.paperPnlSol)),
    meanDiffSol: meanOf(diffs),
    medianDiffSol: median(diffs),
    diffCi95,
    totalLiveSol: lamportsToSol(totalLive),
    totalPaperSol: lamportsToSol(totalPaper),
    paperBetterShare: shareOf(pairs, (pair) => pair.paper.pnl > pair.live.pnl),
    liveWinRate: shareOf(pairs, (pair) => pair.live.pnl > 0n),
    paperWinRate: shareOf(pairs, (pair) => pair.paper.pnl > 0n),
    entryGap: gapStats(details.map((detail) => detail.entryGapBps)),
    exitGap: gapStats(details.map((detail) => detail.exitGapBps)),
    fillFailureRate: { live: failureRate(liveFills), paper: failureRate(paperFills) },
    meanFillLatencyMs: { live: meanLatencyMs(liveFills), paper: meanLatencyMs(paperFills) },
    exitReasonMismatchShare: shareOf(details, (detail) => detail.liveExitReason !== detail.paperExitReason),
    verdict: paperLiveVerdict(pairs.length, minPairs, diffCi95),
    byWeek: weeklyGaps(details),
    pairs: [...details].sort((a, b) => b.closedAtMs - a.closedAtMs).slice(0, Math.max(0, detailLimit))
  };
}
