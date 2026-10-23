import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrackedWalletRegistry } from "../../src/tracker/registry.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";

const HOUR = 3_600_000;
const AS_OF = Date.UTC(2026, 9, 12, 0, 0);

async function insertRun(database: TestDatabase, asOfMs: number, ranAtMs: number, wallets: readonly string[]): Promise<number> {
  const run = await database.db.query<{ id: string }>(
    "INSERT INTO wallet_rank_runs (as_of, ran_at, params, candidates, tracked) VALUES ($1, $2, '{}', $3, $3) RETURNING id::text",
    [new Date(asOfMs), new Date(ranAtMs), wallets.length]
  );
  const runId = Number(run.rows[0]?.id);
  for (const [index, wallet] of wallets.entries()) {
    await database.db.query("INSERT INTO wallet_ranks (run_id, wallet, rank, score, tracked) VALUES ($1, $2, $3, 1, true)", [runId, wallet, index + 1]);
  }
  return runId;
}

describe.skipIf(!hasTestDatabase)("review: when a wallet ranking becomes usable in a backtest", () => {
  let database: TestDatabase;
  let quickRun = 0;
  let postBackfillRun = 0;

  beforeAll(async () => {
    database = await createTestDatabase("review_rankavail");
    quickRun = await insertRun(database, AS_OF, AS_OF + 5 * 60_000, ["QuickA", "QuickB", "QuickC"]);
    postBackfillRun = await insertRun(database, AS_OF, AS_OF + 4 * HOUR, ["BackfilledA", "BackfilledB", "BackfilledC"]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("does not use the post-backfill rerank before it was written", async () => {
    const registry = new TrackedWalletRegistry({ db: database.db });
    await registry.preloadRuns({ fromMs: AS_OF - 24 * HOUR, toMs: AS_OF + 24 * HOUR });
    registry.setAsOf(AS_OF + HOUR);
    expect(registry.currentRun()?.runId).toBe(quickRun);
    expect(registry.isTracked("BackfilledA")).toBe(false);
    registry.setAsOf(AS_OF + 5 * HOUR);
    expect(registry.currentRun()?.runId).toBe(postBackfillRun);
  });
});
