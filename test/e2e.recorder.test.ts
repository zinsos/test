import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveApp, type LiveApp } from "../src/app/live.js";
import { decodeLogs } from "../src/chain/events.js";
import { loadEnv } from "../src/config/env.js";
import { defaultStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import { SOL_QUOTE } from "../src/core/constants.js";
import type { LaunchCreatedEvent } from "../src/core/types.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { FakeLogsNode, loadFixtureTransactions, StubRpcServer, waitUntil } from "./e2e.helpers.js";

const FIXTURES = loadFixtureTransactions();
const PUMP_QUOTE = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const SOL_LAUNCH = "Bm2JFdprrQbStSPa9gcVDwQiMw6FsKGsfXRktofc5h6y";
const MIGRATED = [
  { mint: "2am58xUtW9a34qtSQKaHYc55fZXCFcr2ooDuxotepump", pool: "Hmsm5vDUFaA7CbSPSKfSSZiwc2mE5jTwQ6drfhUyu8SW", signature: "4uaZFYCy" },
  { mint: "66CFbDNx2ibizJvieBEfRX6tAUrW1qEc8Fm3N1AWfcJ9", pool: "DGeroK6u21ZzbPiFnGTZKUVRfVE5caMFzHdKuEctbutL", signature: "GK5Z3vZ6" }
];
const LAST_BLOCK_MS = Math.max(...FIXTURES.map((tx) => tx.blockTime * 1000));
const CREATES: LaunchCreatedEvent[] = FIXTURES.flatMap(
  (tx) =>
    decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 0, receivedAtMs: 0 }).events.filter(
      (event): event is LaunchCreatedEvent => event.kind === "create"
    )
);
const CREATED_MINTS = new Set(CREATES.map((event) => event.mint));
const LAST_CREATE_MS = Math.max(...CREATES.map((event) => event.timestampMs));
const MAX_SLOT = Math.max(...FIXTURES.map((tx) => tx.slot));
const CHECKPOINTS = [10, 30, 60, 120];

function strategy(): StrategyConfig {
  const config = defaultStrategyConfig();
  config.recorder.metadata.enabled = false;
  config.recorder.rpcSnapshotsEnabled = false;
  config.scorer.deepIntel.enabled = false;
  config.scorer.checkpointsSec = CHECKPOINTS;
  return config;
}

async function seedTrackedMigratingLaunches(database: TestDatabase): Promise<void> {
  for (const [index, launch] of MIGRATED.entries()) {
    await database.db.query(
      `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, name, symbol, quote_mint, create_signature, create_slot,
         created_at, token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token)
       VALUES ($1, $2, $3, $3, 'Earlier', 'EARLY', 'SOL', $4, $5, $6, 1000000000000000, 1073000000000000, 30000000000, 793100000000000)`,
      [
        launch.mint,
        `Curve${index}`,
        `EarlierDev${index}`,
        `earlier-create-${index}`,
        460_480_000 + index,
        new Date(LAST_BLOCK_MS - 40 * 60_000)
      ]
    );
  }
}

interface RunningNode {
  app: LiveApp;
  clock: VirtualClock;
  node: FakeLogsNode;
}

async function startRecorder(database: TestDatabase, node: FakeLogsNode, rpc: StubRpcServer): Promise<RunningNode> {
  const clock = new VirtualClock(LAST_BLOCK_MS + 1_000);
  const app = await startLiveApp({
    env: loadEnv({
      DATABASE_URL: database.url,
      MODULES: "recorder,scorer",
      TRADING_MODE: "paper",
      RPC_WS_URL: node.url,
      RPC_HTTP_URL: rpc.url
    }),
    config: strategy(),
    clock,
    db: database.db,
    port: 0
  });
  return { app, clock, node };
}

function sourceStats(app: LiveApp): Record<string, number> {
  return app.ingest?.stats().source ?? {};
}

async function receiveAll(running: RunningNode, alreadyReceived: number): Promise<void> {
  const expected = alreadyReceived + running.node.expectedReplayDeliveries();
  await waitUntil(() => (sourceStats(running.app).notifications ?? 0) >= expected, 10_000, "fixture replay");
}

async function advanceWithTraffic(running: RunningNode, untilMs: number): Promise<void> {
  let slot = MAX_SLOT;
  for (let at = running.clock.nowMs() + 5_000; at <= untilMs + 5_000; at += 5_000) {
    await running.clock.advanceTo(at);
    slot += 12;
    const before = sourceStats(running.app).notifications ?? 0;
    const delivered = running.node.keepalive(slot);
    await waitUntil(() => (sourceStats(running.app).notifications ?? 0) >= before + delivered, 5_000, "keepalive");
  }
}

