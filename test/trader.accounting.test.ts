import { describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import type { CurveView, FillResult, OrderRequest, Position, Signal } from "../src/core/types.js";
import { failedFill, successfulFill } from "../src/execution/fill.js";
import {
  ENTRY_FAILED_REASON,
  SYNTHETIC_CLOSE_NOTE,
  applySellFill,
  closedTradeOf,
  closePosition,
  costsOf,
  effectiveFillPrice,
  entryCostOf,
  failedEntryPosition,
  isDust,
  liquidationValue,
  openPositionFromFill,
  sellProceedsOf,
  syntheticCloseFill,
  unrealizedPnlOf,
  type PositionSeed
} from "../src/trader/accounting.js";
import { entryKey, fillSeqOf, orderKeyOf, positionIdFor, shadowIdFor, shadowKeyFor, withNextFillSeq } from "../src/trader/ids.js";

const execution = defaultStrategyConfig().execution;
const MINT = "MintAccounting11111111111111111111111111111";

function order(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    side: "buy",
    mint: MINT,
    quoteBudget: 100_000_000n,
    tokenAmount: null,
    maxSlippageBps: 1500,
    reason: "smart_convergence",
    urgency: "normal",
    signalSlot: 10,
    signalAtMs: 1_000,
    referencePrice: 3e-5,
    positionId: "key",
    closesPosition: false,
    ...overrides
  };
}

function fill(overrides: Partial<FillResult> = {}): FillResult {
  const base = successfulFill({
    order: order(),
    amounts: {
      venue: "curve",
      tokenAmount: 3_000_000_000n,
      quoteAmount: 98_000_000n,
      userQuote: 99_500_000n,
      protocolFee: 931_000n,
      creatorFee: 294_000n,
      lpFee: 0n,
      extraPlatformFee: 275_000n
    },
    quality: { fillPrice: 99_500_000 / 3_000_000_000, slippageBps: 12, priceImpactBps: 30 },
    attempts: [{ atMs: 1_800, slot: 12, success: true, error: null, networkFee: 305_000n, tip: 1_000_000n }],
    filledAtMs: 1_800,
    filledSlot: 12,
    rentPaid: 2_039_280n,
    rentRefunded: 0n,
    signature: null
  });
  return { ...base, ...overrides };
}

const signal: Signal = { id: null, type: "smart_convergence", mint: MINT, atMs: 1_000, slot: 10, riskScore: 22, wallets: ["a", "b", "c"], meta: {} };

function seed(overrides: Partial<PositionSeed> = {}): PositionSeed {
  return {
    id: "7-1000-mint",
    runId: 7,
    mode: "paper",
    signal,
    signalId: 41,
    launchId: 5,
    shadowOf: null,
    orderKey: "1000-mint",
    migrated: false,
    nowMs: 1_800,
    slot: 12,
    ...overrides
  };
}

function view(overrides: Partial<CurveView> = {}): CurveView {
  return {
    mint: MINT,
    slot: 20,
    atMs: 2_000,
    venue: "curve",
    virtualTokenReserves: 1_000_000_000_000_000n,
    virtualQuoteReserves: 32_000_000_000n,
    realTokenReserves: 720_000_000_000_000n,
    realQuoteReserves: 2_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    migrated: false,
    protocolFeeBps: 95,
    creatorFeeBps: 30,
    lpFeeBps: -1,
    ...overrides
  };
}

