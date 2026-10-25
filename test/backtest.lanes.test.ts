import { describe, expect, it } from "vitest";
import { cohortGroupKey, groupCohortLanes, hardBlockRescorer } from "../src/backtest/cohort.js";
import { ScopedClock } from "../src/backtest/laneClock.js";
import { evictableAt, evictionWindowOf, LaneMarket } from "../src/backtest/laneMarket.js";
import { CohortScoring, DevCacheEmulator, devHistoryKey, devHistoryWallets, LaneScoring } from "../src/backtest/laneScoring.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import { createRng, type Rng } from "../src/core/rng.js";
import type { LaunchCreatedEvent, LaunchScore, TradeEvent } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import { MarketState } from "../src/market/state.js";
import { TrendingTracker } from "../src/scorer/copycat.js";
import { DevHistoryService } from "../src/scorer/devHistory.js";
import { softFlags } from "../src/scorer/features.js";
import { ScoringModel } from "../src/scorer/model.js";
import type { CopycatSubject, StoredFeatures } from "../src/scorer/types.js";

const MINUTE_MS = 60_000;
const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
const NAMES = ["Moon Cat", "Moon Cats", "Doge King", "Pepe Gold", "Frog Coin", "Moon Kat", "Cat Moon", "Gold Frog"];

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) {
    throw new Error("empty choice");
  }
  return item;
}

const SYLLABLES = ["ka", "zu", "mi", "ro", "te", "pa", "xi", "nu", "fe", "go", "ba", "qu"];

function subjectOf(index: number, rng: Rng, atMs: number): CopycatSubject {
  const name = rng() < 0.3 ? pick(rng, NAMES) : `${pick(rng, SYLLABLES)}${pick(rng, SYLLABLES)}${pick(rng, SYLLABLES)} ${pick(rng, SYLLABLES)}`;
  return { mint: `Mint${index}`, name, symbol: name.replace(/ /g, "").slice(0, 4).toUpperCase(), createdAtMs: atMs };
}

function scoreAt(mint: string, atMs: number): LaunchScore {
  return {
    mint,
    launchId: null,
    checkpointSec: 10,
    computedAtMs: atMs,
    slot: 0,
    score: 0,
    hardBlocked: false,
    flags: [],
    features: {},
    contributions: {},
    weightsVersion: "test"
  };
}

