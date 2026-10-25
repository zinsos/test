import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCohortBacktest, type CohortBacktestResult } from "../src/backtest/cohort.js";
import { runBacktest } from "../src/backtest/runner.js";
import type { BacktestResult } from "../src/backtest/summary.js";
import { defaultStrategyConfig, parseStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { seedSyntheticMarket, type SyntheticMarket } from "./backtest.market.js";

const FROM = Date.UTC(2026, 8, 14, 9, 0, 0);

interface Pinned {
  fingerprint: string;
  trades: number;
  signalsAccepted: number;
  entriesFilled: number;
}

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

function variant(change: (config: StrategyConfig) => void): StrategyConfig {
  const config = baseConfig();
  change(config);
  return parseStrategyConfig(config);
}

const CONFIGS: ReadonlyArray<{ key: string; config: StrategyConfig }> = [
  { key: "base", config: parseStrategyConfig(baseConfig()) },
  {
    key: "fast-exits",
    config: variant((config) => {
      config.exits.takeProfit = [{ atMultiple: 1.2, sellFractionOfInitial: 0.5 }];
      config.exits.trailing = [{ peakMultiple: 1.1, trailFraction: 0.1 }];
      config.exits.timeStop.afterSec = 45;
    })
  },
  {
    key: "holder",
    config: variant((config) => {
      config.exits.timeStop.afterSec = 86_400;
      config.exits.maxHoldSec = 7_200;
    })
  },
  {
    key: "convergence-early",
    config: variant((config) => {
      config.signals.enabled = ["smart_convergence"];
      config.tracker.convergence.minWallets = 2;
      config.tracker.convergence.waitForScoreMs = 2_000;
      config.tracker.convergence.maxScoreAgeSec = 0;
      config.exits.events.smartExitMinWallets = 1;
    })
  },
  {
    key: "momentum-only",
    config: variant((config) => {
      config.signals.enabled = ["score_momentum"];
      config.signals.scoreMomentum.checkpointSec = 30;
      config.signals.scoreMomentum.maxRiskScore = 80;
      config.risk.maxConcurrent = 8;
      config.execution.failureRate = 0.35;
    })
  },
  {
    key: "trade-blocked",
    config: variant((config) => {
      config.scorer.hardBlocks.devShareAbove = 1;
      config.scorer.hardBlocks.bundleShareAbove = 1;
      config.scorer.hardBlocks.clusterShareAbove = 1;
      config.scorer.hardBlocks.devRugRateAbove = 1;
      config.tracker.convergence.maxRiskScore = 100;
      config.signals.scoreMomentum.maxRiskScore = 100;
      config.exits.events.devSellMinFraction = 0.05;
      config.exits.events.insiderSellExitFraction = 0.2;
    })
  },
  {
    key: "small-bankroll",
    config: variant((config) => {
      config.risk.startingBankrollSol = 1;
      config.risk.fractionPerTrade = 0.1;
      config.risk.minPositionSol = 0.05;
      config.risk.dailyLossLimitFraction = 0.05;
    })
  }
];

const PINNED: Record<string, Pinned> = {
  base: { fingerprint: "3419a75aad444473e26e7c2820e9a5a66bce95d5cfb3660d54c9ac814b02f5bc", trades: 41, signalsAccepted: 115, entriesFilled: 41 },
  "fast-exits": { fingerprint: "8425b62c66377ba9bc568d38916086797528ce321a29e872aa95b8e39b0ff09b", trades: 58, signalsAccepted: 115, entriesFilled: 58 },
  holder: { fingerprint: "b66396c0d7c04021cf88d843371da30fee53375006119b40036aea32031eec45", trades: 12, signalsAccepted: 115, entriesFilled: 12 },
  "convergence-early": {
    fingerprint: "de3d3b8bb606b86aa0acaf0deed8ce90bbe028ea361ec8aec9e87d53c758cebe",
    trades: 18,
    signalsAccepted: 47,
    entriesFilled: 18
  },
  "momentum-only": {
    fingerprint: "73e13c69b4a10318e6242c71a3762f0e4db73b2eb0e05ce95635cd25a4c8dff5",
    trades: 30,
    signalsAccepted: 119,
    entriesFilled: 28
  },
  "trade-blocked": {
    fingerprint: "d8b9292ef8c849f15afc74c0ddc38f188dd90623bce8a2b1f047417e6a1a4118",
    trades: 45,
    signalsAccepted: 144,
    entriesFilled: 45
  },
  "small-bankroll": {
    fingerprint: "3f1d5442c683198e2c37ca00077671300f34921b4da25e21897ca7dfd3f26631",
    trades: 41,
    signalsAccepted: 115,
    entriesFilled: 41
  }
};

function pinnedOf(result: BacktestResult | null): Pinned | null {
  if (!result) {
    return null;
  }
  return {
    fingerprint: result.summary.fingerprint,
    trades: result.summary.trades.n,
    signalsAccepted: result.summary.counts.signalsAccepted,
    entriesFilled: result.summary.counts.entriesFilled
  };
}

describe.skipIf(!hasTestDatabase)("replay results stay pinned on a deterministic synthetic market", () => {
  let database: TestDatabase;
  let market: SyntheticMarket;
  const standalone = new Map<string, BacktestResult>();
  let cohort: CohortBacktestResult;

  beforeAll(async () => {
    database = await createTestDatabase("backtest_fingerprints");
    market = await seedSyntheticMarket(database.db, { seed: "fingerprint-pin-v1", fromMs: FROM, minutes: 70, launchesPerMinute: 4, storedShare: 0.7 });
    for (const entry of CONFIGS) {
      standalone.set(
        entry.key,
        await runBacktest({ db: database.db, fromMs: market.fromMs, toMs: market.toMs, config: entry.config, label: `pin:${entry.key}` })
      );
    }
    cohort = await runCohortBacktest({
      db: database.db,
      fromMs: market.fromMs,
      toMs: market.toMs,
      lanes: CONFIGS.map((entry) => ({ key: entry.key, config: entry.config, label: `pin-cohort:${entry.key}` }))
    });
  }, 300_000);

  afterAll(async () => {
    await database?.drop();
  });

  it("seeds the same market", () => {
    expect({ launches: market.launches, trades: market.trades, stored: market.stored.size }).toEqual({ launches: 299, trades: 10380, stored: 215 });
    expect(standalone.get("base")?.summary.counts.events).toBe(9906);
  });

  it("gives every standalone backtest its pinned trades", () => {
    const actual = Object.fromEntries(CONFIGS.map((entry) => [entry.key, pinnedOf(standalone.get(entry.key) ?? null)]));
    expect(actual).toEqual(PINNED);
  });

  it("gives every cohort lane the same pinned trades", () => {
    const actual = Object.fromEntries(cohort.lanes.map((lane) => [lane.key, pinnedOf(lane.result)]));
    expect(actual).toEqual(PINNED);
    expect(cohort.lanes.map((lane) => lane.error)).toEqual(CONFIGS.map(() => null));
  });
});
