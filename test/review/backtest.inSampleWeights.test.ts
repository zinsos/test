import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBacktest } from "../../src/backtest/runner.js";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { DEFAULT_WEIGHTS, saveWeights } from "../../src/scorer/weights.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 8, 1);
const TO = Date.UTC(2026, 9, 1);

describe.skipIf(!hasTestDatabase)("review: backtest scorer weights", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("review_weights");
    await saveWeights(database.db, {
      weights: { ...DEFAULT_WEIGHTS, version: "tuned-on-september" },
      labelName: "rugged",
      metrics: { checkpointSec: 30, from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), rows: 50_000 },
      activate: true
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("does not score a September backtest with weights fitted on September outcomes unless asked to", async () => {
    const config = defaultStrategyConfig();
    const result = await runBacktest({
      db: database.db,
      fromMs: FROM + 10 * 24 * HOUR,
      toMs: FROM + 10 * 24 * HOUR + HOUR,
      config,
      weightsFile: config.scorer.weightsFile
    });
    expect(result.summary.weightsVersion).not.toBe("tuned-on-september");
  });
});
