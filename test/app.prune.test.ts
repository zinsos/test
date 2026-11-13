import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/app/cli.js";
import { loadEnv } from "../src/config/env.js";
import { ensureTradePartitions } from "../src/db/partitions.js";
import { partitionDayStart, pruneRecordedData } from "../src/db/retention.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { CLEAN_DEEP_FEATURES, convergenceTrades, seedLaunch, seedStoredScore } from "./backtest.seed.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);

describe("trade partition names", () => {
  it("reads the day a trade partition covers", () => {
    expect(partitionDayStart("trades_20261002")).toBe(Date.UTC(2026, 9, 2));
    expect(partitionDayStart("trades_default")).toBeNull();
  });
});

describe.skipIf(!hasTestDatabase)("pruning recorded data", () => {
  let database: TestDatabase;
  let oldId = 0;
  let recentId = 0;

  beforeAll(async () => {
    database = await createTestDatabase("app_prune");
    await ensureTradePartitions(database.db, NOW - 5 * DAY, 1, 6);
    oldId = await seedLaunch(database.db, { mint: "OldMint", dev: "DevOld", createdAtMs: NOW - 5 * DAY, slot: 1_000, trades: convergenceTrades(["a", "b", "c"]) });
    recentId = await seedLaunch(database.db, { mint: "RecentMint", dev: "DevNew", createdAtMs: NOW - DAY / 2, slot: 9_000, trades: convergenceTrades(["d", "e", "f"]) });
    await seedStoredScore(database.db, oldId, "OldMint", 30, NOW - 5 * DAY + 31_000, CLEAN_DEEP_FEATURES);
    await seedStoredScore(database.db, recentId, "RecentMint", 30, NOW - DAY / 2 + 31_000, CLEAN_DEEP_FEATURES);
    await database.db.query(
      `INSERT INTO holder_snapshots (launch_id, checkpoint_sec, source, taken_at, holder_count, holders)
       VALUES ($1, 30, 'trades', $2, 3, '[]'), ($3, 30, 'trades', $4, 3, '[]')`,
      [oldId, new Date(NOW - 5 * DAY + 30_000), recentId, new Date(NOW - DAY / 2 + 30_000)]
    );
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function counts(): Promise<Record<string, number>> {
    const result = await database.db.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM trades WHERE launch_id = $1) AS old_trades,
              (SELECT count(*)::int FROM trades WHERE launch_id = $2) AS recent_trades,
              (SELECT count(*)::int FROM launch_scores) AS scores,
              (SELECT count(*)::int FROM holder_snapshots) AS snapshots,
              (SELECT count(*)::int FROM launches) AS launches`,
      [oldId, recentId]
    );
    return result.rows[0] ?? {};
  }

  it("reports without deleting on a dry run, then drops whole old days and keeps launches and recent data", async () => {
    const dry = await pruneRecordedData(database.db, { beforeMs: NOW - 2 * DAY, dryRun: true });
    expect(dry.droppedPartitions).toContain("trades_20261015");
    expect(dry.launchesPruned).toBe(1);
    const tradesPerLaunch = convergenceTrades(["a", "b", "c"]).length;
    expect(await counts()).toEqual({ old_trades: tradesPerLaunch, recent_trades: tradesPerLaunch, scores: 2, snapshots: 2, launches: 2 });
    const run = await pruneRecordedData(database.db, { beforeMs: NOW - 2 * DAY });
    expect(run).toMatchObject({ scoresDeleted: 1, snapshotsDeleted: 1, launchesPruned: 1 });
    expect(await counts()).toEqual({ old_trades: 0, recent_trades: tradesPerLaunch, scores: 1, snapshots: 1, launches: 2 });
  });

  it("runs from the CLI and refuses to keep less than a day", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
    const env = loadEnv({ DATABASE_URL: database.url, LOG_LEVEL: "warn" });
    expect(await runCli(["prune-data", "--keep-days", "0"], io, { env })).toBe(2);
    expect(await runCli(["prune-data", "--keep-days", "3650", "--dry-run"], io, { env })).toBe(0);
    expect(out.join("\n")).toContain("(dry run)");
  });
});
