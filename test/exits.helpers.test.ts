import { describe, expect, it } from "vitest";
import { maxSellTokensForImpact } from "../src/chain/curve.js";
import { impactBudgetBps, planChunk, sellCapacity } from "../src/exits/liquidity.js";
import { fractionOf, multipleOf, valueAtPrice } from "../src/exits/math.js";
import { exitOrderRequest } from "../src/exits/orders.js";
import { mergeLiquidation, strongestTrigger } from "../src/exits/engine.js";
import { EXIT_META_KEY, applyExitUpdates, parseLiquidation, readExitState } from "../src/exits/state.js";
import { trailFractionFor } from "../src/exits/rules.js";
import type { LiquidationState } from "../src/exits/types.js";
import { curveView, exitConfig, makePosition } from "./exits.fixtures.js";

const liquidity = exitConfig().liquidity;

describe("exit math", () => {
  it("takes fractions of token amounts without floating point drift", () => {
    expect(fractionOf(10_000_000_000_000n, 0.1)).toBe(1_000_000_000_000n);
    expect(fractionOf(10_000_000_000_000n, 0.9000000000000001)).toBe(9_000_000_000_000n);
    expect(fractionOf(1000n, 1.5)).toBe(1000n);
    expect(fractionOf(1000n, 0)).toBe(0n);
    expect(fractionOf(1000n, Number.NaN)).toBe(0n);
    expect(fractionOf(-5n, 0.5)).toBe(0n);
  });

  it("values tokens and multiples defensively", () => {
    expect(valueAtPrice(1_000_000n, 5e-5)).toBe(50n);
    expect(valueAtPrice(1_000_000n, 0)).toBe(0n);
    expect(valueAtPrice(0n, 1)).toBe(0n);
    expect(multipleOf(2, 1)).toBe(2);
    expect(multipleOf(2, 0)).toBe(0);
    expect(multipleOf(Number.NaN, 1)).toBe(0);
  });
});

describe("liquidity planning", () => {
  const view = curveView({ virtualTokenReserves: 100_000_000_000_000n, virtualQuoteReserves: 5_000_000_000n });

  it("picks the impact budget by urgency", () => {
    expect(impactBudgetBps("normal", liquidity)).toBe(300);
    expect(impactBudgetBps("emergency", liquidity)).toBe(3000);
  });

  it("matches curve math for capacity and returns zero without reserves", () => {
    expect(sellCapacity(view, 300)).toBe(maxSellTokensForImpact(view, 300));
    expect(sellCapacity(curveView({ virtualQuoteReserves: 0n }), 300)).toBe(0n);
  });

  it("plans whole sells, chunks, dust tails and nothing", () => {
    const capacity = maxSellTokensForImpact(view, 300);
    expect(planChunk(0n, view, 5e-5, "normal", liquidity)).toBeNull();
    expect(planChunk(capacity, view, 5e-5, "normal", liquidity)).toEqual({ tokenAmount: capacity, finalChunk: true });
    expect(planChunk(capacity * 2n, view, 5e-5, "normal", liquidity)).toEqual({ tokenAmount: capacity, finalChunk: false });
    expect(planChunk(capacity + 1000n, view, 5e-5, "normal", liquidity)).toEqual({ tokenAmount: capacity + 1000n, finalChunk: true });
    expect(planChunk(capacity * 2n, curveView({ virtualTokenReserves: 0n }), 5e-5, "normal", liquidity)).toBeNull();
  });
});

