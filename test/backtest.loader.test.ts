import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BacktestLoader,
  REPLAY_PHASE,
  compareReplayEvents,
  completeEventFromRow,
  hydrateLaunch,
  launchEventFromRow,
  migrateEventFromRow,
  replayEventOf,
  tradeEventFromRow,
  type ReplayEvent
} from "../src/backtest/loader.js";
import type { ChainEvent } from "../src/core/types.js";
import { MarketState } from "../src/market/state.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { RollingStoredFeatures } from "../src/backtest/storedScores.js";
import { CLEAN_DEEP_FEATURES, convergenceTrades, seedLaunch, seedStoredScore } from "./backtest.seed.js";

const T = Date.UTC(2026, 9, 2);

function launchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9n,
    mint: "MintRow",
    bonding_curve: "Curve",
    dev_wallet: "Dev",
    creator: "Creator",
    name: "Name",
    symbol: "SYM",
    uri: "ipfs://x",
    quote_mint: "SOL",
    token_program: null,
    is_mayhem: false,
    is_cashback: true,
    is_holder_reward: false,
    creator_fee_bps: 30,
    depth: 0,
    create_signature: "sig",
    create_slot: 100n,
    created_at: new Date(T),
    token_total_supply: 1_000_000_000_000_000n,
    initial_virtual_token: 1_073_000_000_000_000n,
    initial_virtual_quote: 30_000_000_000n,
    initial_real_token: 793_100_000_000_000n,
    pool: null,
    completed_at: null,
    completed_slot: null,
    migrated_at: null,
    migrated_slot: null,
    data_complete: true,
    ...overrides
  };
}

function tradeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    launch_id: 9n,
    mint: "MintRow",
    launch_pool: "PoolRow",
    block_time: new Date(T + 5_000),
    slot: 112n,
    seq: 44n,
    signature: "tradeSig",
    event_index: 1,
    venue: 0,
    wallet: "Buyer",
    is_buy: true,
    token_amount: 10n,
    quote_amount: 20n,
    user_quote: 21n,
    protocol_fee: 1n,
    creator_fee: 0n,
    lp_fee: 0n,
    protocol_fee_bps: 95,
    creator_fee_bps: 30,
    lp_fee_bps: 0,
    virtual_token: 1_000n,
    virtual_quote: 2_000n,
    real_token: null,
    real_quote: 5n,
    ix_name: "buy",
    ...overrides
  };
}

