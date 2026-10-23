import { describe, expect, it } from "vitest";
import { computeFeatures } from "../../src/scorer/features.js";
import { exceedsRisk, ScoringModel } from "../../src/scorer/model.js";
import { DEFAULT_WEIGHTS } from "../../src/scorer/weights.js";
import type { WalletIntel } from "../../src/scorer/types.js";
import { intelEntry, LaunchBuilder, scorerConfig, SOL } from "../scorer.fixtures.js";

const config = scorerConfig();
const model = ScoringModel.default();

function bundled(bundleWallets: number, perWallet: bigint, organic: number): LaunchBuilder {
  const builder = new LaunchBuilder({ mint: `Bundle${bundleWallets}x${perWallet}` });
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
  const intel = new Map<string, WalletIntel>();
  for (const wallet of builder.launch.wallets.keys()) {
    intel.set(wallet, intelEntry(wallet));
  }
  return intel;
}

describe("review: weighted-mean model dilutes a strong bundle red flag", () => {
  it("saturated bundle features alone should exceed maxRisk 55 (scores 29.79 today)", () => {
    const vector: Record<string, number> = {};
    for (const [name, spec] of Object.entries(DEFAULT_WEIGHTS.features)) {
      const cleanest = [...spec.points].sort((a, b) => a[1] - b[1])[0];
      vector[name] = cleanest ? cleanest[0] : 0;
    }
    vector.bundle_bought_share = 0.24;
    vector.bundle_share = 0.24;
    vector.creation_slot_buyers = 10;
    const score = model.score(vector, config.hardBlocks);
    expect(score.hardBlocked).toBe(false);
    expect(score.score).toBeGreaterThan(config.maxRisk);
  });

  it("a 5-wallet creation-slot bundle holding ~8% of supply should exceed maxRisk 55 (scores ~28 today)", () => {
    const builder = bundled(5, SOL / 2n, 25);
    const nowMs = builder.createdAtMs + 30_000;
    const result = computeFeatures(builder.launch, { nowMs, config, intel: cleanIntel(builder) });
    const score = model.score(result.features, config.hardBlocks);
    expect(result.features.creation_slot_buyers).toBe(5);
    expect(result.features.bundle_share).toBeGreaterThan(0.07);
    expect(result.flags).toContain("bundled");
    expect(score.hardBlocked).toBe(false);
    expect(exceedsRisk(score, config.maxRisk)).toBe(true);
  });

  it("an 8-wallet creation-slot bundle holding ~21.7% of supply should exceed maxRisk 55 (scores ~36 today)", () => {
    const builder = bundled(8, SOL, 25);
    const nowMs = builder.createdAtMs + 30_000;
    const result = computeFeatures(builder.launch, { nowMs, config, intel: cleanIntel(builder) });
    const score = model.score(result.features, config.hardBlocks);
    expect(result.features.creation_slot_buyers).toBe(8);
    expect(result.features.bundle_share).toBeGreaterThan(0.2);
    expect(score.hardBlocked).toBe(false);
    expect(exceedsRisk(score, config.maxRisk)).toBe(true);
  });
});
