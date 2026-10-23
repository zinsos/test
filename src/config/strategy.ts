import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const Fraction = z.number().min(0).max(1);

export const RecorderConfigSchema = z.object({
  trackMaxAgeHours: z.number().positive().default(24),
  postMigrationTrackHours: z.number().nonnegative().default(24),
  holderCheckpointsSec: z.array(z.number().int().positive()).default([30, 60, 300, 900]),
  rpcSnapshotsEnabled: z.boolean().default(true),
  rpcSnapshotMinTrades: z.number().int().nonnegative().default(15),
  finalizeIntervalSec: z.number().int().positive().default(60),
  partitionDaysAhead: z.number().int().nonnegative().default(3),
  metadata: z
    .object({
      enabled: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(6000),
      gateway: z.string().default("https://ipfs.io/ipfs/"),
      concurrency: z.number().int().positive().default(8),
      maxRetries: z.number().int().nonnegative().default(2)
    })
    .prefault({}),
  outcome: z
    .object({
      deadInactivityMinutes: z.number().positive().default(30),
      deadMaxMcapMultiple: z.number().positive().default(1.5),
      rugWindowSec: z.number().positive().default(120),
      rugInsiderSellFraction: Fraction.default(0.5),
      rugDropFraction: Fraction.default(0.7),
      rugLookaheadSec: z.number().positive().default(300),
      surviveCheckSec: z.number().positive().default(900),
      surviveRecentTradeSec: z.number().positive().default(300),
      surviveMinMultipleOfInitial: z.number().positive().default(1.0),
      finalizeAfterHours: z.number().positive().default(24)
    })
    .prefault({}),
  memory: z
    .object({
      evictInactiveMinutes: z.number().positive().default(45),
      evictMaxAgeHours: z.number().positive().default(6),
      maxTradesPerLaunch: z.number().int().positive().default(25000)
    })
    .prefault({})
});

export const ScorerConfigSchema = z.object({
  checkpointsSec: z.array(z.number().int().positive()).default([10, 30, 60, 120]),
  earlyBuyerCount: z.number().int().positive().default(20),
  earlyWindowSec: z.number().positive().default(60),
  bundleSlotWindow: z.number().int().nonnegative().default(1),
  weightsFile: z.string().default("config/scorer-weights.json"),
  maxRisk: z.number().min(0).max(100).default(55),
  hardBlocks: z
    .object({
      devShareAbove: Fraction.default(0.2),
      bundleShareAbove: Fraction.default(0.25),
      clusterShareAbove: Fraction.default(0.3),
      devRugRateAbove: Fraction.default(0.6),
      devRugMinLaunches: z.number().int().nonnegative().default(3)
    })
    .prefault({}),
  deepIntel: z
    .object({
      enabled: z.boolean().default(true),
      minBuyersForDeep: z.number().int().nonnegative().default(5),
      freshMaxPriorTxs: z.number().int().nonnegative().default(5),
      signatureLookback: z.number().int().positive().default(25),
      maxFundingLookups: z.number().int().positive().default(5),
      minFundingLamports: z.number().nonnegative().default(10_000_000),
      cacheTtlHours: z.number().positive().default(72),
      hubFanoutThreshold: z.number().int().positive().default(40),
      maxWalletsPerLaunch: z.number().int().positive().default(25),
      timeoutMs: z.number().int().positive().default(8000)
    })
    .prefault({}),
  copycat: z
    .object({
      trendingWindowMinutes: z.number().positive().default(60),
      trendingTopN: z.number().int().positive().default(50),
      similarityThreshold: Fraction.default(0.85)
    })
    .prefault({})
});

