import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeLogs, type DecodedChainEvent } from "../src/chain/events.js";
import type { LargestTokenAccount, ParsedAccountInfo } from "../src/chain/rpc.js";
import { defaultStrategyConfig, type RecorderConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { ChainEvent, LaunchCreatedEvent, MigrationEvent, TradeEvent } from "../src/core/types.js";
import { toNumber, type Db } from "../src/db/pool.js";
import { IngestPipeline } from "../src/ingest/pipeline.js";
import { ReplayLogSource } from "../src/ingest/replaySource.js";
import { MarketState } from "../src/market/state.js";
import {
  computeOutcome,
  createRecorderModule,
  HolderSnapshotter,
  LaunchRegistry,
  MetadataFetcher,
  OutcomeFinalizer,
  outcomeParamsFrom,
  RecorderService,
  recomputeOutcomes,
  subjectFromLaunchState,
  type FetchLike,
  type SnapshotRpc
} from "../src/recorder/index.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

interface FixtureTx {
  signature: string;
  slot: number;
  blockTime: number;
  category: string;
  logs: string[];
}

const fixtures = (
  JSON.parse(readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8")) as FixtureTx[]
).sort((a, b) => a.slot - b.slot);

const START_MS = 1_792_767_900_000;
const HOUR_MS = 3_600_000;
const strategy = defaultStrategyConfig();
const recorderConfig: RecorderConfig = { ...strategy.recorder, rpcSnapshotMinTrades: 1 };

function fixture(prefix: string): FixtureTx {
  const tx = fixtures.find((candidate) => candidate.signature.startsWith(prefix));
  if (!tx) {
    throw new Error(`missing fixture ${prefix}`);
  }
  return tx;
}

function decodeTx(tx: FixtureTx): DecodedChainEvent[] {
  return decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 0, receivedAtMs: 0 }).events;
}

function eventOf<K extends DecodedChainEvent["kind"]>(tx: FixtureTx, kind: K): Extract<DecodedChainEvent, { kind: K }> {
  const event = decodeTx(tx).find((candidate): candidate is Extract<DecodedChainEvent, { kind: K }> => candidate.kind === kind);
  if (!event) {
    throw new Error(`missing ${kind} in ${tx.signature}`);
  }
  return event;
}

const template = eventOf(fixture("K48XDQLk"), "create");
const migrationOne = eventOf(fixture("GK5Z3vZ6WS"), "migrate");
const migrationTwo = eventOf(fixture("4uaZFYCyDw"), "migrate");
const pumpCreate = eventOf(fixture("2PaPPLbtTv"), "create");

function syntheticCreate(migration: MigrationEvent): LaunchCreatedEvent {
  return {
    ...template,
    mint: migration.mint,
    bondingCurve: migration.bondingCurve,
    devWallet: `dev-${migration.mint.slice(0, 8)}`,
    creator: `dev-${migration.mint.slice(0, 8)}`,
    name: `Synthetic${String.fromCharCode(0)} ${migration.mint.slice(0, 4)}`,
    tx: { signature: `synthetic-${migration.mint}`, slot: migration.tx.slot - 500, seq: 0, eventIndex: 0, receivedAtMs: 0 },
    timestampMs: migration.timestampMs - 200_000
  };
}

const syntheticOne = syntheticCreate(migrationOne);
const syntheticTwo = syntheticCreate(migrationTwo);

interface Stack {
  market: MarketState;
  bus: Bus;
  registry: LaunchRegistry;
  service: RecorderService;
  pipeline: IngestPipeline;
}

function buildStack(db: Db, clock: VirtualClock, recordRestartGap = true): Stack {
  const market = new MarketState({ maxTradesPerLaunch: 25_000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
  const bus = new Bus();
  const registry = new LaunchRegistry({ db });
  const service = new RecorderService({
    db,
    bus,
    market,
    clock,
    config: recorderConfig,
    registry,
    aggregateFlushMs: 1e9,
    recordRestartGap
  });
  const pipeline = new IngestPipeline({ market, bus, clock, poolLookup: registry.poolLookup });
  return { market, bus, registry, service, pipeline };
}

function feedEvent(stack: Stack, event: ChainEvent): void {
  stack.pipeline.handleBatch(
    { events: [event], truncated: false, incomplete: 0, unknown: 0 },
    { signature: event.tx.signature, slot: event.tx.slot, seq: event.tx.seq, receivedAtMs: event.tx.receivedAtMs }
  );
}

async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: unknown }>(sql, params);
  return toNumber(result.rows[0]?.n);
}

