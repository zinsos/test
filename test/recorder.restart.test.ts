import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { ChainEvent, LaunchCreatedEvent, TradeEvent } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import { IngestPipeline } from "../src/ingest/pipeline.js";
import { MarketState } from "../src/market/state.js";
import { LaunchRegistry, RecorderService, type RecorderServiceOptions } from "../src/recorder/index.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const SLOT0 = 410_000_000;
let sequence = 0;

function txRef(slot: number, atMs: number) {
  sequence += 1;
  return { signature: `restart-sig-${sequence}`, slot, seq: sequence, eventIndex: 0, receivedAtMs: atMs };
}

function create(mint: string, slot: number, atMs: number): LaunchCreatedEvent {
  return {
    kind: "create",
    tx: txRef(slot, atMs),
    mint,
    bondingCurve: `${mint}Curve`,
    devWallet: `${mint}Dev`,
    creator: `${mint}Dev`,
    name: mint,
    symbol: "RST",
    uri: "",
    timestampMs: atMs,
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

function trade(mint: string, slot: number, atMs: number, wallet: string, isBuy = true): TradeEvent {
  return {
    kind: "trade",
    tx: txRef(slot, atMs),
    venue: "curve",
    mint,
    pool: null,
    wallet,
    isBuy,
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
  market: MarketState;
  service: RecorderService;
  pipeline: IngestPipeline;
}

function stack(db: Db, clock: VirtualClock, options: Partial<RecorderServiceOptions> = {}): Stack {
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
    ...options
  });
  return { market, service, pipeline: new IngestPipeline({ market, bus, clock, poolLookup: registry.poolLookup }) };
}

function feed(target: Stack, event: ChainEvent): void {
  target.pipeline.handleBatch(
    { events: [event], truncated: false, incomplete: 0, unknown: 0 },
    { signature: event.tx.signature, slot: event.tx.slot, seq: event.tx.seq, receivedAtMs: event.tx.receivedAtMs }
  );
}

interface LaunchState {
  mint: string;
  data_complete: boolean;
  data_incomplete_at: Date | null;
  trade_count: number;
  buy_count: number;
  unique_traders: number;
}

async function launches(db: Db): Promise<Map<string, LaunchState>> {
  const result = await db.query<LaunchState>(
    "SELECT mint, data_complete, data_incomplete_at, trade_count, buy_count, unique_traders FROM launches ORDER BY mint"
  );
  return new Map(result.rows.map((row) => [row.mint, row]));
}

async function gaps(db: Db): Promise<Array<{ reason: string; from_slot: string | null; to_slot: string | null; affected_launches: number }>> {
  const result = await db.query<{ reason: string; from_slot: string | null; to_slot: string | null; affected_launches: number }>(
    "SELECT reason, from_slot::text, to_slot::text, affected_launches FROM ingest_gaps ORDER BY id"
  );
  return result.rows;
}

describe.skipIf(!hasTestDatabase)("recorder restarts", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("recorder_restart");
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function reset(): Promise<void> {
    await database.db.query("TRUNCATE launches, trades, ingest_gaps, recorder_checkpoints RESTART IDENTITY CASCADE");
  }

  it("records nothing when the new instance starts while the old one still streams, and counts overlapping trades once", async () => {
    await reset();
    const clock = new VirtualClock(T0 + 60_000);
    const oldInstance = stack(database.db, clock);
    await oldInstance.service.start();
    feed(oldInstance, create("OverlapMint", SLOT0, T0));
    await oldInstance.service.settleInflight();
    for (let index = 0; index < 5; index += 1) {
      feed(oldInstance, trade("OverlapMint", SLOT0 + 10 + index, T0 + 4_000 + index * 400, `Buyer${index}`));
    }
    await clock.advanceTo(clock.nowMs() + 6_000);
    const newInstance = stack(database.db, clock);
    await newInstance.service.start();
    for (let index = 5; index < 10; index += 1) {
      const event = trade("OverlapMint", SLOT0 + 10 + index, T0 + 4_000 + index * 400, `Buyer${index % 7}`);
      feed(oldInstance, event);
      feed(newInstance, event);
    }
    await clock.advanceTo(clock.nowMs() + 30_000);
    await oldInstance.service.stop();
    await clock.advanceTo(clock.nowMs() + 30_000);
    await newInstance.service.stop();
    const row = (await launches(database.db)).get("OverlapMint");
    expect(await gaps(database.db)).toEqual([]);
    expect(row).toMatchObject({ data_complete: true, data_incomplete_at: null, trade_count: 10, buy_count: 10, unique_traders: 7 });
    expect(newInstance.service.stats()).toMatchObject({ restartsCovered: 1, restartGaps: 0 });
  });

  it("records nothing after a clean stop when the next stream continues from the next slot", async () => {
    await reset();
    const clock = new VirtualClock(T0 + 60_000);
    const first = stack(database.db, clock);
    await first.service.start();
    feed(first, create("CleanMint", SLOT0, T0));
    await first.service.settleInflight();
    feed(first, trade("CleanMint", SLOT0 + 5, T0 + 2_000, "BuyerA"));
    await clock.advanceTo(clock.nowMs() + 6_000);
    await first.service.stop();
    const second = stack(database.db, clock);
    await second.service.start();
    feed(second, trade("CleanMint", SLOT0 + 6, T0 + 2_400, "BuyerB"));
    await clock.advanceTo(clock.nowMs() + 30_000);
    await second.service.stop();
    expect(await gaps(database.db)).toEqual([]);
    expect((await launches(database.db)).get("CleanMint")).toMatchObject({ data_complete: true, trade_count: 2, unique_traders: 2 });
  });

  it("records the slots between a clean stop and a later start and marks only launches tracked then, from the last recorded event", async () => {
    await reset();
    const clock = new VirtualClock(T0 + 60_000);
    const first = stack(database.db, clock);
    await first.service.start();
    feed(first, create("AliveMint", SLOT0, T0));
    feed(first, create("EndedMint", SLOT0 + 1, T0 + 400));
    await first.service.settleInflight();
    feed(first, trade("AliveMint", SLOT0 + 20, T0 + 8_000, "BuyerA"));
    await clock.advanceTo(clock.nowMs() + 6_000);
    await first.service.stop();
    await database.db.query("UPDATE launches SET tracking_ended_at = $1 WHERE mint = 'EndedMint'", [new Date(T0 + 5_000)]);
    await clock.advanceTo(clock.nowMs() + 300_000);
    const second = stack(database.db, clock);
    await second.service.start();
    feed(second, create("NewMint", SLOT0 + 900, T0 + 360_000));
    feed(second, trade("AliveMint", SLOT0 + 901, T0 + 360_400, "BuyerB"));
    await second.service.settleInflight();
    await clock.advanceTo(clock.nowMs() + 30_000);
    await second.service.stop();
    expect(await gaps(database.db)).toEqual([
      { reason: "restart", from_slot: String(SLOT0 + 20), to_slot: String(SLOT0 + 900), affected_launches: 1 }
    ]);
    const rows = await launches(database.db);
    expect(rows.get("AliveMint")?.data_complete).toBe(false);
    expect(rows.get("AliveMint")?.data_incomplete_at?.getTime()).toBe(T0 + 8_000);
    expect(rows.get("EndedMint")?.data_complete).toBe(true);
    expect(rows.get("NewMint")?.data_complete).toBe(true);
  });

  it("treats a predecessor whose cursor went stale without a stop marker as crashed and starts the gap at its last durable slot", async () => {
    await reset();
    const crashedClock = new VirtualClock(T0 + 60_000);
    const crashed = stack(database.db, crashedClock);
    await crashed.service.start();
    feed(crashed, create("CrashMint", SLOT0, T0));
    await crashed.service.settleInflight();
    feed(crashed, trade("CrashMint", SLOT0 + 30, T0 + 12_000, "BuyerA"));
    await crashedClock.advanceTo(crashedClock.nowMs() + 6_000);
    const cursor = await database.db.query<{ last_slot: string; stopped_at: Date | null }>(
      "SELECT last_slot::text, stopped_at FROM recorder_checkpoints WHERE instance = $1",
      [crashed.service.instanceId]
    );
    expect(cursor.rows).toEqual([{ last_slot: String(SLOT0 + 30), stopped_at: null }]);
    const clock = new VirtualClock(crashedClock.nowMs() + 120_000);
    const replacement = stack(database.db, clock);
    await replacement.service.start();
    feed(replacement, trade("CrashMint", SLOT0 + 400, T0 + 160_000, "BuyerB"));
    await clock.advanceTo(clock.nowMs() + 20_000);
    await replacement.service.settleInflight();
    expect(await gaps(database.db)).toEqual([
      { reason: "restart", from_slot: String(SLOT0 + 30), to_slot: String(SLOT0 + 400), affected_launches: 1 }
    ]);
    expect((await launches(database.db)).get("CrashMint")?.data_incomplete_at?.getTime()).toBe(T0 + 12_000);
    await replacement.service.stop();
    await crashed.service.stop();
  });

  it("waits for a live predecessor that has not yet caught up instead of recording a gap at once", async () => {
    await reset();
    const clock = new VirtualClock(T0 + 60_000);
    const slow = stack(database.db, clock, { aggregateFlushMs: 1e9 });
    await slow.service.start();
    feed(slow, create("SlowMint", SLOT0, T0));
    await slow.service.settleInflight();
    await slow.service.stop();
    await database.db.query("UPDATE recorder_checkpoints SET stopped_at = NULL, updated_at = $1", [new Date(clock.nowMs())]);
    const fresh = stack(database.db, clock, { restartCheckDelayMs: 10_000, cursorStaleMs: 60_000, restartMaxWaitMs: 1e9 });
    await fresh.service.start();
    feed(fresh, trade("SlowMint", SLOT0 + 50, T0 + 20_000, "BuyerA"));
    await clock.advanceTo(clock.nowMs() + 30_000);
    expect(fresh.service.stats()).toMatchObject({ restartsCovered: 0, restartGaps: 0 });
    await database.db.query("UPDATE recorder_checkpoints SET last_slot = $1, updated_at = $2 WHERE instance = $3", [
      SLOT0 + 60,
      new Date(clock.nowMs()),
      slow.service.instanceId
    ]);
    await clock.advanceTo(clock.nowMs() + 15_000);
    expect(fresh.service.stats()).toMatchObject({ restartsCovered: 1, restartGaps: 0 });
    await fresh.service.stop();
    expect(await gaps(database.db)).toEqual([]);
  });

  it("falls back to tracked launch progress when no recorder has written a checkpoint yet", async () => {
    await reset();
    await database.db.query(
      `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, create_signature, create_slot, created_at, token_total_supply,
         initial_virtual_token, initial_virtual_quote, initial_real_token, last_trade_slot, last_trade_at)
       VALUES ('LegacyMint', 'curve', 'dev', 'dev', 'legacy', $1, $2, 1000000000000000, 1073000000000000, 30000000000, 793100000000000, $3, $4)`,
      [SLOT0, new Date(T0), SLOT0 + 40, new Date(T0 + 16_000)]
    );
    const clock = new VirtualClock(T0 + 600_000);
    const recorder = stack(database.db, clock);
    await recorder.service.start();
    feed(recorder, trade("LegacyMint", SLOT0 + 1_200, T0 + 500_000, "BuyerA"));
    await clock.advanceTo(clock.nowMs() + 20_000);
    await recorder.service.stop();
    expect(await gaps(database.db)).toEqual([
      { reason: "restart", from_slot: String(SLOT0 + 40), to_slot: String(SLOT0 + 1_200), affected_launches: 1 }
    ]);
    expect((await launches(database.db)).get("LegacyMint")?.data_incomplete_at?.getTime()).toBe(T0 + 16_000);
  });
});
