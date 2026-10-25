import type { StrategyConfig } from "../config/strategy.js";
import type { Db } from "../db/pool.js";
import type { ScoringModel } from "../scorer/model.js";
import { runCohortBacktest, type ManagedTradingStore } from "./cohort.js";
import type { ObservationModel } from "./loader.js";
import type { BacktestProgress, BacktestResult } from "./summary.js";

export type { ManagedTradingStore } from "./cohort.js";
export {
  BACKTEST_END_REASON,
  countExitReasons,
  tradeFingerprint,
  type BacktestCounts,
  type BacktestProgress,
  type BacktestResult,
  type BacktestSummary
} from "./summary.js";

export interface BacktestOptions {
  db: Db;
  fromMs: number;
  toMs: number;
  config: StrategyConfig;
  label?: string | null;
  includeIncomplete?: boolean;
  walkForward?: boolean;
  model?: ScoringModel | null;
  weightsFile?: string | null;
  allowInSampleWeights?: boolean;
  windowMs?: number;
  observation?: ObservationModel;
  storedChunkMs?: number;
  settleMs?: number;
  evictEveryMs?: number;
  recordRejectedSignals?: boolean;
  store?: ManagedTradingStore | null;
  onProgress?: ((progress: BacktestProgress) => void) | null;
  progressEveryMs?: number;
}

export async function runBacktest(options: BacktestOptions): Promise<BacktestResult> {
  const outcome = await runCohortBacktest({
    db: options.db,
    fromMs: options.fromMs,
    toMs: options.toMs,
    lanes: [
      {
        key: "backtest",
        config: options.config,
        label: options.label ?? null,
        weightsFile: options.weightsFile ?? null,
        store: options.store ?? null,
        recordRejectedSignals: options.recordRejectedSignals ?? true,
        onProgress: options.onProgress ?? null
      }
    ],
    includeIncomplete: options.includeIncomplete,
    walkForward: options.walkForward,
    model: options.model ?? null,
    allowInSampleWeights: options.allowInSampleWeights,
    windowMs: options.windowMs,
    observation: options.observation,
    storedChunkMs: options.storedChunkMs,
    settleMs: options.settleMs,
    evictEveryMs: options.evictEveryMs,
    progressEveryMs: options.progressEveryMs,
    isolateLanes: false
  });
  const lane = outcome.lanes[0];
  if (!lane?.result) {
    throw new Error(lane?.error ?? "the backtest produced no result");
  }
  return lane.result;
}