describe("fill accounting", () => {
  it("counts every lamport that left the wallet as entry cost", () => {
    const buy = fill();
    expect(entryCostOf(buy)).toBe(99_500_000n + 305_000n + 1_000_000n + 2_039_280n);
    expect(costsOf(buy)).toBe(931_000n + 294_000n + 275_000n + 305_000n + 1_000_000n);
  });

  it("charges only network fees for a failed buy and never goes negative", () => {
    const failed = failedFill(order(), "tx_failed", [
      { atMs: 1, slot: 1, success: false, error: "tx_failed", networkFee: 305_000n, tip: 0n },
      { atMs: 2, slot: 2, success: false, error: "slippage_exceeded", networkFee: 305_000n, tip: 0n }
    ], "curve");
    expect(entryCostOf(failed)).toBe(610_000n);
    expect(entryCostOf(failedFill(order(), "no_market", [], "curve"))).toBe(0n);
  });

  it("nets sell proceeds of fees and tips and adds rent refunds; failed sells cost fees", () => {
    const sell = fill({ side: "sell", userQuote: 50_000_000n, rentPaid: 0n, rentRefunded: 2_039_280n });
    expect(sellProceedsOf(sell)).toBe(50_000_000n - 305_000n - 1_000_000n + 2_039_280n);
    const failed = failedFill(order({ side: "sell", tokenAmount: 1n, quoteBudget: null }), "tx_failed", [
      { atMs: 1, slot: 1, success: false, error: "tx_failed", networkFee: 305_000n, tip: 0n }
    ], "curve");
    expect(sellProceedsOf(failed)).toBe(-305_000n);
  });

  it("falls back to quote per token when the fill price is missing or unusable", () => {
    expect(effectiveFillPrice({ fillPrice: null, userQuote: 300n, tokenAmount: 100n })).toBe(3);
    expect(effectiveFillPrice({ fillPrice: Number.NaN, userQuote: 300n, tokenAmount: 100n })).toBe(3);
    expect(effectiveFillPrice({ fillPrice: null, userQuote: 0n, tokenAmount: 0n })).toBe(0);
  });
});

describe("position lifecycle", () => {
  it("opens from a fill with the fee-inclusive entry price and records the order key", () => {
    const position = openPositionFromFill(seed(), fill());
    expect(position.entryTokens).toBe(3_000_000_000n);
    expect(position.tokensHeld).toBe(3_000_000_000n);
    expect(position.entryCost).toBe(entryCostOf(fill()));
    expect(position.entryPrice).toBeCloseTo(99_500_000 / 3_000_000_000, 15);
    expect(position.peakPrice).toBe(position.entryPrice);
    expect(position.openedAtMs).toBe(1_800);
    expect(position.openedSlot).toBe(12);
    expect(position.signalId).toBe(41);
    expect(position.riskScore).toBe(22);
    expect(orderKeyOf(position)).toBe("1000-mint");
    expect(position.migratedSeen).toBe(false);
    expect(position.meta.exit).toBeUndefined();
  });

  it("marks positions opened on migrated coins as already switched", () => {
    const position = openPositionFromFill(seed({ migrated: true }), fill());
    expect(position.migratedSeen).toBe(true);
    expect(position.meta.exit).toEqual({ liquidating: null, migratedSeenAtMs: 1_800 });
  });

  it("caps sells at the tokens held and zeroes the position on a closing fill", () => {
    const open = openPositionFromFill(seed(), fill());
    const oversold = applySellFill(open, { closesPosition: false }, fill({ side: "sell", tokenAmount: 9_000_000_000n, rentPaid: 0n }));
    expect(oversold.tokensHeld).toBe(0n);
    const partial = applySellFill(open, { closesPosition: false }, fill({ side: "sell", tokenAmount: 1_000_000_000n, rentPaid: 0n }));
    expect(partial.tokensHeld).toBe(2_000_000_000n);
    const closing = applySellFill(partial, { closesPosition: true }, fill({ side: "sell", tokenAmount: 1_999_000_000n, rentPaid: 0n }));
    expect(closing.tokensHeld).toBe(0n);
    const failed = applySellFill(partial, { closesPosition: true }, failedFill(order({ side: "sell" }), "tx_failed", [], "curve"));
    expect(failed.tokensHeld).toBe(2_000_000_000n);
  });

  it("builds a closed trade with pnl, hold time and peak multiple", () => {
    const open = { ...openPositionFromFill(seed(), fill()), proceeds: 150_000_000n, peakPrice: (99_500_000 / 3_000_000_000) * 2.5 };
    const closed = closePosition(open, 61_800, "trailing_stop");
    const trade = closedTradeOf(closed);
    expect(trade.pnl).toBe(150_000_000n - open.entryCost);
    expect(trade.holdSec).toBe(60);
    expect(trade.peakMultiple).toBeCloseTo(2.5, 9);
    expect(trade.exitReason).toBe("trailing_stop");
    expect(trade.fees).toBe(open.feesPaid);
  });

  it("books a failed entry as an already closed losing position", () => {
    const failed = failedFill(order(), "slippage_exceeded", [
      { atMs: 1, slot: 1, success: false, error: "slippage_exceeded", networkFee: 305_000n, tip: 0n }
    ], "curve");
    const position = failedEntryPosition(seed({ shadowOf: "live-1", mode: "shadow" }), failed);
    expect(position.status).toBe("closed");
    expect(position.exitReason).toBe(ENTRY_FAILED_REASON);
    expect(position.meta.entryError).toBe("slippage_exceeded");
    expect(position.shadowOf).toBe("live-1");
    const trade = closedTradeOf(position);
    expect(trade.pnl).toBe(-305_000n);
    expect(trade.peakMultiple).toBe(0);
    expect(trade.holdSec).toBe(0);
  });
});

