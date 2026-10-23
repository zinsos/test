import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LaunchScore } from "../src/core/types.js";
import {
  buildDataset,
  csvHeader,
  csvLine,
  datasetColumns,
  exportCsv,
  iterateDataset,
  streamDatasetCsv,
  type DatasetRow
} from "../src/scorer/dataset.js";
import { FEATURE_NAMES, REPLAY_STORED_FEATURES } from "../src/scorer/featureNames.js";
import { LaunchScoreStore } from "../src/scorer/scoreStore.js";
import { loadStoredFeatures, StoredFeaturesIndex } from "../src/scorer/storedFeatures.js";
import { DEFAULT_WEIGHTS, loadActiveWeights, loadWeightsFile, saveWeights } from "../src/scorer/weights.js";
import { loadScoringModel } from "../src/scorer/model.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { insertLaunch, insertOutcome } from "./scorer.db.js";

const T = Date.UTC(2026, 9, 18, 0, 0, 0);
const MINUTE = 60_000;

function score(mint: string, checkpointSec: number, overrides: Partial<LaunchScore> = {}): LaunchScore {
  return {
    mint,
    launchId: null,
    checkpointSec,
    computedAtMs: T + checkpointSec * 1000 + 700,
    slot: 123,
    score: 42.5,
    hardBlocked: false,
    flags: ["bundled", "with,comma"],
    features: { bundle_share: 0.12, fresh_wallet_ratio: 0.5, largest_cluster_size: 3, has_twitter: null, dev_share: Number.NaN },
    contributions: { bundle_share: 10 },
    weightsVersion: "hand-v1",
    ...overrides
  };
}

function datasetRow(overrides: Partial<DatasetRow> = {}): DatasetRow {
  return {
    launchId: 7,
    mint: "MintX",
    createdAtMs: T,
    quoteMint: "SOL",
    checkpointSec: 30,
    score: 61.25,
    hardBlocked: true,
    features: { bundle_share: 0.2, copycat: 1 },
    labels: { survived15m: null, migrated: false, rugged: true, died: false, peakMultipleFrom1m: 1.5, return15mFrom1m: -0.8 },
    ...overrides
  };
}

describe("dataset csv", () => {
  it("has stable columns: base, every feature, labels", () => {
    const columns = datasetColumns();
    expect(columns.slice(0, 6)).toEqual(["launch_id", "mint", "created_at", "checkpoint_sec", "score", "hard_blocked"]);
    expect(columns.slice(6, 6 + FEATURE_NAMES.length)).toEqual([...FEATURE_NAMES]);
    expect(columns.slice(-6)).toEqual(["survived_15m", "migrated", "rugged", "died", "peak_multiple_from_1m", "return_15m_from_1m"]);
    expect(csvHeader().split(",")).toEqual(columns);
  });

  it("writes booleans as 0/1, nulls as empty and keeps one cell per column", () => {
    const line = csvLine(datasetRow());
    const cells = line.split(",");
    expect(cells).toHaveLength(datasetColumns().length);
    expect(cells[0]).toBe("7");
    expect(cells[2]).toBe(new Date(T).toISOString());
    expect(cells[5]).toBe("1");
    expect(cells[6 + FEATURE_NAMES.indexOf("bundle_share")]).toBe("0.2");
    expect(cells[6 + FEATURE_NAMES.indexOf("copycat")]).toBe("1");
    expect(cells[6 + FEATURE_NAMES.indexOf("dev_share")]).toBe("");
    expect(cells.slice(-6)).toEqual(["", "0", "1", "0", "1.5", "-0.8"]);
    const csv = exportCsv([datasetRow(), datasetRow({ mint: 'we"ird,mint' })]);
    expect(csv.split("\n")).toHaveLength(4);
    expect(csv).toContain('"we""ird,mint"');
  });
});

