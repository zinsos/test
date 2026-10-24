import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadClosedTrades, summarizeTrades } from "../src/analytics/index.js";
import { runCli } from "../src/app/cli.js";
import { loadEnv } from "../src/config/env.js";
import { loadStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import { runBacktest } from "../src/backtest/runner.js";
import {
  acquireLabLock,
  applyOverrides,
  LabBusyError,
  loadLabVariants,
  pruneLabRuns,
  runLab,
  type LabResult,
  type LabVariant
} from "../src/lab/index.js";
import { DEFAULT_WEIGHTS, saveWeights } from "../src/scorer/weights.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { buildScenario, type Scenario } from "./e2e.market.js";
import { recordScenario } from "./e2e.recording.js";

const HOUR_MS = 3_600_000;
const SCORER_KEYS = ["baselineAuc", "calibration", "checkpointSec", "features", "label", "positives", "rows", "validationAuc", "weightsVersion"];
const SUMMARY_KEYS = [
  "avgHoldSec",
  "ciHighSol",
  "ciLowSol",
  "exitReasons",
  "expectancySol",
  "maxDrawdownSol",
  "totalPnlSol",
  "trades",
  "verdict",
  "winRate",
  "wins"
];

interface LabRunRow {
  id: string;
  status: string;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
  data_from: Date;
  data_to: Date;
  scorer: Array<Record<string, unknown>>;
  notes: Record<string, unknown>;
}

interface LabVariantRow {
  id: string;
  name: string;
  description: string;
  is_baseline: boolean;
  overrides: Record<string, unknown>;
  strategy_run_id: bigint | null;
  summary: Record<string, unknown> | null;
  error: string | null;
}

function recordingConfig(base: StrategyConfig): StrategyConfig {
  const config = structuredClone(base);
  config.recorder.metadata.enabled = false;
  config.recorder.rpcSnapshotsEnabled = false;
  return config;
}

function labBaseline(base: StrategyConfig): StrategyConfig {
  const config = structuredClone(base);
  config.signals.enabled = ["smart_convergence", "score_momentum"];
  return config;
}

describe.skipIf(!hasTestDatabase)("lab end to end on a recorded synthetic market", () => {
  let database: TestDatabase;
  let scenario: Scenario;
  let base: StrategyConfig;
  let variants: LabVariant[];
  let first: LabResult;
  let firstRuntimeMs = 0;
  let activeBefore: string[] = [];

  const cli = async (argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, {
      env: loadEnv({ DATABASE_URL: database.url, LOG_LEVEL: "warn" })
    });
    return { code, out, err };
  };

  const labRuns = async (): Promise<LabRunRow[]> =>
    (await database.db.query<LabRunRow>("SELECT * FROM lab_runs ORDER BY id")).rows;

  const labVariants = async (labRunId: number): Promise<LabVariantRow[]> =>
    (await database.db.query<LabVariantRow>("SELECT * FROM lab_variants WHERE lab_run_id = $1 ORDER BY id", [labRunId])).rows;

  const options = (overrides: Partial<Parameters<typeof runLab>[1]> = {}): Parameters<typeof runLab>[1] => ({
    config: labBaseline(base),
    variants,
    nowMs: scenario.windowEndMs,
    hours: (scenario.windowEndMs - scenario.windowStartMs) / HOUR_MS,
    minTrainRows: 40,
    minClassRows: 4,
    clock: new VirtualClock(scenario.windowEndMs + HOUR_MS),
    ...overrides
  });

  beforeAll(async () => {
    database = await createTestDatabase("lab_e2e");
    scenario = buildScenario("lab-e2e-v1");
    base = await loadStrategyConfig("config/strategy.json");
    variants = await loadLabVariants();
    await database.db.query("INSERT INTO known_entities (address, kind, label, added_at) VALUES ($1, 'cex', 'exchange hot wallet', $2)", [
      scenario.cex,
      new Date(scenario.t0Ms - 86_400_000)
    ]);
    await recordScenario(database.db, scenario, recordingConfig(base));
    const ranked = await cli(["rank-wallets", "--as-of", String(scenario.windowStartMs), "--config", "config/strategy.json"]);
    expect(ranked.code).toBe(0);
    await saveWeights(database.db, {
      weights: { ...DEFAULT_WEIGHTS, version: "live-active" },
      labelName: "rugged",
      metrics: { to: new Date(scenario.t0Ms - 86_400_000).toISOString() },
      activate: true
    });
    await database.db.query(
      `INSERT INTO lab_runs (started_at, status, data_from, data_to) VALUES ($1, 'running', $1, $1)`,
      [new Date(scenario.windowStartMs)]
    );
    activeBefore = (await database.db.query<{ version: string }>("SELECT version FROM scorer_weights WHERE active ORDER BY version")).rows.map(
      (row) => row.version
    );
    const startedAt = performance.now();
    first = await runLab(database.db, options());
    firstRuntimeMs = performance.now() - startedAt;
  }, 600_000);

  afterAll(async () => {
    await database?.drop();
  });

  it("stores a finished lab run with the scorer results per the contract and marks interrupted runs failed", async () => {
    expect(first.status).toBe("done");
    expect(first.error).toBeNull();
    const runs = await labRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toMatch(/interrupted/);
    const run = runs[1];
    expect(Number(run?.id)).toBe(first.labRunId);
    expect(run?.status).toBe("done");
    expect(run?.finished_at).not.toBeNull();
    expect(run?.data_from.getTime()).toBe(scenario.windowStartMs);
    expect(run?.data_to.getTime()).toBe(scenario.windowEndMs);
    const stored = run?.scorer ?? [];
    expect(stored.map((entry) => `${String(entry.label)}@${String(entry.checkpointSec)}`)).toEqual([
      "survived_15m@30",
      "survived_15m@60",
      "rugged_1h@30",
      "rugged_1h@60",
      "migrated@30",
      "migrated@60"
    ]);
    const scorer = stored.filter((entry) => !("reason" in entry));
    expect(scorer).toHaveLength(4);
    for (const skipped of stored.filter((entry) => "reason" in entry)) {
      expect(Object.keys(skipped).sort()).toEqual([...SCORER_KEYS, "reason"].sort());
      expect(skipped).toMatchObject({ label: "migrated", validationAuc: null, weightsVersion: null, features: [], calibration: [] });
      expect(skipped.reason).toMatch(/matured rows/);
    }
    for (const entry of scorer) {
      expect(Object.keys(entry).sort()).toEqual(SCORER_KEYS);
      expect(entry.rows).toBeGreaterThanOrEqual(40);
      expect(entry.positives).toBeGreaterThan(0);
      expect(entry.weightsVersion).toBe(`lab-${first.labRunId}-${String(entry.label)}-${String(entry.checkpointSec)}`);
      const features = entry.features as Array<Record<string, unknown>>;
      expect(features.length).toBeGreaterThan(0);
      expect(features.length).toBeLessThanOrEqual(15);
      expect(Object.keys(features[0] ?? {}).sort()).toEqual(["auc", "coverage", "direction", "name", "weight"]);
      const calibration = entry.calibration as Array<Record<string, unknown>>;
      expect(calibration).toHaveLength(10);
      expect(Object.keys(calibration[0] ?? {}).sort()).toEqual(["bucket", "n", "positiveRate"]);
      expect(typeof entry.validationAuc).toBe("number");
    }
    const rugged = scorer.find((entry) => entry.label === "rugged_1h" && entry.checkpointSec === 60);
    expect(Number(rugged?.validationAuc)).toBeGreaterThan(0.5);
    const notes = run?.notes ?? {};
    expect(notes.scorerSkipped).toEqual([
      expect.objectContaining({ label: "migrated", checkpointSec: 30, reason: expect.stringMatching(/matured rows/) }),
      expect.objectContaining({ label: "migrated", checkpointSec: 60 })
    ]);
  });

  it("saves the trained weights inactive and never activates anything", async () => {
    const saved = await database.db.query<{ version: string; active: boolean; label_name: string; metrics: { source: string; to: string } }>(
      "SELECT version, active, label_name, metrics FROM scorer_weights WHERE version LIKE 'lab-%' ORDER BY version"
    );
    expect(saved.rows.map((row) => row.version)).toEqual(
      [
        `lab-${first.labRunId}-rugged_1h-30`,
        `lab-${first.labRunId}-rugged_1h-60`,
        `lab-${first.labRunId}-survived_15m-30`,
        `lab-${first.labRunId}-survived_15m-60`
      ].sort()
    );
    expect(saved.rows.every((row) => !row.active && row.metrics.source === "lab")).toBe(true);
    expect(saved.rows.every((row) => Date.parse(row.metrics.to) === scenario.windowEndMs)).toBe(true);
    const active = await database.db.query<{ version: string }>("SELECT version FROM scorer_weights WHERE active ORDER BY version");
    expect(active.rows.map((row) => row.version)).toEqual(activeBefore);
  });

  it("replays the baseline and every variant through labelled backtest runs and summarizes their closed positions", async () => {
    const rows = await labVariants(first.labRunId);
    expect(rows.map((row) => row.name)).toEqual(["baseline", ...variants.map((variant) => variant.name)]);
    expect(rows.filter((row) => row.is_baseline).map((row) => row.name)).toEqual(["baseline"]);
    expect(rows[0]?.overrides).toEqual({});
    expect(rows[1]?.overrides).toEqual(variants[0]?.overrides);
    for (const row of rows) {
      expect(row.error).toBeNull();
      expect(row.strategy_run_id).not.toBeNull();
      expect(Object.keys(row.summary ?? {}).sort()).toEqual(SUMMARY_KEYS);
      const runId = Number(row.strategy_run_id);
      const run = await database.db.query<{ mode: string; label: string; ended_at: Date | null; data_from: Date }>(
        "SELECT mode, label, ended_at, data_from FROM strategy_runs WHERE id = $1",
        [runId]
      );
      expect(run.rows[0]).toMatchObject({ mode: "backtest", label: `lab:${first.labRunId}:${row.name}` });
      expect(run.rows[0]?.ended_at).not.toBeNull();
      const fromDb = summarizeTrades(await loadClosedTrades(database.db, { runId, mode: "backtest" }));
      expect(row.summary?.trades).toBe(fromDb.n);
      expect(Number(row.summary?.totalPnlSol)).toBeCloseTo(fromDb.totalPnlSol, 9);
      const exitCount = ((row.summary?.exitReasons ?? []) as Array<{ n: number }>).reduce((total, reason) => total + reason.n, 0);
      expect(exitCount).toBe(fromDb.n);
    }
    const baseline = rows[0]?.summary;
    expect(Number(baseline?.trades)).toBeGreaterThan(0);
    const blocked = rows.find((row) => row.name === "trade-blocked-event-exits")?.summary;
    expect(Number(blocked?.trades)).toBeGreaterThan(Number(baseline?.trades));
    for (const [index, variant] of variants.entries()) {
      expect(rows[index + 1]?.overrides).toEqual(variant.overrides);
      expect(rows[index + 1]?.description).toBe(variant.description);
    }
  });

  it("writes no rejected-signal rows for lab backtests", async () => {
    const counts = await database.db.query<{ acted: number; rejected: number }>(
      `SELECT count(*) FILTER (WHERE s.acted)::int AS acted, count(*) FILTER (WHERE NOT s.acted)::int AS rejected
         FROM signals s JOIN strategy_runs r ON r.id = s.run_id
        WHERE r.label LIKE 'lab:%'`
    );
    expect(counts.rows[0]?.rejected).toBe(0);
    expect(counts.rows[0]?.acted).toBeGreaterThan(0);
  });

  it("reports an explicitly chosen lab run with its label", async () => {
    const baseline = (await labVariants(first.labRunId))[0];
    const report = await cli(["report", "--run", String(baseline?.strategy_run_id)]);
    expect(report.code).toBe(0);
    expect(report.out.join("\n")).toContain(`(lab:${first.labRunId}:baseline)`);
  });

  it("keeps runtime and per-variant timings in the result and the notes", async () => {
    expect(first.variants).toHaveLength(variants.length + 1);
    for (const variant of first.variants) {
      expect(variant.runtimeMs).toBeGreaterThan(0);
      expect(variant.events).toBeGreaterThan(0);
    }
    const total = first.variants.reduce((sum, variant) => sum + (variant.runtimeMs ?? 0), 0);
    expect(total).toBeLessThanOrEqual(firstRuntimeMs);
    const notes = (await labRuns())[1]?.notes as { variants: Record<string, { runtimeMs: number; changed: string[] }> };
    expect(notes.variants["fast-exits"]?.changed).toEqual(
      expect.arrayContaining(["exits.takeProfit", "exits.timeStop.afterSec", "exits.trailing"])
    );
    expect(notes.variants.baseline?.runtimeMs).toBeGreaterThan(0);
  });

  it("replays variants that share the scorer settings together and each exactly like its own backtest", async () => {
    const together = variants.filter((variant) => variant.name !== "trade-blocked-event-exits").map((variant) => variant.name);
    expect(first.passes.map((pass) => pass.variants)).toEqual([["baseline", ...together], ["trade-blocked-event-exits"]]);
    expect(first.passes.map((pass) => pass.isolated)).toEqual([true, false]);
    expect(first.variants.map((variant) => variant.pass)).toEqual(first.variants.map((variant) => (variant.name === "trade-blocked-event-exits" ? 2 : 1)));
    const notes = (await labRuns())[1]?.notes as { passes: Array<{ variants: string[] }>; variants: Record<string, { pass: number }> };
    expect(notes.passes.map((pass) => pass.variants.length)).toEqual([together.length + 1, 1]);
    expect(notes.variants["fast-exits"]?.pass).toBe(1);
    for (const name of ["baseline", "fast-exits", "trade-blocked-event-exits"]) {
      const overrides = variants.find((variant) => variant.name === name)?.overrides ?? {};
      const config = applyOverrides(labBaseline(base), overrides);
      const alone = await runBacktest({
        db: database.db,
        fromMs: scenario.windowStartMs,
        toMs: scenario.windowEndMs,
        config,
        weightsFile: config.scorer.weightsFile,
        recordRejectedSignals: false
      });
      const lab = first.variants.find((variant) => variant.name === name);
      expect(lab?.fingerprint, name).toBe(alone.summary.fingerprint);
      expect(lab?.summary?.trades, name).toBe(alone.summary.trades.n);
    }
  }, 120_000);

  it("refuses to run while another lab holds the lock and records inert variants without running them", async () => {
    const lock = await acquireLabLock(database.db);
    expect(lock).not.toBeNull();
    try {
      await expect(runLab(database.db, options({ maxVariants: 0 }))).rejects.toBeInstanceOf(LabBusyError);
    } finally {
      await lock?.release();
    }
    const plain = await runLab(database.db, options({ config: base, maxVariants: 1, labels: ["survived_15m"], checkpoints: [30] }));
    expect(plain.status).toBe("done");
    const rows = await labVariants(plain.labRunId);
    expect(rows.map((row) => [row.name, row.strategy_run_id === null, row.error?.startsWith("skipped: ") ?? false])).toEqual([
      ["baseline", false, false],
      ["momentum-strict", true, true]
    ]);
  }, 120_000);

  it("prunes lab backtest runs, positions and fills of all but the latest lab runs and keeps the summaries", async () => {
    const firstRunIds = (await labVariants(first.labRunId)).map((row) => Number(row.strategy_run_id));
    const before = await database.db.query<{ positions: number; fills: number }>(
      `SELECT (SELECT count(*)::int FROM positions WHERE run_id = ANY($1::bigint[])) AS positions,
              (SELECT count(*)::int FROM fills WHERE run_id = ANY($1::bigint[])) AS fills`,
      [firstRunIds]
    );
    expect(before.rows[0]?.positions).toBeGreaterThan(0);
    await database.db.query("UPDATE scorer_weights SET active = (version = $1) WHERE active OR version = $1", [`lab-${first.labRunId}-rugged_1h-60`]);
    const foreign = await database.db.query<{ id: string }>(
      `INSERT INTO strategy_runs (mode, label, config) VALUES ('backtest', 'lab:notes', '{}'), ('paper', $1, '{}') RETURNING id::text AS id`,
      [`lab:${first.labRunId}:baseline`]
    );
    const pruned = await pruneLabRuns(database.db, 1);
    const survivors = await database.db.query("SELECT 1 FROM strategy_runs WHERE id = ANY($1::bigint[])", [foreign.rows.map((row) => row.id)]);
    expect(survivors.rowCount).toBe(2);
    expect(pruned.kept).toBe(1);
    expect(pruned.weights).toBe(3);
    const weights = await database.db.query<{ version: string; active: boolean }>(
      "SELECT version, active FROM scorer_weights WHERE version LIKE 'lab-%' ORDER BY version"
    );
    const latestLab = Number((await labRuns()).at(-1)?.id);
    expect(weights.rows).toEqual([
      { version: `lab-${first.labRunId}-rugged_1h-60`, active: true },
      { version: `lab-${latestLab}-survived_15m-30`, active: false }
    ]);
    expect(pruned.strategyRuns).toBe(firstRunIds.length);
    expect(pruned.positions).toBe(before.rows[0]?.positions);
    expect(pruned.fills).toBe(before.rows[0]?.fills);
    const after = await database.db.query<{ runs: number; positions: number; fills: number; risk: number }>(
      `SELECT (SELECT count(*)::int FROM strategy_runs WHERE id = ANY($1::bigint[])) AS runs,
              (SELECT count(*)::int FROM positions WHERE run_id = ANY($1::bigint[])) AS positions,
              (SELECT count(*)::int FROM fills WHERE run_id = ANY($1::bigint[])) AS fills,
              (SELECT count(*)::int FROM risk_events WHERE run_id = ANY($1::bigint[])) AS risk`,
      [firstRunIds]
    );
    expect(after.rows[0]).toEqual({ runs: 0, positions: 0, fills: 0, risk: 0 });
    const kept = await labVariants(first.labRunId);
    expect(kept.every((row) => row.strategy_run_id === null && row.summary !== null)).toBe(true);
    const latest = (await labRuns()).at(-1);
    const latestRows = await labVariants(Number(latest?.id));
    const latestRun = await database.db.query("SELECT 1 FROM strategy_runs WHERE id = $1", [Number(latestRows[0]?.strategy_run_id)]);
    expect(latestRun.rowCount).toBe(1);
    expect(await pruneLabRuns(database.db, 1)).toMatchObject({ strategyRuns: 0 });
  });

  it("runs from the command line with a readable report and prunes on request", async () => {
    const run = await cli(["lab", "--hours", "1", "--max-variants", "1", "--labels", "survived_15m", "--config", "config/strategy.json"]);
    expect(run.code).toBe(0);
    const text = run.out.join("\n");
    expect(text).toMatch(/== lab run \d+ \(done\) ==/);
    expect(text).toContain("leaderboard");
    expect(text).toContain("baseline *");
    expect(run.err.some((line) => line.includes("variant 1/2 baseline"))).toBe(true);
    const bad = await cli(["lab", "--labels", "rugged_2h"]);
    expect(bad.code).toBe(2);
    const prune = await cli(["lab", "--prune-keep", "1"]);
    expect(prune.code).toBe(0);
    expect(prune.out.join("\n")).toMatch(/^pruned {3}\d+ lab strategy runs/);
  }, 120_000);
});
