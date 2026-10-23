import type { TrackerConfig } from "../config/strategy.js";
import { EXCLUDE_REASONS, type ExcludeReason, type WalletFacts, type WindowStats } from "./types.js";

export interface WalletScoreWeights {
  profitFactorCap: number;
  longWindowWeight: number;
}

export const DEFAULT_SCORE_WEIGHTS: WalletScoreWeights = {
  profitFactorCap: 5,
  longWindowWeight: 0.35
};

export const DEFAULT_EXCLUDED_ENTITY_KINDS: readonly string[] = [
  "bot",
  "exclude",
  "cex",
  "dev",
  "bundler",
  "insider",
  "rugger",
  "sniper"
];

export interface ExclusionRules {
  minTradesShort: number;
  minTradesLong: number;
  minMedianHoldSec: number;
  maxCreationSlotEntryRate: number;
  maxMedianEntryDelaySec: number;
  minEntryDelaySec: number;
  excludeDevLinked: boolean;
  maxInsiderRate: number;
  minInsiderLaunches: number;
  excludedEntityKinds: ReadonlySet<string>;
}

export function exclusionRulesFrom(
  config: TrackerConfig,
  overrides: Partial<Omit<ExclusionRules, "excludedEntityKinds">> & { excludedEntityKinds?: Iterable<string> } = {}
): ExclusionRules {
  return {
    minTradesShort: overrides.minTradesShort ?? config.minTradesShort,
    minTradesLong: overrides.minTradesLong ?? config.minTradesLong,
    minMedianHoldSec: overrides.minMedianHoldSec ?? config.minMedianHoldSec,
    maxCreationSlotEntryRate: overrides.maxCreationSlotEntryRate ?? config.maxCreationSlotEntryRate,
    maxMedianEntryDelaySec: overrides.maxMedianEntryDelaySec ?? config.maxMedianEntryDelaySec,
    minEntryDelaySec: overrides.minEntryDelaySec ?? config.minEntryDelaySec,
    excludeDevLinked: overrides.excludeDevLinked ?? config.excludeDevLinked,
    maxInsiderRate: overrides.maxInsiderRate ?? config.maxCreationSlotEntryRate,
    minInsiderLaunches: overrides.minInsiderLaunches ?? 2,
    excludedEntityKinds: new Set(overrides.excludedEntityKinds ?? DEFAULT_EXCLUDED_ENTITY_KINDS)
  };
}

export function cappedProfitFactor(stats: WindowStats, cap: number): number {
  if (stats.profitFactor === null) {
    return 0;
  }
  return Math.min(cap, stats.profitFactor);
}

export function confidenceAdjustedEdge(stats: WindowStats, weights: WalletScoreWeights): number {
  if (stats.closed === 0 || stats.realizedPnlSol <= 0 || stats.pnlExBestSol <= 0) {
    return 0;
  }
  return stats.winRateLower * cappedProfitFactor(stats, weights.profitFactorCap) * Math.log1p(stats.pnlExBestSol);
}

export function compositeWalletScore(
  short: WindowStats,
  long: WindowStats,
  weights: WalletScoreWeights = DEFAULT_SCORE_WEIGHTS
): number {
  const recent = confidenceAdjustedEdge(short, weights);
  const sustained = confidenceAdjustedEdge(long, weights);
  return recent + weights.longWindowWeight * sustained;
}

function exceeds(value: number | null, limit: number): boolean {
  return value !== null && value > limit;
}

function below(value: number | null, limit: number): boolean {
  return value !== null && value < limit;
}

function insiderRate(facts: WalletFacts, long: WindowStats): number {
  return facts.insiderLaunches / Math.max(1, long.distinctMints);
}

function linkReasons(facts: WalletFacts, long: WindowStats, rules: ExclusionRules): ExcludeReason[] {
  const reasons: ExcludeReason[] = [];
  if (facts.knownEntityKind !== null && rules.excludedEntityKinds.has(facts.knownEntityKind)) {
    reasons.push("known_entity");
  }
  if (rules.excludeDevLinked) {
    if (facts.devLinked) {
      reasons.push("dev_linked");
    }
    if (facts.devFunded) {
      reasons.push("dev_funded");
    }
    if (facts.devFunder) {
      reasons.push("dev_funder");
    }
  }
  if (facts.insiderLaunches >= rules.minInsiderLaunches && insiderRate(facts, long) > rules.maxInsiderRate) {
    reasons.push("bundle_insider");
  }
  return reasons;
}

function behaviourReasons(long: WindowStats, facts: WalletFacts, rules: ExclusionRules): ExcludeReason[] {
  const reasons: ExcludeReason[] = [];
  if (exceeds(long.creationSlotEntryRate, rules.maxCreationSlotEntryRate)) {
    reasons.push("bundle_entries");
  }
  if (below(long.medianEntryDelaySec, rules.minEntryDelaySec)) {
    reasons.push("sniper");
  }
  if (facts.tooActive) {
    reasons.push("too_active");
  }
  if (below(long.medianHoldSec, rules.minMedianHoldSec)) {
    reasons.push("too_fast");
  }
  if (exceeds(long.medianEntryDelaySec, rules.maxMedianEntryDelaySec)) {
    reasons.push("late_entries");
  }
  return reasons;
}

function performanceReasons(short: WindowStats, long: WindowStats, rules: ExclusionRules): ExcludeReason[] {
  const reasons: ExcludeReason[] = [];
  if (short.closed < rules.minTradesShort || long.closed < rules.minTradesLong) {
    reasons.push("min_trades");
  }
  if (short.realizedPnlSol <= 0 || long.realizedPnlSol <= 0) {
    reasons.push("non_positive_pnl");
  } else if (short.pnlExBestSol <= 0) {
    reasons.push("one_hit");
  }
  return reasons;
}

export function exclusionReasons(
  short: WindowStats,
  long: WindowStats,
  facts: WalletFacts,
  rules: ExclusionRules
): ExcludeReason[] {
  const found = new Set<ExcludeReason>([
    ...linkReasons(facts, long, rules),
    ...behaviourReasons(long, facts, rules),
    ...performanceReasons(short, long, rules)
  ]);
  return EXCLUDE_REASONS.filter((reason) => found.has(reason));
}
