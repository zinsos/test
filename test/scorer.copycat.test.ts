import { describe, expect, it } from "vitest";
import { Bus } from "../src/core/bus.js";
import { SOL_QUOTE } from "../src/core/constants.js";
import type { LaunchCreatedEvent, TradeEvent } from "../src/core/types.js";
import { TrendingTracker } from "../src/scorer/copycat.js";
import { jaroWinkler, normalizeText } from "../src/scorer/text.js";
import { LaunchBuilder, PUMP_QUOTE_MINT, scorerConfig, SOL, T0 } from "./scorer.fixtures.js";

const config = scorerConfig();
const MINUTE = 60_000;

function tracker(overrides: Partial<ReturnType<typeof scorerConfig>["copycat"]> = {}): TrendingTracker {
  return new TrendingTracker({ config: scorerConfig({ copycat: { ...config.copycat, ...overrides } }) });
}

describe("text similarity", () => {
  it("normalizes case, punctuation, spacing and diacritics but keeps non-latin letters", () => {
    expect(normalizeText("Pump Squads")).toBe("pumpsquads");
    expect(normalizeText("$PUMP-SQUADS!")).toBe("pumpsquads");
    expect(normalizeText("Café Ñandú")).toBe("cafenandu");
    expect(normalizeText("龙 币")).toBe("龙币");
    expect(normalizeText("  ")).toBe("");
  });

  it("matches known Jaro-Winkler values", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 3);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 3);
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
    expect(jaroWinkler("", "")).toBe(1);
    expect(jaroWinkler("", "a")).toBe(0);
  });
});