describe.skipIf(!hasTestDatabase)("scorer persistence", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("scorer_dataset");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("upserts scores, retries until the launch row exists and drops after max attempts", async () => {
    const store = new LaunchScoreStore({ db: database.db, maxAttempts: 3 });
    const launchA = await insertLaunch(database.db, { mint: "StoreA", createdAtMs: T });
    store.push(score("StoreA", 10), ["dev", "bundler"]);
    store.push(score("StoreLate", 10), []);
    store.push(score("StoreNever", 10), []);
    await store.flush();
    expect(store.stats()).toEqual({ buffered: 2, written: 1, dropped: 0 });
    const row = await database.db.query(
      "SELECT launch_id, score, flags, insiders, features, computed_at FROM launch_scores WHERE mint = 'StoreA'"
    );
    expect(row.rows[0]?.launch_id).toBe(BigInt(launchA));
    expect(row.rows[0]?.flags).toEqual(["bundled", "with,comma"]);
    expect(row.rows[0]?.insiders).toEqual(["dev", "bundler"]);
    expect(row.rows[0]?.features).toEqual({
      bundle_share: 0.12,
      fresh_wallet_ratio: 0.5,
      largest_cluster_size: 3,
      has_twitter: null,
      dev_share: null
    });
    expect((row.rows[0]?.computed_at as Date).getTime()).toBe(T + 10_700);
    await insertLaunch(database.db, { mint: "StoreLate", createdAtMs: T + MINUTE });
    await store.flush();
    expect(store.stats()).toEqual({ buffered: 1, written: 2, dropped: 0 });
    await store.flush();
    expect(store.stats()).toEqual({ buffered: 0, written: 2, dropped: 1 });
    store.push(score("StoreA", 10, { score: 80, hardBlocked: true }), []);
    store.push(score("StoreA", 10, { score: 90, hardBlocked: true }), []);
    await store.stop();
    const updated = await database.db.query("SELECT score, hard_blocked FROM launch_scores WHERE mint = 'StoreA'");
    expect(updated.rows).toEqual([{ score: 90, hard_blocked: true }]);
  });

  it("loads stored deep features for replay", async () => {
    const store = new LaunchScoreStore({ db: database.db });
    store.push(score("StoreA", 30), ["insiderA"]);
    await store.flush();
    const index = await loadStoredFeatures(database.db, { pageSize: 1 });
    const stored = index.get("StoreA", 30);
    expect(stored?.computedAtMs).toBe(T + 30_700);
    expect(stored?.insiders).toEqual(["insiderA"]);
    expect(stored?.features).toEqual({ fresh_wallet_ratio: 0.5, largest_cluster_size: 3, has_twitter: null });
    expect(index.checkpoints("StoreA")).toEqual([10, 30]);
    expect(index.get("StoreA", 60)).toBeNull();
    expect(index.lookup()("StoreLate", 10)).not.toBeNull();
    const filtered = await loadStoredFeatures(database.db, { from: new Date(T + 1_000) });
    expect(filtered.get("StoreA", 10)).toBeNull();
    expect(filtered.get("StoreLate", 10)).not.toBeNull();
  });

  it("builds a time-ordered dataset of scored launches with known outcomes", async () => {
    const db = database.db;
    const store = new LaunchScoreStore({ db });
    const mints = ["DsA", "DsB", "DsC", "DsD"];
    const ids: number[] = [];
    for (const [index, mint] of mints.entries()) {
      ids.push(await insertLaunch(db, { mint, createdAtMs: T + (10 - index) * MINUTE }));
      store.push(score(mint, 10, { score: 10 * index }), []);
      store.push(score(mint, 60, { score: 10 * index + 1 }), []);
    }
    await store.flush();
    await insertOutcome(db, ids[0] ?? 0, { rugged: true, knownAtMs: T + 20 * MINUTE, survived15m: false, peakMultipleFrom1m: 1.1 });
    await insertOutcome(db, ids[1] ?? 0, { migrated: true, finalized: true, survived15m: true, return15mFrom1m: 2.5 });
    await insertOutcome(db, ids[2] ?? 0, { died: true, knownAtMs: T + 30 * MINUTE, survived15m: false });
    await insertOutcome(db, ids[3] ?? 0, { knownAtMs: null, finalized: false });
    const rows = await buildDataset(db, { checkpointSec: 60, from: new Date(T) });
    expect(rows.map((row) => row.mint)).toEqual(["DsC", "DsB", "DsA"]);
    expect(rows.every((row) => row.checkpointSec === 60)).toBe(true);
    const dsb = rows.find((row) => row.mint === "DsB");
    expect(dsb?.labels).toEqual({
      survived15m: true,
      migrated: true,
      rugged: false,
      died: false,
      peakMultipleFrom1m: null,
      return15mFrom1m: 2.5
    });
    expect(dsb?.score).toBe(11);
    expect(dsb?.features.bundle_share).toBe(0.12);
    const all = await buildDataset(db, { from: new Date(T) });
    expect(all).toHaveLength(6);
    const pages: number[] = [];
    for await (const page of iterateDataset(db, { from: new Date(T) }, 4)) {
      pages.push(page.length);
    }
    expect(pages).toEqual([4, 2]);
    const limited = await buildDataset(db, { from: new Date(T), limit: 3 });
    expect(limited).toHaveLength(3);
    const chunks: string[] = [];
    for await (const chunk of streamDatasetCsv(db, { checkpointSec: 60, from: new Date(T) })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe(exportCsv(rows));
  });

  it("saves, activates and loads weights from the database and a file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scorer-weights-"));
    try {
      const filePath = path.join(directory, "weights.json");
      const first = { ...DEFAULT_WEIGHTS, version: "w1" };
      const second = { ...DEFAULT_WEIGHTS, version: "w2" };
      expect(await loadActiveWeights(database.db)).toBeNull();
      await saveWeights(database.db, { weights: first, labelName: "survived_15m", metrics: { auc: 0.7 }, activate: true });
      expect((await loadActiveWeights(database.db))?.version).toBe("w1");
      await saveWeights(database.db, { weights: second, activate: false, filePath });
      expect((await loadActiveWeights(database.db))?.version).toBe("w1");
      expect((await loadWeightsFile(filePath))?.version).toBe("w2");
      expect(await readFile(filePath, "utf8")).toContain('"points": [[');
      await saveWeights(database.db, { weights: second, activate: true });
      const active = await database.db.query("SELECT version FROM scorer_weights WHERE active");
      expect(active.rows).toEqual([{ version: "w2" }]);
      const loaded = await loadScoringModel({ db: database.db, filePath });
      expect(loaded.source).toBe("db");
      expect(loaded.model.version).toBe("w2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("StoredFeaturesIndex", () => {
  it("keeps only replay keys and distinguishes absent from null", () => {
    const index = new StoredFeaturesIndex();
    index.add("m", 10, { fresh_wallet_ratio: 0.25, cluster_count: null, bundle_share: 0.9 }, 5, ["a"]);
    const stored = index.get("m", 10);
    expect(stored?.features).toEqual({ fresh_wallet_ratio: 0.25, cluster_count: null });
    expect("largest_cluster_size" in (stored?.features ?? {})).toBe(false);
    expect(REPLAY_STORED_FEATURES).toContain("dev_rug_rate");
    expect(index.size).toBe(1);
  });
});
