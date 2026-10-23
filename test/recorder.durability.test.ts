import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { ChainEvent, LaunchCreatedEvent, TradeEvent } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import { IngestPipeline } from "../src/ingest/pipeline.js";
import { MarketState } from "../src/market/state.js";
import { createRecorderModule, LaunchRegistry, RecorderService, type FetchLike, type RecorderServiceOptions } from "../src/recorder/index.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const SLOT0 = 420_000_000;
let sequence = 0;

function txRef(slot: number, atMs: number) {
  sequence += 1;
  return { signature: `durable-sig-${sequence}`, slot, seq: sequence, eventIndex: 0, receivedAtMs: atMs };
}

function create(mint: string, slot: number): LaunchCreatedEvent {
  return {
    kind: "create",
    tx: txRef(slot, T0),
    mint,
    bondingCurve: `${mint}Curve`,
    devWallet: `${mint}Dev`,
    creator: `${mint}Dev`,
    name: mint,
    symbol: "DUR",
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

function trade(mint: string, index: number): TradeEvent {
  const slot = SLOT0 + 10 + index;
  const atMs = T0 + (10 + index) * 400;
  return {
    kind: "trade",
    tx: txRef(slot, atMs),
    venue: "curve",
    mint,
    pool: null,
    wallet: `${mint}Buyer${index}`,
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

function failingWhile(db: Db, state: { failing: boolean }, pattern: RegExp): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (sql: unknown, params?: unknown) => {
          if (state.failing && typeof sql === "string" && pattern.test(sql)) {
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

interface Harness {
  market: MarketState;
  service: RecorderService;
  feed(event: ChainEvent): void;
}

function harness(db: Db, clock: VirtualClock, options: Partial<RecorderServiceOptions> = {}): Harness {
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
    aggregateFlushMs: 5_000,
    manageTradePartitions: false,
    recordRestartGap: false,
    ...options
  });
  const pipeline = new IngestPipeline({ market, bus, clock, poolLookup: registry.poolLookup });
  return {
    market,
    service,
    feed: (event) =>
      pipeline.handleBatch(
        { events: [event], truncated: false, incomplete: 0, unknown: 0 },
        { signature: event.tx.signature, slot: event.tx.slot, seq: event.tx.seq, receivedAtMs: event.tx.receivedAtMs }
      )
  };
}

describe.skipIf(!hasTestDatabase)("recorder durability", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("recorder_durable");
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function reset(): Promise<void> {
    await database.db.query("TRUNCATE launches, trades, ingest_gaps, recorder_checkpoints RESTART IDENTITY CASCADE");
  }

  it("marks exactly the launches whose trade rows were dropped, from the first dropped trade, in memory and in the database", async () => {
    await reset();
    const state = { failing: false };
    const clock = new VirtualClock(T0 + 60_000);
    const recorder = harness(failingWhile(database.db, state, /^INSERT INTO trades/), clock, { writerOptions: { maxRetries: 0 } });
    await recorder.service.start();
    recorder.feed(create("DroppedMint", SLOT0));
    recorder.feed(create("KeptMint", SLOT0 + 1));
    await recorder.service.settleInflight();
    recorder.feed(trade("DroppedMint", 0));
    recorder.feed(trade("KeptMint", 0));
    await recorder.service.flushTrades();
    state.failing = true;
    recorder.feed(trade("DroppedMint", 1));
    recorder.feed(trade("DroppedMint", 2));
    await recorder.service.flushTrades();
    await recorder.service.settleInflight();
    state.failing = false;
    recorder.feed(trade("KeptMint", 3));
    await recorder.service.stop();
    expect(recorder.service.stats()).toMatchObject({ tradesDropped: 2, tradeWritesDropped: 2 });
    expect({ dropped: recorder.market.get("DroppedMint")?.dataComplete, kept: recorder.market.get("KeptMint")?.dataComplete }).toEqual({
      dropped: false,
      kept: true
    });
    const rows = await database.db.query<{ mint: string; data_complete: boolean; data_incomplete_at: Date | null; trade_count: number }>(
      "SELECT mint, data_complete, data_incomplete_at, trade_count FROM launches ORDER BY mint"
    );
    expect(rows.rows).toEqual([
      { mint: "DroppedMint", data_complete: false, data_incomplete_at: new Date(T0 + 11 * 400), trade_count: 1 },
      { mint: "KeptMint", data_complete: true, data_incomplete_at: null, trade_count: 2 }
    ]);
    const gaps = await database.db.query<{ reason: string; affected_launches: number }>("SELECT reason, affected_launches FROM ingest_gaps");
    expect(gaps.rows).toEqual([{ reason: "trade write dropped", affected_launches: 1 }]);
  });

  it("retries an ingest gap that could not be written on the next persistence tick", async () => {
    await reset();
    const state = { failing: false };
    const clock = new VirtualClock(T0 + 60_000);
    const recorder = harness(failingWhile(database.db, state, /INSERT INTO ingest_gaps/), clock);
    await recorder.service.start();
    recorder.feed(create("GapMint", SLOT0));
    await recorder.service.settleInflight();
    state.failing = true;
    recorder.service.handleGap({ source: "ws", fromSlot: SLOT0 + 100, toSlot: SLOT0 + 400, startedAtMs: T0 + 60_000, endedAtMs: T0 + 100_000, reason: "closed 1006" });
    await recorder.service.settleInflight();
    expect(recorder.service.stats()).toMatchObject({ gapsPending: 1, gapErrors: 1 });
    expect(recorder.market.get("GapMint")?.dataComplete).toBe(false);
    state.failing = false;
    await clock.advanceTo(clock.nowMs() + 6_000);
    expect(recorder.service.stats()).toMatchObject({ gapsPending: 0, gapsRecorded: 1 });
    const launch = await database.db.query<{ data_complete: boolean; data_incomplete_at: Date | null }>(
      "SELECT data_complete, data_incomplete_at FROM launches WHERE mint = 'GapMint'"
    );
    expect(launch.rows).toEqual([{ data_complete: false, data_incomplete_at: new Date(T0 + 60_000) }]);
    await recorder.service.stop();
  });

  it("keeps retrying trade inserts through a short outage instead of dropping them", async () => {
    await reset();
    const state = { failing: false };
    const clock = new VirtualClock(T0 + 60_000);
    const recorder = harness(failingWhile(database.db, state, /^INSERT INTO trades/), clock);
    await recorder.service.start();
    recorder.feed(create("OutageMint", SLOT0));
    await recorder.service.settleInflight();
    state.failing = true;
    for (let index = 0; index < 4; index += 1) {
      recorder.feed(trade("OutageMint", index));
    }
    const flushed = recorder.service.flushTrades();
    await new Promise((resolve) => setTimeout(resolve, 600));
    state.failing = false;
    await flushed;
    await recorder.service.stop();
    expect(recorder.service.stats().tradesDropped).toBe(0);
    const launch = await database.db.query<{ data_complete: boolean; trade_count: number }>(
      "SELECT data_complete, trade_count FROM launches WHERE mint = 'OutageMint'"
    );
    expect(launch.rows).toEqual([{ data_complete: true, trade_count: 4 }]);
  });

  it("fetches metadata for tracked launches that a previous instance left unfetched", async () => {
    await reset();
    await database.db.query(
      `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, uri, create_signature, create_slot, created_at,
                             token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token, metadata_fetched_at)
       VALUES ('UnfetchedMint', 'curve', 'dev', 'dev', 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'sig-u', 1, $1,
               1000000000000000, 1073000000000000, 30000000000, 793100000000000, NULL),
              ('FetchedMint', 'curve', 'dev', 'dev', 'https://ipfs.io/ipfs/x', 'sig-f', 2, $1,
               1000000000000000, 1073000000000000, 30000000000, 793100000000000, $1)`,
      [new Date(T0)]
    );
    const fetched: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      fetched.push(input);
      return new Response(JSON.stringify({ name: "x", twitter: "https://x.com/x" }), { status: 200 });
    };
    const config = defaultStrategyConfig();
    config.recorder.rpcSnapshotsEnabled = false;
    const clock = new VirtualClock(T0 + 300_000);
    const recorder = createRecorderModule({
      db: database.db,
      rpc: null,
      bus: new Bus(),
      market: new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null }),
      clock,
      config,
      env: { METADATA_GATEWAY: undefined },
      fetchImpl,
      service: { manageTradePartitions: false, recordRestartGap: false, aggregateFlushMs: 1e9 }
    });
    await recorder.start();
    await clock.advanceTo(clock.nowMs() + 1_000);
    await recorder.metadata.drain();
    await recorder.stop();
    expect(fetched).toEqual(["https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"]);
    const row = await database.db.query<{ has_twitter: boolean | null }>("SELECT has_twitter FROM launches WHERE mint = 'UnfetchedMint'");
    expect(row.rows).toEqual([{ has_twitter: true }]);
  });
});
