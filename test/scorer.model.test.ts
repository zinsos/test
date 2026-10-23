import { describe, expect, it } from "vitest";
import { exceedsRisk, hardBlockFlags, loadScoringModel, riskAt, ScoringModel } from "../src/scorer/model.js";
import { DEFAULT_WEIGHTS, formatWeights, loadWeightsFile, parseWeights, type WeightsFile } from "../src/scorer/weights.js";
import { FEATURE_NAMES } from "../src/scorer/featureNames.js";
import { scorerConfig } from "./scorer.fixtures.js";

const hardBlocks = scorerConfig().hardBlocks;

const twoFeatures: WeightsFile = {
  version: "test-v1",
  features: {
    a: { weight: 3, points: [[0, 0], [1, 1]], missingRisk: 0.5 },
    b: { weight: 1, points: [[10, 1], [0, 0]], missingRisk: 1 },
    ignored: { weight: 0, points: [[0, 1]], missingRisk: 1 }
  }
};

describe("riskAt", () => {
  const points: Array<[number, number]> = [[0, 0], [10, 0.5], [20, 1]];

  it("clamps below the first and above the last point", () => {
    expect(riskAt(points, -5)).toBe(0);
    expect(riskAt(points, 100)).toBe(1);
  });

  it("interpolates linearly between points", () => {
    expect(riskAt(points, 5)).toBeCloseTo(0.25, 10);
    expect(riskAt(points, 15)).toBeCloseTo(0.75, 10);
    expect(riskAt(points, 10)).toBe(0.5);
  });

  it("handles decreasing curves, steps and empty point lists", () => {
    expect(riskAt([[0, 1], [10, 0]], 2.5)).toBeCloseTo(0.75, 10);
    expect(riskAt([[0, 0], [0, 1]], 0)).toBe(0);
    expect(riskAt([[0, 0], [0, 1], [1, 1]], 0.5)).toBe(1);
    expect(riskAt([], 3)).toBe(0);
    expect(riskAt([[4, 0.3]], 100)).toBe(0.3);
  });
});

