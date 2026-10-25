import type { OrderUrgency, Position } from "../core/types.js";
import type { ExitReason, ExitState, LiquidationState, PositionUpdates } from "./types.js";

export const EXIT_META_KEY = "exit";

const EXIT_REASONS: ReadonlySet<string> = new Set<ExitReason>([
  "dev_sold",
  "insider_sold",
  "smart_exit",
  "stop_loss",
  "migration_exit",
  "take_profit",
  "trailing_stop",
  "moonbag_trail",
  "time_stop",
  "max_hold",
  "migration_max_hold"
]);

export const EMPTY_EXIT_STATE: ExitState = Object.freeze({ liquidating: null, migratedSeenAtMs: null });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  return null;
}

function parseFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUrgency(value: unknown): OrderUrgency | null {
  return value === "normal" || value === "emergency" ? value : null;
}

function parseReason(value: unknown): ExitReason | null {
  return typeof value === "string" && EXIT_REASONS.has(value) ? (value as ExitReason) : null;
}

export function parseLiquidation(value: unknown): LiquidationState | null {
  if (!isRecord(value)) {
    return null;
  }
  const reason = parseReason(value.reason);
  const urgency = parseUrgency(value.urgency);
  const targetTokens = parseBigInt(value.targetTokens);
  if (!reason || !urgency || targetTokens === null || targetTokens < 0n) {
    return null;
  }
  return {
    reason,
    urgency,
    closesPosition: targetTokens === 0n,
    targetTokens,
    startedAtMs: parseFiniteNumber(value.startedAtMs) ?? 0
  };
}

export function readExitState(position: Pick<Position, "meta">): ExitState {
  const raw = position.meta[EXIT_META_KEY];
  if (!isRecord(raw)) {
    return EMPTY_EXIT_STATE;
  }
  return {
    liquidating: parseLiquidation(raw.liquidating),
    migratedSeenAtMs: parseFiniteNumber(raw.migratedSeenAtMs)
  };
}

export function serializeLiquidation(liquidation: LiquidationState): Record<string, unknown> {
  return {
    reason: liquidation.reason,
    urgency: liquidation.urgency,
    closesPosition: liquidation.closesPosition,
    targetTokens: liquidation.targetTokens.toString(),
    startedAtMs: liquidation.startedAtMs
  };
}

export function serializeExitState(state: ExitState): Record<string, unknown> {
  return {
    liquidating: state.liquidating ? serializeLiquidation(state.liquidating) : null,
    migratedSeenAtMs: state.migratedSeenAtMs
  };
}

export function applyExitUpdates(position: Position, updates: PositionUpdates): Position {
  const state: ExitState = { liquidating: updates.liquidating, migratedSeenAtMs: updates.migratedSeenAtMs };
  return {
    ...position,
    peakPrice: updates.peakPrice,
    lastPrice: updates.lastPrice,
    takeProfitLevelsHit: updates.takeProfitLevelsHit,
    migratedSeen: updates.migratedSeen,
    meta: { ...position.meta, [EXIT_META_KEY]: serializeExitState(state) }
  };
}
