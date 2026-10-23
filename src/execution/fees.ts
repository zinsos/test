import type { PoolFeeRates } from "../chain/amm.js";
import { ceilDiv, type FeeRates } from "../chain/curve.js";
import type { ExecutionConfig } from "../config/strategy.js";
import { BPS } from "../core/constants.js";
import type { CurveView } from "../core/types.js";

export type FeeDefaults = Pick<
  ExecutionConfig,
  | "defaultProtocolFeeBps"
  | "defaultCreatorFeeBps"
  | "defaultPoolLpFeeBps"
  | "defaultPoolProtocolFeeBps"
  | "defaultPoolCreatorFeeBps"
>;

export type FeeView = Pick<CurveView, "protocolFeeBps" | "creatorFeeBps" | "lpFeeBps">;

function observedOr(observed: number, fallback: number): number {
  return Number.isFinite(observed) && observed >= 0 ? Math.floor(observed) : fallback;
}

export function resolveCurveFees(view: FeeView, defaults: FeeDefaults): FeeRates {
  return {
    protocolFeeBps: observedOr(view.protocolFeeBps, defaults.defaultProtocolFeeBps),
    creatorFeeBps: observedOr(view.creatorFeeBps, defaults.defaultCreatorFeeBps)
  };
}

export function resolvePoolFees(view: FeeView, defaults: FeeDefaults): PoolFeeRates {
  return {
    lpFeeBps: observedOr(view.lpFeeBps, defaults.defaultPoolLpFeeBps),
    protocolFeeBps: observedOr(view.protocolFeeBps, defaults.defaultPoolProtocolFeeBps),
    creatorFeeBps: observedOr(view.creatorFeeBps, defaults.defaultPoolCreatorFeeBps)
  };
}

export function platformFeeOn(amount: bigint, bps: number): bigint {
  if (amount <= 0n || bps <= 0) {
    return 0n;
  }
  return ceilDiv(amount * BigInt(Math.floor(bps)), BPS);
}

export function totalCurveFeeBps(fees: FeeRates): number {
  return fees.protocolFeeBps + fees.creatorFeeBps;
}

export function totalPoolFeeBps(fees: PoolFeeRates): number {
  return fees.lpFeeBps + fees.protocolFeeBps + fees.creatorFeeBps;
}
