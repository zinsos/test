import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dashboardTokenProblem, startLiveApp } from "../src/app/live.js";
import type { RpcClient } from "../src/chain/rpc.js";
import { loadEnv } from "../src/config/env.js";
import { defaultStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import { decodeLogs } from "../src/chain/events.js";
import type { Db } from "../src/db/pool.js";
import { DatabaseWaitAborted, waitForDatabase } from "../src/db/wait.js";
import { ReplayLogSource, type ReplayTransaction } from "../src/ingest/replaySource.js";
import { openStream } from "./analytics.sse.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

interface FixtureTx {
  signature: string;
  slot: number;
  blockTime: number;
  logs: string[];
  err?: unknown;
}

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8")) as FixtureTx[];
const START_MS = Math.min(...fixtures.map((tx) => tx.blockTime * 1000));
const CREATED_MINTS = new Set(
  fixtures
    .filter((tx) => tx.err === undefined || tx.err === null)
    .flatMap((tx) => decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 0, receivedAtMs: 0 }).events)
    .flatMap((event) => (event.kind === "create" ? [event.mint] : []))
);

function replayTransactions(): ReplayTransaction[] {
  return fixtures.map((tx) => ({ signature: tx.signature, slot: tx.slot, logs: tx.logs, err: tx.err ?? null, receivedAtMs: tx.blockTime * 1000 }));
}

function config(): StrategyConfig {
  const strategy = defaultStrategyConfig();
  strategy.recorder.metadata.enabled = false;
  strategy.recorder.rpcSnapshotsEnabled = false;
  return strategy;
}

function env(databaseUrl: string, modules: string) {
  return loadEnv({
    DATABASE_URL: databaseUrl,
    MODULES: modules,
    TRADING_MODE: "paper",
    RPC_WS_URL: "ws://127.0.0.1:9",
    DASHBOARD_TOKEN: "s3cret-dashboard-token-for-tests"
  });
}

async function count(database: TestDatabase, sql: string): Promise<number> {
  const result = await database.db.query<{ n: number }>(sql);
  return Number(result.rows[0]?.n ?? 0);
}