async function count(database: TestDatabase, sql: string, params: unknown[] = []): Promise<number> {
  const result = await database.db.query<{ n: number }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

interface LaunchAggregateRow {
  mint: string;
  trade_count: number;
  buy_count: number;
  sell_count: number;
  unique_traders: number;
  last_trade_slot: string | null;
  last_virtual_token: string | null;
  last_virtual_quote: string | null;
  peak_mcap_quote: string | null;
  data_complete: boolean;
  quote_mint: string;
  pool: string | null;
  migrated_slot: string | null;
}

async function launchRows(database: TestDatabase): Promise<Map<string, LaunchAggregateRow>> {
  const result = await database.db.query<LaunchAggregateRow>(
    `SELECT mint, trade_count, buy_count, sell_count, unique_traders, last_trade_slot::text, last_virtual_token::text,
            last_virtual_quote::text, peak_mcap_quote::text, data_complete, quote_mint, pool, migrated_slot::text
       FROM launches ORDER BY mint`
  );
  return new Map(result.rows.map((row) => [row.mint, row]));
}

describe.skipIf(!hasTestDatabase)("end to end: websocket stream to recorder and scorer", () => {
  let database: TestDatabase;
  let node: FakeLogsNode;
  let rpc: StubRpcServer;
  let firstRun: Map<string, LaunchAggregateRow>;
  let firstTrades = 0;
  let firstScores = 0;

  beforeAll(async () => {
    database = await createTestDatabase("e2e_recorder");
    await seedTrackedMigratingLaunches(database);
    node = await FakeLogsNode.start({ transactions: FIXTURES });
    rpc = await StubRpcServer.start();
  }, 60_000);

  afterAll(async () => {
    await node?.close();
    await rpc?.close();
    await database?.drop();
  });

  it("records every launch, curve and pool trade, aggregates and checkpoint scores from a live logs stream", async () => {
    const running = await startRecorder(database, node, rpc);
    const { app } = running;
    expect(app.recorder).not.toBeNull();
    expect(app.scorer).not.toBeNull();
    expect(app.tracker).toBeNull();
    expect(app.trader).toBeNull();
    await receiveAll(running, 0);
    const stream = sourceStats(app);
    expect(stream.subscriptions).toBe(2);
    expect(stream.txDuplicates).toBeGreaterThan(0);
    expect(stream.decodeErrors).toBe(0);
    expect(stream.unknownEvents).toBe(0);
    await advanceWithTraffic(running, LAST_CREATE_MS + Math.max(...CHECKPOINTS) * 1_000);
    const pipeline = app.ingest?.stats().pipeline ?? {};
    expect(pipeline.poolLookupHits).toBe(2);
    expect(pipeline.applyErrors).toBe(0);
    for (const mint of CREATED_MINTS) {
      expect(app.market.get(mint)?.launchId).not.toBeNull();
    }
    const health = await fetch(`http://127.0.0.1:${app.httpPort}/healthz`);
    expect(health.status).toBe(200);
    const memory = new Map(
      [...CREATED_MINTS].map((mint) => {
        const launch = app.market.get(mint);
        return [mint, { trades: launch?.trades.length ?? 0, buys: launch?.buyCount ?? 0, sells: launch?.sellCount ?? 0, wallets: launch?.wallets.size ?? 0, lastSlot: launch?.lastSlot ?? 0, vt: launch?.virtualTokenReserves, peak: launch?.peakMcapQuote }];
      })
    );
    await app.stop("test");
    expect(sourceStats(app).pendingGap).toBe(0);
    expect(rpc.totalCalls()).toBe(0);

    const launches = await launchRows(database);
    expect(launches.size).toBe(CREATED_MINTS.size + MIGRATED.length);
    expect(launches.get(SOL_LAUNCH)?.quote_mint).toBe(SOL_QUOTE);
    for (const mint of CREATED_MINTS) {
      const row = launches.get(mint);
      expect(row, mint).toBeDefined();
      if (mint !== SOL_LAUNCH) {
        expect(row?.quote_mint).toBe(PUMP_QUOTE);
      }
      expect(row?.data_complete).toBe(true);
      const expected = memory.get(mint);
      expect(row?.trade_count).toBe(expected?.trades);
      expect(row?.buy_count).toBe(expected?.buys);
      expect(row?.sell_count).toBe(expected?.sells);
      expect(row?.unique_traders).toBe(expected?.wallets);
      if ((expected?.trades ?? 0) > 0) {
        expect(row?.last_trade_slot).toBe(String(expected?.lastSlot));
        expect(row?.last_virtual_token).toBe(String(expected?.vt));
        expect(BigInt(row?.peak_mcap_quote ?? "0")).toBe(expected?.peak);
      }
    }
    const withTrades = [...CREATED_MINTS].filter((mint) => (memory.get(mint)?.trades ?? 0) > 0);
    expect(withTrades.length).toBeGreaterThanOrEqual(4);

    for (const migrated of MIGRATED) {
      const row = launches.get(migrated.mint);
      expect(row?.pool).toBe(migrated.pool);
      expect(row?.migrated_slot).not.toBeNull();
      expect(row?.data_complete).toBe(false);
      const poolTrades = await database.db.query<{ venue: number; signature: string; is_buy: boolean }>(
        `SELECT t.venue, t.signature, t.is_buy FROM trades t JOIN launches l ON l.id = t.launch_id WHERE l.mint = $1`,
        [migrated.mint]
      );
      expect(poolTrades.rows).toHaveLength(1);
      expect(poolTrades.rows[0]?.venue).toBe(1);
      expect(poolTrades.rows[0]?.is_buy).toBe(true);
      expect(poolTrades.rows[0]?.signature.startsWith(migrated.signature)).toBe(true);
      expect(row?.trade_count).toBe(1);
    }

    firstTrades = await count(database, "SELECT count(*)::int AS n FROM trades");
    expect(await count(database, "SELECT count(*)::int AS n FROM trades WHERE venue = 0")).toBe(
      [...memory.values()].reduce((total, entry) => total + entry.trades, 0)
    );
    expect(await count(database, "SELECT count(*)::int AS n FROM trades WHERE venue = 1")).toBe(MIGRATED.length);
    expect(firstTrades).toBe(await count(database, "SELECT count(DISTINCT (signature, event_index))::int AS n FROM trades"));
    expect(await count(database, "SELECT count(*)::int AS n FROM trades t LEFT JOIN launches l ON l.id = t.launch_id WHERE l.id IS NULL")).toBe(0);

    const scores = await database.db.query<{ mint: string; checkpoint_sec: number; features: Record<string, number | null>; launch_id: string }>(
      "SELECT mint, checkpoint_sec, features, launch_id::text FROM launch_scores ORDER BY mint, checkpoint_sec"
    );
    firstScores = scores.rows.length;
    expect(new Set(scores.rows.map((row) => row.mint))).toEqual(CREATED_MINTS);
    expect(scores.rows).toHaveLength(CREATED_MINTS.size * CHECKPOINTS.length);
    for (const row of scores.rows) {
      expect(CHECKPOINTS).toContain(row.checkpoint_sec);
      expect(row.features.is_sol_quoted).toBe(row.mint === SOL_LAUNCH ? 1 : 0);
      expect(row.features.intel_coverage).toBeNull();
      expect(typeof row.features.mcap_multiple).toBe("number");
    }
    const joined = await count(database, "SELECT count(*)::int AS n FROM launch_scores s JOIN launches l ON l.id = s.launch_id AND l.mint = s.mint");
    expect(joined).toBe(firstScores);

    const gaps = await database.db.query<{ reason: string; affected_launches: number }>("SELECT reason, affected_launches FROM ingest_gaps");
    expect(gaps.rows).toEqual([{ reason: "restart", affected_launches: MIGRATED.length }]);
    firstRun = launches;
  }, 60_000);

  it("is idempotent when a restarted process receives the same stream again", async () => {
    const running = await startRecorder(database, node, rpc);
    const received = 0;
    await receiveAll(running, received);
    await advanceWithTraffic(running, LAST_CREATE_MS + 30_000);
    await running.app.stop("test");
    expect(await count(database, "SELECT count(*)::int AS n FROM trades")).toBe(firstTrades);
    expect(await count(database, "SELECT count(*)::int AS n FROM launch_scores")).toBe(firstScores);
    const launches = await launchRows(database);
    expect(launches.size).toBe(firstRun.size);
    for (const [mint, before] of firstRun) {
      const after = launches.get(mint);
      expect({ ...after, data_complete: null }, mint).toEqual({ ...before, data_complete: null });
      expect(after?.data_complete).toBe(false);
    }
    const restarts = await count(database, "SELECT count(*)::int AS n FROM ingest_gaps WHERE reason = 'restart'");
    expect(restarts).toBe(2);
    expect(node.connectionsOpened).toBe(2);
  }, 60_000);
});
