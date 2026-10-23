import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveApp } from "../src/app/live.js";
import { loadEnv } from "../src/config/env.js";
import { defaultStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import { decodeLogs } from "../src/chain/events.js";
import { ReplayLogSource, type ReplayTransaction } from "../src/ingest/replaySource.js";
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
    DASHBOARD_TOKEN: "s3cret"
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
    const summary = await fetch(`http://127.0.0.1:${app.httpPort}/api/recorder/health`, { headers: { authorization: "Bearer s3cret" } });
    expect(summary.status).toBe(200);
    const body = (await summary.json()) as { process: { trader: { open: number } } };
    expect(body.process.trader.open).toBe(0);
    const stats = app.stats() as { pipeline: { emitted: number }; risk: { runId: number } };
    expect(stats.pipeline.emitted).toBeGreaterThan(0);
    expect(stats.risk.runId).toBe(app.runId);
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
    const app = await startLiveApp({
      env: loadEnv({ DATABASE_URL: database.url, MODULES: "dashboard" }),
      config: config(),
      clock: new VirtualClock(START_MS),
      db: database.db,
      rpc: null,
      port: 0
    });
    expect(app.ingest).toBeNull();
    expect(app.scorer).toBeNull();
    expect((await fetch(`http://127.0.0.1:${app.httpPort}/healthz`)).status).toBe(200);
    expect((app.stats() as { stream: unknown }).stream).toBeNull();
    await app.stop("test");
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
