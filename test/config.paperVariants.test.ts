import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  laneCannotApply,
  laneScoreView,
  paperLaneSpecsFor,
  requestedPaperVariants,
  resolvePaperLanes,
  SharedScoreRequests,
  viewedScores
} from "../src/app/paperLaneSpecs.js";
import { loadEnv } from "../src/config/env.js";
import { defaultStrategyConfig, parseStrategyConfig, tradingRunConfig, type StrategyConfig } from "../src/config/strategy.js";
import type { LaunchScore } from "../src/core/types.js";
import { parseLabVariants, type LabVariant } from "../src/lab/variants.js";

const VARIANTS: LabVariant[] = parseLabVariants(JSON.parse(readFileSync(new URL("../config/lab-variants.json", import.meta.url), "utf8")));

function vpsConfig(): StrategyConfig {
  const config = parseStrategyConfig(JSON.parse(readFileSync(new URL("../config/strategy.json", import.meta.url), "utf8")));
  config.signals.enabled = ["smart_convergence", "score_momentum"];
  return config;
}

function score(overrides: Partial<LaunchScore> = {}): LaunchScore {
  return {
    mint: "Mint1",
    launchId: 1,
    checkpointSec: 60,
    computedAtMs: 1_000,
    slot: 1,
    score: 30,
    hardBlocked: true,
    flags: ["hard_bundle_share", "solo_bundle_share", "fresh_heavy"],
    features: { bundle_share: 0.4, dev_share: 0.05, unique_buyers_per_min: 20 },
    contributions: {},
    weightsVersion: "w",
    ...overrides
  };
}

describe("lab.livePaperVariants", () => {
  it("defaults to no lanes and is spelled out in config/strategy.json", () => {
    expect(defaultStrategyConfig().lab).toEqual({ livePaperVariants: [] });
    const raw = JSON.parse(readFileSync(new URL("../config/strategy.json", import.meta.url), "utf8")) as { lab: unknown };
    expect(raw.lab).toEqual({ livePaperVariants: [] });
  });

  it("accepts variant names and refuses malformed or repeated ones", () => {
    expect(parseStrategyConfig({ lab: { livePaperVariants: ["momentum-loose", " fast-exits "] } }).lab.livePaperVariants).toEqual(["momentum-loose", "fast-exits"]);
    expect(() => parseStrategyConfig({ lab: { livePaperVariants: ["Bad Name"] } })).toThrow(/lab\.livePaperVariants\.0/);
    expect(() => parseStrategyConfig({ lab: { livePaperVariants: ["fast-exits", "fast-exits"] } })).toThrow(/list each variant once/);
  });

  it("is never part of a trading run's stored config, so changing the lanes never looks like a strategy change", () => {
    const config = defaultStrategyConfig();
    config.lab.livePaperVariants = ["fast-exits"];
    const stored = tradingRunConfig(config);
    expect("lab" in stored).toBe(false);
    expect(stored).toEqual(tradingRunConfig(defaultStrategyConfig()));
    expect(config.lab.livePaperVariants).toEqual(["fast-exits"]);
  });
});

describe("PAPER_VARIANTS", () => {
  it("parses a comma separated list and treats a blank value as unset", () => {
    expect(loadEnv({ PAPER_VARIANTS: " momentum-loose , fast-exits,, " }).PAPER_VARIANTS).toEqual(["momentum-loose", "fast-exits"]);
    expect(loadEnv({ PAPER_VARIANTS: "  " }).PAPER_VARIANTS).toBeUndefined();
    expect(loadEnv({}).PAPER_VARIANTS).toBeUndefined();
  });

  it("overrides lab.livePaperVariants when set and falls back to it otherwise", () => {
    const config = defaultStrategyConfig();
    config.lab.livePaperVariants = ["fast-exits"];
    expect(requestedPaperVariants(loadEnv({ PAPER_VARIANTS: "momentum-loose" }), config)).toEqual({ names: ["momentum-loose"], source: "PAPER_VARIANTS" });
    expect(requestedPaperVariants(loadEnv({}), config)).toEqual({ names: ["fast-exits"], source: "lab.livePaperVariants" });
    expect(requestedPaperVariants(loadEnv({ PAPER_VARIANTS: "none" }), config).names).toEqual(["none"]);
  });
});

