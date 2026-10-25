import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recentSignals } from "../src/analytics/activityQueries.js";
import { labTakeaway, loadLabOverview, parseScorerEntries, sortVariants, type LabVariantRow } from "../src/analytics/labQueries.js";
import { selectPositionsRun } from "../src/analytics/positionQueries.js";
import { startAnalyticsServer, type AnalyticsServer } from "../src/analytics/server.js";
import { loadClosedTrades, loadModes, loadRuns } from "../src/analytics/tradeQueries.js";
import { VirtualClock } from "../src/core/clock.js";
import type { Db } from "../src/db/pool.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { mintAt, NOW_MS, HOUR_MS, DAY_MS } from "./analytics.db.js";

const TOKEN = "lab-dashboard-token-0123456789";

interface SummarySpec {
  trades: number;
  expectancySol: number;
  ciLowSol: number;
  ciHighSol: number;
  verdict?: string;
}

function summary(spec: SummarySpec): Record<string, unknown> {
  return {
    trades: spec.trades,
    wins: Math.round(spec.trades * 0.4),
    winRate: 0.4,
    expectancySol: spec.expectancySol,
    ciLowSol: spec.ciLowSol,
    ciHighSol: spec.ciHighSol,
    totalPnlSol: spec.expectancySol * spec.trades,
    maxDrawdownSol: 0.3,
    avgHoldSec: 240,
    verdict: spec.verdict ?? "no_edge",
    exitReasons: [
      { reason: "take_profit", n: 10, pnlSol: 0.5 },
      { reason: "stop_loss", n: 8, pnlSol: -0.4 }
    ]
  };
}

function variant(overrides: Partial<LabVariantRow> & { expectancy?: number | null; trades?: number; low?: number; high?: number }): LabVariantRow {
  const trades = overrides.trades ?? 120;
  const expectancy = overrides.expectancy === undefined ? 0.002 : overrides.expectancy;
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? "baseline",
    description: overrides.description ?? "",
    isBaseline: overrides.isBaseline ?? false,
    overrides: {},
    strategyRunId: null,
    summary:
      overrides.summary === undefined
        ? {
            trades,
            wins: 40,
            winRate: 0.4,
            expectancySol: expectancy,
            ciLowSol: overrides.low ?? (expectancy ?? 0) - 0.006,
            ciHighSol: overrides.high ?? (expectancy ?? 0) + 0.006,
            totalPnlSol: (expectancy ?? 0) * trades,
            maxDrawdownSol: 0.2,
            avgHoldSec: 200,
            verdict: "no_edge",
            exitReasons: []
          }
        : overrides.summary,
    error: overrides.error ?? null,
    vsBaselineSol: null,
    sameTradesAsBaseline: false
  };
}

