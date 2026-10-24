import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advisoryLockKey } from "../src/app/tradingLock.js";
import { laneLockName } from "../src/app/laneLocks.js";
import { startLiveApp, type LiveApp } from "../src/app/live.js";
import type { PaperLane } from "../src/app/paperLanes.js";
import { loadEnv } from "../src/config/env.js";
import { tradingRunConfig, type StrategyConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import type { LaunchScore } from "../src/core/types.js";
import { marketDataSource } from "../src/execution/marketSource.js";
import { ReplayLogSource } from "../src/ingest/replaySource.js";
import { applyOverrides, loadLabVariants } from "../src/lab/variants.js";
import { requestKillReset } from "../src/trader/runs.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { launchEvent, strategy, T0, tradeToQuoteReserves, type TestEnv } from "./trader.fixtures.js";

const LANES = "momentum-loose,fast-exits";
const MCAP_QUOTE = 41_000_000_000n;
const SUNK_QUOTE = 31_000_000_000n;

interface RunRow {
  id: bigint;
  mode: string;
  label: string | null;
  ended_at: Date | null;
  config: unknown;
  summary: Record<string, unknown> | null;
}

function baseConfig(adjust: (config: StrategyConfig) => void = () => undefined): StrategyConfig {
  return strategy((config) => {
    config.recorder.metadata.enabled = false;
    config.recorder.rpcSnapshotsEnabled = false;
    config.signals.enabled = ["smart_convergence", "score_momentum"];
    config.execution.latencySlots = 1;
    adjust(config);
  });
}

function paperEnv(databaseUrl: string, variants: string | undefined, extra: Record<string, string> = {}) {
  return loadEnv({
    DATABASE_URL: databaseUrl,
    MODULES: "recorder,scorer,tracker,trader",
    TRADING_MODE: "paper",
    RPC_WS_URL: "ws://127.0.0.1:9",
    LOG_LEVEL: "warn",
    ...(variants === undefined ? {} : { PAPER_VARIANTS: variants }),
    ...extra
  });
}

function momentumScore(mint: string, atMs: number, score: number): LaunchScore {
  return {
    mint,
    launchId: null,
    checkpointSec: 60,
    computedAtMs: atMs,
    slot: 1,
    score,
    hardBlocked: false,
    flags: [],
    features: { unique_buyers_per_min: 30, buy_sell_count_ratio: 3 },
    contributions: {},
    weightsVersion: "test"
  };
}

function envOf(app: LiveApp, clock: VirtualClock): TestEnv {
  return { clock, bus: app.bus, market: app.market, source: marketDataSource(app.market, clock) };
}

let mintSequence = 0;

function nextMint(): string {
  mintSequence += 1;
  return `LaneMint${String(mintSequence).padStart(4, "0")}${"x".repeat(31)}`;
}

async function settle(clock: VirtualClock, ms = 2_000): Promise<void> {
  await clock.advanceTo(clock.nowMs() + ms);
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function launchAt(app: LiveApp, clock: VirtualClock, quote: bigint = MCAP_QUOTE): Promise<string> {
  const env = envOf(app, clock);
  const mint = nextMint();
  const created = launchEvent(mint, clock.nowMs());
  app.market.apply(created);
  app.bus.emit("chain", created);
  const trade = tradeToQuoteReserves(env, mint, quote, clock.nowMs() + 400, "LaneBuyer1111");
  await clock.advanceTo(clock.nowMs() + 400);
  app.market.apply(trade);
  app.bus.emit("chain", trade);
  return mint;
}

async function movePrice(app: LiveApp, clock: VirtualClock, mint: string, quote: bigint): Promise<void> {
  const trade = tradeToQuoteReserves(envOf(app, clock), mint, quote, clock.nowMs() + 400, "LaneSeller1111");
  await clock.advanceTo(clock.nowMs() + 400);
  app.market.apply(trade);
  app.bus.emit("chain", trade);
}

function laneOf(app: LiveApp, strategyName: string): PaperLane {
  const lane = app.paperLanes?.lanes().find((candidate) => candidate.strategy === strategyName);
  if (!lane) {
    throw new Error(`lane ${strategyName} missing`);
  }
  return lane;
}

async function runs(database: TestDatabase): Promise<RunRow[]> {
  const result = await database.db.query<RunRow>("SELECT id, mode, label, ended_at, config, summary FROM strategy_runs ORDER BY id");
  return result.rows;
}

async function eventually<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    if (performance.now() > deadline) {
      throw new Error("condition not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!hasTestDatabase)("live paper strategy lanes", () => {
  let database: TestDatabase;
  let clock: VirtualClock;
  let app: LiveApp | null = null;
  let firstRuns: Record<string, number> = {};
  let loosePositionMint = "";

  const start = async (config: StrategyConfig, variants: string | undefined, extra: Record<string, string> = {}): Promise<LiveApp> => {
    app = await startLiveApp({
      env: paperEnv(database.url, variants, extra),
      config,
      clock,
      db: database.db,
      rpc: null,
      source: new ReplayLogSource({ clock, transactions: [] }),
      port: 0,
      killResetPollMs: 1_000
    });
    return app;
  };

  const stop = async (): Promise<void> => {
    await app?.stop("test");
    app = null;
  };

  beforeAll(async () => {
    database = await createTestDatabase("app_lanes");
    clock = new VirtualClock(T0);
  });

  afterAll(async () => {
    await stop();
    await database?.drop();
  });

  it("refuses unknown variant names before touching the database", async () => {
    await expect(start(baseConfig(), "momentum-loose,nope")).rejects.toThrow(/PAPER_VARIANTS: unknown paper variant "nope"; config\/lab-variants\.json defines momentum-strict/);
    expect(await runs(database)).toEqual([]);
  });

  it("starts one labelled run per variant next to the main paper run, with the merged variant config stored", async () => {
    const config = baseConfig();
    const running = await start(config, LANES);
    const lanes = running.paperLanes?.lanes() ?? [];
    expect(lanes.map((lane) => [lane.strategy, lane.label, lane.kind, lane.state])).toEqual([
      ["momentum-loose", "paper:momentum-loose", "active", "running"],
      ["fast-exits", "paper:fast-exits", "active", "running"]
    ]);
    const stored = await runs(database);
    expect(stored.map((run) => [run.mode, run.label, run.ended_at])).toEqual([
      ["paper", null, null],
      ["paper", "paper:momentum-loose", null],
      ["paper", "paper:fast-exits", null]
    ]);
    expect(Number(stored[0]?.id)).toBe(running.runId);
    const variants = await loadLabVariants();
    for (const lane of lanes) {
      const variant = variants.find((entry) => entry.name === lane.name);
      const merged = applyOverrides(config, variant?.overrides ?? {});
      const row = stored.find((run) => Number(run.id) === lane.runId);
      expect(row?.config).toEqual(JSON.parse(JSON.stringify(tradingRunConfig(merged))));
    }
    expect((stored[0]?.config as Record<string, unknown>).lab).toBeUndefined();
    expect(laneOf(running, "momentum-loose").config.signals.scoreMomentum.maxRiskScore).toBe(50);
    expect(laneOf(running, "fast-exits").config.exits.timeStop.afterSec).toBe(120);
    firstRuns = Object.fromEntries(lanes.map((lane) => [lane.name, lane.runId]));
    const status = running.stats() as { paperLanes: Array<{ strategy: string; state: string }> };
    expect(status.paperLanes.map((lane) => `${lane.strategy}:${lane.state}`)).toEqual(["momentum-loose:running", "fast-exits:running"]);
  });

  it("lets each strategy decide with its own entry rules, positions and signal records", async () => {
    const running = app as unknown as LiveApp;
    const mint = await launchAt(running, clock);
    running.bus.emit("score", momentumScore(mint, clock.nowMs(), 45));
    await settle(clock);
    const loose = laneOf(running, "momentum-loose");
    const fast = laneOf(running, "fast-exits");
    expect(loose.trader.openPositions().map((position) => position.mint)).toEqual([mint]);
    expect(fast.trader.openPositions()).toEqual([]);
    expect(running.trader?.openPositions()).toEqual([]);
    loosePositionMint = mint;
    const byRun = await eventually(async () => {
      const signals = await database.db.query<{ run_id: number; acted: boolean; skip_reason: string | null }>(
        "SELECT run_id::int, acted, skip_reason FROM signals WHERE mint = $1 ORDER BY id",
        [mint]
      );
      const rows = signals.rows.map((row) => [row.run_id, row.acted, row.skip_reason]);
      return rows.length >= 2 ? rows : null;
    });
    expect(byRun).toContainEqual([running.runId, false, "risk_too_high"]);
    expect(byRun).toContainEqual([loose.runId, true, null]);
    expect(byRun.filter((row) => row[0] === fast.runId)).toEqual([]);
    const positions = await eventually(async () => {
      const result = await database.db.query<{ run_id: number; status: string }>("SELECT run_id::int, status FROM positions WHERE mint = $1", [mint]);
      return result.rows.length > 0 ? result.rows : null;
    });
    expect(positions).toEqual([{ run_id: loose.runId, status: "open" }]);
  });

  it("keeps a lane that throws away from the main trader and the other lanes", async () => {
    const running = app as unknown as LiveApp;
    const fast = laneOf(running, "fast-exits");
    const loose = laneOf(running, "momentum-loose");
    fast.trader.handleSignal = () => {
      throw new Error("lane failure");
    };
    const mint = await launchAt(running, clock);
    running.bus.emit("score", momentumScore(mint, clock.nowMs(), 20));
    await settle(clock);
    expect(running.trader?.openPositions().map((position) => position.mint)).toContain(mint);
    expect(loose.trader.openPositions().map((position) => position.mint)).toContain(mint);
    expect(fast.trader.openPositions()).toEqual([]);
    Reflect.deleteProperty(fast.trader, "handleSignal");
  });

  it("keeps kill switches, daily loss limits and their resets inside each lane", async () => {
    const running = app as unknown as LiveApp;
    const fast = laneOf(running, "fast-exits");
    const loose = laneOf(running, "momentum-loose");
    fast.risk.markToMarket(-3_000_000_000n, clock.nowMs());
    loose.risk.markToMarket(-1_000_000_000n, clock.nowMs());
    expect(fast.risk.status()).toMatchObject({ killed: true, haltedForDay: true });
    expect(loose.risk.status()).toMatchObject({ killed: false, haltedForDay: true });
    expect(running.risk?.status()).toMatchObject({ killed: false, haltedForDay: false });
    const mint = await launchAt(running, clock);
    running.bus.emit("score", momentumScore(mint, clock.nowMs(), 20));
    await settle(clock);
    expect(running.trader?.openPositions().map((position) => position.mint)).toContain(mint);
    expect(loose.trader.openPositions().map((position) => position.mint)).not.toContain(mint);
    expect(fast.trader.openPositions().map((position) => position.mint)).not.toContain(mint);
    const skips = await eventually(async () => {
      const result = await database.db.query<{ run_id: number; acted: boolean; skip_reason: string | null }>(
        "SELECT run_id::int, acted, skip_reason FROM signals WHERE mint = $1 AND NOT acted ORDER BY run_id",
        [mint]
      );
      return result.rows.length >= 2 ? result.rows.map((row) => [row.run_id, row.skip_reason]) : null;
    });
    expect(skips).toEqual([
      [loose.runId, "halted_daily_loss"],
      [fast.runId, "killed"]
    ]);
    await requestKillReset(database.db, fast.runId, "lane test");
    await settle(clock, 1_500);
    await eventually(async () => (fast.risk.status().killed ? null : true));
    expect(fast.risk.status()).toMatchObject({ killed: false, haltedForDay: true });
    expect(loose.risk.status()).toMatchObject({ killed: false, haltedForDay: true });
    expect(running.risk?.status()).toMatchObject({ killed: false, haltedForDay: false });
    const next = await launchAt(running, clock);
    running.bus.emit("score", momentumScore(next, clock.nowMs(), 20));
    await settle(clock);
    expect(running.trader?.openPositions().map((position) => position.mint)).toContain(next);
    expect(fast.trader.openPositions()).toEqual([]);
    const reasons = await eventually(async () => {
      const result = await database.db.query<{ skip_reason: string }>("SELECT skip_reason FROM signals WHERE mint = $1 AND run_id = $2", [next, fast.runId]);
      return result.rows.length > 0 ? result.rows.map((row) => row.skip_reason) : null;
    });
    expect(reasons).toEqual(["halted_daily_loss"]);
  });

  it("does not start a lane whose lock another process holds and runs the others", async () => {
    await stop();
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [advisoryLockKey(laneLockName("paper:fast-exits"))]);
      const running = await start(baseConfig(), LANES);
      expect(running.paperLanes?.lanes().map((lane) => lane.strategy)).toEqual(["momentum-loose"]);
      expect(running.trader?.isRunning()).toBe(true);
      await stop();
    } finally {
      await holder.end();
    }
  });

  it("resumes each lane's run, open positions and risk state after a restart", async () => {
    const running = await start(baseConfig(), LANES);
    const loose = laneOf(running, "momentum-loose");
    const fast = laneOf(running, "fast-exits");
    expect([loose.runId, fast.runId]).toEqual([firstRuns["momentum-loose"], firstRuns["fast-exits"]]);
    expect([loose.resumed, fast.resumed]).toEqual([true, true]);
    expect(loose.trader.openPositions().map((position) => position.mint)).toContain(loosePositionMint);
    expect(fast.trader.openPositions()).toEqual([]);
    expect(loose.risk.status()).toMatchObject({ haltedForDay: true, killed: false });
    expect(fast.risk.status()).toMatchObject({ haltedForDay: true, killed: false });
    expect((await runs(database)).filter((run) => run.label !== null)).toHaveLength(2);
  });

  it("starts a new run when a lane's config changes and lets old runs close their positions without entries before ending them", async () => {
    const mainRunId = app?.runId;
    await stop();
    const running = await start(
      baseConfig((config) => {
        config.exits.maxHoldSec = 1_800;
      }),
      "momentum-loose"
    );
    expect(running.runId).toBe(mainRunId);
    const lanes = running.paperLanes?.lanes() ?? [];
    const looseOld = firstRuns["momentum-loose"] ?? 0;
    const fastOld = firstRuns["fast-exits"] ?? 0;
    expect(lanes.map((lane) => [lane.strategy, lane.kind])).toEqual([
      ["momentum-loose", "active"],
      [`momentum-loose@${looseOld}`, "draining"]
    ]);
    const fastRow = (await runs(database)).find((run) => Number(run.id) === fastOld);
    expect(fastRow?.ended_at).not.toBeNull();
    expect(fastRow?.summary).toMatchObject({ reason: "lane_removed", openPositions: 0 });
    const fresh = laneOf(running, "momentum-loose");
    expect(fresh.runId).not.toBe(looseOld);
    expect(fresh.config.exits.maxHoldSec).toBe(1_800);
    const draining = lanes.filter((lane) => lane.kind === "draining");
    expect(draining.map((lane) => lane.endReason)).toEqual(["config_changed"]);
    expect(draining[0]?.trader.openPositions()).toHaveLength(2);
    expect(draining[0]?.config.exits.maxHoldSec).toBe(3_600);
    const mint = await launchAt(running, clock);
    running.bus.emit("score", momentumScore(mint, clock.nowMs(), 20));
    await settle(clock);
    expect(fresh.trader.openPositions().map((position) => position.mint)).toEqual([mint]);
    for (const lane of draining) {
      expect(lane.trader.openPositions().map((position) => position.mint)).not.toContain(mint);
      expect(lane.trader.stats().signals).toBe(0);
    }
    const held = new Set(draining.flatMap((lane) => lane.trader.openPositions().map((position) => position.mint)));
    for (const heldMint of held) {
      await movePrice(running, clock, heldMint, SUNK_QUOTE);
    }
    await settle(clock, 5_000);
    await eventually(async () => (draining.every((lane) => lane.state === "finished") ? true : null));
    const ended = await eventually(async () => {
      const rows = (await runs(database)).filter((run) => run.ended_at !== null);
      return rows.length >= 2 && rows.every((run) => run.summary !== null) ? rows : null;
    });
    expect(ended.map((run) => [Number(run.id), run.summary?.reason])).toEqual([
      [looseOld, "config_changed"],
      [fastOld, "lane_removed"]
    ]);
    expect(fresh.trader.openPositions()).toHaveLength(1);
    const open = await database.db.query<{ n: number }>("SELECT count(*)::int AS n FROM positions WHERE run_id = ANY($1::bigint[]) AND status = 'open'", [[looseOld, fastOld]]);
    expect(open.rows[0]?.n).toBe(0);
  });

  it("never starts paper lanes or touches lane runs in live mode", async () => {
    await stop();
    const before = await runs(database);
    const running = await start(baseConfig(), LANES, {
      TRADING_MODE: "live",
      LIVE_DRY_RUN: "true",
      RPC_HTTP_URL: "http://127.0.0.1:9",
      HOT_WALLET_SECRET_KEY: bs58.encode(Keypair.generate().secretKey)
    });
    expect(running.paperLanes).toBeNull();
    expect(running.trader?.mode).toBe("live");
    await stop();
    const after = await runs(database);
    const lanesBefore = before.filter((run) => run.label?.startsWith("paper:")).map((run) => [run.id, run.ended_at]);
    const lanesAfter = after.filter((run) => run.label?.startsWith("paper:")).map((run) => [run.id, run.ended_at]);
    expect(lanesAfter).toEqual(lanesBefore);
    expect(after.filter((run) => run.mode === "live").map((run) => run.label)).toEqual(["live-dry-run"]);
  });

  it("ends a removed lane at once when it holds no positions", async () => {
    const config = baseConfig((adjust) => {
      adjust.exits.maxHoldSec = 1_800;
    });
    await start(config, "momentum-loose,momentum-strict");
    const strict = laneOf(app as unknown as LiveApp, "momentum-strict");
    expect(strict.resumed).toBe(false);
    await stop();
    const running = await start(config, "momentum-loose");
    expect(running.paperLanes?.lanes().map((lane) => lane.strategy)).toEqual(["momentum-loose"]);
    const row = (await runs(database)).find((run) => Number(run.id) === strict.runId);
    expect(row?.ended_at).not.toBeNull();
    expect(row?.summary).toMatchObject({ reason: "lane_removed", openPositions: 0 });
    await stop();
  });

  it("serves lane events tagged by strategy, the strategy list and the lane table from the dashboard", async () => {
    const token = "lanes-dashboard-token-0123456789";
    const running = await start(
      baseConfig((adjust) => {
        adjust.exits.maxHoldSec = 1_800;
      }),
      "momentum-loose",
      { MODULES: "recorder,scorer,tracker,trader,dashboard", DASHBOARD_TOKEN: token }
    );
    const get = async <T>(path: string): Promise<T> =>
      (await (await fetch(`http://127.0.0.1:${running.httpPort}${path}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as T;
    const status = await get<{ strategies: Array<{ name: string; runId: number; tradingActive: boolean }> }>("/api/live/status");
    expect(status.strategies.map((strategy) => [strategy.name, strategy.runId, strategy.tradingActive])).toEqual([
      ["main", running.runId, true],
      ["momentum-loose", laneOf(running, "momentum-loose").runId, true]
    ]);
    const mint = await launchAt(running, clock);
    running.bus.emit("score", momentumScore(mint, clock.nowMs(), 45));
    await settle(clock);
    const lane = await get<{ events: Array<{ kind: string; strategy: string | null }> }>("/api/live/events?strategy=momentum-loose");
    expect(lane.events.filter((event) => event.kind !== "score").map((event) => [event.kind, event.strategy])).toEqual([
      ["signal", "momentum-loose"],
      ["entering", "momentum-loose"],
      ["opened", "momentum-loose"]
    ]);
    const main = await get<{ events: Array<{ kind: string; strategy: string | null }> }>("/api/live/events?strategy=main");
    expect(main.events.filter((event) => event.kind !== "score").map((event) => [event.kind, event.strategy])).toEqual([["rejected", "main"]]);
    const table = await get<{ rows: Array<{ strategy: string; status: string; openPositions: number }> }>("/api/lab/live");
    expect(table.rows.filter((row) => row.status !== "ended").map((row) => [row.strategy, row.status])).toEqual([
      ["main", "running"],
      ["momentum-loose", "running"]
    ]);
    await stop();
  });
});
