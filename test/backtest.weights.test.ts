import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { weightsText } from "../src/app/commands/backtest.js";
import { runBacktest } from "../src/backtest/runner.js";
import { selectBacktestWeights } from "../src/backtest/weights.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { ScoringModel } from "../src/scorer/model.js";
import { DEFAULT_WEIGHTS, saveWeights } from "../src/scorer/weights.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const DAY = 86_400_000;
const SEPTEMBER = Date.UTC(2026, 8, 1);
const OCTOBER = Date.UTC(2026, 9, 1);
const BACKTEST_FROM = SEPTEMBER + 10 * DAY;

async function store(database: TestDatabase, version: string, from: number | null, to: number | null, activate: boolean): Promise<void> {
  await saveWeights(database.db, {
    weights: { ...DEFAULT_WEIGHTS, version },
    labelName: "rugged",
    metrics: { checkpointSec: 30, from: from === null ? null : new Date(from).toISOString(), to: to === null ? null : new Date(to).toISOString() },
    activate
  });
}

describe.skipIf(!hasTestDatabase)("backtest scorer weights selection", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("backtest_weights");
  });

  beforeEach(async () => {
    await database.db.query("DELETE FROM scorer_weights");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("skips active weights fitted on the backtest window and falls back to weights fitted earlier", async () => {
    await store(database, "tuned-on-september", SEPTEMBER, OCTOBER, true);
    const selected = await selectBacktestWeights(database.db, { fromMs: BACKTEST_FROM, weightsFile: null });
    expect(selected.provenance).toEqual({ version: DEFAULT_WEIGHTS.version, source: "default", trainedFromMs: null, trainedToMs: null, inSample: false });
    expect(selected.skipped).toEqual([{ version: "tuned-on-september", source: "db", trainedFromMs: SEPTEMBER, trainedToMs: OCTOBER }]);
  });

  it("uses active weights whose training window ended before the backtest starts", async () => {
    await store(database, "tuned-on-august", SEPTEMBER - 31 * DAY, SEPTEMBER, true);
    const selected = await selectBacktestWeights(database.db, { fromMs: BACKTEST_FROM, weightsFile: null });
    expect(selected.model.version).toBe("tuned-on-august");
    expect(selected.provenance).toMatchObject({ source: "db", inSample: false, trainedToMs: SEPTEMBER });
  });

  it("treats weights without a stored training range as fitted on everything up to when they were saved", async () => {
    await store(database, "tuned-on-everything", null, null, true);
    const selected = await selectBacktestWeights(database.db, { fromMs: BACKTEST_FROM, weightsFile: null });
    expect(selected.model.version).toBe(DEFAULT_WEIGHTS.version);
    expect(selected.skipped.map((skipped) => skipped.version)).toEqual(["tuned-on-everything"]);
  });

  it("uses in-sample weights only when asked and labels them as in-sample", async () => {
    await store(database, "tuned-on-september", SEPTEMBER, OCTOBER, true);
    const allowed = await selectBacktestWeights(database.db, { fromMs: BACKTEST_FROM, weightsFile: null, allowInSample: true });
    expect(allowed.provenance).toMatchObject({ version: "tuned-on-september", source: "db", inSample: true });
    const explicit = await selectBacktestWeights(database.db, {
      fromMs: BACKTEST_FROM,
      weightsFile: null,
      explicit: new ScoringModel({ ...DEFAULT_WEIGHTS, version: "tuned-on-september" })
    });
    expect(explicit.provenance).toMatchObject({ source: "explicit", inSample: true, trainedFromMs: SEPTEMBER, trainedToMs: OCTOBER });
    expect(weightsText(explicit.provenance)).toContain("IN-SAMPLE");
  });

  it("reports which weights a default backtest used", async () => {
    await store(database, "tuned-on-september", SEPTEMBER, OCTOBER, true);
    const result = await runBacktest({
      db: database.db,
      fromMs: BACKTEST_FROM,
      toMs: BACKTEST_FROM + 3_600_000,
      config: defaultStrategyConfig(),
      weightsFile: null
    });
    expect(result.summary.weightsVersion).toBe(DEFAULT_WEIGHTS.version);
    expect(result.summary.weights).toMatchObject({ version: DEFAULT_WEIGHTS.version, inSample: false });
    expect(result.summary.skippedWeights.map((skipped) => skipped.version)).toEqual(["tuned-on-september"]);
  });
});
