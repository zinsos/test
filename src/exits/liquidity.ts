import { maxPoolSellForImpact } from "../chain/amm.js";
import { maxSellTokensForImpact } from "../chain/curve.js";
import type { ExitConfig } from "../config/strategy.js";
import type { CurveView, OrderUrgency } from "../core/types.js";
import { valueAtPrice } from "./math.js";

export type LiquidityConfig = ExitConfig["liquidity"];

export interface ChunkPlan {
  tokenAmount: bigint;
  finalChunk: boolean;
}

export function impactBudgetBps(urgency: OrderUrgency, liquidity: LiquidityConfig): number {
  return urgency === "emergency" ? liquidity.emergencyMaxImpactBps : liquidity.maxImpactBps;
}

export function sellCapacity(view: CurveView, impactBps: number): bigint {
  if (view.virtualTokenReserves <= 0n || view.virtualQuoteReserves <= 0n) {
    return 0n;
  }
  if (view.migrated) {
    return maxPoolSellForImpact(
      { baseReserves: view.virtualTokenReserves, quoteReserves: view.virtualQuoteReserves },
      impactBps
    );
  }
  return maxSellTokensForImpact(view, impactBps);
}

export function planChunk(
  toSell: bigint,
  view: CurveView,
  price: number,
  urgency: OrderUrgency,
  liquidity: LiquidityConfig
): ChunkPlan | null {
  if (toSell <= 0n) {
    return null;
  }
  const capacity = sellCapacity(view, impactBudgetBps(urgency, liquidity));
  if (capacity <= 0n) {
    return null;
  }
  if (toSell <= capacity) {
    return { tokenAmount: toSell, finalChunk: true };
  }
  const minChunk = BigInt(liquidity.minChunkLamports);
  const chunkIsDust = valueAtPrice(capacity, price) < minChunk;
  const leftoverIsDust = valueAtPrice(toSell - capacity, price) < minChunk;
  if (chunkIsDust || leftoverIsDust) {
    return { tokenAmount: toSell, finalChunk: true };
  }
  return { tokenAmount: capacity, finalChunk: false };
}