export const TrackerConfigSchema = z.object({
  rerankIntervalHours: z.number().positive().default(168),
  shortWindowDays: z.number().positive().default(30),
  longWindowDays: z.number().positive().default(90),
  minTradesShort: z.number().int().nonnegative().default(8),
  minTradesLong: z.number().int().nonnegative().default(15),
  minMedianHoldSec: z.number().nonnegative().default(45),
  maxCreationSlotEntryRate: Fraction.default(0.3),
  maxMedianEntryDelaySec: z.number().positive().default(3600),
  minEntryDelaySec: z.number().nonnegative().default(3),
  topN: z.number().int().positive().default(100),
  excludeDevLinked: z.boolean().default(true),
  backfill: z
    .object({
      enabled: z.boolean().default(true),
      maxWallets: z.number().int().positive().default(200),
      maxSignaturesPerWallet: z.number().int().positive().default(3000),
      concurrency: z.number().int().positive().default(3)
    })
    .prefault({}),
  convergence: z
    .object({
      windowSec: z.number().positive().default(120),
      minWallets: z.number().int().positive().default(3),
      maxRiskScore: z.number().min(0).max(100).default(55),
      waitForScoreMs: z.number().int().nonnegative().default(5000),
      maxLaunchAgeSec: z.number().positive().default(3600)
    })
    .prefault({})
});

export const SignalsConfigSchema = z.object({
  enabled: z.array(z.enum(["smart_convergence", "score_momentum"])).default(["smart_convergence"]),
  cooldownPerMintSec: z.number().nonnegative().default(3600),
  quoteMints: z.array(z.string()).default(["SOL"]),
  scoreMomentum: z
    .object({
      checkpointSec: z.number().int().positive().default(60),
      maxRiskScore: z.number().min(0).max(100).default(35),
      minUniqueBuyersPerMin: z.number().nonnegative().default(15),
      minBuySellRatio: z.number().nonnegative().default(1.5),
      minMcapSol: z.number().nonnegative().default(35),
      maxMcapSol: z.number().positive().default(150)
    })
    .prefault({})
});

export const ExecutionConfigSchema = z.object({
  latencySlots: z.number().int().nonnegative().default(2),
  latencyJitterSlots: z.number().int().nonnegative().default(2),
  failureRate: Fraction.default(0.12),
  maxRetries: z.number().int().nonnegative().default(2),
  retryDelaySlots: z.number().int().nonnegative().default(3),
  buySlippageBps: z.number().int().nonnegative().default(1500),
  sellSlippageBps: z.number().int().nonnegative().default(2000),
  emergencySellSlippageBps: z.number().int().nonnegative().default(5000),
  priorityFeeLamports: z.number().int().nonnegative().default(300_000),
  useJito: z.boolean().default(false),
  jitoTipLamports: z.number().int().nonnegative().default(1_000_000),
  baseFeeLamports: z.number().int().nonnegative().default(5_000),
  ataRentLamports: z.number().int().nonnegative().default(2_039_280),
  refundAtaOnClose: z.boolean().default(true),
  extraPlatformFeeBps: z.number().int().nonnegative().default(0),
  defaultProtocolFeeBps: z.number().int().nonnegative().default(95),
  defaultCreatorFeeBps: z.number().int().nonnegative().default(30),
  defaultPoolLpFeeBps: z.number().int().nonnegative().default(20),
  defaultPoolProtocolFeeBps: z.number().int().nonnegative().default(5),
  defaultPoolCreatorFeeBps: z.number().int().nonnegative().default(5),
  fillTimeoutMs: z.number().int().positive().default(15_000),
  seed: z.string().default("snypra-edge")
});

const TakeProfitLevel = z.object({ atMultiple: z.number().positive(), sellFractionOfInitial: Fraction });
const TrailingTier = z.object({ peakMultiple: z.number().positive(), trailFraction: Fraction });