describe("replay rows", () => {
  it("rebuilds the create event from a launches row", () => {
    const event = launchEventFromRow(launchRow());
    expect(event).toMatchObject({
      kind: "create",
      mint: "MintRow",
      devWallet: "Dev",
      creator: "Creator",
      quoteMint: "SOL",
      timestampMs: T,
      isCashback: true,
      virtualQuoteReserves: 30_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n
    });
    expect(event.tx).toEqual({ signature: "sig", slot: 100, seq: 0, eventIndex: 0, receivedAtMs: T });
  });

  it("maps venue codes and attaches the pool only to pool trades", () => {
    const curve = tradeEventFromRow(tradeRow());
    expect(curve.venue).toBe("curve");
    expect(curve.pool).toBeNull();
    expect(curve.realTokenReserves).toBeNull();
    expect(curve.realQuoteReserves).toBe(5n);
    expect(curve.tx).toEqual({ signature: "tradeSig", slot: 112, seq: 44, eventIndex: 1, receivedAtMs: T + 5_000 });
    const pool = tradeEventFromRow(tradeRow({ venue: 1 }));
    expect(pool.venue).toBe("pool");
    expect(pool.pool).toBe("PoolRow");
    expect(tradeEventFromRow(tradeRow({ venue: 2 })).venue).toBe("curve_post_complete");
    expect(tradeEventFromRow(tradeRow({ venue: 7 })).venue).toBe("curve");
  });

  it("creates lifecycle events only when the launch completed or migrated to a known pool", () => {
    expect(completeEventFromRow(launchRow())).toBeNull();
    expect(migrateEventFromRow(launchRow({ migrated_at: new Date(T + 9_000) }))).toBeNull();
    const complete = completeEventFromRow(launchRow({ completed_at: new Date(T + 8_000), completed_slot: 130n }));
    expect(complete).toMatchObject({ kind: "complete", timestampMs: T + 8_000, mint: "MintRow" });
    expect(complete?.tx.slot).toBe(130);
    const migrate = migrateEventFromRow(launchRow({ migrated_at: new Date(T + 9_000), migrated_slot: 140n, pool: "PoolRow" }));
    expect(migrate).toMatchObject({ kind: "migrate", pool: "PoolRow", timestampMs: T + 9_000 });
  });

  it("orders events by time, slot, then create, migrate, trade, complete, then sequence", () => {
    const create = launchEventFromRow(launchRow());
    const trade = (slot: number, seq: number, eventIndex: number, atMs = T): ChainEvent => ({
      ...tradeEventFromRow(tradeRow({ slot: BigInt(slot), seq: BigInt(seq), event_index: eventIndex, block_time: new Date(atMs) }))
    });
    const complete = completeEventFromRow(launchRow({ completed_at: new Date(T), completed_slot: 100n }));
    const migrate = migrateEventFromRow(launchRow({ migrated_at: new Date(T), migrated_slot: 100n, pool: "P" }));
    if (!complete || !migrate) {
      throw new Error("missing lifecycle events");
    }
    const events: ReplayEvent[] = [
      replayEventOf(complete, 9),
      replayEventOf(trade(100, 5, 1), 9),
      replayEventOf(trade(100, 5, 0), 9),
      replayEventOf(trade(99, 9, 0, T + 1_000), 9),
      replayEventOf(migrate, 9),
      replayEventOf(trade(100, 2, 3), 9),
      replayEventOf(create, 9)
    ].sort(compareReplayEvents);
    expect(events.map((event) => [event.phase, event.slot, event.seq, event.eventIndex])).toEqual([
      [REPLAY_PHASE.create, 100, -1, -1],
      [REPLAY_PHASE.migrate, 100, -1, -1],
      [REPLAY_PHASE.trade, 100, 2, 3],
      [REPLAY_PHASE.trade, 100, 5, 0],
      [REPLAY_PHASE.trade, 100, 5, 1],
      [REPLAY_PHASE.complete, 100, Number.MAX_SAFE_INTEGER, 0],
      [REPLAY_PHASE.trade, 99, 9, 0]
    ]);
  });
});