async function launchRow(db: Db, mint: string): Promise<Record<string, unknown>> {
  const result = await db.query("SELECT * FROM launches WHERE mint = $1", [mint]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`launch ${mint} missing`);
  }
  return row;
}

const createdMints = new Set<string>([
  syntheticOne.mint,
  syntheticTwo.mint,
  ...fixtures.flatMap(decodeTx).flatMap((event) => (event.kind === "create" ? [event.mint] : []))
]);
const expectedCurveTrades = fixtures
  .flatMap(decodeTx)
  .filter((event): event is TradeEvent => event.kind === "trade" && createdMints.has(event.mint)).length;
const expectedTrades = expectedCurveTrades + 2;

describe.skipIf(!hasTestDatabase)("recorder with postgres", () => {
  let testDb: TestDatabase;
  let db: Db;
  const clock = new VirtualClock(START_MS);
  let first: Stack;
  let second: Stack;

  beforeAll(async () => {
    testDb = await createTestDatabase("recorder_it");
    db = testDb.db;
    first = buildStack(db, clock);
    await first.service.start();
  });

  afterAll(async () => {
    await first?.service.stop();
    await second?.service.stop();
    await testDb?.drop();
  });

  it("creates the daily trade partitions on start", async () => {
    expect(await count(db, "SELECT count(*) AS n FROM pg_class WHERE relname = 'trades_20261023'")).toBe(1);
    expect(await count(db, "SELECT count(*) AS n FROM pg_class WHERE relname = 'trades_20261026'")).toBe(1);
  });

  it("records every launch and its trades, queuing trades that arrive before the launch id", async () => {
    feedEvent(first, syntheticOne);
    feedEvent(first, syntheticTwo);
    await first.service.settleInflight();
    expect(first.registry.isTracked(syntheticTwo.mint)).toBe(true);
    first.market.evict(START_MS + 1e13, (launch) => launch.mint !== syntheticTwo.mint);
    expect(first.market.get(syntheticTwo.mint)).toBeUndefined();

    const source = new ReplayLogSource({ clock });
    await first.pipeline.attach(source);
    let queuedAtCreate = -1;
    for (const tx of fixtures) {
      source.push({ ...tx, receivedAtMs: START_MS });
      if (tx.signature.startsWith("K48XDQLk")) {
        queuedAtCreate = first.service.queuedCount(template.mint);
      }
    }
    expect(queuedAtCreate).toBe(1);
    await first.service.settleInflight();
    await first.service.flush();

    expect(await count(db, "SELECT count(*) AS n FROM launches")).toBe(10);
    expect(await count(db, "SELECT count(*) AS n FROM trades")).toBe(expectedTrades);
    const solLaunch = await launchRow(db, template.mint);
    expect(first.market.get(template.mint)?.launchId).toBe(toNumber(solLaunch.id));
    expect(solLaunch.quote_mint).toBe("SOL");
    expect(solLaunch.dev_wallet).toBe(template.devWallet);
    expect(solLaunch.creator).toBe(template.creator);
    expect(solLaunch.create_signature).toBe(template.tx.signature);
    expect(solLaunch.initial_virtual_quote).toBe(30_000_000_000n);
    const devTrade = await db.query("SELECT * FROM trades WHERE launch_id = $1", [solLaunch.id]);
    expect(devTrade.rows).toHaveLength(1);
    expect(devTrade.rows[0]).toMatchObject({ wallet: template.devWallet, is_buy: true, venue: 0, user_quote: 6_000_000_000n });
    const synthetic = await launchRow(db, syntheticOne.mint);
    expect(synthetic.name).toBe(`Synthetic ${syntheticOne.mint.slice(0, 4)}`);
    expect(first.service.stats()).toMatchObject({ launchesInserted: 10, launchInsertFailures: 0, queuedDropped: 0 });
    expect(first.service.stats().untrackedEvents).toBeGreaterThan(0);
  });

  it("stores pump-quoted launches in their own quote units", async () => {
    const row = await launchRow(db, pumpCreate.mint);
    expect(row.quote_mint).toBe(pumpCreate.quoteMint);
    expect(row.initial_virtual_quote).toBe(pumpCreate.virtualQuoteReserves);
    expect(await count(db, "SELECT count(*) AS n FROM launches WHERE quote_mint <> 'SOL'")).toBe(7);
  });

  it("flushes launch aggregates that match the in-memory launch state", async () => {
    const row = await launchRow(db, pumpCreate.mint);
    const state = first.market.get(pumpCreate.mint);
    expect(state).toBeDefined();
    expect(toNumber(row.trade_count)).toBe(3);
    expect(toNumber(row.buy_count)).toBe(3);
    expect(toNumber(row.sell_count)).toBe(0);
    expect(toNumber(row.unique_traders)).toBe(state?.wallets.size);
    expect(toNumber(row.last_trade_slot)).toBe(state?.lastSlot);
    expect(row.last_virtual_token).toBe(state?.virtualTokenReserves);
    expect(row.last_virtual_quote).toBe(state?.virtualQuoteReserves);
    expect(row.peak_mcap_quote).toBe(state?.peakMcapQuote);
    expect((row.peak_at as Date).getTime()).toBe(state?.peakAtMs);
    expect(toNumber(row.peak_slot)).toBe(state?.peakSlot);
    expect((row.last_trade_at as Date).getTime()).toBe(state?.lastTradeAtMs);
  });

  it("maps migration pools for in-memory and evicted launches and records their pool trades", async () => {
    for (const migration of [migrationOne, migrationTwo]) {
      const row = await launchRow(db, migration.mint);
      expect(row.pool).toBe(migration.pool);
      expect((row.migrated_at as Date).getTime()).toBe(migration.timestampMs);
      expect(toNumber(row.migrated_slot)).toBe(migration.tx.slot);
      expect(first.registry.mintForPool(migration.pool)).toBe(migration.mint);
      const trades = await db.query("SELECT venue, wallet FROM trades WHERE launch_id = $1", [row.id]);
      expect(trades.rows).toEqual([expect.objectContaining({ venue: 1 })]);
    }
    expect(first.pipeline.stats().poolLookupHits).toBe(1);
  });

  it("records ingest gaps and marks launches tracked during the gap as incomplete", async () => {
    const gapSlot = 460486912;
    first.bus.emit("gap", {
      source: "ws",
      fromSlot: gapSlot,
      toSlot: 460486969,
      startedAtMs: START_MS - 60_000,
      endedAtMs: START_MS - 30_000,
      reason: "closed 1006"
    });
    await first.service.settleInflight();
    const gaps = await db.query("SELECT * FROM ingest_gaps");
    expect(gaps.rows).toHaveLength(1);
    expect(gaps.rows[0]).toMatchObject({ source: "ws", reason: "closed 1006", affected_launches: 6 });
    expect(toNumber(gaps.rows[0]?.from_slot)).toBe(gapSlot);
    expect(await count(db, "SELECT count(*) AS n FROM launches WHERE NOT data_complete AND create_slot > $1", [gapSlot])).toBe(0);
    expect(await count(db, "SELECT count(*) AS n FROM launches WHERE NOT data_complete")).toBe(6);
    expect(first.market.get(syntheticOne.mint)?.dataComplete).toBe(false);
    expect(first.market.get(pumpCreate.mint)?.dataComplete).toBe(true);
  });

  it("is idempotent when the same transactions are replayed through the same recorder", async () => {
    const before = await db.query("SELECT mint, trade_count, buy_count, unique_traders, peak_mcap_quote FROM launches ORDER BY mint");
    const replay = new ReplayLogSource({ clock });
    await first.pipeline.attach(replay);
    for (const tx of fixtures) {
      replay.push(tx);
    }
    await first.service.settleInflight();
    await first.service.flush();
    expect(await count(db, "SELECT count(*) AS n FROM launches")).toBe(10);
    expect(await count(db, "SELECT count(*) AS n FROM trades")).toBe(expectedTrades);
    const after = await db.query("SELECT mint, trade_count, buy_count, unique_traders, peak_mcap_quote FROM launches ORDER BY mint");
    expect(after.rows).toEqual(before.rows);
    expect(first.service.stats().tradeDuplicates).toBeGreaterThan(0);
  });

  it("resumes after a restart, records the restart gap and stays idempotent on replay", async () => {
    await first.service.stop();
    const before = await db.query("SELECT mint, trade_count, buy_count, sell_count, last_trade_slot, pool FROM launches ORDER BY mint");
    second = buildStack(db, clock);
    await second.service.start();
    expect(second.registry.size).toBe(10);
    expect(second.registry.mintForPool(migrationTwo.pool)).toBe(migrationTwo.mint);
    const restart = await db.query("SELECT * FROM ingest_gaps WHERE reason = 'restart'");
    expect(restart.rows).toHaveLength(1);
    expect(restart.rows[0]?.affected_launches).toBe(4);
    expect(await count(db, "SELECT count(*) AS n FROM launches WHERE data_complete")).toBe(0);

    feedEvent(second, syntheticOne);
    feedEvent(second, syntheticTwo);
    const replay = new ReplayLogSource({ clock });
    await second.pipeline.attach(replay);
    for (const tx of fixtures) {
      replay.push(tx);
    }
    await second.service.settleInflight();
    await second.service.flush();
    expect(await count(db, "SELECT count(*) AS n FROM launches")).toBe(10);
    expect(await count(db, "SELECT count(*) AS n FROM trades")).toBe(expectedTrades);
    const after = await db.query("SELECT mint, trade_count, buy_count, sell_count, last_trade_slot, pool FROM launches ORDER BY mint");
    expect(after.rows).toEqual(before.rows);
    expect(second.service.stats().launchesInserted).toBe(0);
    expect(second.service.stats().tradesReplayedBeforeResume).toBe(expectedTrades);
    expect(second.market.get(template.mint)?.launchId).toBe(second.registry.launchId(template.mint));
  });

  it("writes trade and rpc holder snapshots at each checkpoint", async () => {
    const launchId = second.registry.launchId(template.mint);
    const state = second.market.get(template.mint);
    if (launchId === undefined || !state) {
      throw new Error("launch not tracked");
    }
    const rpcCalls: string[] = [];
    const rpc: SnapshotRpc = {
      async getTokenLargestAccounts(mint: string): Promise<LargestTokenAccount[]> {
        rpcCalls.push(`largest:${mint}`);
        return [
          { address: "curve-account", amount: "700000000000000", decimals: 6 },
          { address: "dev-account", amount: "200000000000000", decimals: 6 },
          { address: "other-account", amount: "100000000000000", decimals: 6 }
        ];
      },
      async getMultipleParsedAccounts(addresses: string[]): Promise<Array<ParsedAccountInfo | null>> {
        rpcCalls.push(`accounts:${addresses.length}`);
        const owners = [template.bondingCurve, template.devWallet, null];
        return owners.map((owner) =>
          owner === null ? null : { owner: "token", lamports: 1, data: { parsed: { info: { owner } } } }
        );
      },
      stats: () => ({ calls: 0, errors: 0, queued: 0, active: 0 })
    };
    const snapshotter = new HolderSnapshotter({ db, clock, market: second.market, rpc, config: recorderConfig });
    snapshotter.start();
    expect(snapshotter.schedule({ launchId, mint: template.mint, createdAtMs: template.timestampMs })).toBe(true);
    await clock.advanceTo(clock.nowMs());
    await snapshotter.flush();
    expect(await count(db, "SELECT count(*) AS n FROM holder_snapshots WHERE launch_id = $1", [launchId])).toBe(4);
    await clock.advanceTo(template.timestampMs + 905_000);
    await snapshotter.stop();
    const rows = await db.query("SELECT * FROM holder_snapshots WHERE launch_id = $1 ORDER BY source, checkpoint_sec", [launchId]);
    expect(rows.rows.map((row) => `${row.source}:${row.checkpoint_sec}`)).toEqual([
      "rpc:30",
      "rpc:60",
      "rpc:300",
      "rpc:900",
      "trades:30",
      "trades:60",
      "trades:300",
      "trades:900"
    ]);
    const tradeRow = rows.rows.find((row) => row.source === "trades" && row.checkpoint_sec === 60);
    expect(tradeRow).toMatchObject({ holder_count: 1 });
    expect(tradeRow?.dev_share).toBeGreaterThan(0.05);
    expect(tradeRow?.mcap_quote).toBe(state.mcapQuote());
    expect(tradeRow?.holders).toEqual([expect.objectContaining({ wallet: template.devWallet })]);
    const rpcRow = rows.rows.find((row) => row.source === "rpc" && row.checkpoint_sec === 60);
    expect(rpcRow?.curve_share).toBeCloseTo(0.7, 6);
    expect(rpcRow?.dev_share).toBeCloseTo(0.2, 6);
    expect(rpcRow?.top10_share).toBeCloseTo(0.3, 6);
    expect(rpcCalls).toContain(`largest:${template.mint}`);
  });

  it("stores fetched metadata and failures on the launch row", async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.includes("broken")
        ? new Response("gone", { status: 410 })
        : new Response(JSON.stringify({ name: "Meta", twitter: "https://x.com/meta", telegram: "https://t.me/meta" }));
    const fetcher = new MetadataFetcher({ db, clock, market: second.market, config: recorderConfig.metadata, fetchImpl });
    fetcher.start();
    const okId = second.registry.launchId(template.mint) ?? 0;
    const badId = second.registry.launchId(pumpCreate.mint) ?? 0;
    fetcher.enqueue({ launchId: okId, mint: template.mint, uri: "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" });
    fetcher.enqueue({ launchId: badId, mint: pumpCreate.mint, uri: "https://broken.example/x.json" });
    await fetcher.drain();
    const ok = await launchRow(db, template.mint);
    expect(ok).toMatchObject({ has_twitter: true, has_telegram: true, has_website: false, metadata_error: null });
    expect((ok.metadata as Record<string, unknown>).twitter).toBe("https://x.com/meta");
    expect(ok.metadata_fetched_at).toBeInstanceOf(Date);
    const bad = await launchRow(db, pumpCreate.mint);
    expect(bad).toMatchObject({ metadata: null, has_twitter: null, metadata_error: "http 410" });
    expect(second.market.get(template.mint)?.metadata?.twitter).toBe("https://x.com/meta");
  });

  it("labels outcomes, finalizes old launches and stops tracking them", async () => {
    second.market.evict(clock.nowMs() + 1e13, (launch) => launch.mint !== syntheticTwo.mint);
    expect(second.market.get(syntheticTwo.mint)).toBeUndefined();
    const finalizer = new OutcomeFinalizer({
      db,
      clock,
      market: second.market,
      registry: second.registry,
      bus: second.bus,
      config: recorderConfig,
      bundleSlotWindow: strategy.scorer.bundleSlotWindow,
      beforeLoad: () => second.service.flush()
    });
    finalizer.start();
    const early = await finalizer.tick();
    expect(early).toEqual({ computed: 10, finalized: 0, remaining: 0 });
    expect(await count(db, "SELECT count(*) AS n FROM launch_outcomes")).toBe(10);
    const migrated = await db.query(
      "SELECT o.* FROM launch_outcomes o JOIN launches l ON l.id = o.launch_id WHERE l.mint = ANY($1)",
      [[migrationOne.mint, migrationTwo.mint]]
    );
    expect(migrated.rows.map((row) => row.status)).toEqual(["migrated", "migrated"]);
    expect(migrated.rows.every((row) => row.finalized === false)).toBe(true);
    expect(second.registry.size).toBe(10);
    expect(finalizer.stats().fromDatabase).toBe(1);
    const stillTracked = second.registry.size;

    const idle = await finalizer.tick();
    expect(idle.computed).toBe(0);

    await clock.advanceTo(template.timestampMs + 25 * HOUR_MS);
    expect(finalizer.stats().finalized).toBe(stillTracked);
    expect(finalizer.stats().ticks).toBeGreaterThan(10);
    expect(second.registry.size).toBe(0);
    const late = await finalizer.tick();
    expect(late).toEqual({ computed: 0, finalized: 0, remaining: 0 });
    expect(await count(db, "SELECT count(*) AS n FROM launches WHERE tracking_ended_at IS NULL")).toBe(0);
    expect(await count(db, "SELECT count(*) AS n FROM launch_outcomes WHERE finalized")).toBe(10);
    await finalizer.stop();

    const solOutcome = await db.query(
      "SELECT o.* FROM launch_outcomes o JOIN launches l ON l.id = o.launch_id WHERE l.mint = $1",
      [template.mint]
    );
    const state = second.market.get(template.mint);
    if (!state) {
      throw new Error("state missing");
    }
    const expected = computeOutcome({
      ...subjectFromLaunchState(1, state),
      nowMs: (solOutcome.rows[0]?.computed_at as Date).getTime(),
      params: outcomeParamsFrom(recorderConfig, strategy.scorer.bundleSlotWindow)
    });
    expect(solOutcome.rows[0]).toMatchObject({
      status: expected.status,
      trade_count: 1,
      unique_traders: 1,
      initial_mcap_quote: expected.initialMcapQuote,
      peak_mcap_quote: expected.peakMcapQuote,
      final_mcap_quote: expected.finalMcapQuote
    });
    const evicted = await db.query(
      "SELECT o.status, o.trade_count, o.peak_mcap_quote FROM launch_outcomes o JOIN launches l ON l.id = o.launch_id WHERE l.mint = $1",
      [migrationTwo.mint]
    );
    expect(evicted.rows[0]).toMatchObject({ status: "migrated", trade_count: 1 });
    expect(finalizer.stats().fromDatabase).toBeGreaterThan(0);
    const pumpRow = await launchRow(db, pumpCreate.mint);
    expect(toNumber(pumpRow.trade_count)).toBe(3);
    expect(pumpRow.tracking_ended_at).toBeInstanceOf(Date);
  });

  it("stops recording trades for finalized launches", async () => {
    const before = await count(db, "SELECT count(*) AS n FROM trades");
    const trade = eventOf(fixture("3UvKmUrNDc"), "trade");
    second.bus.emit("chain", { ...trade, tx: { ...trade.tx, signature: "fresh-signature" } });
    await second.service.flush();
    expect(await count(db, "SELECT count(*) AS n FROM trades")).toBe(before);
  });

  it("recomputes outcome labels after a config change without reopening tracking", async () => {
    const strict = defaultStrategyConfig();
    strict.recorder.outcome.deadMaxMcapMultiple = 0.01;
    const result = await recomputeOutcomes(db, {
      from: new Date(0),
      to: new Date(START_MS + HOUR_MS),
      config: strict,
      nowMs: clock.nowMs()
    });
    expect(result).toEqual({ launches: 10, finalized: 10 });
    expect(await count(db, "SELECT count(*) AS n FROM launch_outcomes WHERE status = 'died'")).toBe(0);
    expect(await count(db, "SELECT count(*) AS n FROM launch_outcomes WHERE status = 'migrated'")).toBe(2);
    expect(await count(db, "SELECT count(*) AS n FROM launches WHERE tracking_ended_at IS NULL")).toBe(0);
  });
});