describe("mark to market", () => {
  const open = (): Position => openPositionFromFill(seed(), fill());

  it("values tokens at the net sell quote of the current curve", () => {
    const value = liquidationValue(open(), view(), execution);
    const gross = (3_000_000_000n * 32_000_000_000n) / (1_000_000_000_000_000n + 3_000_000_000n);
    expect(value).toBeLessThan(gross);
    expect(value).toBeGreaterThan((gross * 98n) / 100n);
    expect(unrealizedPnlOf(open(), view(), execution)).toBe(value - open().entryCost);
  });

  it("falls back to the last price while the curve awaits migration or without a view", () => {
    const position = { ...open(), lastPrice: 4e-5 };
    expect(liquidationValue(position, view({ complete: true }), execution)).toBe(120_000n);
    expect(liquidationValue(position, null, execution)).toBe(120_000n);
    expect(liquidationValue({ ...position, tokensHeld: 0n }, view(), execution)).toBe(0n);
  });

  it("treats tiny remainders as dust only when the price is usable", () => {
    expect(isDust(0n, 0, 1_000n)).toBe(true);
    expect(isDust(10n, 3e-5, 1_000n)).toBe(true);
    expect(isDust(1_000_000_000n, 3e-5, 1_000n)).toBe(false);
    expect(isDust(10n, 0, 1_000n)).toBe(false);
  });

  it("closes synthetically at the curve quote with one network fee and the rent refund", () => {
    const position = open();
    const { order: closeOrder, fill: closeFill } = syntheticCloseFill(position, view(), 3.2e-5, execution, 9_000, "backtest_end", "key");
    expect(closeOrder.closesPosition).toBe(true);
    expect(closeOrder.tokenAmount).toBe(position.tokensHeld);
    expect(closeFill.success).toBe(true);
    expect(closeFill.error).toBe(SYNTHETIC_CLOSE_NOTE);
    expect(closeFill.networkFees).toBe(305_000n);
    expect(closeFill.rentRefunded).toBe(2_039_280n);
    expect(closeFill.userQuote).toBe(liquidationValue(position, view(), execution));
    const fallback = syntheticCloseFill(position, view({ complete: true }), 4e-5, execution, 9_000, "backtest_end", "key");
    expect(fallback.fill.quoteAmount).toBe(120_000n);
    expect(fallback.fill.userQuote).toBe(120_000n - (120_000n * 125n) / 10_000n);
  });
});

describe("ids", () => {
  it("derives run-scoped position ids from run-independent order keys", () => {
    const key = entryKey(MINT, 1_234.9);
    expect(key).toBe(`1234-${MINT}`);
    expect(positionIdFor(3, key)).toBe(`3-1234-${MINT}`);
    expect(shadowIdFor(positionIdFor(3, key))).toBe(`3-1234-${MINT}-shadow`);
    expect(shadowKeyFor(key)).toBe(`1234-${MINT}-shadow`);
  });

  it("counts fills per position starting at zero and falls back to the id for the order key", () => {
    const position = openPositionFromFill(seed(), fill());
    expect(fillSeqOf(position)).toBeNull();
    const first = withNextFillSeq(position);
    expect(fillSeqOf(first)).toBe(0);
    expect(fillSeqOf(withNextFillSeq(first))).toBe(1);
    expect(orderKeyOf({ id: "abc", meta: {} })).toBe("abc");
  });
});