describe("resolving paper lanes", () => {
  const base = vpsConfig();
  const request = (names: string[]) => ({ names, source: "PAPER_VARIANTS" });

  it("merges each named variant onto the base strategy and labels its run paper:<name>", () => {
    const lanes = resolvePaperLanes(request(["momentum-loose", "fast-exits", "momentum-loose"]), VARIANTS, base);
    expect(lanes.map((lane) => [lane.name, lane.label])).toEqual([
      ["momentum-loose", "paper:momentum-loose"],
      ["fast-exits", "paper:fast-exits"]
    ]);
    expect(lanes[0]?.config.signals.scoreMomentum.maxRiskScore).toBe(50);
    expect(lanes[0]?.config.signals.enabled).toEqual(["smart_convergence", "score_momentum"]);
    expect(lanes[0]?.changed).toEqual(["signals.scoreMomentum.maxRiskScore"]);
    expect(lanes[1]?.config.exits.timeStop.afterSec).toBe(120);
    expect(lanes[1]?.config.risk).toEqual(base.risk);
  });

  it("fails fast on unknown names with the list of known variants", () => {
    expect(() => resolvePaperLanes(request(["momentum-loose", "nope", "baseline"]), VARIANTS, base)).toThrow(
      'PAPER_VARIANTS: unknown paper variants "nope", "baseline"; config/lab-variants.json defines momentum-strict, momentum-loose, momentum-low-buyers, fast-exits, no-time-stop, trade-blocked-event-exits (the main paper trader runs the base strategy, list only variants)'
    );
  });

  it("understands all and none, alone", () => {
    expect(resolvePaperLanes(request(["all"]), VARIANTS, base).map((lane) => lane.name)).toEqual(VARIANTS.map((variant) => variant.name));
    expect(resolvePaperLanes(request(["none"]), VARIANTS, base)).toEqual([]);
    expect(() => resolvePaperLanes(request(["all", "fast-exits"]), VARIANTS, base)).toThrow(/"all" cannot be combined/);
    expect(() => resolvePaperLanes(request(["none", "fast-exits"]), VARIANTS, base)).toThrow(/"none" cannot be combined/);
  });

  it("runs every shipped variant as a lane on the VPS strategy", () => {
    const lanes = resolvePaperLanes(request(["all"]), VARIANTS, base);
    expect(lanes).toHaveLength(6);
    expect(lanes.find((lane) => lane.name === "trade-blocked-event-exits")?.config.scorer.hardBlocks.bundleShareAbove).toBe(1);
  });

  it("refuses variants that change settings lanes share with the service", () => {
    const custom: LabVariant[] = [
      { name: "bigger-memory", description: "x", overrides: { recorder: { memory: { evictMaxAgeHours: 12 } } } },
      { name: "other-checkpoints", description: "x", overrides: { scorer: { checkpointsSec: [5, 60] }, exits: { maxHoldSec: 60 } } },
      { name: "typo", description: "x", overrides: { exits: { maxHoldSecs: 60 } } }
    ];
    expect(() => resolvePaperLanes(request(["bigger-memory"]), custom, base)).toThrow(
      'PAPER_VARIANTS: paper variant "bigger-memory" changes a setting a live paper lane cannot apply (lanes share the recorder, scorer and wallet ranking of the service): recorder.memory.evictMaxAgeHours'
    );
    expect(() => resolvePaperLanes(request(["other-checkpoints"]), custom, base)).toThrow(/scorer\.checkpointsSec$/);
    expect(() => resolvePaperLanes(request(["typo"]), custom, base)).toThrow(/paper variant "typo" is invalid: unknown strategy settings: exits\.maxHoldSecs/);
    expect(["signals.cooldownPerMintSec", "tracker.convergence.minWallets", "risk.maxConcurrent", "exits.maxHoldSec", "execution.failureRate", "scorer.hardBlocks.devShareAbove", "lab.livePaperVariants"].filter(laneCannotApply)).toEqual([]);
    expect(["scorer.maxRisk", "scorer.bundleSlotWindow", "tracker.topN", "sweeper.enabled", "recorder.trackMaxAgeHours"].every(laneCannotApply)).toBe(true);
  });

  it("starts lanes only for a paper trader and never reads the variants file otherwise", async () => {
    let reads = 0;
    const loadVariants = (): Promise<LabVariant[]> => {
      reads += 1;
      return Promise.resolve(VARIANTS);
    };
    const trader = new Set(["trader"] as const);
    expect(await paperLaneSpecsFor(loadEnv({ TRADING_MODE: "live", PAPER_VARIANTS: "fast-exits,nope" }), base, trader, { loadVariants })).toEqual([]);
    expect(await paperLaneSpecsFor(loadEnv({ PAPER_VARIANTS: "fast-exits" }), base, new Set(["recorder"] as const), { loadVariants })).toEqual([]);
    expect(await paperLaneSpecsFor(loadEnv({}), base, trader, { loadVariants })).toEqual([]);
    expect(await paperLaneSpecsFor(loadEnv({ PAPER_VARIANTS: "none" }), base, trader, { loadVariants })).toEqual([]);
    expect(reads).toBe(0);
    expect((await paperLaneSpecsFor(loadEnv({ PAPER_VARIANTS: "fast-exits" }), base, trader, { loadVariants })).map((lane) => lane.name)).toEqual(["fast-exits"]);
    await expect(paperLaneSpecsFor(loadEnv({ PAPER_VARIANTS: "nope" }), base, trader, { loadVariants })).rejects.toThrow(/unknown paper variant "nope"/);
    expect(reads).toBe(2);
  });
});

