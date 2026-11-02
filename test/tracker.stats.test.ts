import { describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { wilsonLowerBound } from "../src/core/stats.js";
import { closeLedger } from "../src/tracker/roundtrips.js";
import {
  compositeWalletScore,
  confidenceAdjustedEdge,
  DEFAULT_SCORE_WEIGHTS,
  exclusionReasons,
  exclusionRulesFrom
} from "../src/tracker/scoring.js";
import { computeWindowStats, emptyWindowStats, statsToJson } from "../src/tracker/stats.js";
import { EMPTY_WALLET_FACTS, type RoundTrip, type WalletFacts, type WindowStats } from "../src/tracker/types.js";

const SOL = 1_000_000_000n;
const DAY = 86_400_000;
const ASOF = Date.UTC(2026, 9, 20);
const SHORT = { fromMs: ASOF - 30 * DAY, toMs: ASOF };
const LONG = { fromMs: ASOF - 90 * DAY, toMs: ASOF };

interface TripSpec {
  mint?: string;
  closedDaysAgo: number;
  costSol?: number;
  pnlSol: number;
  holdSec?: number;
  entryDelaySec?: number | null;
  creationSlotEntry?: boolean | null;
  writtenOff?: boolean;
}

let counter = 0;

function lamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

function trip(spec: TripSpec): RoundTrip {
  counter += 1;
  const closedAtMs = ASOF - spec.closedDaysAgo * DAY;
  const holdMs = (spec.holdSec ?? 300) * 1000;
  const cost = lamports(spec.costSol ?? 1);
  return closeLedger(
    {
      wallet: "W",
      mint: spec.mint ?? `M${counter}`,
      openedAtMs: closedAtMs - holdMs,
      openedSlot: 1,
      lastTradeAtMs: closedAtMs,
      cost,
      proceeds: cost + lamports(spec.pnlSol),
      tokensBought: 100n,
      tokensSold: 100n,
      buys: 1,
      sells: 1,
      entryDelaySec: spec.entryDelaySec === undefined ? 30 : spec.entryDelaySec,
      creationSlotEntry: spec.creationSlotEntry === undefined ? false : spec.creationSlotEntry
    },
    closedAtMs,
    spec.writtenOff ? "written_off" : "sold"
  );
}

function facts(overrides: Partial<WalletFacts> = {}): WalletFacts {
  return { ...EMPTY_WALLET_FACTS, ...overrides };
}

const RULES = exclusionRulesFrom(defaultStrategyConfig().tracker);

function goodTrips(count: number, startDaysAgo = 1): RoundTrip[] {
  return Array.from({ length: count }, (_, index) =>
    trip({ closedDaysAgo: startDaysAgo + (index % 25), pnlSol: index % 3 === 2 ? -0.3 : 0.6, holdSec: 600 })
  );
}

describe("computeWindowStats", () => {
  it("summarises only round trips closed inside the window", () => {
    const trips = [
      trip({ closedDaysAgo: 1, pnlSol: 1, holdSec: 100, entryDelaySec: 10, creationSlotEntry: true }),
      trip({ closedDaysAgo: 2, pnlSol: -0.5, holdSec: 200, entryDelaySec: 20 }),
      trip({ closedDaysAgo: 3, pnlSol: 2, holdSec: 300, entryDelaySec: null, creationSlotEntry: null, writtenOff: true }),
      trip({ closedDaysAgo: 40, pnlSol: 50 }),
      trip({ closedDaysAgo: -1, pnlSol: 99 })
    ];
    const stats = computeWindowStats(trips, SHORT);
    expect(stats.closed).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.writeOffs).toBe(1);
    expect(stats.winRate).toBeCloseTo(2 / 3, 10);
    expect(stats.winRateLower).toBeCloseTo(wilsonLowerBound(2, 3), 10);
    expect(stats.realizedPnlSol).toBeCloseTo(2.5, 9);
    expect(stats.grossProfitSol).toBeCloseTo(3, 9);
    expect(stats.grossLossSol).toBeCloseTo(0.5, 9);
    expect(stats.profitFactor).toBeCloseTo(6, 9);
    expect(stats.bestTradeSol).toBeCloseTo(2, 9);
    expect(stats.pnlExBestSol).toBeCloseTo(0.5, 9);
    expect(stats.medianWinSol).toBeCloseTo(1.5, 9);
    expect(stats.medianLossSol).toBeCloseTo(-0.5, 9);
    expect(stats.medianWinPct).toBeCloseTo(150, 9);
    expect(stats.medianLossPct).toBeCloseTo(-50, 9);
    expect(stats.medianHoldSec).toBe(200);
    expect(stats.medianEntryDelaySec).toBe(15);
    expect(stats.creationSlotEntryRate).toBeCloseTo(0.5, 10);
    expect(stats.totalCostSol).toBeCloseTo(3, 9);
    expect(stats.roiPct).toBeCloseTo((2.5 / 3) * 100, 9);
    expect(stats.distinctMints).toBe(3);
  });

  it("handles empty windows and loss-free windows", () => {
    const empty = emptyWindowStats(SHORT);
    expect(empty.closed).toBe(0);
    expect(empty.winRate).toBeNull();
    expect(empty.winRateLower).toBe(0);
    expect(empty.profitFactor).toBeNull();
    expect(empty.medianHoldSec).toBeNull();
    expect(empty.creationSlotEntryRate).toBeNull();
    const lossFree = computeWindowStats([trip({ closedDaysAgo: 1, pnlSol: 1 })], SHORT);
    expect(lossFree.profitFactor).toBe(Number.POSITIVE_INFINITY);
    expect(statsToJson(lossFree).profitFactor).toBeNull();
    expect(lossFree.pnlExBestSol).toBe(0);
  });

  it("includes the window start and excludes the window end", () => {
    const atStart = trip({ closedDaysAgo: 30, pnlSol: 1 });
    const atEnd = trip({ closedDaysAgo: 0, pnlSol: 1 });
    expect(computeWindowStats([atStart, atEnd], SHORT).closed).toBe(1);
  });
});