describe.skipIf(!hasTestDatabase)("live app wiring", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("app_live");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("runs recorder, scorer, tracker, paper trader and dashboard on one stream and shuts down cleanly", async () => {
    const clock = new VirtualClock(START_MS);
    const app = await startLiveApp({
      env: env(database.url, "recorder,scorer,tracker,trader,dashboard"),
      config: config(),
      clock,
      db: database.db,
      rpc: null,
      source: new ReplayLogSource({ clock, transactions: replayTransactions() }),
      port: 0
    });
    expect([...app.modules].sort()).toEqual(["dashboard", "recorder", "scorer", "tracker", "trader"]);
    expect(app.trader).not.toBeNull();
    expect(app.runId).not.toBeNull();
    expect(app.market.size).toBeGreaterThan(0);
    const health = await fetch(`http://127.0.0.1:${app.httpPort}/healthz`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    expect((await fetch(`http://127.0.0.1:${app.httpPort}/api/summary`)).status).toBe(401);
    const summary = await fetch(`http://127.0.0.1:${app.httpPort}/api/recorder/health`, { headers: { authorization: "Bearer s3cret-dashboard-token-for-tests" } });
    expect(summary.status).toBe(200);
    const body = (await summary.json()) as { process: { trader: { open: number } } };
    expect(body.process.trader.open).toBe(0);
    const stats = app.stats() as { pipeline: { emitted: number }; risk: { runId: number } };
    expect(stats.pipeline.emitted).toBeGreaterThan(0);
    expect(stats.risk.runId).toBe(app.runId);
    const liveStatus = await fetch(`http://127.0.0.1:${app.httpPort}/api/live/status`, { headers: { authorization: "Bearer s3cret-dashboard-token-for-tests" } });
    expect(await liveStatus.json()).toMatchObject({ enabled: true, tradingActive: true, clients: 0 });
    expect((await fetch(`http://127.0.0.1:${app.httpPort}/api/live/stream`)).status).toBe(401);
    const stream = await openStream(app.httpPort, "/api/live/stream?token=s3cret-dashboard-token-for-tests");
    expect(stream.status).toBe(200);
    expect((await stream.next((message) => message.event === "hello")).data).toMatchObject({ tradingActive: true, positions: [] });
    const scored = [...app.market.all()].find((launch) => launch.isSolQuoted);
    expect(scored).toBeDefined();
    app.bus.emit("score", {
      mint: scored?.mint ?? "",
      launchId: scored?.launchId ?? null,
      checkpointSec: 60,
      computedAtMs: clock.nowMs(),
      slot: 1,
      score: 12,
      hardBlocked: false,
      flags: [],
      features: {},
      contributions: {},
      weightsVersion: "test"
    });
    const scoreEvent = await stream.next((message) => message.data.kind === "score");
    expect(scoreEvent.data).toMatchObject({ mint: scored?.mint, category: "score", tone: "good" });
    expect(String(scoreEvent.data.text)).toMatch(/^Scored .+ 60s: 12 \(clean\)$/);
    app.bus.emit("signal", { id: null, type: "score_momentum", mint: scored?.mint ?? "", atMs: clock.nowMs(), slot: 1, riskScore: 12, wallets: [], meta: {} });
    await clock.advanceTo(clock.nowMs() + 3_000);
    const outcome = await stream.next((message) => message.data.kind === "entering" || message.data.kind === "skipped");
    expect(outcome.data.mint).toBe(scored?.mint);
    await clock.advanceTo(clock.nowMs() + 15_000);
    await stream.next((message) => message.event === "heartbeat");
    stream.close();
    await app.recorder?.service.settleInflight();
    await app.stop("test");
    await app.stop("again");
    expect(CREATED_MINTS.size).toBeGreaterThan(0);
    expect(await count(database, "SELECT count(*)::int AS n FROM launches")).toBe(CREATED_MINTS.size);
    expect(await count(database, "SELECT count(*)::int AS n FROM trades")).toBeGreaterThan(0);
    const run = await database.db.query<{ mode: string; ended_at: Date | null }>("SELECT mode, ended_at FROM strategy_runs WHERE id = $1", [app.runId]);
    expect(run.rows[0]).toEqual({ mode: "paper", ended_at: null });
    await expect(fetch(`http://127.0.0.1:${app.httpPort}/healthz`)).rejects.toThrow();
  });

  it("runs a trader-only service with its own signal engine, resumes the paper run and serves health", async () => {
    const firstRun = await database.db.query<{ id: string }>("SELECT id FROM strategy_runs WHERE mode = 'paper' ORDER BY id DESC LIMIT 1");
    const clock = new VirtualClock(START_MS);
    const app = await startLiveApp({
      env: env(database.url, "trader"),
      config: config(),
      clock,
      db: database.db,
      rpc: null,
      source: new ReplayLogSource({ clock, transactions: replayTransactions() }),
      port: 0
    });
    expect(app.recorder).toBeNull();
    expect(app.scorer).not.toBeNull();
    expect(app.tracker).not.toBeNull();
    expect(String(app.runId)).toBe(String(firstRun.rows[0]?.id));
    for (const launch of app.market.all()) {
      expect(launch.isSolQuoted).toBe(true);
    }
    const health = await fetch(`http://127.0.0.1:${app.httpPort}/healthz`);
    expect(health.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${app.httpPort}/api/summary`)).status).toBe(404);
    await app.stop("test");
  });

  it("records signals without a run when the tracker runs without a trader", async () => {
    const clock = new VirtualClock(START_MS);
    const app = await startLiveApp({
      env: env(database.url, "scorer,tracker"),
      config: config(),
      clock,
      db: database.db,
      rpc: null,
      source: new ReplayLogSource({ clock, transactions: [] }),
      port: 0
    });
    expect(app.trader).toBeNull();
    const launch = [...app.market.all()][0];
    app.bus.emit("signal", {
      id: null,
      type: "smart_convergence",
      mint: launch?.mint ?? "ObservedMint",
      atMs: START_MS,
      slot: 1,
      riskScore: 10,
      wallets: ["A", "B", "C"],
      meta: {}
    });
    await app.stop("test");
    const rows = await database.db.query<{ run_id: string | null; acted: boolean }>("SELECT run_id, acted FROM signals WHERE run_id IS NULL");
    expect(rows.rows).toEqual([{ run_id: null, acted: false }]);
  });

  it("serves only the dashboard without opening a chain stream", async () => {
    const clock = new VirtualClock(START_MS);
    const app = await startLiveApp({
      env: loadEnv({ DATABASE_URL: database.url, MODULES: "dashboard", DASHBOARD_TOKEN: "dashboard-only-token-0123456789" }),
      config: config(),
      clock,
      db: database.db,
      rpc: null,
      port: 0
    });
    expect(app.ingest).toBeNull();
    expect(app.scorer).toBeNull();
    expect((await fetch(`http://127.0.0.1:${app.httpPort}/healthz`)).status).toBe(200);
    expect((app.stats() as { stream: unknown }).stream).toBeNull();
    const stream = await openStream(app.httpPort, "/api/live/stream", { Authorization: "Bearer dashboard-only-token-0123456789" });
    expect((await stream.next((message) => message.event === "hello")).data).toMatchObject({ tradingActive: false, positions: [] });
    await clock.advanceTo(START_MS + 15_000);
    expect((await stream.next((message) => message.event === "heartbeat")).data).toMatchObject({ clients: 1, tradingActive: false });
    await app.stop("test");
    await stream.ended();
  });

  it("refuses to serve the dashboard without a long, non-placeholder token", async () => {
    for (const token of [undefined, "", "short-token", "change-me-to-a-long-random-string"]) {
      const started = startLiveApp({
        env: loadEnv({ DATABASE_URL: database.url, MODULES: "dashboard", ...(token === undefined ? {} : { DASHBOARD_TOKEN: token }) }),
        config: config(),
        clock: new VirtualClock(START_MS),
        db: database.db,
        rpc: null,
        port: 0
      });
      await expect(started).rejects.toThrow(/DASHBOARD_TOKEN/);
    }
    expect(dashboardTokenProblem("a-long-random-dashboard-token-value")).toBeNull();
  });

  it("serves an open dashboard only with DASHBOARD_ALLOW_OPEN", async () => {
    const app = await startLiveApp({
      env: loadEnv({ DATABASE_URL: database.url, MODULES: "dashboard", DASHBOARD_ALLOW_OPEN: "true" }),
      config: config(),
      clock: new VirtualClock(START_MS),
      db: database.db,
      rpc: null,
      port: 0
    });
    try {
      expect((await fetch(`http://127.0.0.1:${app.httpPort}/api/recorder/health`)).status).toBe(200);
    } finally {
      await app.stop("test");
    }
  });

  it("keeps a recorder service with the dashboard unhealthy until its stream has delivered something", async () => {
    const clock = new VirtualClock(START_MS);
    const source = new ReplayLogSource({ clock, transactions: [] });
    const app = await startLiveApp({ env: env(database.url, "recorder,dashboard"), config: config(), clock, db: database.db, rpc: null, source, port: 0 });
    try {
      const before = await fetch(`http://127.0.0.1:${app.httpPort}/healthz`);
      expect({ status: before.status, body: await before.json() }).toMatchObject({ status: 503, body: { db: "ok", ready: false } });
      const first = replayTransactions()[0];
      if (first) {
        source.push(first);
      }
      expect((await fetch(`http://127.0.0.1:${app.httpPort}/healthz`)).status).toBe(200);
    } finally {
      await app.stop("test");
    }
  });

  it("keeps a recorder service unhealthy until its stream has delivered something", async () => {
    const clock = new VirtualClock(START_MS);
    const source = new ReplayLogSource({ clock, transactions: [] });
    const app = await startLiveApp({ env: env(database.url, "recorder"), config: config(), clock, db: database.db, rpc: null, source, port: 0 });
    const before = await fetch(`http://127.0.0.1:${app.httpPort}/healthz`);
    expect({ status: before.status, body: await before.json() }).toMatchObject({ status: 503, body: { db: true, ready: false } });
    const first = replayTransactions()[0];
    if (first) {
      source.push(first);
    }
    const after = await fetch(`http://127.0.0.1:${app.httpPort}/healthz`);
    expect(after.status).toBe(200);
    await app.stop("test");
  });

  it("lets a trader-only service score from stored wallet intel without making wallet-intel RPC calls", async () => {
    const calls: string[] = [];
    const rpc = {
      stats: () => ({ calls: calls.length, errors: 0, queued: 0, active: 0 }),
      getSignaturesForAddress: async (address: string) => {
        calls.push(`signatures:${address}`);
        return [];
      },
      getParsedTransaction: async (signature: string) => {
        calls.push(`transaction:${signature}`);
        return null;
      },
      getTokenLargestAccounts: async () => [],
      getMultipleParsedAccounts: async () => []
    } as unknown as RpcClient;
    const clock = new VirtualClock(START_MS + 60_000);
    const app = await startLiveApp({
      env: env(database.url, "trader"),
      config: config(),
      clock,
      db: database.db,
      rpc,
      source: new ReplayLogSource({ clock, transactions: [] }),
      port: 0
    });
    try {
      const template = fixtures
        .flatMap((tx) => decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 0, receivedAtMs: 0 }).events)
        .find((event) => event.kind === "create");
      if (!template || template.kind !== "create") {
        throw new Error("create fixture missing");
      }
      const mint = "StoredIntelMint1111111111111111111111111111";
      app.market.apply({ ...template, mint, quoteMint: "SOL", timestampMs: START_MS, tx: { ...template.tx, slot: 1_000 } });
      for (let index = 0; index < 6; index += 1) {
        app.market.apply({
          kind: "trade",
          tx: { signature: `stored-intel-${index}`, slot: 1_001 + index, seq: index, eventIndex: 0, receivedAtMs: START_MS + 2_000 * (index + 1) },
          venue: "curve",
          mint,
          pool: null,
          wallet: `StoredIntelBuyer${index}`,
          isBuy: true,
          tokenAmount: 1_000_000_000n,
          quoteAmount: 100_000_000n,
          userQuote: 101_250_000n,
          protocolFee: 950_000n,
          creatorFee: 300_000n,
          lpFee: 0n,
          protocolFeeBps: 95,
          creatorFeeBps: 30,
          lpFeeBps: 0,
          virtualTokenReserves: 1_070_000_000_000_000n - BigInt(index) * 1_000_000_000n,
          virtualQuoteReserves: 30_100_000_000n + BigInt(index) * 100_000_000n,
          realTokenReserves: 790_000_000_000_000n,
          realQuoteReserves: 100_000_000n * BigInt(index + 1),
          timestampMs: START_MS + 2_000 * (index + 1),
          ixName: "buy"
        });
      }
      await database.db.query(
        `INSERT INTO wallet_intel (wallet, prior_tx_count, prior_tx_capped, checked_before_signature, checked_at)
         VALUES ('StoredIntelBuyer0', 2, false, 'stored-intel-0', $1)`,
        [new Date(START_MS + 20_000)]
      );
      const score = await app.scorer?.service.runCheckpoint(mint, 30);
      expect(score).not.toBeNull();
      expect(calls).toEqual([]);
      expect(Number(score?.features.intel_coverage ?? 0)).toBeGreaterThan(0);
    } finally {
      await app.stop("test");
    }
  });

  it("starts a second trader only after the first one released the trading lock", async () => {
    const firstClock = new VirtualClock(START_MS);
    const first = await startLiveApp({
      env: env(database.url, "trader"),
      config: config(),
      clock: firstClock,
      db: database.db,
      rpc: null,
      source: new ReplayLogSource({ clock: firstClock, transactions: [] }),
      port: 0
    });
    const secondClock = new VirtualClock(START_MS);
    let secondStarted = false;
    const starting = startLiveApp({
      env: env(database.url, "trader"),
      config: config(),
      clock: secondClock,
      db: database.db,
      rpc: null,
      source: new ReplayLogSource({ clock: secondClock, transactions: [] }),
      port: 0,
      lockRetryMs: 1_000
    }).then((app) => {
      secondStarted = true;
      return app;
    });
    await waitFor(() => secondClock.pendingCount() > 0);
    await secondClock.advanceTo(START_MS + 1_000);
    await waitFor(() => secondClock.pendingCount() > 0);
    expect(secondStarted).toBe(false);
    await first.stop("handover");
    await secondClock.advanceTo(START_MS + 2_000);
    const second = await starting;
    expect(second.runId).toBe(first.runId);
    await second.stop("test");
  });

  it("halts the trader at once when the trading lock connection is lost", async () => {
    const clock = new VirtualClock(START_MS);
    const app = await startLiveApp({
      env: env(database.url, "trader"),
      config: config(),
      clock,
      db: database.db,
      rpc: null,
      source: new ReplayLogSource({ clock, transactions: [] }),
      port: 0
    });
    try {
      expect(app.trader?.isRunning()).toBe(true);
      const holders = await database.db.query<{ pid: number }>(
        `SELECT l.pid FROM pg_locks l JOIN pg_database d ON d.oid = l.database
          WHERE l.locktype = 'advisory' AND l.granted AND d.datname = current_database()`
      );
      expect(holders.rows).toHaveLength(1);
      await database.db.query("SELECT pg_terminate_backend($1)", [holders.rows[0]?.pid]);
      expect(await app.done).toBe("trading lock lost");
      expect(app.trader?.isRunning()).toBe(false);
      app.trader?.start();
      expect(app.trader?.isRunning()).toBe(false);
    } finally {
      await app.stop("test");
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error("condition not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("startup while the database is unreachable", () => {
  it("keeps waiting for the database until stopped instead of failing at once", async () => {
    let aborted = false;
    const startedAt = performance.now();
    const started = startLiveApp({
      env: loadEnv({ DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/snypra", MODULES: "trader", TRADING_MODE: "paper", RPC_WS_URL: "ws://127.0.0.1:9" }),
      config: defaultStrategyConfig(),
      rpc: null,
      source: new ReplayLogSource({ clock: new VirtualClock(0), transactions: [] }),
      port: 0,
      abort: () => aborted
    });
    const settled = started.then(
      () => "started",
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    aborted = true;
    expect(await settled).toBe(new DatabaseWaitAborted().message);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_200);
  });

  it("retries with backoff until the database answers and gives up after the maximum wait", async () => {
    let failures = 2;
    const flaky = {
      query: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("connect ECONNREFUSED");
        }
        return { rows: [], rowCount: 1 };
      }
    } as unknown as Db;
    const clock = new VirtualClock(0);
    expect(await drive(clock, waitForDatabase(flaky, { clock, initialDelayMs: 1_000 }))).toBe(3);
    expect(clock.nowMs()).toBe(3_000);
    const down = { query: async () => Promise.reject(new Error("connect ECONNREFUSED")) } as unknown as Db;
    const giveUp = waitForDatabase(down, { clock, initialDelayMs: 1_000, maxWaitMs: 10_000 }).then(
      () => "connected",
      (error: unknown) => (error as Error).message
    );
    expect(await drive(clock, giveUp)).toMatch(/database unreachable for 10s/);
  });
});

async function drive<T>(clock: VirtualClock, work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => {
    done = true;
  });
  while (!done) {
    await clock.advanceTo(clock.nextDueMs() ?? clock.nowMs());
  }
  return tracked;
}