describe("lab takeaway", () => {
  it("names the best challenger and says whether its lead is significant", () => {
    const baseline = variant({ id: 1, name: "baseline", isBaseline: true, expectancy: 0.002, low: -0.004, high: 0.008 });
    const faster = variant({ id: 2, name: "faster_exits", expectancy: 0.006, trades: 118, low: -0.001, high: 0.013 });
    const weaker = variant({ id: 3, name: "tight_stop", expectancy: -0.003 });
    const open = labTakeaway([baseline, faster, weaker]);
    expect(open?.tone).toBe("warn");
    expect(open?.headline).toBe("Faster exits beat the baseline by +0.004 SOL per trade over 118 trades, not yet significant");
    const clear = labTakeaway([baseline, variant({ id: 2, name: "faster_exits", expectancy: 0.02, trades: 300, low: 0.012, high: 0.028 })]);
    expect(clear?.tone).toBe("good");
    expect(clear?.headline).toBe("Faster exits beat the baseline by +0.018 SOL per trade over 300 trades");
    const thin = labTakeaway([baseline, variant({ id: 2, name: "wide-tp", expectancy: 0.05, trades: 12, low: 0.03, high: 0.07 })]);
    expect(thin?.headline).toBe("Wide tp beat the baseline by +0.048 SOL per trade over 12 trades, too few trades to tell");
    const kept = labTakeaway([baseline, weaker]);
    expect(kept).toMatchObject({ tone: "neutral", headline: "The baseline is still the best of 2 strategies" });
    expect(kept?.detail).toContain("tight stop at -0.005 SOL per trade against the baseline");
    expect(labTakeaway([variant({ id: 1, isBaseline: true, trades: 0, expectancy: null }), variant({ id: 2, name: "x", trades: 0 })])?.headline).toBe(
      "No strategy traded in this window"
    );
    expect(labTakeaway([])).toBeNull();
  });

  it("sorts by expectancy with untraded and failed variants last", () => {
    const rows = sortVariants([
      variant({ id: 1, name: "baseline", isBaseline: true, expectancy: 0.002 }),
      variant({ id: 2, name: "broken", summary: null, error: "boom" }),
      variant({ id: 3, name: "best", expectancy: 0.01 }),
      variant({ id: 4, name: "idle", trades: 0 }),
      variant({ id: 5, name: "worst", expectancy: -0.01 })
    ]);
    expect(rows.map((row) => row.name)).toEqual(["best", "baseline", "worst", "broken", "idle"]);
  });

  it("parses scorer entries defensively and keeps at most 15 features", () => {
    const entries = parseScorerEntries([
      {
        label: "rugged",
        checkpointSec: 60,
        rows: 1_200,
        positives: 300,
        validationAuc: 0.71,
        baselineAuc: 0.66,
        features: Array.from({ length: 20 }, (_, index) => ({ name: `f${index}`, auc: 0.6, direction: "higher_riskier", coverage: 0.9, weight: 1 })),
        calibration: [{ bucket: "0-10", n: 100, positiveRate: 0.05 }],
        weightsVersion: "lab-1"
      },
      { label: "migrated", checkpointSec: 30, rows: 40, positives: 2, reason: "too few positives" },
      "junk"
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.features).toHaveLength(15);
    expect(entries[0]).toMatchObject({ label: "rugged", validationAuc: 0.71, baselineAuc: 0.66, skipReason: null });
    expect(entries[1]).toMatchObject({ label: "migrated", features: [], calibration: [], skipReason: "too few positives", validationAuc: null });
    expect(parseScorerEntries(null)).toEqual([]);
  });

  it("reports the lab as unavailable when its tables are missing", async () => {
    const missing = { query: () => Promise.reject(Object.assign(new Error('relation "lab_runs" does not exist'), { code: "42P01" })) } as unknown as Db;
    expect(await loadLabOverview(missing)).toMatchObject({ available: false, run: null, variants: [] });
    const broken = { query: () => Promise.reject(new Error("connection lost")) } as unknown as Db;
    await expect(loadLabOverview(broken)).rejects.toThrow("connection lost");
  });
});

interface Seeded {
  paperRunId: number;
  backtestRunId: number;
  labBaselineRunId: number;
  labFasterRunId: number;
  doneRunId: number;
  olderRunId: number;
  runningRunId: number;
}

async function insertRun(db: Db, mode: string, label: string | null, startedAtMs: number): Promise<number> {
  const result = await db.query<{ id: string }>(
    "INSERT INTO strategy_runs (mode, label, started_at, config) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id::text AS id",
    [mode, label, new Date(startedAtMs)]
  );
  return Number(result.rows[0]?.id ?? 0);
}

async function insertClosed(db: Db, id: string, runId: number, mode: string, closedAtMs: number, pnl: bigint): Promise<void> {
  await db.query(
    `INSERT INTO positions (id, run_id, mode, mint, signal_type, risk_score, opened_at, opened_slot, entry_price, entry_tokens,
       entry_cost, tokens_held, proceeds, fees_paid, peak_price, last_price, status, closed_at, exit_reason, realized_pnl, hold_sec, peak_multiple)
     VALUES ($1, $2, $3, $4, 'score_momentum', 20, $5, 1, 0.0000001, 1000000000, 100000000, 0, $6, 1000000, 0.0000002, 0.0000001,
       'closed', $7, 'take_profit', $8, 60, 1.5)`,
    [id, runId, mode, mintAt(3), new Date(closedAtMs - 60_000), (100_000_000n + pnl).toString(), new Date(closedAtMs), pnl.toString()]
  );
}

async function insertSignal(db: Db, runId: number, atMs: number): Promise<void> {
  await db.query(
    `INSERT INTO signals (run_id, type, mint, at, slot, risk_score, acted, skip_reason) VALUES ($1, 'score_momentum', $2, $3, 1, 20, FALSE, 'max_concurrent')`,
    [runId, mintAt(4), new Date(atMs)]
  );
}

async function insertLabRun(db: Db, status: string, startedAtMs: number, scorer: unknown = []): Promise<number> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO lab_runs (started_at, finished_at, status, error, data_from, data_to, scorer, notes)
     VALUES ($1, $2, $3, NULL, $4, $5, $6::jsonb, '{"variants":4}'::jsonb) RETURNING id::text AS id`,
    [
      new Date(startedAtMs),
      status === "running" ? null : new Date(startedAtMs + 10 * 60_000),
      status,
      new Date(startedAtMs - 3 * DAY_MS),
      new Date(startedAtMs),
      JSON.stringify(scorer)
    ]
  );
  return Number(result.rows[0]?.id ?? 0);
}

async function insertVariant(
  db: Db,
  labRunId: number,
  name: string,
  isBaseline: boolean,
  strategyRunId: number | null,
  variantSummary: Record<string, unknown> | null,
  error: string | null = null
): Promise<void> {
  await db.query(
    `INSERT INTO lab_variants (lab_run_id, name, description, is_baseline, overrides, strategy_run_id, summary, error)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6::jsonb, $7)`,
    [labRunId, name, `${name} description`, isBaseline, strategyRunId, variantSummary === null ? null : JSON.stringify(variantSummary), error]
  );
}

const SCORER = [
  {
    label: "rugged",
    checkpointSec: 60,
    rows: 2_400,
    positives: 610,
    validationAuc: 0.74,
    baselineAuc: 0.69,
    features: [
      { name: "dev_share", auc: 0.68, direction: "higher_riskier", coverage: 1, weight: 1.4 },
      { name: "unique_buyers_per_min", auc: 0.62, direction: "lower_riskier", coverage: 0.98, weight: -0.7 }
    ],
    calibration: [
      { bucket: "0-10", n: 400, positiveRate: 0.05 },
      { bucket: "90-100", n: 80, positiveRate: 0.81 }
    ],
    weightsVersion: "lab-2-rugged-60"
  }
];

async function seed(db: Db): Promise<Seeded> {
  const paperRunId = await insertRun(db, "paper", null, NOW_MS - 5 * DAY_MS);
  const backtestRunId = await insertRun(db, "backtest", "bt-manual", NOW_MS - 4 * DAY_MS);
  const labBaselineRunId = await insertRun(db, "backtest", "lab:2:baseline", NOW_MS - HOUR_MS);
  const labFasterRunId = await insertRun(db, "backtest", "lab:2:faster_exits", NOW_MS - HOUR_MS);
  for (let index = 0; index < 3; index += 1) {
    await insertClosed(db, `paper-${index}`, paperRunId, "paper", NOW_MS - 2 * DAY_MS + index * HOUR_MS, 5_000_000n);
  }
  for (let index = 0; index < 2; index += 1) {
    await insertClosed(db, `bt-${index}`, backtestRunId, "backtest", NOW_MS - 3 * DAY_MS + index * HOUR_MS, -1_000_000n);
  }
  for (let index = 0; index < 5; index += 1) {
    await insertClosed(db, `lab-base-${index}`, labBaselineRunId, "backtest", NOW_MS - 10 * 60_000 + index * 1_000, 2_000_000n);
    await insertClosed(db, `lab-fast-${index}`, labFasterRunId, "backtest", NOW_MS - 10 * 60_000 + index * 1_000, 6_000_000n);
  }
  await insertSignal(db, paperRunId, NOW_MS - 2 * HOUR_MS);
  await insertSignal(db, labBaselineRunId, NOW_MS - 30 * 60_000);
  const olderRunId = await insertLabRun(db, "done", NOW_MS - DAY_MS);
  await insertVariant(db, olderRunId, "baseline", true, null, summary({ trades: 90, expectancySol: 0.001, ciLowSol: -0.006, ciHighSol: 0.008 }));
  const doneRunId = await insertLabRun(db, "done", NOW_MS - 2 * HOUR_MS, SCORER);
  await insertVariant(db, doneRunId, "baseline", true, labBaselineRunId, summary({ trades: 120, expectancySol: 0.002, ciLowSol: -0.004, ciHighSol: 0.008 }));
  await insertVariant(db, doneRunId, "faster_exits", false, labFasterRunId, summary({ trades: 118, expectancySol: 0.006, ciLowSol: -0.001, ciHighSol: 0.013 }));
  await insertVariant(db, doneRunId, "tight_stop", false, null, summary({ trades: 131, expectancySol: -0.003, ciLowSol: -0.009, ciHighSol: 0.003 }));
  await insertVariant(db, doneRunId, "broken", false, null, null, "replay failed: out of memory");
  await insertVariant(db, doneRunId, "clone", false, null, summary({ trades: 120, expectancySol: 0.002, ciLowSol: -0.004, ciHighSol: 0.008 }));
  await db.query(
    `UPDATE lab_runs SET notes = '{"variants":{"baseline":{"sameTradesAsBaseline":null},"clone":{"sameTradesAsBaseline":true},"faster_exits":{"sameTradesAsBaseline":false}}}'::jsonb WHERE id = $1`,
    [doneRunId]
  );
  const runningRunId = await insertLabRun(db, "running", NOW_MS - 5 * 60_000);
  await insertVariant(db, runningRunId, "baseline", true, null, null);
  return { paperRunId, backtestRunId, labBaselineRunId, labFasterRunId, doneRunId, olderRunId, runningRunId };
}

describe.skipIf(!hasTestDatabase)("lab queries and run pickers", () => {
  let database: TestDatabase;
  let seeded: Seeded;
  let server: AnalyticsServer;
  let base = "";

  async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    database = await createTestDatabase("analytics_lab");
    seeded = await seed(database.db);
    server = await startAnalyticsServer({ db: database.db, port: 0, host: "127.0.0.1", token: TOKEN, clock: new VirtualClock(NOW_MS), cacheTtlMs: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  it("shows the newest finished lab run with a sorted leaderboard, scorer training and baseline history", async () => {
    const lab = await loadLabOverview(database.db);
    expect(lab.available).toBe(true);
    expect(lab.runs).toBe(3);
    expect(lab.latest).toMatchObject({ id: seeded.runningRunId, status: "running", finishedAtMs: null });
    expect(lab.run).toMatchObject({ id: seeded.doneRunId, status: "done", dataFromMs: NOW_MS - 2 * HOUR_MS - 3 * DAY_MS, dataToMs: NOW_MS - 2 * HOUR_MS });
    expect(lab.variants.map((row) => row.name)).toEqual(["faster_exits", "baseline", "clone", "tight_stop", "broken"]);
    const [faster, baseline, clone, tight, broken] = lab.variants;
    expect([faster, baseline, clone, tight, broken].map((row) => row?.sameTradesAsBaseline)).toEqual([false, false, true, false, false]);
    expect(baseline).toMatchObject({ isBaseline: true, strategyRunId: seeded.labBaselineRunId, vsBaselineSol: null, description: "baseline description" });
    expect(faster?.vsBaselineSol).toBeCloseTo(0.004, 12);
    expect(tight?.vsBaselineSol).toBeCloseTo(-0.005, 12);
    expect(faster?.summary).toMatchObject({ trades: 118, verdict: "no_edge", maxDrawdownSol: 0.3, exitReasons: [{ reason: "take_profit", n: 10, pnlSol: 0.5 }, { reason: "stop_loss", n: 8, pnlSol: -0.4 }] });
    expect(broken).toMatchObject({ summary: null, error: "replay failed: out of memory", vsBaselineSol: null });
    expect(lab.takeaway?.headline).toBe("Faster exits beat the baseline by +0.004 SOL per trade over 118 trades, not yet significant");
    expect(lab.scorer).toHaveLength(1);
    expect(lab.scorer[0]).toMatchObject({ label: "rugged", checkpointSec: 60, validationAuc: 0.74, baselineAuc: 0.69, weightsVersion: "lab-2-rugged-60" });
    expect(lab.scorer[0]?.features.map((feature) => feature.direction)).toEqual(["higher_riskier", "lower_riskier"]);
    expect(lab.history.map((point) => [point.labRunId, point.expectancySol, point.trades])).toEqual([
      [seeded.olderRunId, 0.001, 90],
      [seeded.doneRunId, 0.002, 120]
    ]);
    const response = await get("/api/lab");
    expect(response.status).toBe(200);
    expect((response.body.run as Record<string, unknown>).id).toBe(seeded.doneRunId);
    expect((response.body.variants as unknown[]).length).toBe(5);
  });

  it("keeps lab backtests out of automatic run and mode pickers unless a run is chosen explicitly", async () => {
    const db = database.db;
    const runs = await loadRuns(db);
    expect(runs.map((run) => run.id).sort((a, b) => a - b)).toEqual([seeded.paperRunId, seeded.backtestRunId].sort((a, b) => a - b));
    const withLab = await loadRuns(db, { includeLab: true });
    expect(withLab).toHaveLength(4);
    const modes = await loadModes(db);
    expect(modes.map((mode) => [mode.mode, mode.closedTrades])).toEqual([
      ["paper", 3],
      ["backtest", 2]
    ]);
    expect(await loadClosedTrades(db, { mode: "backtest" })).toHaveLength(2);
    expect(await loadClosedTrades(db, {})).toHaveLength(5);
    expect(await loadClosedTrades(db, { runId: seeded.labFasterRunId })).toHaveLength(5);
    expect((await selectPositionsRun(db, { mode: "backtest" }))?.id).toBe(seeded.backtestRunId);
    expect((await selectPositionsRun(db, { runId: seeded.labBaselineRunId }))?.id).toBe(seeded.labBaselineRunId);
    expect((await recentSignals(db, {})).map((signal) => signal.runId)).toEqual([seeded.paperRunId]);
    expect((await recentSignals(db, { runId: seeded.labBaselineRunId })).map((signal) => signal.runId)).toEqual([seeded.labBaselineRunId]);
    const api = await get("/api/runs");
    expect((api.body.runs as Array<{ label: string | null }>).some((run) => run.label?.startsWith("lab:"))).toBe(false);
    const apiWithLab = await get("/api/runs?lab=1");
    expect((apiWithLab.body.runs as unknown[]).length).toBe(4);
    const summary = await get("/api/summary?mode=backtest");
    expect((summary.body.summary as Record<string, unknown>).n).toBe(2);
    const labSummary = await get(`/api/summary?runId=${seeded.labFasterRunId}`);
    expect((labSummary.body.summary as Record<string, unknown>).n).toBe(5);
    const auto = await get("/api/summary?mode=all");
    expect((auto.body.summary as Record<string, unknown>).n).toBe(5);
  });

  it("returns an empty overview before the first lab run", async () => {
    const empty = await createTestDatabase("analytics_lab_empty");
    try {
      expect(await loadLabOverview(empty.db)).toEqual({
        available: true,
        runs: 0,
        latest: null,
        run: null,
        variants: [],
        scorer: [],
        history: [],
        takeaway: null,
        learning: { available: true, report: null, error: null, promotions: [], inEffect: null }
      });
    } finally {
      await empty.drop();
    }
  });
});
