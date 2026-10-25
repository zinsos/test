import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadClosedTrades, summarizeTrades } from "../src/analytics/index.js";
import { runCli } from "../src/app/cli.js";
import { loadEnv } from "../src/config/env.js";
import { loadStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import {
  acquireLabLock,
  formatLabReport,
  LabBusyError,
  loadLabVariants,
  pruneLabRuns,
  runLab,
  type LabResult,
  type LabVariant
} from "../src/lab/index.js";
import { replayEngineVersion } from "../src/lab/engine.js";
import { overridesHash, strategyHash } from "../src/lab/identity.js";
import { DEFAULT_WEIGHTS, saveWeights } from "../src/scorer/weights.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { buildScenario, type Scenario } from "./e2e.market.js";
import { recordScenario } from "./e2e.recording.js";

const HOUR_MS = 3_600_000;
const SCORER_KEYS = [
  "baselineAuc",
  "calibration",
  "checkpointSec",
  "features",
  "label",
  "positives",
  "rows",
  "validationAuc",
  "validationFromMs",
  "validationRows",
  "validationToMs",
  "weightsVersion"
];
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

  const windowHours = (): number => (scenario.windowEndMs - scenario.windowStartMs) / HOUR_MS;

  const learningBaseline = (): StrategyConfig => {
    const config = labBaseline(base);
    config.lab.autoLearn.windowHours = windowHours();
    config.lab.autoLearn.bootstrapIterations = 1000;
    return config;
  };

  const options = (overrides: Partial<Parameters<typeof runLab>[1]> = {}): Parameters<typeof runLab>[1] => ({
    config: learningBaseline(),
    variants,
    nowMs: scenario.windowEndMs,
    hours: windowHours(),
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
      expect(Number(entry.validationRows)).toBeGreaterThan(0);
      expect(Number(entry.validationRows)).toBeLessThan(Number(entry.rows));
      expect(Number(entry.validationFromMs)).toBeLessThanOrEqual(Number(entry.validationToMs));
      expect(Number(entry.validationToMs)).toBeLessThanOrEqual(scenario.windowEndMs);
    }
    const rugged = scorer.find((entry) => entry.label === "rugged_1h" && entry.checkpointSec === 60);
    expect(Number(rugged?.validationAuc)).toBeGreaterThan(0.5);
    const notes = run?.notes ?? {};
    expect(notes.scorerSkipped).toEqual([
      expect.objectContaining({ label: "migrated", checkpointSec: 30, reason: expect.stringMatching(/matured rows/) }),
      expect.objectContaining({ label: "migrated", checkpointSec: 60 })
    ]);
  });

  it("stores the settings hash, the replay code version, per-trade evidence and a learner report that keeps collecting on a single window", async () => {
    const run = await database.db.query<{ baseline_hash: string; engine_version: string; learner: Record<string, unknown> }>(
      "SELECT baseline_hash, engine_version, learner FROM lab_runs WHERE id = $1",
      [first.labRunId]
    );
    expect(run.rows[0]?.baseline_hash).toBe(strategyHash(labBaseline(base)));
    expect(first.baselineHash).toBe(run.rows[0]?.baseline_hash);
    expect(run.rows[0]?.engine_version).toBe(replayEngineVersion());
    expect(first.engineVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(first.canPromote).toBe(true);
    const rows = await database.db.query<{ name: string; trades: unknown; summary: { trades: number } | null }>(
      "SELECT name, trades, summary FROM lab_variants WHERE lab_run_id = $1 AND summary IS NOT NULL ORDER BY id",
      [first.labRunId]
    );
    let stored = 0;
    for (const row of rows.rows) {
      const trades = row.trades as Array<Record<string, unknown>>;
      expect(Array.isArray(trades)).toBe(true);
      expect(trades.length).toBe(row.summary?.trades);
      for (const trade of trades) {
        expect(Object.keys(trade).sort()).toEqual(["closedAtMs", "exitReason", "mint", "openedAtMs", "r", "sol"]);
        stored += 1;
      }
    }
    expect(stored).toBeGreaterThan(0);
    const report = run.rows[0]?.learner as {
      identity: { engineVersion: string };
      windows: unknown[];
      decision: { kind: string };
      variants: Array<{ name: string; verdict: string }>;
      weights: { mode: string };
    };
    expect(first.learner?.labRunId).toBe(first.labRunId);
    expect(first.learnerError).toBeNull();
    expect(report.identity.engineVersion).toBe(first.engineVersion);
    expect(report.windows).toHaveLength(1);
    expect(report.decision.kind).toBe("hold");
    expect(report.weights.mode).toBe("report_only");
    expect(report.variants.every((variant) => ["collecting", "not_run", "owner_only"].includes(variant.verdict))).toBe(true);
    expect(report.variants.find((variant) => variant.name === "trade-blocked-event-exits")?.verdict).toBe("owner_only");
    expect((await database.db.query("SELECT 1 FROM promotions")).rowCount).toBe(0);
    const text = formatLabReport(first);
    expect(text).toMatch(/^learning \(settings [0-9a-f]{8}, replay code [0-9a-f]{16}, 1 non-overlapping windows, baseline \d+ trades/m);
    expect(text).toContain("  decision   hold: no variant meets the discovery rule yet");
    expect(text).toContain("  weights    report only;");
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

  it("replays the settings from before a change as an undo arm while that change is on probation", async () => {
    const config = learningBaseline();
    const before = structuredClone(config);
    before.exits.timeStop.afterSec = 240;
    const undo = { exits: { timeStop: { afterSec: 240 } } };
    const inserted = await database.db.query<{ id: string }>(
      `INSERT INTO promotions (kind, name, overrides, overrides_hash, baseline_hash, status, root_hash, overlay, applied_hash, undo, confirm_windows, created_at, updated_at, applied_at)
       VALUES ('variant', 'shorter-time-stop', $1, $2, $3, 'applied', $3, $1, $4, $5, 24, $6, $6, $6) RETURNING id::text AS id`,
      [
        JSON.stringify({ exits: { timeStop: { afterSec: config.exits.timeStop.afterSec } } }),
        overridesHash({ exits: { timeStop: { afterSec: config.exits.timeStop.afterSec } } }),
        strategyHash(before),
        strategyHash(config),
        JSON.stringify(undo),
        new Date(scenario.windowStartMs - HOUR_MS)
      ]
    );
    const id = Number(inserted.rows[0]?.id);
    try {
      const result = await runLab(database.db, options({ variants: [], pruneKeep: null }));
      expect(result.undoArm).toBe(`undo-${id}`);
      const arm = result.variants.find((variant) => variant.name === `undo-${id}`);
      expect(arm).toMatchObject({ isBaseline: false, error: null, changed: ["exits.timeStop.afterSec"] });
      const stored = await database.db.query<{ overrides: unknown; trades: unknown }>("SELECT overrides, trades FROM lab_variants WHERE lab_run_id = $1 AND name = $2", [
        result.labRunId,
        `undo-${id}`
      ]);
      expect(stored.rows[0]?.overrides).toEqual(undo);
      expect(Array.isArray(stored.rows[0]?.trades)).toBe(true);
      expect(result.learner?.probation).toMatchObject({ promotionId: id, undoName: `undo-${id}`, needed: 24, complete: false });
      expect(result.learner?.variants.map((variant) => variant.name)).toEqual([]);
    } finally {
      await database.db.query("DELETE FROM promotions");
    }
  });
});
