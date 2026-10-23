import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VirtualClock } from "../src/core/clock.js";
import type { Db } from "../src/db/pool.js";
import { latestRun, latestRunAsOf, TrackedWalletRegistry } from "../src/tracker/registry.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const DAY = 86_400_000;
const T1 = Date.UTC(2026, 8, 1);
const T2 = T1 + 7 * DAY;
const T3 = T2 + 7 * DAY;

async function insertRun(db: Db, asOfMs: number, wallets: Array<{ wallet: string; tracked: boolean; rank: number | null; score: number }>): Promise<number> {
  const run = await db.query<{ id: bigint }>(
    `INSERT INTO wallet_rank_runs (as_of, params, candidates, tracked) VALUES ($1, '{}', $2, $3) RETURNING id`,
    [new Date(asOfMs), wallets.length, wallets.filter((wallet) => wallet.tracked).length]
  );
  const runId = Number(run.rows[0]?.id ?? 0);
  for (const wallet of wallets) {
    await db.query(
      `INSERT INTO wallet_ranks (run_id, wallet, rank, score, tracked, excluded) VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, wallet.wallet, wallet.rank, wallet.score, wallet.tracked, !wallet.tracked]
    );
  }
  return runId;
}

describe("static registry", () => {
  it("tracks the given wallets with ranks in order", () => {
    const registry = TrackedWalletRegistry.fromWallets(["A", { wallet: "B", score: 3, rank: 7 }]);
    expect(registry.count()).toBe(2);
    expect(registry.isTracked("A")).toBe(true);
    expect(registry.isTracked("C")).toBe(false);
    expect(registry.get("A")).toEqual({ wallet: "A", rank: 1, score: 1, runId: 0 });
    expect(registry.get("B")?.rank).toBe(7);
    expect(registry.version()).toBe("static:2");
    expect(registry.currentRun()).toBeNull();
    registry.setWallets(["Z"]);
    expect(registry.isTracked("A")).toBe(false);
    expect(registry.list().map((wallet) => wallet.wallet)).toEqual(["Z"]);
  });

  it("refuses database operations without a database", async () => {
    const registry = TrackedWalletRegistry.fromWallets([]);
    await expect(registry.load(T1)).rejects.toThrow("no database");
    expect(registry.setAsOf(T1)).toBe(false);
  });
});

describe.skipIf(!hasTestDatabase)("tracked wallet registry", () => {
  let database: TestDatabase;
  let run1 = 0;
  let run2 = 0;
  let run2b = 0;
  let run3 = 0;

  beforeAll(async () => {
    database = await createTestDatabase("tracker_registry");
    const db = database.db;
    run1 = await insertRun(db, T1, [
      { wallet: "A", tracked: true, rank: 1, score: 5 },
      { wallet: "B", tracked: true, rank: 2, score: 4 },
      { wallet: "X", tracked: false, rank: null, score: 9 }
    ]);
    run2 = await insertRun(db, T2, [{ wallet: "C", tracked: true, rank: 1, score: 2 }]);
    run2b = await insertRun(db, T2, [
      { wallet: "D", tracked: true, rank: 1, score: 3 },
      { wallet: "A", tracked: true, rank: 2, score: 1 }
    ]);
    run3 = await insertRun(db, T3, [{ wallet: "E", tracked: true, rank: 1, score: 8 }]);
  });

  afterAll(async () => {
    await database.drop();
  });

  it("picks the most recent run at or before the decision time", async () => {
    const db = database.db;
    expect(await latestRunAsOf(db, T1 - 1)).toBeNull();
    expect((await latestRunAsOf(db, T1))?.runId).toBe(run1);
    expect((await latestRunAsOf(db, T2 - 1))?.runId).toBe(run1);
    expect((await latestRunAsOf(db, T2))?.runId).toBe(run2b);
    expect((await latestRun(db))?.runId).toBe(run3);
    expect(run2).toBeLessThan(run2b);
  });

  it("loads only tracked wallets of the chosen run", async () => {
    const registry = await TrackedWalletRegistry.loadAsOf(database.db, T2 - 1);
    expect(registry.count()).toBe(2);
    expect(registry.isTracked("A")).toBe(true);
    expect(registry.isTracked("X")).toBe(false);
    expect(registry.get("B")).toEqual({ wallet: "B", rank: 2, score: 4, runId: run1 });
    expect(registry.version()).toBe(`run:${run1}`);
    await registry.load(T2 + DAY);
    expect(registry.list().map((wallet) => wallet.wallet)).toEqual(["D", "A"]);
    expect(registry.currentRun()).toEqual({ runId: run2b, asOfMs: T2 });
    await registry.load(T1 - DAY);
    expect(registry.count()).toBe(0);
    expect(registry.version()).toBe("none");
  });

  it("walks forward through preloaded runs without lookahead", async () => {
    const registry = new TrackedWalletRegistry({ db: database.db });
    expect(await registry.preloadRuns({ fromMs: T2, toMs: T3 + DAY })).toBe(4);
    expect(registry.setAsOf(T1 - 1)).toBe(false);
    expect(registry.count()).toBe(0);
    expect(registry.setAsOf(T1 + DAY)).toBe(true);
    expect(registry.version()).toBe(`run:${run1}`);
    expect(registry.setAsOf(T1 + 2 * DAY)).toBe(false);
    expect(registry.setAsOf(T2 - 1)).toBe(false);
    expect(registry.setAsOf(T2)).toBe(true);
    expect(registry.version()).toBe(`run:${run2b}`);
    expect(registry.isTracked("D")).toBe(true);
    expect(registry.setAsOf(T3 + 1)).toBe(true);
    expect(registry.list().map((wallet) => wallet.wallet)).toEqual(["E"]);
    expect(registry.setAsOf(T1)).toBe(true);
    expect(registry.version()).toBe(`run:${run1}`);
  });

  it("preloads only the run in force at the range start plus runs inside the range", async () => {
    const registry = new TrackedWalletRegistry({ db: database.db });
    expect(await registry.preloadRuns({ fromMs: T3, toMs: T3 + DAY })).toBe(2);
    registry.setAsOf(T3 - 1);
    expect(registry.version()).toBe(`run:${run2b}`);
    expect(await registry.preloadRuns({ fromMs: T1, toMs: T2 - 1 })).toBe(1);
  });

  it("refreshes on its clock in live mode", async () => {
    const clock = new VirtualClock(T3 + DAY);
    const registry = new TrackedWalletRegistry({ db: database.db, clock, refreshIntervalMs: 60_000 });
    await registry.refresh();
    expect(registry.version()).toBe(`run:${run3}`);
    registry.startAutoRefresh();
    const run4 = await insertRun(database.db, T3 + DAY + 30_000, [{ wallet: "F", tracked: true, rank: 1, score: 1 }]);
    await clock.advanceTo(T3 + DAY + 61_000);
    expect(registry.version()).toBe(`run:${run4}`);
    registry.stop();
    expect(clock.pendingCount()).toBe(0);
  });
});

describe.skipIf(!hasTestDatabase)("rank run availability and scope", () => {
  let database: TestDatabase;
  const HOUR = 3_600_000;
  const AS_OF = Date.UTC(2026, 9, 12);

  async function run(asOfMs: number, ranAtMs: number, params: Record<string, unknown>, wallets: string[]): Promise<number> {
    const inserted = await database.db.query<{ id: bigint }>(
      `INSERT INTO wallet_rank_runs (as_of, ran_at, params, candidates, tracked) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [new Date(asOfMs), new Date(ranAtMs), JSON.stringify(params), wallets.length]
    );
    const runId = Number(inserted.rows[0]?.id ?? 0);
    for (const [index, wallet] of wallets.entries()) {
      await database.db.query(`INSERT INTO wallet_ranks (run_id, wallet, rank, score, tracked) VALUES ($1, $2, $3, 1, true)`, [runId, wallet, index + 1]);
    }
    return runId;
  }

  beforeAll(async () => {
    database = await createTestDatabase("tracker_registry_scope");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("switches to a live rerank only once it was written and to a point-in-time run at its as_of", async () => {
    const live = { label: "live", historyKnownBeforeMs: null };
    const quick = await run(AS_OF, AS_OF + 5 * 60_000, live, ["QuickA"]);
    const backfilled = await run(AS_OF, AS_OF + 4 * HOUR, live, ["BackfilledA"]);
    const pointInTime = await run(AS_OF + 2 * HOUR, AS_OF + 30 * DAY, { label: "cli-as-of", historyKnownBeforeMs: AS_OF + 2 * HOUR }, ["AsOfA"]);
    const registry = new TrackedWalletRegistry({ db: database.db });
    expect(await registry.preloadRuns({ fromMs: AS_OF - DAY, toMs: AS_OF + DAY })).toBe(3);
    registry.setAsOf(AS_OF + 60_000);
    expect(registry.count()).toBe(0);
    registry.setAsOf(AS_OF + HOUR);
    expect(registry.currentRun()?.runId).toBe(quick);
    registry.setAsOf(AS_OF + 3 * HOUR);
    expect(registry.currentRun()?.runId).toBe(pointInTime);
    registry.setAsOf(AS_OF + 5 * HOUR);
    expect(registry.currentRun()?.runId).toBe(pointInTime);
    expect(registry.isTracked("BackfilledA")).toBe(false);
    registry.setAsOf(AS_OF + HOUR);
    expect(registry.currentRun()?.runId).toBe(quick);
    expect(backfilled).toBeGreaterThan(quick);
    await database.db.query("DELETE FROM wallet_rank_runs WHERE id = $1", [pointInTime]);
    await registry.preloadRuns({ fromMs: AS_OF + 3 * HOUR, toMs: AS_OF + DAY });
    registry.setAsOf(AS_OF + 3 * HOUR);
    expect(registry.currentRun()?.runId).toBe(quick);
    registry.setAsOf(AS_OF + 5 * HOUR);
    expect(registry.currentRun()?.runId).toBe(backfilled);
  });

  it("keeps walk-forward runs away from live readers and preloads them only when asked for", async () => {
    await database.db.query("TRUNCATE wallet_rank_runs CASCADE");
    const published = await run(AS_OF, AS_OF, { label: "live", historyKnownBeforeMs: null }, ["LiveA"]);
    const walkForward = await run(AS_OF + DAY, AS_OF + 40 * DAY, { label: "walk-forward", historyKnownBeforeMs: AS_OF + DAY }, ["WalkA"]);
    expect((await latestRun(database.db))?.runId).toBe(published);
    expect((await latestRunAsOf(database.db, AS_OF + 2 * DAY))?.runId).toBe(published);
    const live = await TrackedWalletRegistry.loadAsOf(database.db, AS_OF + 2 * DAY);
    expect(live.isTracked("WalkA")).toBe(false);
    const snypra = await database.db.query<{ wallet: string; run_id: unknown }>("SELECT wallet, run_id FROM snypra_tracked_wallets ORDER BY wallet");
    expect(snypra.rows.map((row) => [row.wallet, Number(row.run_id)])).toEqual([["LiveA", published]]);
    const backtest = new TrackedWalletRegistry({ db: database.db });
    expect(await backtest.preloadRuns({ fromMs: AS_OF, toMs: AS_OF + 2 * DAY })).toBe(1);
    expect(await backtest.preloadRuns({ fromMs: AS_OF, toMs: AS_OF + 2 * DAY }, [walkForward])).toBe(1);
    backtest.setAsOf(AS_OF + 2 * DAY);
    expect(backtest.currentRun()?.runId).toBe(walkForward);
    backtest.setAsOf(AS_OF);
    expect(backtest.count()).toBe(0);
  });
});
