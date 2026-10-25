import { createHash } from "node:crypto";
import {
  allBreakdowns,
  describeSummary,
  summarizeTrades,
  type Breakdown,
  type Narrative,
  type TradeSummary
} from "../analytics/index.js";
import type { RiskStatus } from "../core/contracts.js";
import type { ClosedTrade } from "../core/types.js";
import type { TraderStats } from "../trader/trader.js";
import type { LoaderCounts } from "./loader.js";
import type { SkippedWeights, WeightsProvenance } from "./weights.js";

export const BACKTEST_END_REASON = "backtest_end";

export interface BacktestProgress {
  virtualNowMs: number;
  fromMs: number;
  toMs: number;
  events: number;
  openPositions: number;
  closedTrades: number;
}

export interface BacktestCounts extends LoaderCounts {
  events: number;
  signalsAccepted: number;
  signalsRejected: number;
  traderSignals: number;
  entriesAttempted: number;
  entriesFilled: number;
  entriesFailed: number;
  skipped: number;
  rejectedByRisk: number;
  closedTrades: number;
  closedAtEnd: number;
  storedScoreLaunches: number;
}

export interface BacktestSummary {
  runId: number;
  label: string | null;
  fromMs: number;
  toMs: number;
  weightsVersion: string;
  weights: WeightsProvenance;
  skippedWeights: SkippedWeights[];
  trackedVersionAtEnd: string;
  counts: BacktestCounts;
  exitReasons: Record<string, number>;
  risk: {
    killed: boolean;
    killReason: string | null;
    haltedForDay: boolean;
    realizedPnlLamports: bigint;
    peakEquityLamports: bigint;
    equityLamports: bigint;
  };
  trades: TradeSummary;
  breakdowns: Breakdown[];
  narrative: Narrative;
  fingerprint: string;
}

export interface BacktestResult {
  runId: number;
  summary: BacktestSummary;
  closedTrades: ClosedTrade[];
}

export function tradeFingerprint(trades: readonly ClosedTrade[]): string {
  const hash = createHash("sha256");
  for (const trade of trades) {
    hash.update(
      [
        trade.mint,
        trade.signalType,
        trade.openedAtMs,
        trade.closedAtMs,
        trade.cost.toString(),
        trade.proceeds.toString(),
        trade.fees.toString(),
        trade.exitReason,
        trade.riskScore ?? "null"
      ].join("|")
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function countExitReasons(trades: readonly ClosedTrade[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trade of trades) {
    counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1;
  }
  return counts;
}

export interface SummaryInput {
  runId: number;
  label: string | null;
  fromMs: number;
  toMs: number;
  closedTrades: ClosedTrade[];
  riskStatus: RiskStatus;
  loaderCounts: LoaderCounts;
  events: number;
  closedAtEnd: number;
  traderStats: TraderStats;
  signalStats: { accepted: number; rejected: number };
  weightsVersion: string;
  weights: WeightsProvenance;
  skippedWeights: SkippedWeights[];
  trackedVersion: string;
  storedScoreLaunches: number;
}

export function buildSummary(input: SummaryInput): BacktestSummary {
  const trades = summarizeTrades(input.closedTrades);
  const traderStats = input.traderStats;
  const status = input.riskStatus;
  return {
    runId: input.runId,
    label: input.label,
    fromMs: input.fromMs,
    toMs: input.toMs,
    weightsVersion: input.weightsVersion,
    weights: input.weights,
    skippedWeights: input.skippedWeights,
    trackedVersionAtEnd: input.trackedVersion,
    counts: {
      ...input.loaderCounts,
      events: input.events,
      signalsAccepted: input.signalStats.accepted,
      signalsRejected: input.signalStats.rejected,
      traderSignals: traderStats.signals,
      entriesAttempted: traderStats.entriesAttempted,
      entriesFilled: traderStats.entriesFilled,
      entriesFailed: traderStats.entriesFailed,
      skipped: traderStats.skipped,
      rejectedByRisk: traderStats.rejectedByRisk,
      closedTrades: input.closedTrades.length,
      closedAtEnd: input.closedAtEnd,
      storedScoreLaunches: input.storedScoreLaunches
    },
    exitReasons: countExitReasons(input.closedTrades),
    risk: {
      killed: status.killed,
      killReason: status.killReason,
      haltedForDay: status.haltedForDay,
      realizedPnlLamports: status.realizedPnlLamports,
      peakEquityLamports: status.peakEquityLamports,
      equityLamports: status.equityLamports
    },
    trades,
    breakdowns: allBreakdowns(input.closedTrades),
    narrative: describeSummary(trades),
    fingerprint: tradeFingerprint(input.closedTrades)
  };
}
