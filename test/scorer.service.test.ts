import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/chain/rpc.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { LaunchScore } from "../src/core/types.js";
import { TrendingTracker } from "../src/scorer/copycat.js";
import { createScorerModule } from "../src/scorer/index.js";
import type { IntelRpc } from "../src/scorer/intel.js";
import { ScoringModel } from "../src/scorer/model.js";
import { overlayStored, ScorerService, type ScorerMode } from "../src/scorer/service.js";
import { DEFAULT_WEIGHTS } from "../src/scorer/weights.js";
import type {
  DevHistoryProvider,
  DevHistorySummary,
  IntelEnsureOptions,
  IntelRequest,
  ScoreExtras,
  StoredFeatures,
  WalletIntel,
  WalletIntelProvider
} from "../src/scorer/types.js";
import { intelEntry, LaunchBuilder, scorerConfig, SOL, T0 } from "./scorer.fixtures.js";

const config = scorerConfig();

class MockIntel implements WalletIntelProvider {
  readonly ensureCalls: Array<{ entries: IntelRequest[]; deadlineMs: number }> = [];
  readonly storedOnlyCalls: Array<{ entries: IntelRequest[]; deadlineMs: number }> = [];
  cachedCalls = 0;
  constructor(private readonly data: Map<string, WalletIntel>) {}

  async ensure(entries: readonly IntelRequest[], deadlineMs: number, options: IntelEnsureOptions = {}): Promise<Map<string, WalletIntel>> {
    (options.fetch === false ? this.storedOnlyCalls : this.ensureCalls).push({ entries: [...entries], deadlineMs });
    return this.pick(entries.map((entry) => entry.wallet));
  }

  cached(wallets: Iterable<string>): Map<string, WalletIntel> {
    this.cachedCalls += 1;
    return this.pick([...wallets]);
  }

  private pick(wallets: string[]): Map<string, WalletIntel> {
    const result = new Map<string, WalletIntel>();
    for (const wallet of wallets) {
      const entry = this.data.get(wallet);
      if (entry) {
        result.set(wallet, entry);
      }
    }
    return result;
  }
}

class ForbiddenIntel implements WalletIntelProvider {
  calls = 0;
  async ensure(): Promise<Map<string, WalletIntel>> {
    this.calls += 1;
    throw new Error("intel must not be used in replay");
  }
  cached(): Map<string, WalletIntel> {
    this.calls += 1;
    throw new Error("intel must not be used in replay");
  }
}

class MockDevHistory implements DevHistoryProvider {
  readonly asOf: number[] = [];
  fail = false;
  async lookup(_devs: readonly string[], asOfMs: number): Promise<DevHistorySummary> {
    this.asOf.push(asOfMs);
    if (this.fail) {
      throw new Error("db down");
    }
    return { launchCount: 4, outcomeCount: 4, ruggedCount: 3, migratedCount: 0, rugRate: 0.75, migrationRate: 0, medianPeakMultiple: 1.2 };
  }
}

class CountingRpc implements IntelRpc {
  calls = 0;
  async getSignaturesForAddress(): Promise<never> {
    this.calls += 1;
    throw new Error("no rpc in replay");
  }
  async getParsedTransaction(): Promise<never> {
    this.calls += 1;
    throw new Error("no rpc in replay");
  }
}

function clusteredLaunch(): LaunchBuilder {
  const builder = new LaunchBuilder({ mint: "SvcMint", createdAtMs: T0 });
  builder.buy("DevWallet", SOL, { slot: builder.createdSlot });
  for (let index = 0; index < 6; index += 1) {
    builder.buy(`c${index}`, SOL / 2n, { atMs: T0 + 2_000 + index * 1_000 });
  }
  builder.buy("lateBuyer", SOL, { atMs: T0 + 12_000 });
  builder.buy("laterBuyer", SOL, { atMs: T0 + 40_000 });
  return builder;
}