describe("ScoringModel", () => {
  const model = new ScoringModel(twoFeatures);

  it("computes the weighted mean risk scaled to 100", () => {
    const result = model.score({ a: 0.5, b: 10 }, hardBlocks);
    expect(result.score).toBeCloseTo((100 * (3 * 0.5 + 1 * 1)) / 4, 2);
    expect(result.weightsVersion).toBe("test-v1");
    expect(result.hardBlocked).toBe(false);
  });

  it("uses missingRisk with half weight for missing or non-finite features", () => {
    const result = model.score({ a: 1, b: null }, hardBlocks);
    expect(result.score).toBeCloseTo((100 * (3 * 1 + 0.5 * 1)) / 3.5, 2);
    const nan = model.score({ a: Number.NaN, b: 0 }, hardBlocks);
    expect(nan.score).toBeCloseTo((100 * (1.5 * 0.5)) / 2.5, 2);
  });

  it("sorts unsorted points and ignores zero-weight features", () => {
    expect(model.featureNames()).toEqual(["a", "b"]);
    expect(model.score({ a: 0, b: 5 }, hardBlocks).score).toBeCloseTo((100 * 0.5) / 4, 2);
  });

  it("returns contributions that add up to the score", () => {
    const result = model.score({ a: 0.7, b: 3 }, hardBlocks);
    const total = Object.values(result.contributions).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(result.score, 1);
    expect(Object.keys(result.contributions).sort()).toEqual(["a", "b"]);
  });

  it("scores zero when no feature has weight", () => {
    const empty = new ScoringModel({ version: "empty", features: {} });
    expect(empty.score({ a: 1 }, hardBlocks).score).toBe(0);
  });

  it("applies hard blocks strictly above thresholds", () => {
    expect(hardBlockFlags({ dev_share: 0.2 }, hardBlocks)).toEqual([]);
    expect(hardBlockFlags({ dev_share: 0.21 }, hardBlocks)).toEqual(["hard_dev_share"]);
    expect(hardBlockFlags({ bundle_share: 0.3, largest_cluster_share: 0.31 }, hardBlocks)).toEqual([
      "hard_bundle_share",
      "hard_cluster_share"
    ]);
    expect(hardBlockFlags({ dev_rug_rate: 0.9, dev_outcome_count: 2 }, hardBlocks)).toEqual([]);
    expect(hardBlockFlags({ dev_rug_rate: 0.9, dev_outcome_count: 3 }, hardBlocks)).toEqual(["hard_dev_rug_rate"]);
    expect(hardBlockFlags({ dev_rug_rate: null, dev_outcome_count: 10 }, hardBlocks)).toEqual([]);
    const blocked = new ScoringModel(DEFAULT_WEIGHTS).score({ bundle_share: 0.4 }, hardBlocks);
    expect(blocked.hardBlocked).toBe(true);
    expect(blocked.flags).toContain("hard_bundle_share");
    expect(exceedsRisk(blocked, 100)).toBe(true);
    expect(exceedsRisk({ score: 56, hardBlocked: false }, 55)).toBe(true);
    expect(exceedsRisk({ score: 55, hardBlocked: false }, 55)).toBe(false);
  });

  it("ranks a bundled, clustered launch far above a clean one with the default weights", () => {
    const defaults = ScoringModel.default();
    const clean = defaults.score(
      {
        bundle_bought_share: 0,
        bundle_share: 0,
        creation_slot_buyers: 0,
        largest_cluster_share: 0,
        largest_cluster_size: 0,
        dev_funded_buyers: 0,
        cluster_count: 0,
        dev_share: 0.01,
        dev_sold_fraction: 0,
        dev_rug_rate: 0,
        dev_launch_count: 1,
        dev_migration_rate: 0.3,
        top10_share: 0.15,
        fresh_wallet_ratio: 0.1,
        unique_buyers_per_min: 40,
        buy_sell_count_ratio: 2,
        buy_sell_volume_ratio: 2,
        volume_hhi: 0.04,
        wash_ratio: 0,
        socials_count: 3,
        copycat: 0,
        same_ticker_recent: 0
      },
      hardBlocks
    );
    const dirty = defaults.score(
      {
        bundle_bought_share: 0.2,
        bundle_share: 0.18,
        creation_slot_buyers: 6,
        largest_cluster_share: 0.2,
        largest_cluster_size: 6,
        dev_funded_buyers: 3,
        cluster_count: 2,
        dev_share: 0.08,
        dev_sold_fraction: 0,
        top10_share: 0.5,
        fresh_wallet_ratio: 0.9
      },
      hardBlocks
    );
    expect(clean.score).toBeLessThan(15);
    expect(dirty.score).toBeGreaterThan(70);
  });

  it("weights bundles and clusters above dev, concentration, flow and metadata", () => {
    const weight = (name: string): number => DEFAULT_WEIGHTS.features[name]?.weight ?? 0;
    expect(weight("bundle_bought_share")).toBeGreaterThanOrEqual(weight("dev_share"));
    expect(weight("largest_cluster_share")).toBeGreaterThanOrEqual(weight("dev_rug_rate"));
    expect(weight("dev_share")).toBeGreaterThan(weight("top10_share"));
    expect(weight("top10_share")).toBeGreaterThan(weight("unique_buyers_per_min"));
    expect(weight("unique_buyers_per_min")).toBeGreaterThan(weight("socials_count"));
    for (const name of Object.keys(DEFAULT_WEIGHTS.features)) {
      expect(FEATURE_NAMES).toContain(name);
    }
  });
});

describe("weights files", () => {
  it("rejects malformed weights", () => {
    expect(() => parseWeights({ version: "x", features: { a: { weight: -1, points: [[0, 0]] } } })).toThrow();
    expect(() => parseWeights({ version: "x", features: { a: { weight: 1, points: [] } } })).toThrow();
    expect(() => parseWeights({ version: "x", features: { a: { weight: 1, points: [[0, 2]] } } })).toThrow();
    expect(() => parseWeights({ features: {} })).toThrow();
    expect(parseWeights({ version: "x", features: { a: { weight: 1, points: [[0, 0]] } } }).features.a?.missingRisk).toBe(0.5);
  });

  it("formats points compactly and round-trips", () => {
    const text = formatWeights(DEFAULT_WEIGHTS);
    expect(text).toContain('"points": [[0, 0], [0.02, 0.25], [0.05, 0.6], [0.1, 0.9], [0.2, 1]]');
    expect(parseWeights(JSON.parse(text))).toEqual(DEFAULT_WEIGHTS);
  });

  it("ships a valid config/scorer-weights.json and loads it", async () => {
    const file = await loadWeightsFile("config/scorer-weights.json");
    expect(file).not.toBeNull();
    expect(Object.keys(file?.features ?? {}).length).toBeGreaterThan(15);
    const loaded = await loadScoringModel({ filePath: "config/scorer-weights.json" });
    expect(loaded.source).toBe("file");
    const fallback = await loadScoringModel({ filePath: "config/does-not-exist.json" });
    expect(fallback.source).toBe("default");
    expect(fallback.model.version).toBe(DEFAULT_WEIGHTS.version);
  });
});
