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
const SLOT0 = 410_000_000;
const MINT = "OverlapMint11111111111111111111111111111111";
let sequence = 0;

function txRef(slot: number, atMs: number) {
  sequence += 1;
  return { signature: `overlap-sig-${sequence}`, slot, seq: sequence, eventIndex: 0, receivedAtMs: atMs };
}

function create(): LaunchCreatedEvent {
  return {
    kind: "create",
    tx: txRef(SLOT0, T0),
    mint: MINT,
    bondingCurve: "OverlapCurve111111111111111111111111111111",
    devWallet: "OverlapDev11111111111111111111111111111111",
    creator: "OverlapDev11111111111111111111111111111111",
    name: "Overlap",
    symbol: "OVL",
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
    wallet: `OverlapBuyer${index}`,
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

interface Stack {
  service: RecorderService;
  pipeline: IngestPipeline;
}

function stack(db: Db, clock: VirtualClock): Stack {
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
    manageTradePartitions: false
  });
  const pipeline = new IngestPipeline({ market, bus, clock, poolLookup: registry.poolLookup });
  return { service, pipeline };
}

function feed(target: Stack, event: ChainEvent): void {
  target.pipeline.handleBatch(
    { events: [event], truncated: false, incomplete: 0, unknown: 0 },
    { signature: event.tx.signature, slot: event.tx.slot, seq: event.tx.seq, receivedAtMs: event.tx.receivedAtMs }
  );
}

describe.skipIf(!hasTestDatabase)("review ops: restart gap during an overlapping Railway deploy", () => {
  let database: TestDatabase;
  let result: {
    storedTrades: number;
    gaps: Array<{ reason: string; affected_launches: number }>;
    dataComplete: boolean | undefined;
    tradeCount: number | undefined;
    buyCount: number | undefined;
  };

  beforeAll(async () => {
    database = await createTestDatabase("review_ops_overlap");
    const clock = new VirtualClock(T0 + 60_000);
    const oldInstance = stack(database.db, clock);
    await oldInstance.service.start();
    feed(oldInstance, create());
    await oldInstance.service.settleInflight();
    for (let index = 0; index < 5; index += 1) {
      feed(oldInstance, trade(index));
    }
    await oldInstance.service.flush();

    const newInstance = stack(database.db, clock);
    await newInstance.service.start();
    for (let index = 5; index < 10; index += 1) {
      const event = trade(index);
      feed(oldInstance, event);
      feed(newInstance, event);
    }
    await clock.advanceTo(clock.nowMs() + 30_000);
    await oldInstance.service.stop();
    await clock.advanceTo(clock.nowMs() + 30_000);
    await newInstance.service.stop();

    const trades = await database.db.query<{ n: number }>("SELECT count(*)::int AS n FROM trades");
    const launch = await database.db.query<{ data_complete: boolean; trade_count: number; buy_count: number }>(
      "SELECT data_complete, trade_count, buy_count FROM launches WHERE mint = $1",
      [MINT]
    );
    const gaps = await database.db.query<{ reason: string; affected_launches: number }>(
      "SELECT reason, affected_launches FROM ingest_gaps"
    );
    result = {
      storedTrades: trades.rows[0]?.n ?? 0,
      gaps: gaps.rows,
      dataComplete: launch.rows[0]?.data_complete,
      tradeCount: launch.rows[0]?.trade_count,
      buyCount: launch.rows[0]?.buy_count
    };
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("keeps a launch complete when the new recorder starts while the old one is still recording every trade", () => {
    expect(result.storedTrades).toBe(10);
    expect({ gaps: result.gaps, dataComplete: result.dataComplete }).toEqual({ gaps: [], dataComplete: true });
  });

  it("does not count the overlapping trades twice in the launch aggregates", () => {
    expect({ tradeCount: result.tradeCount, buyCount: result.buyCount }).toEqual({ tradeCount: 10, buyCount: 10 });
  });
});

describe.skipIf(!hasTestDatabase)("review ops: restart gap after a real outage", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("review_ops_outage");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("still marks the launch incomplete when the new recorder starts streaming after slots nobody recorded", async () => {
    const clock = new VirtualClock(T0 + 60_000);
    const oldInstance = stack(database.db, clock);
    await oldInstance.service.start();
    feed(oldInstance, create());
    await oldInstance.service.settleInflight();
    for (let index = 0; index < 5; index += 1) {
      feed(oldInstance, trade(index));
    }
    await clock.advanceTo(clock.nowMs() + 10_000);
    await oldInstance.service.stop();

    await clock.advanceTo(clock.nowMs() + 300_000);
    const newInstance = stack(database.db, clock);
    await newInstance.service.start();
    for (let index = 800; index < 805; index += 1) {
      feed(newInstance, trade(index));
    }
    await clock.advanceTo(clock.nowMs() + 30_000);
    await newInstance.service.stop();

    const launch = await database.db.query<{ data_complete: boolean }>("SELECT data_complete FROM launches WHERE mint = $1", [MINT]);
    const gaps = await database.db.query<{ n: number }>("SELECT count(*)::int AS n FROM ingest_gaps");
    expect({ dataComplete: launch.rows[0]?.data_complete, gaps: gaps.rows[0]?.n }).toEqual({ dataComplete: false, gaps: 1 });
  });
});
