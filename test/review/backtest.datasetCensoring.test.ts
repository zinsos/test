import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDataset } from "../../src/scorer/dataset.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";
import { insertLaunches } from "../tracker.db.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 23, 12);

async function addRows(database: TestDatabase, launchId: number, createdAtMs: number, outcome: { status: string; rugged: boolean; knownAtMs: number | null; finalized: boolean }): Promise<void> {
  await database.db.query(
    `INSERT INTO launch_scores (launch_id, checkpoint_sec, mint, computed_at, slot, score, features, contributions, weights_version)
     SELECT id, 30, mint, $2, 1, 50, '{"bundle_share": 0.1}', '{}', 'hand-v1' FROM launches WHERE id = $1`,
    [launchId, new Date(createdAtMs + 31_000)]
  );
  await database.db.query(
    `INSERT INTO launch_outcomes (launch_id, status, rugged, outcome_known_at, finalized, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [launchId, outcome.status, outcome.rugged, outcome.knownAtMs === null ? null : new Date(outcome.knownAtMs), outcome.finalized, new Date(NOW)]
  );
}

describe.skipIf(!hasTestDatabase)("review: scorer dataset label censoring", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("review_dataset");
    const created = NOW - 2 * HOUR;
    const ids = await insertLaunches(database.db, [
      { mint: "YoungRugMint", createdAtMs: created },
      { mint: "YoungAliveMint", createdAtMs: created }
    ]);
    await addRows(database, ids.get("YoungRugMint") ?? 0, created, { status: "rugged", rugged: true, knownAtMs: created + 10 * 60_000, finalized: true });
    await addRows(database, ids.get("YoungAliveMint") ?? 0, created, { status: "alive", rugged: false, knownAtMs: null, finalized: false });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("does not keep launches of the same age only when they already resolved badly", async () => {
    const rows = await buildDataset(database.db, { checkpointSec: 30 });
    const mints = rows.map((row) => row.mint).sort();
    expect(mints.includes("YoungRugMint")).toBe(mints.includes("YoungAliveMint"));
  });
});