interface Harness {
  clock: VirtualClock;
  bus: Bus;
  builder: LaunchBuilder;
  service: ScorerService;
  scores: LaunchScore[];
  stored: Array<{ score: LaunchScore; extras: ScoreExtras }>;
}

function harness(
  mode: ScorerMode,
  options: {
    intel?: WalletIntelProvider | null;
    devHistory?: DevHistoryProvider | null;
    storedFeatures?: (mint: string, checkpointSec: number) => StoredFeatures | null;
    builder?: LaunchBuilder;
  } = {}
): Harness {
  const clock = new VirtualClock(T0 - 1_000);
  const bus = new Bus();
  const builder = options.builder ?? clusteredLaunch();
  const scores: LaunchScore[] = [];
  const stored: Array<{ score: LaunchScore; extras: ScoreExtras }> = [];
  bus.on("score", (score) => scores.push(score));
  const service = new ScorerService({
    clock,
    bus,
    market: builder.market,
    config,
    model: ScoringModel.default(),
    intel: options.intel ?? null,
    devHistory: options.devHistory ?? null,
    trending: new TrendingTracker({ config }),
    store: (score, extras) => stored.push({ score, extras }),
    mode,
    storedFeatures: options.storedFeatures ?? null
  });
  service.start();
  return { clock, bus, builder, service, scores, stored };
}

const clusterIntel = new Map<string, WalletIntel>(
  ["c0", "c1", "c2", "c3"].map((wallet) => [wallet, intelEntry(wallet, { funder: "Sybil", priorTxCount: 1, priorTxCapped: false })])
);

