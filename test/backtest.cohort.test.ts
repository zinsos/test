import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCohortBacktest, type CohortBacktestResult, type CohortLane } from "../src/backtest/cohort.js";
import { runBacktest } from "../src/backtest/runner.js";
import type { BacktestResult } from "../src/backtest/summary.js";
import { defaultStrategyConfig, parseStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { createRng, type Rng } from "../src/core/rng.js";
import { jsonSafe } from "../src/db/pool.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { seedSyntheticMarket, type SyntheticMarket } from "./backtest.market.js";

const FROM = Date.UTC(2026, 9, 5, 12, 0, 0);
const MINUTES = 75;

type Mutation = (config: StrategyConfig, rng: Rng) => void;

function choose<T>(rng: Rng, values: readonly T[]): T {
  const value = values[Math.floor(rng() * values.length)];
  if (value === undefined) {
    throw new Error("empty choice");
  }
  return value;
}

const MUTATIONS: readonly Mutation[] = [
  (config, rng) => {
    config.tracker.convergence.minWallets = choose(rng, [2, 3, 4]);
  },
  (config, rng) => {
    config.tracker.convergence.maxRiskScore = choose(rng, [30, 55, 90]);
  },
  (config, rng) => {
    config.tracker.convergence.windowSec = choose(rng, [20, 60, 180]);
  },
  (config, rng) => {
    config.tracker.convergence.waitForScoreMs = choose(rng, [0, 2_000, 5_000]);
    config.tracker.convergence.maxScoreAgeSec = choose(rng, [0, 10, 120]);
  },
  (config, rng) => {
    config.tracker.convergence.maxLaunchAgeSec = choose(rng, [120, 900, 3_600]);
  },
  (config, rng) => {
    config.signals.enabled = choose(rng, [["smart_convergence"], ["score_momentum"], ["smart_convergence", "score_momentum"]] as const).slice();
  },
  (config, rng) => {
    config.signals.scoreMomentum.maxRiskScore = choose(rng, [30, 50, 80]);
    config.signals.scoreMomentum.minUniqueBuyersPerMin = choose(rng, [4, 10, 20]);
    config.signals.scoreMomentum.minMcapSol = choose(rng, [28, 33]);
    config.signals.scoreMomentum.checkpointSec = choose(rng, [30, 60]);
  },
  (config, rng) => {
    config.signals.cooldownPerMintSec = choose(rng, [30, 3_600]);
  },
  (config, rng) => {
    config.exits.timeStop.afterSec = choose(rng, [45, 120, 86_400]);
  },
  (config, rng) => {
    config.exits.takeProfit = choose(rng, [
      [{ atMultiple: 1.2, sellFractionOfInitial: 0.5 }],
      [
        { atMultiple: 1.5, sellFractionOfInitial: 0.4 },
        { atMultiple: 2.5, sellFractionOfInitial: 0.3 }
      ]
    ]);
    config.exits.trailing = choose(rng, [[{ peakMultiple: 1.1, trailFraction: 0.1 }], [{ peakMultiple: 1.5, trailFraction: 0.3 }]]);
  },
  (config, rng) => {
    config.exits.stopLossMultiple = choose(rng, [0.5, 0.85]);
    config.exits.maxHoldSec = choose(rng, [300, 3_600]);
  },
  (config, rng) => {
    config.exits.events.devSellExit = choose(rng, [true, false]);
    config.exits.events.insiderSellExitFraction = choose(rng, [0.05, 0.3]);
    config.exits.events.smartExitMinWallets = choose(rng, [0, 1, 3]);
  },
  (config, rng) => {
    config.risk.fractionPerTrade = choose(rng, [0.01, 0.06]);
    config.risk.maxConcurrent = choose(rng, [1, 3, 8]);
  },
  (config, rng) => {
    config.risk.maxEntriesPerDevPerDay = choose(rng, [1, 4]);
    config.risk.startingBankrollSol = choose(rng, [2, 20]);
  },
  (config, rng) => {
    config.execution.latencySlots = choose(rng, [0, 1, 5]);
    config.execution.latencyJitterSlots = choose(rng, [0, 3]);
  },
  (config, rng) => {
    config.execution.failureRate = choose(rng, [0, 0.35]);
    config.execution.maxRetries = choose(rng, [0, 2]);
  }
];

function baseConfig(): StrategyConfig {
  const config = defaultStrategyConfig();
  config.signals.enabled = ["smart_convergence", "score_momentum"];
  config.signals.scoreMomentum.minMcapSol = 30;
  config.signals.scoreMomentum.minUniqueBuyersPerMin = 8;
  config.signals.scoreMomentum.maxRiskScore = 60;
  config.recorder.memory.evictInactiveMinutes = 4;
  config.recorder.memory.evictMaxAgeHours = 1;
  return config;
}

function variantConfigs(seed: string, count: number): Array<{ key: string; config: StrategyConfig }> {
  const rng = createRng(seed);
  const variants: Array<{ key: string; config: StrategyConfig }> = [
    { key: "base", config: baseConfig() },
    {
      key: "holder",
      config: parseStrategyConfig({ ...baseConfig(), exits: { ...baseConfig().exits, timeStop: { afterSec: 86_400, flatBandFraction: 0.15 } } })
    }
  ];
  while (variants.length < count) {
    const config = baseConfig();
    const picks = 2 + Math.floor(rng() * 3);
    for (let index = 0; index < picks; index += 1) {
      choose(rng, MUTATIONS)(config, rng);
    }
    variants.push({ key: `v${variants.length}`, config: parseStrategyConfig(config) });
  }
  return variants;
}

function comparable(result: BacktestResult | null): string {
  if (!result) {
    return "missing";
  }
  return JSON.stringify(jsonSafe({ ...result.summary, runId: 0 }));
}

describe.skipIf(!hasTestDatabase)("cohort replay gives every lane the trades of its standalone backtest", () => {
  let database: TestDatabase;
  let market: SyntheticMarket;
  const variants = variantConfigs("cohort-property-v1", 9);
  const blocked = (() => {
    const config = baseConfig();
    config.scorer.hardBlocks.bundleShareAbove = 1;
    config.tracker.convergence.maxRiskScore = 100;
    return { key: "other-blocks", config: parseStrategyConfig(config) };
  })();
  const otherScorer = (() => {
    const config = baseConfig();
    config.scorer.earlyBuyerCount = 6;
    config.scorer.hardBlocks.devShareAbove = 1;
    return { key: "other-scorer", config: parseStrategyConfig(config) };
  })();
  const lanes: CohortLane[] = [...variants, blocked, otherScorer].map((variant) => ({
    key: variant.key,
    config: variant.config,
    label: `cohort:${variant.key}`
  }));
  const standalone = new Map<string, BacktestResult>();
  let first: CohortBacktestResult;
  let second: CohortBacktestResult;

  beforeAll(async () => {
    database = await createTestDatabase("backtest_cohort");
    market = await seedSyntheticMarket(database.db, { seed: "cohort-market-v1", fromMs: FROM, minutes: MINUTES, launchesPerMinute: 4, storedShare: 0.85 });
    for (const lane of lanes) {
      standalone.set(
        lane.key,
        await runBacktest({ db: database.db, fromMs: market.fromMs, toMs: market.toMs, config: lane.config, label: lane.label ?? null })
      );
    }
    first = await runCohortBacktest({ db: database.db, fromMs: market.fromMs, toMs: market.toMs, lanes });
    second = await runCohortBacktest({ db: database.db, fromMs: market.fromMs, toMs: market.toMs, lanes });
  }, 300_000);

  afterAll(async () => {
    await database?.drop();
  });

  it("seeds a market with every launch kind and trades in most lanes", () => {
    expect(new Set(market.kinds.values()).size).toBe(7);
    expect(market.trades).toBeGreaterThan(5_000);
    const traded = [...standalone.values()].filter((result) => result.summary.trades.n > 0);
    expect(traded.length).toBeGreaterThanOrEqual(lanes.length - 2);
    const fingerprints = new Set([...standalone.values()].map((result) => result.summary.fingerprint));
    expect(fingerprints.size).toBeGreaterThanOrEqual(5);
  });

  it("replays lanes that share the scorer features and market settings in one isolated pass, whatever their hard blocks, and the other scorer in its own", () => {
    const isolated = first.passes.filter((pass) => pass.isolated);
    expect(isolated).toHaveLength(1);
    expect(isolated[0]?.lanes).toEqual([...variants.map((variant) => variant.key), blocked.key]);
    expect(first.passes.some((pass) => !pass.isolated && pass.lanes.join() === otherScorer.key)).toBe(true);
    expect(standalone.get(blocked.key)?.summary.fingerprint).not.toBe(standalone.get("base")?.summary.fingerprint);
    for (const pass of first.passes) {
      expect(pass.events).toBe(standalone.get("base")?.summary.counts.events);
    }
  });

  it("matches the standalone fingerprint and summary of every lane", () => {
    for (const lane of first.lanes) {
      expect(lane.error).toBeNull();
      const alone = standalone.get(lane.key);
      expect(lane.result?.summary.fingerprint, lane.key).toBe(alone?.summary.fingerprint);
      expect(comparable(lane.result), lane.key).toBe(comparable(alone ?? null));
      expect(lane.result?.closedTrades.length, lane.key).toBe(alone?.closedTrades.length);
    }
  });

  it("keeps most lanes inside the shared pass and hides evicted launches from lanes that would have dropped them", () => {
    const fallbacks = first.lanes.filter((lane) => lane.fallback !== null);
    expect(fallbacks.length).toBeLessThanOrEqual(Math.floor(variants.length / 3));
    expect(first.passes.find((pass) => pass.isolated)?.hiddenWhileHeld).toBeGreaterThan(0);
  });

  it("replays a lane alone when its own early scoring would have changed a shared checkpoint score", async () => {
    const early = baseConfig();
    early.tracker.convergence.minWallets = 2;
    const pair: CohortLane[] = [
      { key: "base", config: baseConfig(), label: "pair:base" },
      { key: "early", config: parseStrategyConfig(early), label: "pair:early" }
    ];
    const alone = await runBacktest({ db: database.db, fromMs: market.fromMs, toMs: market.toMs, config: pair[1]?.config ?? baseConfig(), label: "pair:early" });
    const cohort = await runCohortBacktest({ db: database.db, fromMs: market.fromMs, toMs: market.toMs, lanes: pair });
    const [base, replayed] = cohort.lanes;
    expect(base?.fallback).toBeNull();
    expect(comparable(base?.result ?? null)).toBe(comparable(standalone.get("base") ?? null).replace('"label":"cohort:base"', '"label":"pair:base"'));
    expect(replayed?.fallback).toMatch(/dev history/);
    expect(comparable(replayed?.result ?? null)).toBe(comparable(alone));
    expect(cohort.passes.map((pass) => [pass.lanes.join(), pass.isolated])).toEqual([
      ["base,early", true],
      ["early", false]
    ]);
  }, 120_000);

  it("is deterministic across cohort runs", () => {
    expect(second.lanes.map((lane) => [lane.key, lane.fallback, comparable(lane.result)])).toEqual(
      first.lanes.map((lane) => [lane.key, lane.fallback, comparable(lane.result)])
    );
  });

  it("writes one finished strategy run per lane and discards the runs of lanes replayed alone", async () => {
    const labels = lanes.map((lane) => lane.label);
    const rows = await database.db.query<{ label: string; n: number; finished: number }>(
      `SELECT label, count(*)::int AS n, count(ended_at)::int AS finished FROM strategy_runs WHERE label = ANY($1::text[]) GROUP BY label ORDER BY label`,
      [labels]
    );
    for (const row of rows.rows) {
      expect(row.n, row.label).toBe(3);
      expect(row.finished, row.label).toBe(3);
    }
    expect(rows.rows).toHaveLength(lanes.length);
  });
});
