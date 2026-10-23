import { describe, expect, it } from "vitest";
import { computeFeatures, devWalletsOf, intelRequestsFor, ratio, uniqueBuyersAsOf } from "../src/scorer/features.js";
import { FEATURE_NAMES } from "../src/scorer/featureNames.js";
import { ScoringModel } from "../src/scorer/model.js";
import type { WalletIntel } from "../src/scorer/types.js";
import {
  intelEntry,
  LaunchBuilder,
  organicLaunch,
  PUMP_QUOTE_MINT,
  scorerConfig,
  SOL
} from "./scorer.fixtures.js";

const config = scorerConfig();
const model = ScoringModel.default();

function bundledLaunch(): LaunchBuilder {
  const builder = new LaunchBuilder({ mint: "BundledMint" });
  builder.buy("DevWallet", SOL, { slot: builder.createdSlot });
  for (let index = 0; index < 6; index += 1) {
    builder.buy(`bundle${index}`, (SOL * 3n) / 2n, { slot: builder.createdSlot, atMs: builder.createdAtMs });
  }
  builder.buy("late0", SOL / 10n, { atMs: builder.createdAtMs + 6_000 });
  builder.buy("late1", SOL / 10n, { atMs: builder.createdAtMs + 8_000 });
  return builder;
}

