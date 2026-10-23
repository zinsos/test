import { describe, expect, it } from "vitest";
import { computeFeatures } from "../src/scorer/features.js";
import { exceedsRisk, hardBlockFlags, loadScoringModel, riskAt, ScoringModel, soloFlag } from "../src/scorer/model.js";
import { DEFAULT_WEIGHTS, formatWeights, loadWeightsFile, parseWeights, type WeightsFile } from "../src/scorer/weights.js";
import { FEATURE_NAMES } from "../src/scorer/featureNames.js";
import type { WalletIntel } from "../src/scorer/types.js";
import { intelEntry, LaunchBuilder, scorerConfig, SOL } from "./scorer.fixtures.js";

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

describe("solo terms", () => {
  const soloWeights: WeightsFile = {
    version: "solo-v1",
    features: {
      a: { weight: 3, points: [[0, 0], [1, 1]], missingRisk: 0.5, solo: 80 },
      b: { weight: 1, points: [[0, 0], [1, 1]], missingRisk: 1 },
      c: { weight: 0, points: [[0, 0], [1, 1]], missingRisk: 1, solo: 50 }
    }
  };
  const model = new ScoringModel(soloWeights);

  it("scores the strongest single red flag when it beats the weighted mean and names it in the flags", () => {
    const result = model.score({ a: 1, b: 0, c: 0 }, hardBlocks);
    expect(result.score).toBe(80);
    expect(result.flags).toEqual([soloFlag("a")]);
    expect(result.hardBlocked).toBe(false);
    expect(result.contributions).toEqual({ a: 75, b: 0 });
  });

  it("keeps the weighted mean when it is higher and scales the solo term by risk", () => {
    expect(model.score({ a: 1, b: 1, c: 1 }, hardBlocks)).toMatchObject({ score: 100, flags: [] });
    expect(model.score({ a: 0.5, b: 0, c: 0 }, hardBlocks)).toMatchObject({ score: 40, flags: [soloFlag("a")] });
  });

  it("never applies a solo term to a missing feature", () => {
    const result = model.score({ a: null, b: 0, c: null }, hardBlocks);
    expect(result.flags).toEqual([]);
    expect(result.score).toBeCloseTo((100 * 1.5 * 0.5) / 2.5, 2);
  });

  it("lets a zero-weight feature act only through its solo term", () => {
    const result = model.score({ a: 0, b: 0, c: 1 }, hardBlocks);
    expect(result.score).toBe(50);
    expect(result.flags).toEqual([soloFlag("c")]);
    expect(Object.keys(result.contributions).sort()).toEqual(["a", "b"]);
  });

  it("keeps hard blocks and solo flags apart", () => {
    const blocked = ScoringModel.default().score({ bundle_share: 0.4 }, hardBlocks);
    expect(blocked.hardBlocked).toBe(true);
    expect(blocked.flags).toEqual(["hard_bundle_share", soloFlag("bundle_share")]);
  });
});

