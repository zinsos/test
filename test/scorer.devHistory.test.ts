import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevHistoryService, EMPTY_DEV_HISTORY, summarize } from "../src/scorer/devHistory.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { countingDb, insertLaunch, insertOutcome } from "./scorer.db.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const T = Date.UTC(2026, 9, 20, 12, 0, 0);

describe("dev history summary", () => {
  it("derives rates only when outcomes exist", () => {
    expect(summarize(undefined)).toEqual(EMPTY_DEV_HISTORY);
    expect(
      summarize({ launch_count: 4n, outcome_count: 0, rugged_count: 0, migrated_count: 0, median_peak_multiple: null })
    ).toEqual({ ...EMPTY_DEV_HISTORY, launchCount: 4 });
    expect(
      summarize({ launch_count: 4, outcome_count: 4, rugged_count: 3, migrated_count: 1, median_peak_multiple: 1.5 })
    ).toEqual({
      launchCount: 4,
      outcomeCount: 4,
      ruggedCount: 3,
      migratedCount: 1,
      rugRate: 0.75,
      migrationRate: 0.25,
      medianPeakMultiple: 1.5
    });
  });
});

describe.skipIf(!hasTestDatabase)("DevHistoryService", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("scorer_devhist");
    const db = database.db;
    const l1 = await insertLaunch(db, { mint: "L1", dev: "SerialDev", createdAtMs: T - 5 * HOUR });
    await insertOutcome(db, l1, { rugged: true, knownAtMs: T - 3 * HOUR, rugAtMs: T - 4 * HOUR, peakMultiple: 2, peakAtMs: T - 4.5 * HOUR });
    const l2 = await insertLaunch(db, { mint: "L2", dev: "SerialDev", createdAtMs: T - 4 * HOUR });
    await insertOutcome(db, l2, { rugged: true, knownAtMs: T - 2 * HOUR, peakMultiple: 1.5, peakAtMs: T - 3.9 * HOUR });
    const l3 = await insertLaunch(db, { mint: "L3", dev: "SerialDev", createdAtMs: T - 3 * HOUR });
    await insertOutcome(db, l3, { died: true, knownAtMs: T - HOUR, peakMultiple: 1.2, peakAtMs: T - 2.9 * HOUR });
    const l4 = await insertLaunch(db, { mint: "L4", dev: "SerialDev", createdAtMs: T - 2 * HOUR, migratedAtMs: T - 40 * MINUTE });
    await insertOutcome(db, l4, { migrated: true, knownAtMs: T - 30 * MINUTE, peakMultiple: 10, peakAtMs: T + HOUR });
    const l5 = await insertLaunch(db, { mint: "L5", dev: "SerialDev", createdAtMs: T - HOUR });
    await insertOutcome(db, l5, { rugged: true, knownAtMs: T + 10 * MINUTE, peakMultiple: 3, peakAtMs: T - 50 * MINUTE });
    const l6 = await insertLaunch(db, { mint: "L6", dev: "SerialDev", createdAtMs: T + HOUR });
    await insertOutcome(db, l6, { rugged: true, knownAtMs: T + 2 * HOUR });
    const l7 = await insertLaunch(db, { mint: "L7", dev: "Other", creator: "SerialDev", createdAtMs: T - 6 * HOUR });
    await insertOutcome(db, l7, { died: true, knownAtMs: T - 5 * HOUR, peakMultiple: 1.1, peakAtMs: T - 5.9 * HOUR });
    await insertLaunch(db, { mint: "CUR", dev: "SerialDev", createdAtMs: T - MINUTE });
    await insertLaunch(db, { mint: "Unrelated", dev: "Stranger", createdAtMs: T - HOUR });
  });

  afterAll(async () => {
    await database.drop();
  });

  it("counts only launches and outcomes knowable before the decision time", async () => {
    const service = new DevHistoryService({ db: database.db });
    const summary = await service.lookup(["SerialDev"], T, "CUR");
    expect(summary.launchCount).toBe(6);
    expect(summary.outcomeCount).toBe(5);
    expect(summary.ruggedCount).toBe(2);
    expect(summary.migratedCount).toBe(1);
    expect(summary.rugRate).toBeCloseTo(0.4, 10);
    expect(summary.migrationRate).toBeCloseTo(0.2, 10);
    expect(summary.medianPeakMultiple).toBeCloseTo(1.35, 4);
  });

  it("sees more once later outcomes and peaks become known", async () => {
    const service = new DevHistoryService({ db: database.db });
    const later = await service.lookup(["SerialDev"], T + 3 * HOUR, "CUR");
    expect(later.launchCount).toBe(7);
    expect(later.outcomeCount).toBe(7);
    expect(later.ruggedCount).toBe(4);
    expect(later.medianPeakMultiple).toBeCloseTo(1.75, 4);
  });

  it("matches both dev wallet and creator and excludes the scored mint", async () => {
    const service = new DevHistoryService({ db: database.db });
    const asCreatorOnly = await service.lookup(["Other"], T, "none");
    expect(asCreatorOnly.launchCount).toBe(1);
    const withCurrent = await service.lookup(["SerialDev"], T, "none");
    expect(withCurrent.launchCount).toBe(7);
    const both = await service.lookup(["SerialDev", "Other", "SerialDev"], T, "CUR");
    expect(both.launchCount).toBe(6);
  });

  it("returns an empty history for unknown or empty dev lists", async () => {
    const service = new DevHistoryService({ db: database.db });
    expect(await service.lookup(["Nobody"], T, "CUR")).toEqual(EMPTY_DEV_HISTORY);
    expect(await service.lookup([], T, "CUR")).toEqual(EMPTY_DEV_HISTORY);
  });

  it("caches forward in time only within the ttl", async () => {
    const counted = countingDb(database.db);
    const service = new DevHistoryService({ db: counted.db, cacheTtlMs: 60_000 });
    await service.lookup(["SerialDev"], T, "CUR");
    await service.lookup(["SerialDev"], T + 30_000, "CUR");
    expect(counted.calls()).toBe(1);
    await service.lookup(["SerialDev"], T - 10_000, "CUR");
    expect(counted.calls()).toBe(2);
    await service.lookup(["SerialDev"], T + 3 * HOUR, "CUR");
    expect(counted.calls()).toBe(3);
  });
});