describe("cohort copycat trending emulation", () => {
  for (const seed of ["copycat-a", "copycat-b", "copycat-c", "copycat-d", "copycat-e", "copycat-f", "copycat-g", "copycat-h"]) {
    it(`gives each lane the copycat results of its own standalone tracker (${seed})`, () => {
      const rng = createRng(seed);
      const config = defaultStrategyConfig().scorer;
      config.copycat.trendingTopN = 3;
      const shared = new TrendingTracker({ config });
      const scratch = new TrendingTracker({ config });
      const laneCount = 3;
      const references = Array.from({ length: laneCount }, () => new TrendingTracker({ config }));
      const clock = new VirtualClock(T0);
      const market = new MarketState({ maxTradesPerLaunch: 100, evictInactiveMs: MINUTE_MS, evictMaxAgeMs: MINUTE_MS, quoteMints: null });
      const copycatStored = (mint: string): StoredFeatures | null =>
        Number(mint.slice(4)) % 2 === 0 ? { features: { copycat: 0, copycat_similarity: 0, same_ticker_recent: 0 }, computedAtMs: T0 } : null;
      const cohort = new CohortScoring({ db: null, market, shared, scratch, stored: copycatStored });
      const lanes = references.map(
        () =>
          new LaneScoring({
            cohort,
            market: new LaneMarket(market, clock),
            clock,
            bus: new Bus(),
            config,
            model: ScoringModel.default(),
            stored: () => null
          })
      );
      const created: CopycatSubject[] = [];
      let atMs = T0;
      let compared = 0;
      let adhoc = 0;
      let touched = 0;
      for (let step = 0; step < 3_000; step += 1) {
        atMs += Math.floor(rng() * 4_000);
        const roll = rng();
        if (roll < 0.15 || created.length === 0) {
          const subject = subjectOf(created.length, rng, atMs);
          created.push(subject);
          for (const tracker of [shared, scratch, ...references]) {
            tracker.onCreate({ ...subject, quoteMint: "SOL" });
          }
          cohort.eventApplied();
        } else if (roll < 0.55) {
          const subject = pick(rng, created);
          const amount = BigInt(1 + Math.floor(rng() * 5_000_000_000));
          for (const tracker of [shared, scratch, ...references]) {
            tracker.onTrade(subject.mint, amount, atMs);
          }
          cohort.eventApplied();
        } else if (roll < 0.92) {
          const subject = pick(rng, created);
          const consumed = copycatStored(subject.mint) === null;
          const result = consumed ? shared.isCopycat(subject, atMs) : null;
          if (!consumed) {
            shared.touch(subject, atMs);
          }
          cohort.onCheckpoint(scoreAt(subject.mint, atMs));
          references.forEach((reference, index) => {
            if (!consumed) {
              reference.touch(subject, atMs);
              return;
            }
            const expected = reference.isCopycat(subject, atMs);
            if (lanes[index]?.active()) {
              expect(result).toEqual(expected);
              compared += 1;
            }
          });
        } else {
          const index = Math.floor(rng() * laneCount);
          const lane = lanes[index];
          const reference = references[index];
          const subject = pick(rng, created);
          if (lane && reference) {
            if (rng() < 0.4) {
              cohort.copycatFor(lane, subject, atMs, false);
              reference.touch(subject, atMs);
              touched += 1;
            } else {
              const result = cohort.copycatFor(lane, subject, atMs);
              const expected = reference.isCopycat(subject, atMs);
              if (lane.active()) {
                expect(result).toEqual(expected);
                compared += 1;
                adhoc += 1;
              }
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(300);
      expect(adhoc).toBeGreaterThan(30);
      expect(touched).toBeGreaterThan(20);
      expect(lanes.filter((lane) => lane.active()).length).toBeGreaterThanOrEqual(1);
    });
  }
});

class CountingDb {
  queries = 0;
  query(_sql: string, params: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries += 1;
    const asOf = params[1] instanceof Date ? params[1].getTime() : 0;
    return Promise.resolve({
      rows: [{ launch_count: asOf % 7, outcome_count: 0, rugged_count: 0, migrated_count: 0, median_peak_multiple: null }]
    });
  }
}

describe("cohort dev history cache emulation", () => {
  it("hits and misses exactly like the scorer's dev history cache", async () => {
    const rng = createRng("dev-cache");
    const fake = new CountingDb();
    const service = new DevHistoryService({ db: fake as unknown as Db });
    const emulator = new DevCacheEmulator();
    let atMs = T0;
    const devs = ["DevA", "DevB", "DevC", ""];
    for (let step = 0; step < 600; step += 1) {
      atMs += Math.floor(rng() * 40_000);
      const wallets = [pick(rng, devs), pick(rng, devs)];
      const mint = pick(rng, ["MintA", "MintB"]);
      const before = fake.queries;
      const summary = await service.lookup(wallets, atMs, mint);
      const queried = fake.queries > before;
      const normalized = devHistoryWallets(wallets);
      if (normalized.length === 0) {
        expect(queried).toBe(false);
        continue;
      }
      const key = devHistoryKey(normalized, mint);
      const hit = emulator.hit(key, atMs);
      expect(hit === null).toBe(queried);
      if (hit) {
        expect(hit.summary).toEqual(summary);
      } else {
        emulator.store(key, { asOfMs: atMs, summary });
      }
    }
    expect(fake.queries).toBeGreaterThan(50);
  });
});

describe("cohort lane helpers", () => {
  it("decides evictable launches exactly like MarketState.evict", () => {
    const rng = createRng("evict");
    const memory = { ...defaultStrategyConfig().recorder.memory, evictInactiveMinutes: 3, evictMaxAgeHours: 1 };
    const window = evictionWindowOf(memory);
    const market = new MarketState({ maxTradesPerLaunch: 10, evictInactiveMs: window.inactiveMs, evictMaxAgeMs: window.maxAgeMs, quoteMints: null });
    for (let index = 0; index < 200; index += 1) {
      const createdAtMs = T0 + Math.floor(rng() * 2 * 3_600_000);
      const create = {
        kind: "create",
        tx: { signature: `c${index}`, slot: index, seq: 0, eventIndex: 0, receivedAtMs: createdAtMs },
        mint: `Evict${index}`,
        bondingCurve: `Curve${index}`,
        devWallet: "Dev",
        creator: "Dev",
        name: "x",
        symbol: "X",
        uri: "",
        timestampMs: createdAtMs,
        virtualTokenReserves: 1_073_000_000_000_000n,
        virtualQuoteReserves: 30_000_000_000n,
        realTokenReserves: 793_100_000_000_000n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        tokenProgram: null,
        quoteMint: "SOL",
        isMayhemMode: false,
        isCashback: false,
        isHolderReward: false,
        creatorFeeBps: 30,
        depth: 0
      } satisfies LaunchCreatedEvent;
      market.apply(create);
      if (rng() < 0.6) {
        const tradeAtMs = createdAtMs + Math.floor(rng() * 30 * MINUTE_MS);
        const trade = {
          kind: "trade",
          tx: { signature: `t${index}`, slot: index + 1, seq: 1, eventIndex: 0, receivedAtMs: tradeAtMs },
          venue: "curve",
          mint: create.mint,
          pool: null,
          wallet: "Buyer",
          isBuy: true,
          tokenAmount: 1_000_000n,
          quoteAmount: 1_000n,
          userQuote: 1_000n,
          protocolFee: 0n,
          creatorFee: 0n,
          lpFee: 0n,
          protocolFeeBps: 95,
          creatorFeeBps: 30,
          lpFeeBps: 0,
          virtualTokenReserves: 1_072_000_000_000_000n,
          virtualQuoteReserves: 30_100_000_000n,
          realTokenReserves: 792_000_000_000_000n,
          realQuoteReserves: 100_000_000n,
          timestampMs: tradeAtMs,
          ixName: "buy"
        } satisfies TradeEvent;
        market.apply(trade);
      }
    }
    const nowMs = T0 + 90 * MINUTE_MS;
    const predicted = [...market.all()].filter((launch) => evictableAt(launch, nowMs, window)).map((launch) => launch.mint).sort();
    const evicted = market.evict(nowMs).map((launch) => launch.mint).sort();
    expect(predicted.length).toBeGreaterThan(20);
    expect(evicted).toEqual(predicted);
  });

  it("tracks the timers a scoped clock schedules and leaves the others alone", async () => {
    const base = new VirtualClock(T0);
    const lane = new ScopedClock(base);
    const other = new ScopedClock(base);
    const fired: string[] = [];
    const first = lane.schedule(T0 + 500, () => {
      fired.push("lane-500");
    });
    lane.schedule(T0 + 200, () => {
      fired.push("lane-200");
    });
    other.schedule(T0 + 100, () => {
      fired.push("other-100");
    });
    base.schedule(T0 + 50, () => {
      fired.push("base-50");
    });
    expect(lane.nextDueMs()).toBe(T0 + 200);
    expect(other.nextDueMs()).toBe(T0 + 100);
    expect(lane.pendingCount()).toBe(2);
    await base.advanceTo(T0 + 300);
    expect(fired).toEqual(["base-50", "other-100", "lane-200"]);
    expect(lane.nextDueMs()).toBe(T0 + 500);
    expect(other.nextDueMs()).toBeNull();
    lane.cancel(first);
    expect(lane.nextDueMs()).toBeNull();
    await base.advanceTo(T0 + 1_000);
    expect(fired).toHaveLength(3);
    const slept = lane.sleepUntil(T0 + 1_200);
    expect(lane.nextDueMs()).toBe(T0 + 1_200);
    await base.advanceTo(T0 + 1_200);
    await slept;
    expect(lane.pendingCount()).toBe(0);
  });

  it("groups lanes by everything a lane cannot vary", () => {
    const base = defaultStrategyConfig();
    const exits = structuredClone(base);
    exits.exits.timeStop.afterSec = 30;
    const signals = structuredClone(base);
    signals.tracker.convergence.minWallets = 2;
    signals.signals.scoreMomentum.maxRiskScore = 10;
    const blocks = structuredClone(base);
    blocks.scorer.hardBlocks.devShareAbove = 1;
    const scorer = structuredClone(base);
    scorer.scorer.earlyBuyerCount = 5;
    const memory = structuredClone(base);
    memory.recorder.memory.evictInactiveMinutes = 5;
    const lanes = [
      { key: "base", config: base },
      { key: "exits", config: exits },
      { key: "blocks", config: blocks },
      { key: "scorer", config: scorer },
      { key: "signals", config: signals },
      { key: "memory", config: memory },
      { key: "weights", config: base, weightsFile: "weights.json" }
    ];
    const groups = groupCohortLanes(lanes);
    expect(groups.map((group) => group.map((lane) => lane.key))).toEqual([["base", "exits", "blocks", "signals"], ["scorer"], ["memory"], ["weights"]]);
    expect(cohortGroupKey({ config: base })).toBe(cohortGroupKey({ config: signals }));
    expect(cohortGroupKey({ config: base })).toBe(cohortGroupKey({ config: blocks }));
    const split = groupCohortLanes(lanes, { splitHardBlocks: true });
    expect(split.map((group) => group.map((lane) => lane.key))).toEqual([["base", "exits", "signals"], ["blocks"], ["scorer"], ["memory"], ["weights"]]);
  });

  it("rescores a shared checkpoint score with a lane's own hard blocks exactly like that lane's scorer", () => {
    const config = defaultStrategyConfig().scorer;
    const loose = structuredClone(config);
    loose.hardBlocks.bundleShareAbove = 1;
    loose.hardBlocks.devShareAbove = 1;
    const model = ScoringModel.default();
    const scorer = { service: { currentModel: () => model } } as unknown as Parameters<typeof hardBlockRescorer>[0];
    const rescore = hardBlockRescorer(scorer, loose.hardBlocks);
    const features = { dev_share: 0.4, bundle_share: 0.5, creation_slot_buyers: 4, wash_ratio: 0.5, top10_share: 0.7, socials_count: 0 };
    const strict = model.score(features, config.hardBlocks);
    const shared: LaunchScore = {
      ...scoreAt("MintR", T0),
      score: strict.score,
      hardBlocked: strict.hardBlocked,
      flags: [...new Set([...strict.flags, ...softFlags(features)])],
      features,
      contributions: strict.contributions,
      weightsVersion: strict.weightsVersion
    };
    expect(shared.hardBlocked).toBe(true);
    const own = model.score(features, loose.hardBlocks);
    expect(rescore(shared)).toEqual({ ...shared, hardBlocked: own.hardBlocked, flags: [...new Set([...own.flags, ...softFlags(features)])] });
    expect(rescore(shared).hardBlocked).toBe(false);
    expect(rescore(shared).flags).not.toContain("hard_bundle_share");
    expect(rescore(shared).flags).toContain("bundled");
  });
});
