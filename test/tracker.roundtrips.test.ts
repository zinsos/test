import { describe, expect, it } from "vitest";
import { buildRoundTrips, compareTrades, groupTradesByWallet } from "../src/tracker/roundtrips.js";
import type { MintContext, WalletTrade } from "../src/tracker/types.js";

const SOL = 1_000_000_000n;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const SEC = 1_000;

let sequence = 0;

function trade(overrides: Partial<WalletTrade> & Pick<WalletTrade, "mint" | "isBuy" | "atMs">): WalletTrade {
  sequence += 1;
  return {
    wallet: "W",
    signature: `sig${sequence}`,
    eventIndex: 0,
    slot: 1_000 + Math.floor((overrides.atMs - T0) / 400),
    seq: sequence,
    venue: "curve",
    tokenAmount: 1_000_000n,
    userQuote: SOL,
    quoteMint: "SOL",
    ...overrides
  };
}

function contexts(entries: Record<string, Partial<MintContext>>): Map<string, MintContext> {
  return new Map(
    Object.entries(entries).map(([mint, context]) => [
      mint,
      { createdAtMs: null, createdSlot: null, deadAtMs: null, ...context }
    ])
  );
}

const ASOF = T0 + 10 * 86_400_000;

describe("buildRoundTrips", () => {
  it("opens at the first buy and closes once 99% of tokens are sold", () => {
    const result = buildRoundTrips(
      [
        trade({ mint: "A", isBuy: true, atMs: T0, tokenAmount: 1_000n, userQuote: SOL }),
        trade({ mint: "A", isBuy: true, atMs: T0 + 10 * SEC, tokenAmount: 1_000n, userQuote: SOL }),
        trade({ mint: "A", isBuy: false, atMs: T0 + 60 * SEC, tokenAmount: 1_000n, userQuote: 2n * SOL }),
        trade({ mint: "A", isBuy: false, atMs: T0 + 120 * SEC, tokenAmount: 980n, userQuote: SOL })
      ],
      { asOfMs: ASOF, mints: contexts({ A: { createdAtMs: T0 - 30 * SEC, createdSlot: 900 } }), bundleSlotWindow: 1 }
    );
    expect(result.open).toHaveLength(0);
    expect(result.closed).toHaveLength(1);
    const trip = result.closed[0];
    expect(trip?.cost).toBe(2n * SOL);
    expect(trip?.proceeds).toBe(3n * SOL);
    expect(trip?.pnl).toBe(SOL);
    expect(trip?.returnPct).toBeCloseTo(50, 10);
    expect(trip?.holdSec).toBe(120);
    expect(trip?.entryDelaySec).toBe(30);
    expect(trip?.creationSlotEntry).toBe(false);
    expect(trip?.closeKind).toBe("sold");
    expect(trip?.buys).toBe(2);
    expect(trip?.sells).toBe(2);
  });

  it("keeps a partially sold position open when below the close threshold", () => {
    const result = buildRoundTrips(
      [
        trade({ mint: "A", isBuy: true, atMs: T0, tokenAmount: 1_000n }),
        trade({ mint: "A", isBuy: false, atMs: T0 + SEC, tokenAmount: 500n, userQuote: 3n * SOL })
      ],
      { asOfMs: ASOF, mints: new Map(), bundleSlotWindow: 1 }
    );
    expect(result.closed).toHaveLength(0);
    expect(result.open).toHaveLength(1);
    expect(result.open[0]?.proceeds).toBe(3n * SOL);
    expect(result.open[0]?.tokensSold).toBe(500n);
  });

  it("writes off the remainder of a dead mint at the time the outcome became known", () => {
    const deadAt = T0 + 30 * 60 * SEC;
    const result = buildRoundTrips(
      [
        trade({ mint: "R", isBuy: true, atMs: T0, tokenAmount: 1_000n, userQuote: 2n * SOL }),
        trade({ mint: "R", isBuy: false, atMs: T0 + 60 * SEC, tokenAmount: 400n, userQuote: SOL / 2n })
      ],
      { asOfMs: ASOF, mints: contexts({ R: { deadAtMs: deadAt } }), bundleSlotWindow: 1 }
    );
    expect(result.open).toHaveLength(0);
    const trip = result.closed[0];
    expect(trip?.closeKind).toBe("written_off");
    expect(trip?.closedAtMs).toBe(deadAt);
    expect(trip?.pnl).toBe(SOL / 2n - 2n * SOL);
    expect(trip?.returnPct).toBeCloseTo(-75, 10);
    expect(trip?.holdSec).toBe(1_800);
  });

  it("does not write off when the death became known at or after as-of", () => {
    const result = buildRoundTrips([trade({ mint: "R", isBuy: true, atMs: T0 })], {
      asOfMs: ASOF,
      mints: contexts({ R: { deadAtMs: ASOF } }),
      bundleSlotWindow: 1
    });
    expect(result.closed).toHaveLength(0);
    expect(result.open).toHaveLength(1);
  });

  it("writes off at the last trade when the wallet kept trading after the death label", () => {
    const deadAt = T0 + 60 * SEC;
    const result = buildRoundTrips(
      [
        trade({ mint: "R", isBuy: true, atMs: T0, tokenAmount: 1_000n }),
        trade({ mint: "R", isBuy: false, atMs: T0 + 120 * SEC, tokenAmount: 100n, userQuote: SOL / 10n })
      ],
      { asOfMs: ASOF, mints: contexts({ R: { deadAtMs: deadAt } }), bundleSlotWindow: 1 }
    );
    expect(result.closed[0]?.closedAtMs).toBe(T0 + 120 * SEC);
    expect(result.closed[0]?.proceeds).toBe(SOL / 10n);
  });

  it("excludes non-SOL quoted trades and anything at or after as-of", () => {
    const result = buildRoundTrips(
      [
        trade({ mint: "P", isBuy: true, atMs: T0, quoteMint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn" }),
        trade({ mint: "P", isBuy: false, atMs: T0 + SEC, quoteMint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn" }),
        trade({ mint: "A", isBuy: true, atMs: ASOF - SEC }),
        trade({ mint: "A", isBuy: false, atMs: ASOF, userQuote: 100n * SOL })
      ],
      { asOfMs: ASOF, mints: new Map(), bundleSlotWindow: 1 }
    );
    expect(result.ignoredNonSol).toBe(2);
    expect(result.ignoredAfterAsOf).toBe(1);
    expect(result.closed).toHaveLength(0);
    expect(result.open.map((position) => position.mint)).toEqual(["A"]);
  });

  it("ignores sells without a position and caps proceeds for tokens not bought", () => {
    const result = buildRoundTrips(
      [
        trade({ mint: "A", isBuy: false, atMs: T0 - SEC, tokenAmount: 1_000n, userQuote: 9n * SOL }),
        trade({ mint: "A", isBuy: true, atMs: T0, tokenAmount: 1_000n, userQuote: SOL }),
        trade({ mint: "A", isBuy: false, atMs: T0 + SEC, tokenAmount: 2_000n, userQuote: 4n * SOL })
      ],
      { asOfMs: ASOF, mints: new Map(), bundleSlotWindow: 1 }
    );
    expect(result.orphanSells).toBe(1);
    expect(result.closed).toHaveLength(1);
    expect(result.closed[0]?.proceeds).toBe(2n * SOL);
    expect(result.closed[0]?.pnl).toBe(SOL);
  });

  it("starts a new round trip after a close and flags creation-slot entries", () => {
    const mints = contexts({ A: { createdAtMs: T0, createdSlot: 1_000 } });
    const result = buildRoundTrips(
      [
        trade({ mint: "A", isBuy: true, atMs: T0, slot: 1_001, tokenAmount: 100n }),
        trade({ mint: "A", isBuy: false, atMs: T0 + 5 * SEC, slot: 1_012, tokenAmount: 100n, userQuote: 2n * SOL }),
        trade({ mint: "A", isBuy: true, atMs: T0 + 50 * SEC, slot: 1_125, tokenAmount: 100n }),
        trade({ mint: "A", isBuy: false, atMs: T0 + 90 * SEC, slot: 1_225, tokenAmount: 100n, userQuote: SOL / 2n })
      ],
      { asOfMs: ASOF, mints, bundleSlotWindow: 1 }
    );
    expect(result.closed.map((trip) => trip.creationSlotEntry)).toEqual([true, false]);
    expect(result.closed.map((trip) => trip.entryDelaySec)).toEqual([0, 50]);
    expect(result.closed.map((trip) => trip.pnl)).toEqual([SOL, -SOL / 2n]);
  });

  it("orders trades by slot then time regardless of input order", () => {
    const sell = trade({ mint: "A", isBuy: false, atMs: T0 + 10 * SEC, slot: 2_000, tokenAmount: 100n, userQuote: 2n * SOL });
    const buy = trade({ mint: "A", isBuy: true, atMs: T0, slot: 1_000, tokenAmount: 100n });
    const result = buildRoundTrips([sell, buy], { asOfMs: ASOF, mints: new Map(), bundleSlotWindow: 1 });
    expect(result.closed).toHaveLength(1);
    expect(compareTrades(buy, sell)).toBeLessThan(0);
  });

  it("returns null entry facts when the launch is unknown and handles a custom close fraction", () => {
    const result = buildRoundTrips(
      [
        trade({ mint: "X", isBuy: true, atMs: T0, tokenAmount: 1_000n }),
        trade({ mint: "X", isBuy: false, atMs: T0 + SEC, tokenAmount: 900n, userQuote: 2n * SOL })
      ],
      { asOfMs: ASOF, mints: () => undefined, bundleSlotWindow: 1, closeFraction: 0.9 }
    );
    expect(result.closed[0]?.entryDelaySec).toBeNull();
    expect(result.closed[0]?.creationSlotEntry).toBeNull();
  });

  it("separates wallets and mints", () => {
    const trades = [
      trade({ wallet: "W1", mint: "A", isBuy: true, atMs: T0 }),
      trade({ wallet: "W2", mint: "A", isBuy: true, atMs: T0 }),
      trade({ wallet: "W1", mint: "B", isBuy: true, atMs: T0 })
    ];
    const grouped = groupTradesByWallet(trades);
    expect(grouped.get("W1")).toHaveLength(2);
    expect(grouped.get("W2")).toHaveLength(1);
    const combined = buildRoundTrips(trades, { asOfMs: ASOF, mints: new Map(), bundleSlotWindow: 1 });
    expect(combined.open).toHaveLength(3);
  });
});
