import { describe, expect, it } from "vitest";
import { computeFeatures } from "../../src/scorer/features.js";
import { ScoringModel } from "../../src/scorer/model.js";
import type { WalletIntel } from "../../src/scorer/types.js";
import { intelEntry, LaunchBuilder, scorerConfig, SOL } from "../scorer.fixtures.js";

const config = scorerConfig();
const model = ScoringModel.default();

function clusteredLaunch(): LaunchBuilder {
  const builder = new LaunchBuilder({ mint: "PartialIntelMint" });
  builder.buy("DevWallet", SOL / 2n, { slot: builder.createdSlot });
  for (let index = 0; index < 5; index += 1) {
    builder.buy(`linked${index}`, SOL / 2n, { atMs: builder.createdAtMs + 3_000 + index * 500 });
  }
  for (let index = 0; index < 10; index += 1) {
    builder.buy(`organic${index}`, SOL / 5n, { atMs: builder.createdAtMs + 6_000 + index * 900 });
  }
  return builder;
}

function fullIntel(builder: LaunchBuilder): Map<string, WalletIntel> {
  const intel = new Map<string, WalletIntel>();
  for (const wallet of builder.launch.wallets.keys()) {
    const funder = wallet.startsWith("linked") ? "MasterFunder" : null;
    intel.set(wallet, intelEntry(wallet, { funder }));
  }
  return intel;
}

describe("review: partial wallet intel coverage is scored as a clean, fully known launch", () => {
  it("with only the dev's intel resolved before the deadline, cluster features should be unknown, not zero", () => {
    const builder = clusteredLaunch();
    const nowMs = builder.createdAtMs + 30_000;
    const full = computeFeatures(builder.launch, { nowMs, config, intel: fullIntel(builder) });
    expect(full.features.largest_cluster_size).toBe(5);
    const devOnly = new Map<string, WalletIntel>([["DevWallet", intelEntry("DevWallet")]]);
    const partial = computeFeatures(builder.launch, { nowMs, config, intel: devOnly });
    expect(partial.features.intel_coverage).toBe(0);
    expect(partial.features.largest_cluster_size).toBeNull();
    expect(partial.features.largest_cluster_share).toBeNull();
  });

  it("a launch whose buyer intel timed out should not score lower than one with no intel at all", () => {
    const builder = clusteredLaunch();
    const nowMs = builder.createdAtMs + 30_000;
    const none = model.score(computeFeatures(builder.launch, { nowMs, config, intel: null }).features, config.hardBlocks);
    const devOnly = new Map<string, WalletIntel>([["DevWallet", intelEntry("DevWallet")]]);
    const partial = model.score(computeFeatures(builder.launch, { nowMs, config, intel: devOnly }).features, config.hardBlocks);
    expect(partial.score).toBeGreaterThanOrEqual(none.score);
  });
});