describe("liquidation selection", () => {
  const base: LiquidationState = { reason: "take_profit", urgency: "normal", closesPosition: false, targetTokens: 500n, startedAtMs: 1 };

  it("picks the trigger with the lowest target and keeps priority order on ties", () => {
    expect(
      strongestTrigger([
        null,
        { reason: "stop_loss", urgency: "emergency", targetTokens: 0n },
        { reason: "time_stop", urgency: "normal", targetTokens: 0n },
        { reason: "trailing_stop", urgency: "normal", targetTokens: 100n }
      ])?.reason
    ).toBe("stop_loss");
    expect(strongestTrigger([null, null])).toBeNull();
  });

  it("merges active and new liquidations", () => {
    expect(mergeLiquidation(null, base)).toBe(base);
    expect(mergeLiquidation(base, null)).toBe(base);
    const deeper = { ...base, reason: "trailing_stop" as const, targetTokens: 100n, startedAtMs: 9 };
    expect(mergeLiquidation(base, deeper)).toEqual(deeper);
    expect(mergeLiquidation(deeper, base)).toEqual(deeper);
    const urgent = { ...base, reason: "dev_sold" as const, urgency: "emergency" as const, startedAtMs: 7 };
    expect(mergeLiquidation(base, urgent)).toEqual(urgent);
    expect(mergeLiquidation(urgent, base)).toEqual(urgent);
    const shallowUrgent = { ...base, targetTokens: 900n, urgency: "emergency" as const };
    expect(mergeLiquidation(base, shallowUrgent)).toEqual({ ...base, urgency: "emergency" });
  });
});

describe("trail fraction", () => {
  const config = exitConfig();

  it("returns null below the first tier and the tightest reached tier above it", () => {
    expect(trailFractionFor(1.2, { migratedSeen: false, config })).toBeNull();
    expect(trailFractionFor(1.3, { migratedSeen: false, config })).toBe(0.25);
    expect(trailFractionFor(4, { migratedSeen: false, config })).toBe(0.18);
    expect(trailFractionFor(50, { migratedSeen: false, config })).toBe(0.15);
  });

  it("switches to the migration fraction after a switch migration only", () => {
    expect(trailFractionFor(1, { migratedSeen: true, config })).toBe(0.3);
    expect(trailFractionFor(4, { migratedSeen: true, config: exitConfig({ migration: { action: "hold" } }) })).toBe(0.18);
  });
});

describe("exit state", () => {
  it("parses only well formed liquidations", () => {
    expect(parseLiquidation(null)).toBeNull();
    expect(parseLiquidation({ reason: "nope", urgency: "normal", targetTokens: "1" })).toBeNull();
    expect(parseLiquidation({ reason: "stop_loss", urgency: "fast", targetTokens: "1" })).toBeNull();
    expect(parseLiquidation({ reason: "stop_loss", urgency: "normal", targetTokens: "-1" })).toBeNull();
    expect(parseLiquidation({ reason: "stop_loss", urgency: "normal", targetTokens: 1.5 })).toBeNull();
    expect(parseLiquidation({ reason: "stop_loss", urgency: "emergency", targetTokens: "0", startedAtMs: 5 })).toEqual({
      reason: "stop_loss",
      urgency: "emergency",
      closesPosition: true,
      targetTokens: 0n,
      startedAtMs: 5
    });
  });

  it("reads empty state from positions without exit meta and keeps other meta keys", () => {
    expect(readExitState(makePosition())).toEqual({ liquidating: null, migratedSeenAtMs: null });
    expect(readExitState(makePosition({ meta: { [EXIT_META_KEY]: "garbage" } }))).toEqual({ liquidating: null, migratedSeenAtMs: null });
    const updated = applyExitUpdates(makePosition({ meta: { source: "test" } }), {
      peakPrice: 2,
      lastPrice: 1,
      takeProfitLevelsHit: 3,
      migratedSeen: true,
      migratedSeenAtMs: 42,
      liquidating: null
    });
    expect(updated.meta.source).toBe("test");
    expect(updated).toMatchObject({ peakPrice: 2, lastPrice: 1, takeProfitLevelsHit: 3, migratedSeen: true });
    expect(readExitState(updated).migratedSeenAtMs).toBe(42);
  });
});

describe("exit order request", () => {
  it("builds a sell order from an action", () => {
    const order = exitOrderRequest(
      makePosition(),
      { tokenAmount: 123n, reason: "stop_loss", urgency: "emergency", maxSlippageBps: 5000, closesPosition: true, finalChunk: true },
      curveView({ slot: 77 }),
      4e-5,
      999
    );
    expect(order).toEqual({
      side: "sell",
      mint: makePosition().mint,
      quoteBudget: null,
      tokenAmount: 123n,
      maxSlippageBps: 5000,
      reason: "stop_loss",
      urgency: "emergency",
      signalSlot: 77,
      signalAtMs: 999,
      referencePrice: 4e-5,
      positionId: "pos-1",
      closesPosition: true
    });
  });
});
