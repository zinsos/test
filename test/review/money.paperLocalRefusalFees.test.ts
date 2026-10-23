import { describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { createRng } from "../../src/core/rng.js";
import type { CurveView, OrderRequest } from "../../src/core/types.js";
import { computeTradeLeg, fillPriceOf, remainingSlippageBps, simulateAttempt, slippageVersusReference } from "../../src/execution/model.js";

const view: CurveView = {
  mint: "Mint",
  slot: 1,
  atMs: 0,
  venue: "curve",
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualQuoteReserves: 30_000_000_000n,
  realTokenReserves: 793_100_000_000_000n,
  realQuoteReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
  migrated: false,
  protocolFeeBps: 95,
  creatorFeeBps: 30,
  lpFeeBps: -1
};

const spot = Number(view.virtualQuoteReserves) / Number(view.virtualTokenReserves);

function sellAfterDump(): OrderRequest {
  return {
    side: "sell",
    mint: "Mint",
    quoteBudget: null,
    tokenAmount: 3_000_000_000_000n,
    maxSlippageBps: 2_000,
    reason: "trailing_stop",
    urgency: "normal",
    signalSlot: 1,
    signalAtMs: 0,
    referencePrice: spot * 1.5,
    positionId: "p",
    closesPosition: false
  };
}

describe("review money: paper charges network fees for retries that live refuses before sending", () => {
  it("does not charge a retry whose slippage cap is already exceeded when it is quoted", () => {
    const config = { ...defaultStrategyConfig().execution, failureRate: 0 };
    const order = sellAfterDump();
    const leg = computeTradeLeg(order, view, { ...config, extraPlatformFeeBps: 0 });
    if (!("leg" in leg)) {
      throw new Error("no leg");
    }
    const expected = slippageVersusReference("sell", fillPriceOf(leg.leg) ?? 0, order.referencePrice) ?? 0;
    expect(remainingSlippageBps("sell", order.maxSlippageBps, expected)).toBeNull();
    const outcome = simulateAttempt({ order, view, config, rng: createRng("x"), attempt: 1, isFirstBuyOfPosition: false });
    expect(outcome.error).toBe("slippage_exceeded");
    expect(outcome.networkFee).toBe(0n);
  });

  it("does not charge a retry on a curve that is already complete", () => {
    const config = { ...defaultStrategyConfig().execution, failureRate: 0 };
    const order: OrderRequest = { ...sellAfterDump(), side: "buy", quoteBudget: 100_000_000n, tokenAmount: null, referencePrice: spot, maxSlippageBps: 1_500 };
    const outcome = simulateAttempt({ order, view: { ...view, complete: true }, config, rng: createRng("x"), attempt: 1, isFirstBuyOfPosition: true });
    expect(outcome.error).toBe("curve_complete");
    expect(outcome.networkFee).toBe(0n);
  });
});