describe("composite wallet score", () => {
  it("is zero without positive realized pnl", () => {
    expect(confidenceAdjustedEdge(emptyWindowStats(SHORT), DEFAULT_SCORE_WEIGHTS)).toBe(0);
    const losing = computeWindowStats([trip({ closedDaysAgo: 1, pnlSol: -1 })], SHORT);
    expect(confidenceAdjustedEdge(losing, DEFAULT_SCORE_WEIGHTS)).toBe(0);
  });

  it("ranks a consistent wallet above a lucky one-hit wallet with more pnl", () => {
    const consistent = goodTrips(30);
    const lucky = [
      trip({ closedDaysAgo: 2, pnlSol: 20 }),
      ...Array.from({ length: 9 }, (_, index) => trip({ closedDaysAgo: 3 + index, pnlSol: -0.5 }))
    ];
    const consistentScore = compositeWalletScore(computeWindowStats(consistent, SHORT), computeWindowStats(consistent, LONG));
    const luckyShort = computeWindowStats(lucky, SHORT);
    const luckyScore = compositeWalletScore(luckyShort, computeWindowStats(lucky, LONG));
    expect(luckyShort.realizedPnlSol).toBeGreaterThan(computeWindowStats(consistent, SHORT).realizedPnlSol);
    expect(consistentScore).toBeGreaterThan(luckyScore);
  });

  it("caps the profit factor so loss-free streaks do not explode", () => {
    const perfect = computeWindowStats(
      Array.from({ length: 10 }, (_, index) => trip({ closedDaysAgo: 1 + index, pnlSol: 0.5 })),
      SHORT
    );
    const expected = perfect.winRateLower * DEFAULT_SCORE_WEIGHTS.profitFactorCap * Math.log1p(perfect.pnlExBestSol);
    expect(confidenceAdjustedEdge(perfect, DEFAULT_SCORE_WEIGHTS)).toBeCloseTo(expected, 10);
  });

  it("sizes the edge by pnl without the best trade so one big hit plus dust cannot outrank steady profit", () => {
    const lottery = [
      trip({ closedDaysAgo: 2, pnlSol: 100 }),
      trip({ closedDaysAgo: 3, pnlSol: -0.05 }),
      ...Array.from({ length: 13 }, (_, index) => trip({ closedDaysAgo: 5 + index, pnlSol: 0.01 }))
    ];
    const steady = Array.from({ length: 60 }, (_, index) => trip({ closedDaysAgo: 1 + (index % 28), pnlSol: index % 3 === 2 ? -0.5 : 1 }));
    const lotteryShort = computeWindowStats(lottery, SHORT);
    const lotteryScore = compositeWalletScore(lotteryShort, computeWindowStats(lottery, LONG));
    const steadyScore = compositeWalletScore(computeWindowStats(steady, SHORT), computeWindowStats(steady, LONG));
    expect(lotteryShort.pnlExBestSol).toBeGreaterThan(0);
    expect(lotteryShort.realizedPnlSol).toBeGreaterThan(computeWindowStats(steady, SHORT).realizedPnlSol);
    expect(steadyScore).toBeGreaterThan(5 * lotteryScore);
  });

  it("weights the recent window above the long window", () => {
    const recent = goodTrips(20, 1);
    const old = goodTrips(20, 45);
    const recentScore = compositeWalletScore(computeWindowStats(recent, SHORT), computeWindowStats(recent, LONG));
    const oldScore = compositeWalletScore(computeWindowStats(old, SHORT), computeWindowStats(old, LONG));
    expect(recentScore).toBeGreaterThan(oldScore);
    expect(oldScore).toBeGreaterThan(0);
  });
});