describe("computeFeatures", () => {
  it("returns every declared feature name", () => {
    const builder = organicLaunch();
    const result = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 60_000, config });
    expect(Object.keys(result.features).sort()).toEqual([...FEATURE_NAMES].sort());
  });

  it("detects creation-slot bundles and marks bundle wallets as insiders", () => {
    const builder = bundledLaunch();
    const nowMs = builder.createdAtMs + 10_000;
    const result = computeFeatures(builder.launch, { nowMs, config });
    expect(result.features.creation_slot_buyers).toBe(6);
    expect(result.features.bundle_bought_share).toBeGreaterThan(0.2);
    expect(result.features.bundle_share).toBeCloseTo(result.features.bundle_bought_share ?? 0, 6);
    expect(result.features.dev_initial_share).toBeGreaterThan(0.02);
    expect(result.bundleWallets).toHaveLength(6);
    expect(result.flags).toContain("bundled");
    for (let index = 0; index < 6; index += 1) {
      expect(result.insiders.has(`bundle${index}`)).toBe(true);
    }
    expect(result.insiders.has("DevWallet")).toBe(true);
    expect(result.insiders.has("late0")).toBe(false);
    expect(result.features.unique_buyers_per_min).toBeCloseTo(2 / (10 / 60), 6);
  });

  it("counts slot window buyers but not later buyers as bundles", () => {
    const builder = new LaunchBuilder();
    builder.buy("sameSlot", SOL, { slot: builder.createdSlot });
    builder.buy("nextSlot", SOL, { slot: builder.createdSlot + 1 });
    builder.buy("twoSlots", SOL, { slot: builder.createdSlot + 2 });
    const nowMs = builder.createdAtMs + 5_000;
    expect(computeFeatures(builder.launch, { nowMs, config }).features.creation_slot_buyers).toBe(2);
    const strict = scorerConfig({ bundleSlotWindow: 0 });
    expect(computeFeatures(builder.launch, { nowMs, config: strict }).features.creation_slot_buyers).toBe(1);
  });

  it("tracks dev dumps and ignores trades after nowMs", () => {
    const builder = new LaunchBuilder({ mint: "DumpMint" });
    builder.buy("DevWallet", SOL * 2n, { slot: builder.createdSlot });
    builder.buy("buyer0", SOL / 2n, { atMs: builder.createdAtMs + 4_000 });
    builder.sellFraction("DevWallet", 1, { atMs: builder.createdAtMs + 20_000 });
    const before = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 10_000, config });
    expect(before.features.dev_sold_fraction).toBe(0);
    expect(before.features.dev_share).toBeCloseTo(before.features.dev_initial_share ?? -1, 6);
    expect(before.flags).not.toContain("dev_dumped");
    const after = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 30_000, config });
    expect(after.features.dev_sold_fraction).toBe(1);
    expect(after.features.dev_share).toBe(0);
    expect(after.flags).toContain("dev_dumped");
    expect(after.features.mcap_multiple).toBeLessThan(before.features.mcap_multiple ?? 0);
  });

  it("produces identical features whether or not later trades exist", () => {
    const short = organicLaunch({ mint: "Same" }, 4);
    const long = organicLaunch({ mint: "Same" }, 30);
    const nowMs = short.createdAtMs + 10_000;
    const a = computeFeatures(short.launch, { nowMs, config }).features;
    const b = computeFeatures(long.launch, { nowMs, config }).features;
    expect(b).toEqual(a);
  });

  it("treats creator and dev wallet as dev wallets", () => {
    const builder = new LaunchBuilder({ dev: "Signer", creator: "FeeRecipient" });
    builder.buy("Signer", SOL, { slot: builder.createdSlot });
    builder.buy("FeeRecipient", SOL, { slot: builder.createdSlot });
    builder.buy("other", SOL, { atMs: builder.createdAtMs + 5_000 });
    expect(devWalletsOf(builder.launch)).toEqual(["Signer", "FeeRecipient"]);
    const result = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 10_000, config });
    expect(result.features.creation_slot_buyers).toBe(0);
    expect(result.features.dev_initial_share).toBeGreaterThan(0.05);
    expect(result.insiders.has("FeeRecipient")).toBe(true);
  });

  it("scores organic flow with low concentration and no bundle", () => {
    const builder = organicLaunch({ mint: "OrganicMint" });
    builder.launch.metadata = { twitter: "https://x.com/coin", telegram: "https://t.me/coin", website: null, description: null };
    const result = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 60_000, config });
    const f = result.features;
    expect(f.creation_slot_buyers).toBe(0);
    expect(f.early_buyers).toBe(20);
    expect(f.unique_buyers_per_min).toBeGreaterThan(25);
    expect(f.buy_sell_count_ratio).toBeGreaterThan(1);
    expect(f.wash_ratio).toBe(0);
    expect(f.volume_hhi).toBeLessThan(0.1);
    expect(f.top10_share).toBeLessThan(0.4);
    expect(f.socials_count).toBe(2);
    expect(f.has_website).toBe(0);
    expect(f.is_sol_quoted).toBe(1);
    const organicScore = model.score(f, config.hardBlocks);
    const bundled = bundledLaunch();
    const bundledScore = model.score(
      computeFeatures(bundled.launch, { nowMs: bundled.createdAtMs + 10_000, config }).features,
      config.hardBlocks
    );
    expect(organicScore.score).toBeLessThan(bundledScore.score - 15);
  });

  it("keeps features unit-free for PUMP-quoted launches", () => {
    const sol = organicLaunch({ mint: "Twin" }, 12);
    const pump = organicLaunch({ mint: "Twin", quoteMint: PUMP_QUOTE_MINT }, 12);
    const nowMs = sol.createdAtMs + 30_000;
    const solFeatures = computeFeatures(sol.launch, { nowMs, config }).features;
    const pumpFeatures = computeFeatures(pump.launch, { nowMs, config }).features;
    expect(pump.launch.isSolQuoted).toBe(false);
    expect(pumpFeatures.is_sol_quoted).toBe(0);
    expect({ ...pumpFeatures, is_sol_quoted: 1 }).toEqual(solFeatures);
    expect(pumpFeatures.mcap_multiple).toBeGreaterThan(1);
  });

  it("measures wash trading from repeated round trips", () => {
    const builder = new LaunchBuilder();
    for (let round = 0; round < 4; round += 1) {
      builder.buy("washer", SOL, { atMs: builder.createdAtMs + 2_000 + round * 2_000 });
      builder.sellFraction("washer", 1, { atMs: builder.createdAtMs + 3_000 + round * 2_000 });
    }
    builder.buy("honest", SOL / 10n, { atMs: builder.createdAtMs + 4_000 });
    const result = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 20_000, config });
    expect(result.features.wash_ratio).toBeGreaterThan(0.9);
    expect(result.features.volume_hhi).toBeGreaterThan(0.9);
    expect(result.flags).toContain("wash_trading");
  });

  it("returns null deep features without intel and fills them from funding clusters", () => {
    const builder = new LaunchBuilder({ mint: "ClusterMint" });
    builder.buy("DevWallet", SOL / 2n, { slot: builder.createdSlot });
    const wallets = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"];
    wallets.forEach((wallet, index) => {
      builder.buy(wallet, SOL / 2n, { atMs: builder.createdAtMs + 2_000 + index * 500 });
    });
    const nowMs = builder.createdAtMs + 30_000;
    const plain = computeFeatures(builder.launch, { nowMs, config });
    expect(plain.features.largest_cluster_size).toBeNull();
    expect(plain.features.fresh_wallet_ratio).toBeNull();
    expect(plain.features.intel_coverage).toBeNull();
    const intel = new Map<string, WalletIntel>([
      ["w1", intelEntry("w1", { funder: "F1", priorTxCount: 1, priorTxCapped: false })],
      ["w2", intelEntry("w2", { funder: "F1", priorTxCount: 1, priorTxCapped: false })],
      ["w3", intelEntry("w3", { funder: "F1", priorTxCount: 2, priorTxCapped: false })],
      ["w4", intelEntry("w4", { funder: "F1", priorTxCount: 0, priorTxCapped: false })],
      ["w5", intelEntry("w5", { funder: "Exchange", funderIsHub: true })],
      ["w6", intelEntry("w6", { funder: "Exchange", funderIsHub: true })],
      ["w7", intelEntry("w7", { funder: "DevWallet" })],
      ["w8", intelEntry("w8", { funder: "Other" })],
      ["DevWallet", intelEntry("DevWallet", { funder: "w8" })]
    ]);
    const result = computeFeatures(builder.launch, { nowMs, config, intel });
    const f = result.features;
    expect(f.intel_coverage).toBe(1);
    expect(f.fresh_wallet_ratio).toBe(0.5);
    expect(f.largest_cluster_size).toBe(4);
    expect(f.cluster_count).toBe(2);
    expect(f.dev_funded_buyers).toBe(2);
    expect(f.largest_cluster_share).toBeGreaterThan(0.04);
    for (const wallet of ["w1", "w2", "w3", "w4", "w7", "w8", "DevWallet"]) {
      expect(result.insiders.has(wallet)).toBe(true);
    }
    expect(result.insiders.has("w5")).toBe(false);
    expect(result.insiders.has("w6")).toBe(false);
    expect(result.flags).toEqual(expect.arrayContaining(["funding_cluster", "dev_funded_buyers"]));
    const devCluster = result.clusters.find((cluster) => cluster.containsDev);
    expect(devCluster?.buyers.sort()).toEqual(["w7", "w8"]);
    expect(devCluster?.heldShare).toBeGreaterThan(0);
  });

  it("reports zero coverage when intel is requested but nothing came back", () => {
    const builder = organicLaunch({}, 6);
    const result = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 30_000, config, intel: new Map() });
    expect(result.features.intel_coverage).toBe(0);
    expect(result.features.fresh_wallet_ratio).toBeNull();
    expect(result.features.largest_cluster_size).toBeNull();
  });

  it("treats cluster absence as unknown when only part of the early buyers have intel", () => {
    const builder = new LaunchBuilder({ mint: "PartialCoverageMint" });
    builder.buy("DevWallet", SOL / 2n, { slot: builder.createdSlot });
    for (let index = 0; index < 5; index += 1) {
      builder.buy(`linked${index}`, SOL / 2n, { atMs: builder.createdAtMs + 3_000 + index * 500 });
    }
    for (let index = 0; index < 10; index += 1) {
      builder.buy(`organic${index}`, SOL / 5n, { atMs: builder.createdAtMs + 6_000 + index * 900 });
    }
    const nowMs = builder.createdAtMs + 30_000;
    const devOnly = computeFeatures(builder.launch, { nowMs, config, intel: new Map([["DevWallet", intelEntry("DevWallet")]]) });
    expect(devOnly.features.intel_coverage).toBe(0);
    for (const name of ["largest_cluster_size", "largest_cluster_share", "cluster_count", "dev_funded_buyers"]) {
      expect(devOnly.features[name]).toBeNull();
    }
    const none = computeFeatures(builder.launch, { nowMs, config, intel: null });
    const model = ScoringModel.default();
    expect(model.score(devOnly.features, config.hardBlocks).score).toBeGreaterThanOrEqual(model.score(none.features, config.hardBlocks).score);
    const organicOnly = new Map<string, WalletIntel>(
      Array.from({ length: 5 }, (_, index) => [`organic${index}`, intelEntry(`organic${index}`)] as const)
    );
    const partial = computeFeatures(builder.launch, { nowMs, config, intel: organicOnly });
    expect(partial.features.intel_coverage).toBeCloseTo(1 / 3, 6);
    expect(partial.features.largest_cluster_size).toBeNull();
    const linkedTwo = new Map(organicOnly);
    linkedTwo.set("linked0", intelEntry("linked0", { funder: "Master" }));
    linkedTwo.set("linked1", intelEntry("linked1", { funder: "Master" }));
    const found = computeFeatures(builder.launch, { nowMs, config, intel: linkedTwo });
    expect(found.features.largest_cluster_size).toBe(2);
    expect(found.features.dev_funded_buyers).toBeNull();
    const everyone = new Map<string, WalletIntel>([...builder.launch.wallets.keys()].map((wallet) => [wallet, intelEntry(wallet)]));
    const clean = computeFeatures(builder.launch, { nowMs, config, intel: everyone });
    expect(clean.features.largest_cluster_size).toBe(0);
    expect(clean.features.dev_funded_buyers).toBe(0);
  });

  it("passes dev history and copycat context through", () => {
    const builder = organicLaunch({}, 3);
    const result = computeFeatures(builder.launch, {
      nowMs: builder.createdAtMs + 10_000,
      config,
      devHistory: {
        launchCount: 7,
        outcomeCount: 5,
        ruggedCount: 4,
        migratedCount: 0,
        rugRate: 0.8,
        migrationRate: 0,
        medianPeakMultiple: 1.4
      },
      copycat: { copycat: true, similarity: 0.97, original: "OrigMint", sameTickerRecent: 3 }
    });
    expect(result.features.dev_launch_count).toBe(7);
    expect(result.features.dev_outcome_count).toBe(5);
    expect(result.features.dev_rug_rate).toBe(0.8);
    expect(result.features.copycat).toBe(1);
    expect(result.features.copycat_similarity).toBe(0.97);
    expect(result.features.same_ticker_recent).toBe(3);
    expect(result.flags).toEqual(expect.arrayContaining(["serial_rugger", "copycat"]));
    expect(result.features.has_twitter).toBeNull();
  });

  it("handles a launch with no trades", () => {
    const builder = new LaunchBuilder();
    const result = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 10_000, config });
    expect(result.features.early_buyers).toBe(0);
    expect(result.features.top10_share).toBe(0);
    expect(result.features.buy_sell_count_ratio).toBeNull();
    expect(result.features.buy_sell_volume_ratio).toBeNull();
    expect(result.features.volume_hhi).toBeNull();
    expect(result.features.mcap_multiple).toBe(1);
    expect(result.features.dev_sold_fraction).toBe(0);
    expect(result.insiders).toEqual(new Set(["DevWallet"]));
  });

  it("caps the sell-free volume ratio and clamps negative ages", () => {
    const builder = new LaunchBuilder();
    builder.buy("a", SOL, { atMs: builder.createdAtMs + 1_000 });
    const result = computeFeatures(builder.launch, { nowMs: builder.createdAtMs + 1_000, config });
    expect(result.features.buy_sell_volume_ratio).toBe(50);
    expect(result.features.buy_sell_count_ratio).toBe(2);
    const early = computeFeatures(builder.launch, { nowMs: builder.createdAtMs - 5_000, config });
    expect(early.features.age_sec).toBe(0);
    expect(early.features.early_buyers).toBe(0);
  });

  it("builds intel requests for dev wallets first, then early buyers, capped", () => {
    const builder = organicLaunch({ dev: "Dev", creator: "Creator" }, 30);
    const capped = scorerConfig({ deepIntel: { ...config.deepIntel, maxWalletsPerLaunch: 5 } });
    const requests = intelRequestsFor(builder.launch, builder.createdAtMs + 60_000, capped);
    expect(requests).toHaveLength(5);
    expect(requests[0]).toEqual({ wallet: "Dev", buySignature: builder.createSignature, buySlot: builder.createdSlot });
    expect(requests[1]?.wallet).toBe("Creator");
    expect(requests[2]?.wallet).toBe("organic0");
    expect(requests[2]?.buySignature).toMatch(/^organic0sig/);
    expect(uniqueBuyersAsOf(builder.launch, builder.createdAtMs + 4_000)).toBe(1);
  });

  it("puts a same-funder bundle above maxRisk and a clean launch far below with default weights", () => {
    const bundle = new LaunchBuilder({ mint: "SybilBundle" });
    bundle.buy("DevWallet", SOL, { slot: bundle.createdSlot });
    for (let index = 0; index < 5; index += 1) {
      bundle.buy(`b${index}`, SOL, { slot: bundle.createdSlot });
    }
    for (let index = 0; index < 10; index += 1) {
      bundle.buy(`o${index}`, SOL / 5n, { atMs: bundle.createdAtMs + 2_000 + index * 900 });
    }
    const sybil = new Map<string, WalletIntel>(
      [0, 1, 2, 3, 4].map((index) => [`b${index}`, intelEntry(`b${index}`, { funder: "Sybil", priorTxCount: 1, priorTxCapped: false })])
    );
    const bundleScore = model.score(
      computeFeatures(bundle.launch, { nowMs: bundle.createdAtMs + 10_000, config, intel: sybil }).features,
      config.hardBlocks
    );
    expect(bundleScore.score).toBeGreaterThan(config.maxRisk);
    const clean = organicLaunch({}, 30);
    clean.launch.metadata = { twitter: "x", telegram: "t", website: null, description: null };
    const cleanIntel = new Map<string, WalletIntel>(
      Array.from({ length: 30 }, (_, index) => [`organic${index}`, intelEntry(`organic${index}`, { funder: `F${index}` })])
    );
    const cleanScore = model.score(
      computeFeatures(clean.launch, { nowMs: clean.createdAtMs + 60_000, config, intel: cleanIntel }).features,
      config.hardBlocks
    );
    expect(cleanScore.score).toBeLessThan(15);
  });

  it("computes exact ratios with bigint inputs", () => {
    expect(ratio(1n, 4n)).toBe(0.25);
    expect(ratio(5n, 0n)).toBe(0);
  });
});
