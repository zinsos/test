import type { ClosedTrade } from "../src/core/types.js";
import type { FillSummary, PaperLivePair } from "../src/analytics/compare.js";

export const SOL = 1_000_000_000n;
export const MONDAY_MS = Date.UTC(2026, 9, 5, 0, 0, 0);
export const MINT = "Fq3m4b8uSqVQ6WqJrxR6QAJ5TJqvkbRm5bmV6dXmpump";

let sequence = 0;

export function lamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export function closedTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  sequence += 1;
  const cost = overrides.cost ?? SOL / 10n;
  const pnl = overrides.pnl ?? 0n;
  const openedAtMs = overrides.openedAtMs ?? MONDAY_MS + sequence * 1_000;
  const holdSec = overrides.holdSec ?? 60;
  return {
    positionId: `pos-${String(sequence).padStart(6, "0")}`,
    runId: 1,
    mode: "paper",
    mint: MINT,
    signalType: "smart_convergence",
    riskScore: 20,
    openedAtMs,
    closedAtMs: openedAtMs + holdSec * 1_000,
    holdSec,
    cost,
    proceeds: cost + pnl,
    pnl,
    fees: 1_000_000n,
    exitReason: "take_profit",
    peakMultiple: 1.5,
    ...overrides
  };
}

export function tradesWithPnls(pnlsSol: readonly number[], overrides: Partial<ClosedTrade> = {}): ClosedTrade[] {
  return pnlsSol.map((pnl, index) =>
    closedTrade({
      openedAtMs: MONDAY_MS + index * 60_000,
      ...overrides,
      pnl: lamports(pnl)
    })
  );
}

export function alternating(count: number, win: number, loss: number): number[] {
  return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? win : -loss));
}

export function fill(overrides: Partial<FillSummary> = {}): FillSummary {
  return {
    side: "buy",
    success: true,
    tokenAmount: 1_000_000_000n,
    quoteAmount: SOL / 10n,
    userQuote: SOL / 10n,
    requestedAtMs: MONDAY_MS,
    filledAtMs: MONDAY_MS + 800,
    attempts: 1,
    ...overrides
  };
}

export function pair(livePnlSol: number, paperPnlSol: number, closedAtMs: number, extra: Partial<PaperLivePair> = {}): PaperLivePair {
  const live = closedTrade({ mode: "live", pnl: lamports(livePnlSol), openedAtMs: closedAtMs - 60_000 });
  const paper = closedTrade({ mode: "shadow", pnl: lamports(paperPnlSol), openedAtMs: closedAtMs - 60_000 });
  return {
    live,
    paper,
    liveFills: [fill(), fill({ side: "sell" })],
    paperFills: [fill(), fill({ side: "sell" })],
    ...extra
  };
}