describe("default weights on single red flags", () => {
  const config = scorerConfig();
  const defaults = ScoringModel.default();

  function launch(bundleWallets: number, perWallet: bigint, organic: number): LaunchBuilder {
    const builder = new LaunchBuilder({ mint: `Solo${bundleWallets}x${perWallet}x${organic}` });
    builder.buy("DevWallet", SOL / 2n, { slot: builder.createdSlot });
    for (let index = 0; index < bundleWallets; index += 1) {
      builder.buy(`bundle${index}`, perWallet, { slot: builder.createdSlot, atMs: builder.createdAtMs });
    }
    for (let index = 0; index < organic; index += 1) {
      builder.buy(`organic${index}`, SOL / 5n, { atMs: builder.createdAtMs + 2_000 + index * 900 });
    }
    return builder;
  }

  function cleanIntel(builder: LaunchBuilder): Map<string, WalletIntel> {
    return new Map([...builder.launch.wallets.keys()].map((wallet) => [wallet, intelEntry(wallet)]));
  }

  function scoreAt30s(builder: LaunchBuilder, intel: Map<string, WalletIntel> | null) {
    const result = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 30_000, config, intel });
    return { features: result.features, score: defaults.score(result.features, config.hardBlocks) };
  }

  it("blocks a 5-wallet creation-slot bundle without wallet intel on the bundle alone", () => {
    const { features, score } = scoreAt30s(launch(5, SOL / 2n, 25), null);
    expect(features.creation_slot_buyers).toBe(5);
    expect(features.bundle_share).toBeLessThan(config.hardBlocks.bundleShareAbove);
    expect(score.hardBlocked).toBe(false);
    expect(score.score).toBeGreaterThan(config.maxRisk);
    expect(score.flags.some((flag) => flag.startsWith("solo_bundle"))).toBe(true);
  });

  it("blocks 5 and 8 wallet bundles even when every wallet has clean deep intel", () => {
    for (const [wallets, perWallet] of [[5, SOL / 2n], [8, SOL]] as const) {
      const builder = launch(wallets, perWallet, 25);
      const { score } = scoreAt30s(builder, cleanIntel(builder));
      expect(score.hardBlocked).toBe(false);
      expect(exceedsRisk(score, config.maxRisk)).toBe(true);
    }
  });

  it("keeps clean organic launches well below maxRisk with or without intel", () => {
    const builder = launch(0, 0n, 25);
    for (const intel of [null, cleanIntel(builder)]) {
      const { score } = scoreAt30s(builder, intel);
      expect(score.score).toBeLessThan(config.maxRisk - 20);
      expect(score.hardBlocked).toBe(false);
    }
  });

  it("lets saturated bundle features alone exceed maxRisk when everything else is clean", () => {
    const vector: Record<string, number> = {};
    for (const [name, spec] of Object.entries(DEFAULT_WEIGHTS.features)) {
      const cleanest = [...spec.points].sort((a, b) => a[1] - b[1])[0];
      vector[name] = cleanest ? cleanest[0] : 0;
    }
    vector.bundle_bought_share = 0.24;
    vector.bundle_share = 0.24;
    vector.creation_slot_buyers = 10;
    const score = defaults.score(vector, config.hardBlocks);
    expect(score.hardBlocked).toBe(false);
    expect(score.score).toBeGreaterThan(config.maxRisk);
  });
});

describe("weights files", () => {
  it("rejects malformed weights", () => {
    expect(() => parseWeights({ version: "x", features: { a: { weight: -1, points: [[0, 0]] } } })).toThrow();
    expect(() => parseWeights({ version: "x", features: { a: { weight: 1, points: [] } } })).toThrow();
    expect(() => parseWeights({ version: "x", features: { a: { weight: 1, points: [[0, 2]] } } })).toThrow();
    expect(() => parseWeights({ features: {} })).toThrow();
    expect(parseWeights({ version: "x", features: { a: { weight: 1, points: [[0, 0]] } } }).features.a?.missingRisk).toBe(0.5);
    expect(() => parseWeights({ version: "x", features: { a: { weight: 1, points: [[0, 0]], solo: 101 } } })).toThrow();
    expect(parseWeights({ version: "x", features: { a: { weight: 1, points: [[0, 0]] } } }).features.a?.solo).toBeUndefined();
  });

  it("formats points compactly and round-trips", () => {
    const text = formatWeights(DEFAULT_WEIGHTS);
    expect(text).toContain('"points": [[0, 0], [0.02, 0.25], [0.05, 0.6], [0.1, 0.9], [0.2, 1]]');
    expect(parseWeights(JSON.parse(text))).toEqual(DEFAULT_WEIGHTS);
  });

  it("ships a valid config/scorer-weights.json and loads it", async () => {
    const file = await loadWeightsFile("config/scorer-weights.json");
    expect(file).toEqual(DEFAULT_WEIGHTS);
    expect(Object.keys(file?.features ?? {}).length).toBeGreaterThan(15);
    const loaded = await loadScoringModel({ filePath: "config/scorer-weights.json" });
    expect(loaded.source).toBe("file");
    const fallback = await loadScoringModel({ filePath: "config/does-not-exist.json" });
    expect(fallback.source).toBe("default");
    expect(fallback.model.version).toBe(DEFAULT_WEIGHTS.version);
  });
});