describe.skipIf(!hasTestDatabase)("recorder module factory", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase("recorder_module");
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it("wires recorder, metadata and snapshots and flushes everything on stop", async () => {
    const db = testDb.db;
    const clock = new VirtualClock(template.timestampMs + 1_000);
    const market = new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    const bus = new Bus();
    const fetched: string[] = [];
    const module = createRecorderModule({
      db,
      rpc: null,
      bus,
      market,
      clock,
      config: strategy,
      env: { METADATA_GATEWAY: "https://gw.example/ipfs/" },
      fetchImpl: async (url) => {
        fetched.push(url);
        return new Response(JSON.stringify({ name: "x", website: "https://x.io" }));
      },
      marketEviction: { intervalSec: 60 }
    });
    const pipeline = new IngestPipeline({ market, bus, clock, poolLookup: module.poolLookup });
    await module.start();
    const source = new ReplayLogSource({ clock });
    await pipeline.attach(source);
    source.push(fixture("K48XDQLk"));
    await module.service.settleInflight();
    await module.metadata.drain();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.startsWith("https://gw.example/ipfs/") || !template.uri.includes("ipfs")).toBe(true);
    await clock.advanceTo(template.timestampMs + 40_000);
    await module.stop();
    expect(await count(db, "SELECT count(*) AS n FROM trades")).toBe(1);
    expect(await count(db, "SELECT count(*) AS n FROM holder_snapshots WHERE source = 'trades'")).toBe(1);
    const row = await db.query("SELECT has_website, trade_count FROM launches");
    expect(row.rows[0]).toMatchObject({ has_website: true, trade_count: 1 });
    const stats = module.stats();
    expect(stats.recorder?.launchesInserted).toBe(1);
    expect(stats.snapshots?.tradeSnapshots).toBe(1);
  });
});