export const ExitConfigSchema = z.object({
  takeProfit: z.array(TakeProfitLevel).default([
    { atMultiple: 2, sellFractionOfInitial: 0.5 },
    { atMultiple: 3, sellFractionOfInitial: 0.15 },
    { atMultiple: 5, sellFractionOfInitial: 0.15 },
    { atMultiple: 10, sellFractionOfInitial: 0.1 }
  ]),
  moonbagFraction: Fraction.default(0.1),
  stopLossMultiple: z.number().positive().default(0.65),
  trailing: z.array(TrailingTier).default([
    { peakMultiple: 1.3, trailFraction: 0.25 },
    { peakMultiple: 2, trailFraction: 0.22 },
    { peakMultiple: 3, trailFraction: 0.18 },
    { peakMultiple: 5, trailFraction: 0.15 }
  ]),
  moonbagTrailFraction: Fraction.default(0.45),
  timeStop: z
    .object({
      afterSec: z.number().positive().default(300),
      flatBandFraction: Fraction.default(0.15)
    })
    .prefault({}),
  maxHoldSec: z.number().positive().default(3600),
  events: z
    .object({
      devSellExit: z.boolean().default(true),
      devSellMinFraction: Fraction.default(0.1),
      insiderSellExitFraction: Fraction.default(0.3),
      smartExitMinWallets: z.number().int().nonnegative().default(2)
    })
    .prefault({}),
  migration: z
    .object({
      action: z.enum(["switch", "exit", "hold"]).default("switch"),
      trailFraction: Fraction.default(0.3),
      timeStopSec: z.number().positive().default(1800)
    })
    .prefault({}),
  liquidity: z
    .object({
      maxImpactBps: z.number().int().positive().default(300),
      emergencyMaxImpactBps: z.number().int().positive().default(3000),
      minChunkLamports: z.number().int().nonnegative().default(10_000_000)
    })
    .prefault({}),
  evaluateIntervalMs: z.number().int().positive().default(2000)
});

export const RiskConfigSchema = z.object({
  startingBankrollSol: z.number().positive().default(5),
  fractionPerTrade: Fraction.default(0.015),
  minPositionSol: z.number().nonnegative().default(0.02),
  maxPositionSol: z.number().positive().default(0.5),
  maxConcurrent: z.number().int().positive().default(5),
  dailyLossLimitFraction: Fraction.default(0.08),
  killSwitchDrawdownFraction: Fraction.default(0.25),
  dayResetUtcHour: z.number().int().min(0).max(23).default(0),
  flattenOnKill: z.boolean().default(true),
  maxEntriesPerDevPerDay: z.number().int().positive().default(1),
  minFeeReserveSol: z.number().nonnegative().default(0.05)
});

export const SweeperConfigSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().positive().default(60),
  hotTargetSol: z.number().positive().default(5),
  reserveSol: z.number().nonnegative().default(0.1),
  minSweepSol: z.number().positive().default(0.25)
});

export const StrategyConfigSchema = z.object({
  recorder: RecorderConfigSchema.prefault({}),
  scorer: ScorerConfigSchema.prefault({}),
  tracker: TrackerConfigSchema.prefault({}),
  signals: SignalsConfigSchema.prefault({}),
  execution: ExecutionConfigSchema.prefault({}),
  exits: ExitConfigSchema.prefault({}),
  risk: RiskConfigSchema.prefault({}),
  sweeper: SweeperConfigSchema.prefault({})
});

export type RecorderConfig = z.infer<typeof RecorderConfigSchema>;
export type ScorerConfig = z.infer<typeof ScorerConfigSchema>;
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;
export type SignalsConfig = z.infer<typeof SignalsConfigSchema>;
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
export type ExitConfig = z.infer<typeof ExitConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type SweeperConfig = z.infer<typeof SweeperConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export function parseStrategyConfig(raw: unknown): StrategyConfig {
  const parsed = StrategyConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`invalid strategy config: ${issues}`);
  }
  return parsed.data;
}

export function defaultStrategyConfig(): StrategyConfig {
  return parseStrategyConfig({});
}

export async function loadStrategyConfig(filePath: string): Promise<StrategyConfig> {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) {
    return defaultStrategyConfig();
  }
  const raw: unknown = JSON.parse(await readFile(resolved, "utf8"));
  return parseStrategyConfig(raw);
}