describe("exclusion reasons", () => {
  const evaluate = (trips: RoundTrip[], walletFacts: WalletFacts = facts()): string[] =>
    exclusionReasons(computeWindowStats(trips, SHORT), computeWindowStats(trips, LONG), walletFacts, RULES);

  it("accepts a consistent profitable wallet", () => {
    expect(evaluate(goodTrips(30))).toEqual([]);
  });

  it("requires minimum trades in both windows", () => {
    expect(evaluate(goodTrips(7))).toContain("min_trades");
    const recentOnlyFew = [...goodTrips(5, 1), ...goodTrips(20, 40)];
    expect(evaluate(recentOnlyFew)).toContain("min_trades");
  });

  it("flags non-positive pnl in either window and one-hit wonders", () => {
    const losing = Array.from({ length: 20 }, (_, index) => trip({ closedDaysAgo: 1 + index, pnlSol: index % 2 ? 0.1 : -0.2 }));
    expect(evaluate(losing)).toContain("non_positive_pnl");
    const oneHit = [
      trip({ closedDaysAgo: 1, pnlSol: 30 }),
      ...Array.from({ length: 19 }, (_, index) => trip({ closedDaysAgo: 2 + index, pnlSol: -0.5 }))
    ];
    expect(evaluate(oneHit)).toEqual(["one_hit"]);
    const oldLosses = [...goodTrips(20, 1), ...Array.from({ length: 20 }, (_, index) => trip({ closedDaysAgo: 40 + index, pnlSol: -3 }))];
    expect(evaluate(oldLosses)).toContain("non_positive_pnl");
  });

  it("flags snipers, bundle entries, fast flippers and late entries", () => {
    const sniper = goodTrips(30).map((item) => ({ ...item, entryDelaySec: 1 }));
    expect(evaluate(sniper)).toContain("sniper");
    const bundler = goodTrips(30).map((item, index) => ({ ...item, creationSlotEntry: index % 2 === 0 }));
    expect(evaluate(bundler)).toContain("bundle_entries");
    const flipper = goodTrips(30).map((item) => ({ ...item, holdSec: 10 }));
    expect(evaluate(flipper)).toEqual(["too_fast"]);
    const late = goodTrips(30).map((item) => ({ ...item, entryDelaySec: 7_200 }));
    expect(evaluate(late)).toEqual(["late_entries"]);
  });

  it("skips entry checks when launch creation data is unknown", () => {
    const unknown = goodTrips(30).map((item) => ({ ...item, entryDelaySec: null, creationSlotEntry: null }));
    expect(evaluate(unknown)).toEqual([]);
  });

  it("flags dev links, insiders and known entities, and orders reasons by priority", () => {
    expect(evaluate(goodTrips(30), facts({ devLinked: true }))).toEqual(["dev_linked"]);
    expect(evaluate(goodTrips(30), facts({ devFunded: true, devFunder: true }))).toEqual(["dev_funded", "dev_funder"]);
    expect(evaluate(goodTrips(30), facts({ knownEntityKind: "bot", devLinked: true }))).toEqual(["known_entity", "dev_linked"]);
    expect(evaluate(goodTrips(30), facts({ knownEntityKind: "smart_money" }))).toEqual([]);
    expect(evaluate(goodTrips(30), facts({ insiderLaunches: 10 }))).toEqual(["bundle_insider"]);
    expect(evaluate(goodTrips(30), facts({ insiderLaunches: 1 }))).toEqual([]);
    expect(evaluate(goodTrips(30), facts({ tooActive: true }))).toEqual(["too_active"]);
  });

  it("honours excludeDevLinked = false", () => {
    const relaxed = exclusionRulesFrom({ ...defaultStrategyConfig().tracker, excludeDevLinked: false });
    const stats = computeWindowStats(goodTrips(30), SHORT);
    const long: WindowStats = computeWindowStats(goodTrips(30), LONG);
    expect(exclusionReasons(stats, long, facts({ devLinked: true, devFunded: true }), relaxed)).toEqual([]);
  });
});
