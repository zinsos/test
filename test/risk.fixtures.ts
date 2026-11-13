import { RiskConfigSchema, type RiskConfig } from "../src/config/strategy.js";
import type { RiskEntryInput, RiskStatus } from "../src/core/contracts.js";
import type { ClosedTrade, Position, Signal } from "../src/core/types.js";
import type { RiskPersistence } from "../src/risk/persistence.js";
import { makePosition } from "./exits.fixtures.js";

export const SOL = 1_000_000_000n;
export const NOON_UTC = Date.UTC(2026, 9, 23, 12, 0, 0);

export function riskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return RiskConfigSchema.parse(overrides);
}

export function signalFor(mint: string, atMs: number): Signal {
  return { id: null, type: "smart_convergence", mint, atMs, slot: 1, riskScore: 10, wallets: [], meta: {} };
}

export function entry(mint: string, devWallet: string, nowMs: number, openPositions: readonly Position[] = []): RiskEntryInput {
  return { mint, devWallet, signal: signalFor(mint, nowMs), nowMs, openPositions };
}

export function openPosition(id: string, mint: string): Position {
  return makePosition({ id, mint });
}

export function closedTrade(positionId: string, mint: string, pnl: bigint, closedAtMs: number): ClosedTrade {
  return {
    positionId,
    runId: 1,
    mode: "paper",
    mint,
    signalType: "smart_convergence",
    riskScore: 10,
    openedAtMs: closedAtMs - 60_000,
    closedAtMs,
    holdSec: 60,
    cost: 75_000_000n,
    proceeds: 75_000_000n + pnl,
    pnl,
    fees: 1_000_000n,
    exitReason: "time_stop",
    peakMultiple: 1.1
  };
}

export interface RecordingStore extends RiskPersistence {
  saves: Array<{ status: RiskStatus; extra: Record<string, unknown> }>;
  events: Array<{ runId: number; atMs: number; kind: string; detail: Record<string, unknown> }>;
  lastSave(): { status: RiskStatus; extra: Record<string, unknown> };
  kinds(): string[];
}

export function recordingStore(): RecordingStore {
  const saves: RecordingStore["saves"] = [];
  const events: RecordingStore["events"] = [];
  return {
    saves,
    events,
    saveRiskState(status, extra) {
      saves.push({ status, extra: JSON.parse(JSON.stringify(extra)) as Record<string, unknown> });
    },
    recordRiskEvent(runId, atMs, kind, detail) {
      events.push({ runId, atMs, kind, detail });
    },
    lastSave() {
      const last = saves[saves.length - 1];
      if (!last) {
        throw new Error("nothing saved");
      }
      return last;
    },
    kinds() {
      return events.map((event) => event.kind);
    }
  };
}
