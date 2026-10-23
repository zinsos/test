import { summarizeTrades, type EdgeVerdict, type TradeSummary } from "../analytics/metrics.js";
import { lamportsToSol } from "../analytics/units.js";
import type { ClosedTrade } from "../core/types.js";

export interface LabExitReason {
  reason: string;
  n: number;
  pnlSol: number;
}

export interface LabVariantSummary {
  trades: number;
  wins: number;
  winRate: number | null;
  expectancySol: number | null;
  ciLowSol: number | null;
  ciHighSol: number | null;
  totalPnlSol: number;
  maxDrawdownSol: number;
  avgHoldSec: number | null;
  verdict: EdgeVerdict;
  exitReasons: LabExitReason[];
}

export function exitReasonBreakdown(trades: readonly ClosedTrade[]): LabExitReason[] {
  const byReason = new Map<string, { n: number; pnl: bigint }>();
  for (const trade of trades) {
    const entry = byReason.get(trade.exitReason) ?? { n: 0, pnl: 0n };
    entry.n += 1;
    entry.pnl += trade.pnl;
    byReason.set(trade.exitReason, entry);
  }
  return [...byReason.entries()]
    .map(([reason, entry]) => ({ reason, n: entry.n, pnlSol: lamportsToSol(entry.pnl) }))
    .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
}

export function labSummaryOf(trades: readonly ClosedTrade[], summary: TradeSummary = summarizeTrades(trades)): LabVariantSummary {
  return {
    trades: summary.n,
    wins: summary.wins,
    winRate: summary.winRate,
    expectancySol: summary.expectancySol,
    ciLowSol: summary.decisionCi95?.low ?? null,
    ciHighSol: summary.decisionCi95?.high ?? null,
    totalPnlSol: summary.totalPnlSol,
    maxDrawdownSol: summary.maxDrawdownSol,
    avgHoldSec: summary.avgHoldSec,
    verdict: summary.verdict,
    exitReasons: exitReasonBreakdown(trades)
  };
}