describe("ScorerService live mode", () => {
  it("scores each checkpoint with deep intel, persists, emits and marks insiders", async () => {
    const intel = new MockIntel(clusterIntel);
    const devHistory = new MockDevHistory();
    const h = harness("live", { intel, devHistory });
    h.bus.emit("chain", h.builder.createEvent);
    h.bus.emit("chain", h.builder.createEvent);
    expect(h.service.pendingCheckpoints()).toBe(config.checkpointsSec.length);
    await h.clock.advanceTo(T0 + 10_000);
    expect(h.scores).toHaveLength(1);
    const score = h.scores[0] as LaunchScore;
    expect(score.checkpointSec).toBe(10);
    expect(score.computedAtMs).toBe(T0 + 10_000);
    expect(score.features.early_buyers).toBe(6);
    expect(score.features.largest_cluster_size).toBe(4);
    expect(score.features.fresh_wallet_ratio).toBe(1);
    expect(score.features.dev_rug_rate).toBe(0.75);
    expect(score.flags).toEqual(expect.arrayContaining(["funding_cluster", "hard_dev_rug_rate"]));
    expect(score.hardBlocked).toBe(true);
    expect(intel.ensureCalls[0]?.deadlineMs).toBe(T0 + 10_000 + config.deepIntel.timeoutMs);
    expect(intel.ensureCalls[0]?.entries[0]?.wallet).toBe("DevWallet");
    expect(devHistory.asOf).toEqual([T0 + 10_000]);
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]?.extras.insiders).toEqual(expect.arrayContaining(["DevWallet", "c0", "c1", "c2", "c3"]));
    expect(h.builder.launch.insiders.has("c3")).toBe(true);
    expect(h.builder.launch.insiders.has("c5")).toBe(false);
    expect(h.service.latest("SvcMint")).toBe(score);
    await h.clock.advanceTo(T0 + 200_000);
    expect(h.scores.map((entry) => entry.checkpointSec)).toEqual(config.checkpointsSec);
    expect(h.service.pendingCheckpoints()).toBe(0);
    expect(h.service.latest("SvcMint")?.checkpointSec).toBe(120);
  });

  it("uses only already stored intel, never new RPC lookups, when there are too few buyers for deep lookups", async () => {
    const intel = new MockIntel(clusterIntel);
    const builder = new LaunchBuilder({ mint: "Thin", createdAtMs: T0 });
    builder.buy("only", SOL, { atMs: T0 + 3_000 });
    const h = harness("live", { intel, builder });
    h.service.scheduleLaunch("Thin", T0);
    await h.clock.advanceTo(T0 + 10_000);
    expect(intel.ensureCalls).toHaveLength(0);
    expect(intel.storedOnlyCalls).toHaveLength(1);
    expect(intel.storedOnlyCalls[0]?.deadlineMs).toBe(T0 + 10_000 + config.deepIntel.timeoutMs);
    expect(intel.cachedCalls).toBe(0);
    expect(h.scores[0]?.features.intel_coverage).toBe(0);
  });

  it("still scores when dev history fails and skips launches that left the market", async () => {
    const devHistory = new MockDevHistory();
    devHistory.fail = true;
    const h = harness("live", { devHistory });
    h.service.scheduleLaunch("SvcMint", T0);
    h.service.scheduleLaunch("GoneMint", T0);
    await h.clock.advanceTo(T0 + 10_000);
    expect(h.scores).toHaveLength(1);
    expect(h.scores[0]?.features.dev_rug_rate).toBeNull();
    expect(h.scores[0]?.features.largest_cluster_size).toBeNull();
  });

  it("scores ad hoc from cached intel without emitting or persisting", async () => {
    const intel = new MockIntel(clusterIntel);
    const h = harness("live", { intel });
    await h.clock.advanceTo(T0 + 25_000);
    const score = await h.service.scoreNow("SvcMint", "signal");
    expect(score?.checkpointSec).toBe(25);
    expect(score?.features.largest_cluster_size).toBe(4);
    expect(intel.ensureCalls).toHaveLength(0);
    expect(intel.storedOnlyCalls).toHaveLength(1);
    expect(h.scores).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
    expect(h.service.latest("SvcMint")).toBe(score);
    expect(await h.service.scoreNow("Missing", "signal")).toBeNull();
  });

  it("cancels timers on stop, skips stale checkpoints and swaps models", async () => {
    const h = harness("live");
    h.bus.emit("chain", h.builder.createEvent);
    expect(h.service.pendingCheckpoints()).toBe(4);
    await h.service.stop();
    expect(h.service.pendingCheckpoints()).toBe(0);
    await h.clock.advanceTo(T0 + 300_000);
    expect(h.scores).toHaveLength(0);
    h.service.start();
    h.service.scheduleLaunch("SvcMint", T0 + 300_000 - 100_000);
    expect(h.service.pendingCheckpoints()).toBe(2);
    h.service.setModel(new ScoringModel({ version: "swapped", features: {} }));
    await h.clock.advanceTo(T0 + 400_000);
    expect(h.scores.map((score) => score.weightsVersion)).toEqual(["swapped", "swapped"]);
    expect(h.service.currentModel().version).toBe("swapped");
  });
});

