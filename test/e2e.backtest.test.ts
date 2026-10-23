import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadClosedTrades, startAnalyticsServer, summarizeTrades } from "../src/analytics/index.js";
import { readFileSync } from "node:fs";
import { runCli } from "../src/app/cli.js";
import { loadEnv } from "../src/config/env.js";
import { loadStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { jsonSafe } from "../src/db/pool.js";
import { recomputeOutcomes } from "../src/recorder/index.js";
import { startLiveApp } from "../src/app/live.js";
import type { RpcClient } from "../src/chain/rpc.js";
import { VirtualClock } from "../src/core/clock.js";
import type { ClosedTrade } from "../src/core/types.js";
import { ReplayLogSource } from "../src/ingest/replaySource.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { buildScenario, decodeResultOf, ScenarioIntelRpc, simulateScenario, type LaunchKind, type Scenario } from "./e2e.market.js";
import { recordScenario, type RecordingResult } from "./e2e.recording.js";

const HOUR_MS = 3_600_000;

interface CliRun {
  code: number;
  out: string[];
  err: string[];
}

interface BacktestJson {
  runId: number;
  fingerprint: string;
  trackedVersionAtEnd: string;
  counts: { signalsAccepted: number; signalsRejected: number; entriesFilled: number; entriesFailed: number; launches: number; trades: number };
  exitReasons: Record<string, number>;
  trades: { n: number; totalPnlSol: number; totalFeesSol: number; totalCostSol: number; expectancySol: number };
}

interface SignalRow {
  mint: string;
  acted: boolean;
  skip_reason: string | null;
  wallets: string[];
  meta: { trackedVersion?: string; quoteMint?: string };
}

function comparableTrade(trade: ClosedTrade): string {
  return [trade.mint, trade.signalType, trade.openedAtMs, trade.closedAtMs, trade.cost, trade.proceeds, trade.pnl, trade.fees, trade.exitReason, trade.riskScore].join("|");
}

function recordingConfig(base: StrategyConfig): StrategyConfig {
  const config = structuredClone(base);
  config.recorder.metadata.enabled = false;
  config.recorder.rpcSnapshotsEnabled = false;
  return config;
}

function frictionless(base: StrategyConfig): StrategyConfig {
  const config = structuredClone(base);
  config.execution.latencySlots = 0;
  config.execution.latencyJitterSlots = 0;
  config.execution.failureRate = 0;
  config.execution.priorityFeeLamports = 0;
  config.execution.baseFeeLamports = 0;
  config.execution.ataRentLamports = 0;
  config.execution.jitoTipLamports = 0;
  config.execution.useJito = false;
  config.execution.extraPlatformFeeBps = 0;
  return config;
}

describe.skipIf(!hasTestDatabase)("end to end: recorded market, wallet ranking and backtest", () => {
  let database: TestDatabase;
  let scenario: Scenario;
  let base: StrategyConfig;
  let recording: RecordingResult;
  let configDir: string;
  let kinds: Map<string, LaunchKind>;
  let rankStartRun = 0;
  let rankAfterRun = 0;
  let paper: BacktestJson;
  let paperAgain: BacktestJson;
  let zeroCost: BacktestJson;
  let paperSummaryText = "";
  let paperAgainSummaryText = "";

  const cli = async (argv: string[]): Promise<CliRun> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, {
      env: loadEnv({ DATABASE_URL: database.url, LOG_LEVEL: "warn" })
    });
    return { code, out, err };
  };

  const writeConfig = (name: string, config: StrategyConfig): string => {
    const file = path.join(configDir, `${name}.json`);
    writeFileSync(file, JSON.stringify(config, null, 2));
    return file;
  };

  const backtest = async (label: string, configFile: string): Promise<BacktestJson> => {
    const run = await cli([
      "backtest",
      "--from",
      String(scenario.windowStartMs),
      "--to",
      String(scenario.windowEndMs),
      "--label",
      label,
      "--config",
      configFile,
      "--json"
    ]);
    expect(run.err.filter((line) => line.startsWith("error"))).toEqual([]);
    expect(run.code).toBe(0);
    const json = run.out[run.out.length - 1] ?? "{}";
    return JSON.parse(json) as BacktestJson;
  };

  const storedSummary = async (runId: number): Promise<string> => {
    const result = await database.db.query<{ summary: Record<string, unknown> }>("SELECT summary FROM strategy_runs WHERE id = $1", [runId]);
    const summary = { ...(result.rows[0]?.summary ?? {}) };
    delete summary.runId;
    return JSON.stringify(summary);
  };

  const signalsOf = async (runId: number): Promise<SignalRow[]> => {
    const result = await database.db.query<SignalRow>(
      "SELECT mint, acted, skip_reason, wallets, meta FROM signals WHERE run_id = $1 ORDER BY at, id",
      [runId]
    );
    return result.rows;
  };

  const windowMints = (wanted: readonly LaunchKind[]): string[] =>
    scenario.plans.filter((plan) => plan.createdAtMs >= scenario.windowStartMs && wanted.includes(plan.kind)).map((plan) => plan.mint);

  beforeAll(async () => {
    database = await createTestDatabase("e2e_backtest");
    configDir = mkdtempSync(path.join(tmpdir(), "snypra-e2e-"));
    scenario = buildScenario("e2e-backtest-v1");
    kinds = new Map(scenario.plans.map((plan) => [plan.mint, plan.kind]));
    base = await loadStrategyConfig("config/strategy.json");
    await database.db.query("INSERT INTO known_entities (address, kind, label, added_at) VALUES ($1, 'cex', 'exchange hot wallet', $2)", [
      scenario.cex,
      new Date(scenario.t0Ms - 86_400_000)
    ]);
    recording = await recordScenario(database.db, scenario, recordingConfig(base));

    const rankStart = await cli(["rank-wallets", "--as-of", String(scenario.windowStartMs), "--config", writeConfig("rank", base)]);
    expect(rankStart.code).toBe(0);
    const startRun = await database.db.query<{ id: string }>("SELECT id FROM wallet_rank_runs ORDER BY id DESC LIMIT 1");
    rankStartRun = Number(startRun.rows[0]?.id);
    const rankAfter = await cli(["rank-wallets", "--as-of", String(scenario.windowEndMs + HOUR_MS), "--config", writeConfig("rank", base)]);
    expect(rankAfter.code).toBe(0);
    const afterRun = await database.db.query<{ id: string }>("SELECT id FROM wallet_rank_runs ORDER BY id DESC LIMIT 1");
    rankAfterRun = Number(afterRun.rows[0]?.id);

    const paperFile = writeConfig("paper", base);
    paper = await backtest("paper-1", paperFile);
    paperSummaryText = await storedSummary(paper.runId);
    paperAgain = await backtest("paper-1", paperFile);
    paperAgainSummaryText = await storedSummary(paperAgain.runId);
    zeroCost = await backtest("zero-cost", writeConfig("zero-cost", frictionless(base)));
  }, 600_000);

  afterAll(async () => {
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
    }
    await database?.drop();
  });

  it("records every synthetic launch and trade through the live recorder, scorer and finalizer", async () => {
    expect(recording.clockErrors).toEqual([]);
    expect(recording.pipeline.applyErrors).toBe(0);
    expect(recording.pipeline.unresolvedPoolTrades).toBe(0);
    expect(recording.recorder.recorder?.tradesDropped).toBe(0);
    expect(recording.recorder.recorder?.launchInsertFailures).toBe(0);
    expect(recording.intelRpc.signatures).toBeGreaterThan(0);
    const counts = await database.db.query<{ launches: number; trades: number; pool: number; scores: number; tracked: number; outcomes: number }>(
      `SELECT (SELECT count(*)::int FROM launches) AS launches,
              (SELECT count(*)::int FROM trades) AS trades,
              (SELECT count(*)::int FROM trades WHERE venue = 1) AS pool,
              (SELECT count(*)::int FROM launch_scores) AS scores,
              (SELECT count(*)::int FROM launches WHERE tracking_ended_at IS NULL) AS tracked,
              (SELECT count(*)::int FROM launch_outcomes WHERE finalized) AS outcomes`
    );
    const row = counts.rows[0];
    expect(row?.launches).toBe(scenario.plans.length);
    expect(row?.trades).toBe(recording.recorder.recorder?.tradesRecorded);
    expect(row?.pool).toBeGreaterThan(0);
    expect(row?.scores).toBe(scenario.plans.length * base.scorer.checkpointsSec.length);
    expect(row?.tracked).toBe(0);
    expect(row?.outcomes).toBe(scenario.plans.length);
    const pumpQuoted = await database.db.query<{ n: number }>("SELECT count(*)::int AS n FROM launches WHERE quote_mint <> 'SOL'");
    expect(pumpQuoted.rows[0]?.n).toBe(scenario.plans.filter((plan) => plan.kind === "pumpQuoted").length);
  });

  it("labels outcomes by kind and the database recompute agrees with the live finalizer", async () => {
    const outcomes = await database.db.query<{ mint: string; status: string }>(
      "SELECT l.mint, o.status FROM launches l JOIN launch_outcomes o ON o.launch_id = l.id"
    );
    const byKind = new Map<string, Map<string, number>>();
    for (const outcome of outcomes.rows) {
      const kind = kinds.get(outcome.mint) ?? "unknown";
      const statuses = byKind.get(kind) ?? new Map<string, number>();
      statuses.set(outcome.status, (statuses.get(outcome.status) ?? 0) + 1);
      byKind.set(kind, statuses);
    }
    const count = (kind: LaunchKind, status: string): number => byKind.get(kind)?.get(status) ?? 0;
    const total = (kind: LaunchKind): number => scenario.plans.filter((plan) => plan.kind === kind).length;
    expect(count("bundle", "rugged")).toBeGreaterThanOrEqual(Math.ceil(total("bundle") * 0.8));
    expect(count("mooner", "migrated")).toBe(total("mooner"));
    expect(count("dead", "died")).toBe(total("dead"));
    expect(count("runner", "rugged")).toBe(0);
    expect(count("pumpQuoted", "rugged")).toBe(0);
    const before = new Map(outcomes.rows.map((outcome) => [outcome.mint, outcome.status]));
    const recomputed = await recomputeOutcomes(database.db, {
      from: new Date(scenario.t0Ms - HOUR_MS),
      to: new Date(scenario.windowEndMs),
      config: recordingConfig(base),
      nowMs: scenario.lastLaunchMs + 30 * HOUR_MS
    });
    expect(recomputed.launches).toBe(scenario.plans.length);
    const after = await database.db.query<{ mint: string; status: string }>(
      "SELECT l.mint, o.status FROM launches l JOIN launch_outcomes o ON o.launch_id = l.id"
    );
    expect(new Map(after.rows.map((outcome) => [outcome.mint, outcome.status]))).toEqual(before);
  });

  it("ranks the planted smart wallets as of the window start without using later data", async () => {
    const tracked = async (runId: number): Promise<string[]> =>
      (await database.db.query<{ wallet: string }>("SELECT wallet FROM wallet_ranks WHERE run_id = $1 AND tracked ORDER BY rank", [runId])).rows.map(
        (row) => row.wallet
      );
    const atStart = await tracked(rankStartRun);
    expect([...atStart].sort()).toEqual([...scenario.smart].sort());
    const afterWindow = await tracked(rankAfterRun);
    for (const wallet of scenario.late) {
      expect(afterWindow).toContain(wallet);
    }
    const asOf = await database.db.query<{ id: string; as_of: Date }>("SELECT id, as_of FROM wallet_rank_runs ORDER BY id");
    expect(asOf.rows.map((row) => row.as_of.getTime())).toEqual([scenario.windowStartMs, scenario.windowEndMs + HOUR_MS]);
  });

  it("trades the window with positions and fills persisted, and analytics agrees with the run summary", async () => {
    expect(paper.counts.signalsAccepted).toBeGreaterThan(0);
    expect(paper.counts.entriesFilled).toBeGreaterThan(5);
    expect(paper.trades.n).toBeGreaterThan(5);
    const stored = await database.db.query<{ positions: number; closed: number; fills: number; open: number }>(
      `SELECT (SELECT count(*)::int FROM positions WHERE run_id = $1) AS positions,
              (SELECT count(*)::int FROM positions WHERE run_id = $1 AND status = 'closed') AS closed,
              (SELECT count(*)::int FROM positions WHERE run_id = $1 AND status = 'open') AS open,
              (SELECT count(*)::int FROM fills WHERE run_id = $1) AS fills`,
      [paper.runId]
    );
    const row = stored.rows[0];
    expect(row?.positions).toBe(paper.trades.n);
    expect(row?.closed).toBe(paper.trades.n);
    expect(row?.open).toBe(0);
    expect(row?.fills).toBeGreaterThanOrEqual(2 * paper.counts.entriesFilled);
    const fromDb = await loadClosedTrades(database.db, { runId: paper.runId, mode: "backtest" });
    const recomputed = summarizeTrades(fromDb);
    expect(recomputed.n).toBe(paper.trades.n);
    expect(recomputed.totalPnlSol).toBeCloseTo(paper.trades.totalPnlSol, 9);
    expect(recomputed.totalFeesSol).toBeCloseTo(paper.trades.totalFeesSol, 9);
    const solQuoted = new Set(scenario.plans.filter((plan) => plan.quoteMint === "SOL").map((plan) => plan.mint));
    for (const trade of fromDb) {
      expect(solQuoted.has(trade.mint)).toBe(true);
      expect(trade.openedAtMs).toBeGreaterThanOrEqual(scenario.windowStartMs);
    }
  });

  it("blocks most bundled rugs with the scorer and never acts on PUMP-quoted launches", async () => {
    const signals = await signalsOf(paper.runId);
    const bundles = new Set(windowMints(["bundle"]));
    const bundleSignals = signals.filter((signal) => bundles.has(signal.mint));
    const bundleMintsSignalled = new Set(bundleSignals.map((signal) => signal.mint));
    expect(bundleMintsSignalled.size).toBeGreaterThanOrEqual(Math.ceil(bundles.size * 0.8));
    const blockedMints = new Set(
      bundleSignals.filter((signal) => !signal.acted && ["hard_blocked", "risk_too_high"].includes(signal.skip_reason ?? "")).map((signal) => signal.mint)
    );
    const actedBundles = new Set(bundleSignals.filter((signal) => signal.acted).map((signal) => signal.mint));
    expect(blockedMints.size).toBeGreaterThanOrEqual(Math.ceil(bundleMintsSignalled.size * 0.75));
    expect(actedBundles.size).toBeLessThanOrEqual(Math.floor(bundles.size * 0.25));
    const runners = new Set(windowMints(["runner", "mooner"]));
    const actedRunners = new Set(signals.filter((signal) => signal.acted && runners.has(signal.mint)).map((signal) => signal.mint));
    expect(actedRunners.size).toBeGreaterThanOrEqual(Math.ceil(runners.size * 0.6));
    const pumpQuoted = new Set(windowMints(["pumpQuoted"]));
    expect(pumpQuoted.size).toBeGreaterThan(0);
    expect(signals.filter((signal) => pumpQuoted.has(signal.mint))).toEqual([]);
    const positions = await database.db.query<{ mint: string }>("SELECT DISTINCT mint FROM positions WHERE run_id = $1", [paper.runId]);
    for (const position of positions.rows) {
      expect(pumpQuoted.has(position.mint)).toBe(false);
    }
  });

  it("never uses a wallet ranking dated after the decision time", async () => {
    const signals = await signalsOf(paper.runId);
    expect(signals.length).toBeGreaterThan(0);
    const late = new Set(scenario.late);
    for (const signal of signals) {
      expect(signal.meta.trackedVersion).toBe(`run:${rankStartRun}`);
      expect(signal.wallets.filter((wallet) => late.has(wallet))).toEqual([]);
    }
    expect(paper.trackedVersionAtEnd).toBe(`run:${rankStartRun}`);
    const lateRunners = new Set(windowMints(["lateRunner"]));
    expect(signals.filter((signal) => lateRunners.has(signal.mint))).toEqual([]);
  });

  it("replays byte-identically and pays for fees and latency compared with a frictionless run", () => {
    expect(paperAgain.runId).not.toBe(paper.runId);
    expect(paperAgain.fingerprint).toBe(paper.fingerprint);
    expect(paperAgainSummaryText).toBe(paperSummaryText);
    expect(JSON.stringify(jsonSafe({ ...paperAgain, runId: 0 }))).toBe(JSON.stringify(jsonSafe({ ...paper, runId: 0 })));
    expect(zeroCost.counts.signalsAccepted).toBe(paper.counts.signalsAccepted);
    expect(zeroCost.counts.entriesFailed).toBe(0);
    expect(zeroCost.trades.totalPnlSol).toBeGreaterThan(paper.trades.totalPnlSol);
    expect(zeroCost.trades.totalFeesSol).toBeLessThan(paper.trades.totalFeesSol);
    expect(zeroCost.trades.expectancySol).toBeGreaterThan(paper.trades.expectancySol);
  });

  it("trades the same window identically when the live paper trader service streams it", async () => {
    const clock = new VirtualClock(scenario.windowStartMs);
    const app = await startLiveApp({
      env: loadEnv({ DATABASE_URL: database.url, MODULES: "trader", TRADING_MODE: "paper", RPC_WS_URL: "ws://127.0.0.1:9", LOG_LEVEL: "warn" }),
      config: base,
      clock,
      db: database.db,
      rpc: new ScenarioIntelRpc(scenario.profiles) as unknown as RpcClient,
      source: new ReplayLogSource({ clock, transactions: [] }),
      port: 0
    });
    const pipeline = app.ingest?.pipeline;
    const tracker = app.tracker;
    expect(pipeline).toBeDefined();
    expect(app.runId).not.toBeNull();
    const window = simulateScenario(scenario).filter((tx) => tx.atMs >= scenario.windowStartMs && tx.atMs < scenario.windowEndMs);
    for (const tx of window) {
      await clock.advanceTo(tx.atMs);
      pipeline?.handleBatch(decodeResultOf(tx), { signature: tx.signature, slot: tx.slot, seq: tx.events[0]?.tx.seq ?? 0, receivedAtMs: tx.atMs });
      await tracker?.signals.idle();
    }
    await clock.advanceTo(scenario.windowEndMs);
    expect(app.trader?.openPositions()).toEqual([]);
    const liveRunId = app.runId ?? 0;
    await app.stop("parity");
    const live = await loadClosedTrades(database.db, { runId: liveRunId, mode: "paper" });
    const backtested = await loadClosedTrades(database.db, { runId: paper.runId, mode: "backtest" });
    expect(live.length).toBe(paper.trades.n);
    expect(live.map(comparableTrade)).toEqual(backtested.map(comparableTrade));
    const liveSignals = await signalsOf(liveRunId);
    const backtestSignals = await signalsOf(paper.runId);
    const brief = (rows: SignalRow[]): string[] => rows.map((row) => `${row.mint}|${row.acted}|${row.skip_reason ?? ""}`);
    expect(brief(liveSignals)).toEqual(brief(backtestSignals));
  }, 120_000);

  it("serves the recorded data and runs through the CLI report, dataset export, tuning and analytics API", async () => {
    const report = await cli(["report", "--run", String(paper.runId)]);
    expect(report.code).toBe(0);
    expect(report.out.join("\n")).toContain(`${paper.trades.n} (`);
    const csv = path.join(configDir, "dataset.csv");
    const exported = await cli(["export-dataset", "--checkpoint", "30", "--out", csv]);
    expect(exported.code).toBe(0);
    const lines = readFileSync(csv, "utf8").trim().split("\n");
    expect(lines).toHaveLength(scenario.plans.length + 1);
    const tuned = await cli(["tune-scorer", "--checkpoint", "30", "--label", "rugged", "--version", "e2e-tuned"]);
    expect(tuned.code).toBe(0);
    const stored = await database.db.query<{ active: boolean }>("SELECT active FROM scorer_weights WHERE version = 'e2e-tuned'");
    expect(stored.rows).toEqual([{ active: false }]);
    const server = await startAnalyticsServer({ db: database.db, port: 0, token: "e2e-token" });
    try {
      const get = async <T>(route: string): Promise<{ status: number; body: T }> => {
        const response = await fetch(`http://127.0.0.1:${server.port}${route}`, { headers: { authorization: "Bearer e2e-token" } });
        return { status: response.status, body: (await response.json()) as T };
      };
      const summary = await get<{ summary: { n: number; totalPnlSol: number } }>(`/api/summary?runId=${paper.runId}&mode=all`);
      expect(summary.status).toBe(200);
      expect(summary.body.summary.n).toBe(paper.trades.n);
      expect(summary.body.summary.totalPnlSol).toBeCloseTo(paper.trades.totalPnlSol, 9);
      const bundle = windowMints(["bundle"])[0] ?? "";
      const score = await get<{ hardBlocked: boolean; source: string }>(`/api/score/${bundle}`);
      expect(score.status).toBe(200);
      expect(score.body.source).toBe("db");
      expect(score.body.hardBlocked).toBe(true);
      const tracked = await get<{ run: { runId: number } }>("/api/wallets/tracked");
      expect(tracked.body.run.runId).toBe(rankAfterRun);
    } finally {
      await server.close();
    }
  }, 120_000);
});