describe.skipIf(!hasTestDatabase)("replay loader on Postgres", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("backtest_loader");
    await seedLaunch(database.db, { mint: "LoaderA", dev: "DevA", createdAtMs: T + 30_000, slot: 1_000, trades: convergenceTrades(["a", "b", "c"]) });
    await seedLaunch(database.db, { mint: "LoaderB", dev: "DevB", createdAtMs: T + 90_000, slot: 2_000, trades: convergenceTrades(["d", "e", "f"]) });
    await seedLaunch(database.db, { mint: "LoaderPump", dev: "DevP", createdAtMs: T + 95_000, slot: 2_100, trades: convergenceTrades(["g"]), quoteMint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn" });
    await seedLaunch(database.db, { mint: "LoaderGap", dev: "DevG", createdAtMs: T + 100_000, slot: 2_200, trades: convergenceTrades(["h"]), dataComplete: false });
    await seedLaunch(database.db, {
      mint: "LoaderSurvivor",
      dev: "DevS",
      createdAtMs: T + 110_000,
      slot: 2_300,
      trades: convergenceTrades(["i", "j", "k"]),
      incompleteFromMs: T + 110_000 + 150_000
    });
    await database.db.query(
      "UPDATE launches SET completed_at = $1, completed_slot = 1100, migrated_at = $2, migrated_slot = 1200, pool = 'PoolA' WHERE mint = 'LoaderA'",
      [new Date(T + 150_000), new Date(T + 160_000)]
    );
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("streams creates, trades and lifecycle events window by window in replay order", async () => {
    const loader = new BacktestLoader({ db: database.db, fromMs: T, toMs: T + 600_000, tradeQuoteMints: ["SOL"], windowMs: 60_000 });
    await loader.prepare();
    const all: ReplayEvent[] = [];
    let windows = 0;
    for await (const window of loader.windows()) {
      windows += 1;
      for (let index = 1; index < window.length; index += 1) {
        expect(compareReplayEvents(window[index - 1] as ReplayEvent, window[index] as ReplayEvent)).toBeLessThanOrEqual(0);
      }
      all.push(...window);
    }
    expect(windows).toBeGreaterThan(1);
    for (let index = 1; index < all.length; index += 1) {
      expect((all[index] as ReplayEvent).atMs).toBeGreaterThanOrEqual((all[index - 1] as ReplayEvent).atMs);
    }
    const creates = all.filter((event) => event.event.kind === "create").map((event) => event.event.mint);
    expect(creates).toEqual(["LoaderA", "LoaderB", "LoaderPump", "LoaderGap", "LoaderSurvivor"]);
    const tradeMints = new Set(all.filter((event) => event.event.kind === "trade").map((event) => event.event.mint));
    expect([...tradeMints].sort()).toEqual(["LoaderA", "LoaderB", "LoaderGap", "LoaderSurvivor"]);
    const incompleteFrom = new Map(
      all.filter((event) => event.event.kind === "create").map((event) => [event.event.mint, event.incompleteFromMs ?? null])
    );
    expect(Object.fromEntries(incompleteFrom)).toEqual({
      LoaderA: null,
      LoaderB: null,
      LoaderPump: null,
      LoaderGap: T + 100_000,
      LoaderSurvivor: T + 260_000
    });
    expect(all.filter((event) => event.event.kind === "trade" && event.event.mint === "LoaderSurvivor")).toHaveLength(
      convergenceTrades(["i", "j", "k"]).length
    );
    expect(all.filter((event) => event.event.kind === "complete" || event.event.kind === "migrate").map((event) => event.event.kind)).toEqual([
      "complete",
      "migrate"
    ]);
    expect(loader.stats()).toMatchObject({ launches: 5, incompleteLaunches: 2, lifecycle: 2 });
  });

  it("loads stored live scores chunk by chunk ahead of replay time and forgets old chunks", async () => {
    const early = await seedLaunch(database.db, { mint: "StoredEarly", dev: "DevSE", createdAtMs: T + 10 * 60_000, slot: 5_000, trades: [] });
    const late = await seedLaunch(database.db, { mint: "StoredLate", dev: "DevSL", createdAtMs: T + 70 * 60_000, slot: 6_000, trades: [] });
    await seedStoredScore(database.db, early, "StoredEarly", 30, T + 10 * 60_000 + 30_500, { ...CLEAN_DEEP_FEATURES, cluster_count: 2 });
    await seedStoredScore(database.db, late, "StoredLate", 60, T + 70 * 60_000 + 61_000, CLEAN_DEEP_FEATURES);
    const stored = new RollingStoredFeatures({ db: database.db, fromMs: T, toMs: T + 180 * 60_000, chunkMs: 30 * 60_000, retentionMs: 30 * 60_000 });
    await stored.advanceTo(T);
    expect(stored.get("StoredEarly", 30)?.features.cluster_count).toBe(2);
    expect(stored.get("StoredEarly", 30)?.computedAtMs).toBe(T + 10 * 60_000 + 30_500);
    expect(stored.get("StoredLate", 60)).toBeNull();
    expect(stored.needsAdvance(T)).toBe(false);
    expect(stored.needsAdvance(T + 1)).toBe(true);
    await stored.advanceTo(T + 45 * 60_000);
    expect(stored.get("StoredLate", 60)?.features.cluster_count).toBe(0);
    expect(stored.get("StoredEarly", 30)).not.toBeNull();
    await stored.advanceTo(T + 100 * 60_000);
    expect(stored.get("StoredEarly", 30)).toBeNull();
    expect(stored.get("StoredLate", 60)).not.toBeNull();
    expect(stored.size).toBe(2);
    expect(stored.get("StoredLate", 30)).toBeNull();
  });

  it("hydrates a launch with its trades and lifecycle from the database", async () => {
    const market = new MarketState({ maxTradesPerLaunch: 1_000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    expect(await hydrateLaunch(database.db, market, "LoaderA")).toBe(true);
    const launch = market.get("LoaderA");
    expect(launch?.launchId).not.toBeNull();
    expect(launch?.trades.length).toBe(convergenceTrades(["a", "b", "c"]).length);
    expect(launch?.migrated).toBe(true);
    expect(launch?.pool).toBe("PoolA");
    expect(launch?.virtualQuoteReserves).not.toBe(30_000_000_000n);
    expect(market.mintForPool("PoolA")).toBe("LoaderA");
    expect(await hydrateLaunch(database.db, market, "Missing")).toBe(false);
    expect(await hydrateLaunch(database.db, market, "LoaderA")).toBe(true);
  });
});