describe("lane scores", () => {
  it("re-evaluates hard blocks with the lane's thresholds and leaves the score and other flags alone", () => {
    const base = vpsConfig();
    const blocked = resolvePaperLanes({ names: ["trade-blocked-event-exits"], source: "test" }, VARIANTS, base)[0];
    const loose = resolvePaperLanes({ names: ["momentum-loose"], source: "test" }, VARIANTS, base)[0];
    expect(laneScoreView(base, loose?.config ?? base)).toBeNull();
    const view = laneScoreView(base, blocked?.config ?? base);
    const viewed = view?.(score());
    expect(viewed).toMatchObject({ hardBlocked: false, score: 30, flags: ["solo_bundle_share", "fresh_heavy"] });
    const stricter = structuredClone(base);
    stricter.scorer.hardBlocks.devShareAbove = 0.01;
    expect(laneScoreView(base, stricter)?.(score({ hardBlocked: false, flags: ["fresh_heavy"] }))).toMatchObject({
      hardBlocked: true,
      flags: ["hard_dev_share", "hard_bundle_share", "fresh_heavy"]
    });
  });

  it("shares one on-demand scoring request per mint between lanes and applies each lane's view", async () => {
    let calls = 0;
    let release: (value: LaunchScore | null) => void = () => undefined;
    const shared = new SharedScoreRequests({
      latest: () => score(),
      scoreNow: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    });
    const first = shared.scoreNow("Mint1", "convergence");
    const second = shared.scoreNow("Mint1", "convergence");
    expect(calls).toBe(1);
    expect(shared.pending()).toBe(1);
    release(score({ score: 12 }));
    expect((await first)?.score).toBe(12);
    expect((await second)?.score).toBe(12);
    expect(shared.pending()).toBe(0);
    void shared.scoreNow("Mint1", "convergence");
    expect(calls).toBe(2);
    const view = laneScoreView(vpsConfig(), resolvePaperLanes({ names: ["trade-blocked-event-exits"], source: "test" }, VARIANTS, vpsConfig())[0]?.config ?? vpsConfig());
    const viewed = viewedScores(shared, view);
    expect(viewed.latest("Mint1")?.hardBlocked).toBe(false);
    expect(viewedScores(shared, null)).toBe(shared);
  });
});
