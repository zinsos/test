import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest/runner.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { INCOMPLETE_DATA_REASON } from "../src/trader/trader.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { CLEAN_DEEP_FEATURES, convergenceTrades, seedLaunch, seedRankRun, seedStoredScore } from "./backtest.seed.js";

const FROM = Date.UTC(2026, 9, 2, 0, 0, 0);
const TO = FROM + 3 * 3_600_000;
const MINUTE = 60_000;
const W = ["GapWalletA", "GapWalletB", "GapWalletC"];

const LAUNCHES = {
  diedBeforeRestart: { mint: "GapDiedEarly", atMs: FROM + 10 * MINUTE, incompleteFromMs: undefined },
  aliveAtRestart: { mint: "GapStillAlive", atMs: FROM + 20 * MINUTE, incompleteFromMs: FROM + 60 * MINUTE },
  gapBeforeEntry: { mint: "GapBeforeEntry", atMs: FROM + 80 * MINUTE, incompleteFromMs: FROM + 80 * MINUTE + 30_000 },
  incompleteFromStart: { mint: "GapFromStart", atMs: FROM + 100 * MINUTE, incompleteFromMs: FROM + 100 * MINUTE }
};

describe.skipIf(!hasTestDatabase)("backtest launches with ingest gaps", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("backtest_gaps");
    await seedRankRun(database.db, FROM - 86_400_000, W);
    let slot = 310_000_000;
    for (const spec of Object.values(LAUNCHES)) {
      slot += 50_000;
      const id = await seedLaunch(database.db, {
        mint: spec.mint,
        dev: `Dev${spec.mint}`,
        createdAtMs: spec.atMs,
        slot,
        trades: convergenceTrades(W),
        incompleteFromMs: spec.incompleteFromMs
      });
      await seedStoredScore(database.db, id, spec.mint, 30, spec.atMs + 30_200, CLEAN_DEEP_FEATURES);
    }
    await database.db.query("UPDATE launches SET tracking_ended_at = $1 WHERE mint = $2", [
      new Date(LAUNCHES.diedBeforeRestart.atMs + 30 * MINUTE),
      LAUNCHES.diedBeforeRestart.mint
    ]);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it("trades a launch alive at a restart up to the gap and skips entries only after its data became incomplete", async () => {
    const config = defaultStrategyConfig();
    config.tracker.convergence.maxRiskScore = 100;
    const result = await runBacktest({ db: database.db, fromMs: FROM, toMs: TO, config });
    const signals = await database.db.query<{ mint: string; acted: boolean; skip_reason: string | null }>(
      "SELECT mint, acted, skip_reason FROM signals WHERE run_id = $1 ORDER BY at, id",
      [result.runId]
    );
    const byMint = Object.fromEntries(signals.rows.map((row) => [row.mint, { acted: row.acted, skip: row.skip_reason }]));
    expect(byMint).toEqual({
      [LAUNCHES.diedBeforeRestart.mint]: { acted: true, skip: null },
      [LAUNCHES.aliveAtRestart.mint]: { acted: true, skip: null },
      [LAUNCHES.gapBeforeEntry.mint]: { acted: false, skip: INCOMPLETE_DATA_REASON },
      [LAUNCHES.incompleteFromStart.mint]: { acted: false, skip: INCOMPLETE_DATA_REASON }
    });
    expect(result.closedTrades.map((trade) => trade.mint).sort()).toEqual([LAUNCHES.diedBeforeRestart.mint, LAUNCHES.aliveAtRestart.mint].sort());
    expect(result.summary.counts).toMatchObject({ launches: 4, incompleteLaunches: 3, trades: 4 * convergenceTrades(W).length });
  }, 120_000);
});