describe("TrendingTracker", () => {
  it("keeps a rolling volume window", () => {
    const t = tracker({ trendingWindowMinutes: 10 });
    t.onCreate({ mint: "A", name: "Alpha", symbol: "ALP", createdAtMs: T0, quoteMint: SOL_QUOTE });
    t.onTrade("A", SOL, T0 + 1_000);
    t.onTrade("A", 2n * SOL, T0 + 5 * MINUTE);
    expect(t.rollingVolume("A", T0 + 6 * MINUTE)).toBe(3e9);
    expect(t.rollingVolume("A", T0 + 11 * MINUTE)).toBe(2e9);
    expect(t.rollingVolume("A", T0 + 30 * MINUTE)).toBe(0);
    t.onTrade("unknown", SOL, T0);
    expect(t.rollingVolume("unknown", T0)).toBe(0);
  });

  it("ranks top N per quote mint", () => {
    const t = tracker({ trendingTopN: 1 });
    t.onCreate({ mint: "S1", name: "Sol One", symbol: "S1", createdAtMs: T0, quoteMint: SOL_QUOTE });
    t.onCreate({ mint: "S2", name: "Sol Two", symbol: "S2", createdAtMs: T0, quoteMint: SOL_QUOTE });
    t.onCreate({ mint: "P1", name: "Pump One", symbol: "P1", createdAtMs: T0, quoteMint: PUMP_QUOTE_MINT });
    t.onTrade("S1", 5n * SOL, T0 + 1_000);
    t.onTrade("S2", SOL, T0 + 1_000);
    t.onTrade("P1", 1_000n, T0 + 1_000);
    const trending = t.trending(T0 + 2_000).map((entry) => entry.mint).sort();
    expect(trending).toEqual(["P1", "S1"]);
  });

  it("flags a later launch copying a trending older ticker and names the earliest as original", () => {
    const t = tracker();
    t.onCreate({ mint: "Squads1", name: "Pump Squads", symbol: "SQUADS", createdAtMs: T0, quoteMint: SOL_QUOTE });
    t.onCreate({ mint: "Squads2", name: "PUMP SQUADS", symbol: "squads", createdAtMs: T0 + MINUTE, quoteMint: SOL_QUOTE });
    t.onTrade("Squads1", 10n * SOL, T0 + 30_000);
    t.onTrade("Squads2", 20n * SOL, T0 + 90_000);
    const nowMs = T0 + 3 * MINUTE;
    const copy = t.isCopycat({ mint: "Squads3", name: "Pump Squads", symbol: "$SQUADS", createdAtMs: T0 + 2 * MINUTE }, nowMs);
    expect(copy.copycat).toBe(true);
    expect(copy.original).toBe("Squads1");
    expect(copy.similarity).toBe(1);
    expect(copy.sameTickerRecent).toBe(2);
    const first = t.isCopycat({ mint: "Squads1", name: "Pump Squads", symbol: "SQUADS", createdAtMs: T0 }, nowMs);
    expect(first.copycat).toBe(false);
    expect(first.sameTickerRecent).toBe(0);
  });

  it("matches similar names above the threshold and ignores short or dissimilar ones", () => {
    const t = tracker({ similarityThreshold: 0.85 });
    t.onCreate({ mint: "Moon", name: "Moon Dog Coin", symbol: "MDOG", createdAtMs: T0, quoteMint: SOL_QUOTE });
    t.onCreate({ mint: "Cat", name: "Cat", symbol: "C", createdAtMs: T0, quoteMint: SOL_QUOTE });
    t.onTrade("Moon", SOL, T0 + 1_000);
    t.onTrade("Cat", SOL, T0 + 1_000);
    const nowMs = T0 + MINUTE;
    const similar = t.isCopycat({ mint: "X", name: "MoonDog Coins", symbol: "MDC", createdAtMs: T0 + 10_000 }, nowMs);
    expect(similar.copycat).toBe(true);
    expect(similar.similarity).toBeGreaterThan(0.85);
    const different = t.isCopycat({ mint: "Y", name: "Solar Panel", symbol: "SUN", createdAtMs: T0 + 10_000 }, nowMs);
    expect(different.copycat).toBe(false);
    const short = t.isCopycat({ mint: "Z", name: "Car", symbol: "C", createdAtMs: T0 + 10_000 }, nowMs);
    expect(short.copycat).toBe(false);
    expect(short.similarity).toBe(0);
  });

  it("does not treat newer or quiet coins as originals", () => {
    const t = tracker({ trendingWindowMinutes: 5 });
    t.onCreate({ mint: "Old", name: "Quiet Coin", symbol: "QUIET", createdAtMs: T0, quoteMint: SOL_QUOTE });
    t.onTrade("Old", SOL, T0 + 1_000);
    t.onCreate({ mint: "Newer", name: "Fresh Thing", symbol: "FRESH", createdAtMs: T0 + 2 * MINUTE, quoteMint: SOL_QUOTE });
    t.onTrade("Newer", SOL, T0 + 2 * MINUTE);
    const later = T0 + 20 * MINUTE;
    expect(t.isCopycat({ mint: "C1", name: "Quiet Coin", symbol: "QUIET", createdAtMs: later - 1_000 }, later).copycat).toBe(false);
    expect(
      t.isCopycat({ mint: "C2", name: "Fresh Thing", symbol: "FRESH", createdAtMs: T0 + MINUTE }, T0 + 3 * MINUTE).copycat
    ).toBe(false);
  });

  it("attaches to the bus and follows create and trade events", () => {
    const bus = new Bus();
    const t = tracker();
    const detach = t.attach(bus);
    const create: LaunchCreatedEvent = {
      kind: "create",
      tx: { signature: "c", slot: 1, seq: 0, eventIndex: 0, receivedAtMs: T0 },
      mint: "BusMint",
      bondingCurve: "curve",
      devWallet: "dev",
      creator: "dev",
      name: "Bus Coin",
      symbol: "BUS",
      uri: "",
      timestampMs: T0,
      virtualTokenReserves: 1n,
      virtualQuoteReserves: 1n,
      realTokenReserves: 1n,
      tokenTotalSupply: 1n,
      tokenProgram: null,
      quoteMint: SOL_QUOTE,
      isMayhemMode: false,
      isCashback: false,
      isHolderReward: false,
      creatorFeeBps: 0,
      depth: 0
    };
    bus.emit("chain", create);
    const trade = {
      kind: "trade",
      tx: { signature: "t", slot: 2, seq: 1, eventIndex: 0, receivedAtMs: T0 + 1_000 },
      venue: "curve",
      mint: "BusMint",
      quoteAmount: 3n * SOL,
      timestampMs: T0 + 1_000
    } as unknown as TradeEvent;
    bus.emit("chain", trade);
    expect(t.rollingVolume("BusMint", T0 + 2_000)).toBe(3e9);
    detach();
    bus.emit("chain", trade);
    expect(t.rollingVolume("BusMint", T0 + 2_000)).toBe(3e9);
  });

  it("bounds memory by evicting inactive old mints", () => {
    const t = new TrendingTracker({ config, maxMints: 10 });
    for (let index = 0; index < 50; index += 1) {
      t.onCreate({ mint: `M${index}`, name: `Coin ${index}`, symbol: `C${index}`, createdAtMs: T0 + index * 10 * MINUTE, quoteMint: SOL_QUOTE });
    }
    expect(t.size).toBeLessThanOrEqual(11);
  });
});

describe("TrendingTracker with launch state", () => {
  it("accepts a LaunchState directly", () => {
    const t = tracker();
    t.onCreate({ mint: "Orig", name: "Doge Moon", symbol: "DMOON", createdAtMs: T0 - MINUTE, quoteMint: SOL_QUOTE });
    t.onTrade("Orig", SOL, T0 - 30_000);
    const builder = new LaunchBuilder({ mint: "Copy", name: "Doge Moon", symbol: "dmoon", createdAtMs: T0 });
    const result = t.isCopycat(builder.launch, T0 + 10_000);
    expect(result).toEqual({ copycat: true, similarity: 1, original: "Orig", sameTickerRecent: 1 });
  });
});
