import type { ExecutionConfig, ExitConfig } from "../config/strategy.js";
import type { CurveView, OrderUrgency, Position } from "../core/types.js";

export interface ExitEvents {
  devSoldFraction: number;
  insiderSoldFraction: number;
  smartWalletsExited: number;
}

export const NO_EXIT_EVENTS: ExitEvents = Object.freeze({
  devSoldFraction: 0,
  insiderSoldFraction: 0,
  smartWalletsExited: 0
});

export type ExitReason =
  | "dev_sold"
  | "insider_sold"
  | "smart_exit"
  | "stop_loss"
  | "migration_exit"
  | "take_profit"
  | "trailing_stop"
  | "moonbag_trail"
  | "time_stop"
  | "max_hold"
  | "migration_max_hold";

export interface ExitAction {
  tokenAmount: bigint;
  reason: ExitReason;
  urgency: OrderUrgency;
  maxSlippageBps: number;
  closesPosition: boolean;
  finalChunk: boolean;
}

export interface LiquidationState {
  reason: ExitReason;
  urgency: OrderUrgency;
  closesPosition: boolean;
  targetTokens: bigint;
  startedAtMs: number;
}

export interface ExitState {
  liquidating: LiquidationState | null;
  migratedSeenAtMs: number | null;
}

export interface PositionUpdates {
  peakPrice: number;
  lastPrice: number;
  takeProfitLevelsHit: number;
  migratedSeen: boolean;
  migratedSeenAtMs: number | null;
  liquidating: LiquidationState | null;
}

export type ExitExecutionConfig = Pick<ExecutionConfig, "sellSlippageBps" | "emergencySellSlippageBps">;

export interface ExitContext {
  position: Position;
  view: CurveView;
  price: number;
  nowMs: number;
  events: ExitEvents;
  config: ExitConfig;
  execution: ExitExecutionConfig;
  sellInFlight: boolean;
  migratedSlot?: number | null;
}

export interface ExitDecision {
  actions: ExitAction[];
  updates: PositionUpdates;
}

export interface ExitTrigger {
  reason: ExitReason;
  urgency: OrderUrgency;
  targetTokens: bigint;
}
