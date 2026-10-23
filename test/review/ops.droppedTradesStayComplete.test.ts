import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { Bus } from "../../src/core/bus.js";
import { VirtualClock } from "../../src/core/clock.js";
import type { ChainEvent, LaunchCreatedEvent, TradeEvent } from "../../src/core/types.js";
import type { Db } from "../../src/db/pool.js";
import { IngestPipeline } from "../../src/ingest/pipeline.js";
import { MarketState } from "../../src/market/state.js";
import { LaunchRegistry, RecorderService } from "../../src/recorder/index.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const SLOT0 = 420_000_000;
const MINT = "DropMint1111111111111111111111111111111111111";
let sequence = 0;

function txRef(slot: number, atMs: number) {
  sequence += 1;
  return { signature: `drop-sig-${sequence}`, slot, seq: sequence, eventIndex: 0, receivedAtMs: atMs };
}

function create(): LaunchCreatedEvent {
  return {
    kind: "create",
    tx: txRef(SLOT0, T0),
    mint: MINT,
    bondingCurve: "DropCurve11111111111111111111111111111111111",
    devWallet: "DropDev111111111111111111111111111111111111",
    creator: "DropDev111111111111111111111111111111111111",
    name: "Drop",
    symbol: "DRP",
    uri: "",
    timestampMs: T0,
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
  };
}

function trade(index: number): TradeEvent {
  const slot = SLOT0 + 10 + index;
  const atMs = T0 + (10 + index) * 400;
  return {
    kind: "trade",
    tx: txRef(slot, atMs),
    venue: "curve",
    mint: MINT,
    pool: null,
    wallet: `DropBuyer${index}`,
    isBuy: true,
    tokenAmount: 1_000_000_000n,
    quoteAmount: 1_000_000n,
    userQuote: 1_012_500n,
    protocolFee: 9_500n,
    creatorFee: 3_000n,
    lpFee: 0n,
    protocolFeeBps: 95,
    creatorFeeBps: 30,
    lpFeeBps: 0,
    virtualTokenReserves: 1_000_000_000_000_000n,
    virtualQuoteReserves: 32_000_000_000n,
    realTokenReserves: 720_000_000_000_000n,
    realQuoteReserves: 2_000_000_000n,
    timestampMs: atMs,
    ixName: "buy"
  };
}

function flakyQueries(db: Db, state: { failing: boolean }, prefix: RegExp): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (sql: unknown, params?: unknown) => {
          if (state.failing && typeof sql === "string" && prefix.test(sql)) {
            return Promise.reject(new Error("Connection terminated unexpectedly"));
          }
          return (target.query as (text: unknown, values?: unknown) => Promise<unknown>).call(target, sql, params);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
}

describe.skipIf(!hasTestDatabase)("review ops: trades dropped by the batch writer", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("review_ops_drop");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("marks the launch incomplete when its trade rows are dropped after a database outage", async () => {
    const state = { failing: false };
    const db = flakyQueries(database.db, state, /^INSERT INTO trades/);
    const clock = new VirtualClock(T0 + 60_000);
    const market = new MarketState({ maxTradesPerLaunch: 25_000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    const bus = new Bus();
    const registry = new LaunchRegistry({ db });
    const service = new RecorderService({
      db,
      bus,
      market,
      clock,
      config: defaultStrategyConfig().recorder,
      registry,
      aggregateFlushMs: 1e9,
      manageTradePartitions: false,
      writerOptions: { maxRetries: 0 }
    });
    const pipeline = new IngestPipeline({ market, bus, clock, poolLookup: registry.poolLookup });
    const feed = (event: ChainEvent): void =>
      pipeline.handleBatch(
        { events: [event], truncated: false, incomplete: 0, unknown: 0 },
        { signature: event.tx.signature, slot: event.tx.slot, seq: event.tx.seq, receivedAtMs: event.tx.receivedAtMs }
      );

    await service.start();
    feed(create());
    await service.settleInflight();
    feed(trade(0));
    await service.flushTrades();
    state.failing = true;
    for (let index = 1; index < 6; index += 1) {
      feed(trade(index));
    }
    await service.flushTrades();
    state.failing = false;
    for (let index = 6; index < 8; index += 1) {
      feed(trade(index));
    }
    await service.stop();

    expect(service.stats().tradesDropped).toBe(5);
    const stored = await database.db.query<{ n: number }>("SELECT count(*)::int AS n FROM trades");
    expect(stored.rows[0]?.n).toBe(3);
    const launch = await database.db.query<{ data_complete: boolean; trade_count: number }>(
      "SELECT data_complete, trade_count FROM launches WHERE mint = $1",
      [MINT]
    );
    expect({ inMemory: market.get(MINT)?.dataComplete, inDb: launch.rows[0]?.data_complete }).toEqual({
      inMemory: false,
      inDb: false
    });
  });
  it("keeps the ingest gap on record when the database is briefly unreachable while the gap is written", async () => {
    const state = { failing: false };
    await database.db.query("UPDATE launches SET data_complete = true, tracking_ended_at = NULL");
    const db = flakyQueries(database.db, state, /INSERT INTO ingest_gaps/);
    const clock = new VirtualClock(T0 + 120_000);
    const market = new MarketState({ maxTradesPerLaunch: 25_000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    const bus = new Bus();
    const registry = new LaunchRegistry({ db });
    const service = new RecorderService({
      db,
      bus,
      market,
      clock,
      config: defaultStrategyConfig().recorder,
      registry,
      aggregateFlushMs: 1e9,
      manageTradePartitions: false,
      recordRestartGap: false
    });
    await service.start();
    state.failing = true;
    service.handleGap({
      source: "ws",
      fromSlot: SLOT0 + 100,
      toSlot: SLOT0 + 400,
      startedAtMs: T0 + 60_000,
      endedAtMs: T0 + 100_000,
      reason: "closed 1006"
    });
    await service.settleInflight();
    state.failing = false;
    await clock.advanceTo(clock.nowMs() + 60_000);
    await service.settleInflight();
    await service.stop();
    const gaps = await database.db.query<{ n: number }>("SELECT count(*)::int AS n FROM ingest_gaps WHERE reason = 'closed 1006'");
    const launch = await database.db.query<{ data_complete: boolean }>("SELECT data_complete FROM launches WHERE mint = $1", [MINT]);
    expect({ gaps: gaps.rows[0]?.n, dataComplete: launch.rows[0]?.data_complete }).toEqual({ gaps: 1, dataComplete: false });
  });
});