describe("ScorerService replay mode", () => {
  const storedRows = new Map<number, StoredFeatures>([
    [
      10,
      {
        features: {
          intel_coverage: 1,
          fresh_wallet_ratio: 0.9,
          largest_cluster_size: 5,
          largest_cluster_share: 0.35,
          cluster_count: 1,
          dev_funded_buyers: 2,
          copycat: 0,
          has_twitter: null
        },
        computedAtMs: T0 + 13_500,
        insiders: ["c5"]
      }
    ],
    [30, { features: { fresh_wallet_ratio: 0.8 }, computedAtMs: T0 + 30_200 }]
  ]);
  const lookup = (mint: string, checkpointSec: number): StoredFeatures | null =>
    mint === "SvcMint" ? (storedRows.get(checkpointSec) ?? null) : null;

  it("never touches intel and publishes at the stored computed_at with overlaid deep features", async () => {
    const intel = new ForbiddenIntel();
    const devHistory = new MockDevHistory();
    const h = harness("replay", { intel, devHistory, storedFeatures: lookup });
    h.bus.emit("chain", h.builder.createEvent);
    await h.clock.advanceTo(T0 + 10_000);
    expect(h.scores).toHaveLength(0);
    await h.clock.advanceTo(T0 + 13_499);
    expect(h.scores).toHaveLength(0);
    await h.clock.advanceTo(T0 + 13_500);
    expect(h.scores).toHaveLength(1);
    const score = h.scores[0] as LaunchScore;
    expect(score.computedAtMs).toBe(T0 + 13_500);
    expect(score.checkpointSec).toBe(10);
    expect(score.features.fresh_wallet_ratio).toBe(0.9);
    expect(score.features.largest_cluster_share).toBe(0.35);
    expect(score.features.has_twitter).toBeNull();
    expect(score.features.early_buyers).toBe(7);
    expect(score.hardBlocked).toBe(true);
    expect(score.flags).toContain("hard_cluster_share");
    expect(h.builder.launch.insiders.has("c5")).toBe(true);
    expect(devHistory.asOf).toEqual([T0 + 13_500]);
    await h.clock.advanceTo(T0 + 200_000);
    expect(h.scores.map((entry) => [entry.checkpointSec, entry.computedAtMs])).toEqual([
      [10, T0 + 13_500],
      [30, T0 + 30_200],
      [60, T0 + 60_000],
      [120, T0 + 120_000]
    ]);
    expect(h.scores[2]?.features.fresh_wallet_ratio).toBeNull();
    expect(intel.calls).toBe(0);
  });

  it("uses the latest stored checkpoint already computed for ad hoc scores", async () => {
    const h = harness("replay", { storedFeatures: lookup });
    await h.clock.advanceTo(T0 + 20_000);
    const early = await h.service.scoreNow("SvcMint", "signal");
    expect(early?.features.fresh_wallet_ratio).toBe(0.9);
    await h.clock.advanceTo(T0 + 31_000);
    const later = await h.service.scoreNow("SvcMint", "signal");
    expect(later?.features.fresh_wallet_ratio).toBe(0.8);
    expect(h.scores).toHaveLength(0);
  });

  it("wires a replay module without intel or score persistence and never calls rpc", async () => {
    const rpc = new CountingRpc();
    const clock = new VirtualClock(T0 - 1_000);
    const bus = new Bus();
    const builder = clusteredLaunch();
    const scorer = createScorerModule({
      db: null,
      rpc,
      bus,
      market: builder.market,
      clock,
      config,
      mode: "replay",
      storedFeatures: lookup
    });
    expect(scorer.intel).toBeNull();
    expect(scorer.store).toBeNull();
    await scorer.start();
    expect(scorer.service.currentModel().version).toBe(DEFAULT_WEIGHTS.version);
    const scores: LaunchScore[] = [];
    bus.on("score", (score) => scores.push(score));
    bus.emit("chain", builder.createEvent);
    await clock.advanceTo(T0 + 200_000);
    expect(scores).toHaveLength(4);
    expect(rpc.calls).toBe(0);
    await scorer.stop();
  });

  it("wires a live module with intel when rpc is available", async () => {
    const realRpc: IntelRpc = new RpcClient({ url: "http://127.0.0.1:1", maxRps: 1, maxConcurrency: 1, timeoutMs: 10, maxRetries: 0 });
    expect(realRpc).toBeDefined();
    const scorer = createScorerModule({
      db: null,
      rpc: new CountingRpc(),
      bus: new Bus(),
      market: clusteredLaunch().market,
      clock: new VirtualClock(T0),
      config,
      mode: "live",
      model: ScoringModel.default()
    });
    expect(scorer.intel).not.toBeNull();
    expect(scorer.devHistory).toBeNull();
    await scorer.start();
    await scorer.stop();
  });
});

describe("overlayStored", () => {
  it("overlays only keys present in the stored row", () => {
    const merged = overlayStored(
      { a: 1, b: 2, c: 3 },
      { features: { a: null, b: 5, d: 9 }, computedAtMs: 0 },
      ["a", "b", "c"]
    );
    expect(merged).toEqual({ a: null, b: 5, c: 3 });
    expect(overlayStored({ a: 1 }, null, ["a"])).toEqual({ a: 1 });
  });
});
