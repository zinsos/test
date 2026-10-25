import type { AutoLearnConfig } from "../config/strategy.js";
import { createRng, type Rng } from "../core/rng.js";
import { studentTQuantile } from "../core/stats.js";
import type { ClosedTrade } from "../core/types.js";
import { lamportsToSol } from "../analytics/units.js";
import { isPlainObject, UNDO_VARIANT_PREFIX, type JsonObject } from "./variants.js";

export const LEARNER_REPORT_VERSION = 2;
export const OWN_CONFIDENCE = 0.95;
export const PAPER_CONFIDENCE = 0.95;
export const MIN_PAPER_MATCH = 0.6;
export const PAPER_BIAS_TOLERANCE = 0.02;
export const CONFIRM_TRADE_MARGIN = 1.25;
export const WINDOW_LENGTH_TOLERANCE_MS = 60_000;
export const ENTRY_OVERLAP_TOLERANCE_MS = 5 * 60_000;
export const UNDO_PREFIX = UNDO_VARIANT_PREFIX;
const R_DIGITS = 1e6;
const SOL_DIGITS = 1e9;
const HOUR_MS = 3_600_000;

export interface StoredTrade {
  r: number;
  sol: number;
  mint: string;
  openedAtMs: number;
  closedAtMs: number;
  exitReason: string;
}

export interface EvidenceTrade {
  r: number;
  sol: number;
  mint: string | null;
  openedAtMs: number;
}

export interface EvidenceIdentity {
  settingsHash: string;
  engineVersion: string | null;
  weightsVersion: string | null;
}

export interface EvidenceArm {
  name: string;
  key: string;
  isBaseline: boolean;
  promotable: boolean;
  trades: EvidenceTrade[] | null;
}

export interface EvidenceWindow {
  labRunId: number;
  fromMs: number;
  toMs: number;
  settingsHash: string | null;
  engineVersion: string | null;
  weightsVersion: string | null;
  arms: EvidenceArm[];
}

export interface PlannedArm {
  name: string;
  description: string;
  overrides: JsonObject;
  key: string;
  ownerOnly: string[];
  holdMs: number;
}

export interface PaperEvidence {
  runId: number;
  startedAtMs: number;
  configMatches: boolean;
  trades: EvidenceTrade[];
}

export interface LearnerRule {
  minTrades: number;
  minWindows: number;
  maxWindows: number;
  confirmWindows: number;
  windowMs: number;
  familyConfidence: number;
  bootstrapIterations: number;
  seed: string;
  minPaperTrades: number;
}

export interface WeightsRule {
  minAucGain: number;
  minValidationRows: number;
}

export interface OpenCandidate {
  promotionId: number;
  name: string;
  key: string;
  overrides: JsonObject;
  confirmFromMs: number;
  confirmWindows: number;
  index: number;
}

export interface PendingPromotion {
  promotionId: number;
  kind: "variant" | "revert";
  name: string;
}

export interface ProbationState {
  promotionId: number;
  name: string;
  undoName: string;
  undoKey: string;
  fromMs: number;
  windows: number;
}

export interface LearnerState {
  tried: ReadonlySet<string>;
  nominations: number;
  confirming: OpenCandidate | null;
  pending: PendingPromotion | null;
  probation: ProbationState | null;
}

export interface WindowResult {
  labRunId: number;
  fromMs: number;
  toMs: number;
  variantTrades: number;
  baselineTrades: number;
  variant: number;
  baseline: number;
  variantSol: number;
  baselineSol: number;
  gain: number;
  gainSol: number;
}

export interface GainStats {
  windows: number;
  confidence: number;
  variantTrades: number;
  baselineTrades: number;
  variantPerTrade: number | null;
  baselinePerTrade: number | null;
  gain: number | null;
  gainSol: number | null;
  gainLow: number | null;
  gainHigh: number | null;
  own: number | null;
  ownSol: number | null;
  ownLow: number | null;
  baselineMean: number | null;
  positive: number;
  negative: number;
  withoutBest: number | null;
  halves: { older: number | null; newer: number | null; olderWindows: number; newerWindows: number };
}

export type VariantVerdictKind = "not_run" | "collecting" | "not_better" | "worse" | "candidate" | "owner_only" | "tried" | "confirming" | "pending";

export interface VariantVerdict {
  name: string;
  key: string;
  description: string;
  overrides: JsonObject;
  ownerOnly: string[];
  stats: GainStats | null;
  progress: { trades: number; windows: number };
  verdict: VariantVerdictKind;
  reasons: string[];
}

export type PaperCheckStatus = "no_run" | "other_settings" | "too_few" | "unmatched" | "consistent" | "replay_optimistic";

export interface PaperCheck {
  status: PaperCheckStatus;
  runId: number | null;
  windows: number;
  matched: number;
  replayOnly: number;
  paperOnly: number;
  coverage: number | null;
  bias: number | null;
  biasLow: number | null;
  biasHigh: number | null;
  paperPerTrade: number | null;
  replayPerTrade: number | null;
  marginPerTrade: number;
  needed: number;
}

export interface ConfirmationReport {
  promotionId: number;
  name: string;
  key: string;
  index: number;
  confidence: number;
  fromMs: number;
  needed: number;
  collected: number;
  variantTrades: number;
  baselineTrades: number;
  complete: boolean;
  stats: GainStats | null;
  reasons: string[];
}

export interface ProbationReport {
  promotionId: number;
  name: string;
  undoName: string;
  fromMs: number;
  needed: number;
  collected: number;
  complete: boolean;
  stats: GainStats | null;
  result: "kept" | "revert" | null;
}

export type LearnerDecision =
  | { kind: "hold"; name: string | null; reason: string }
  | {
      kind: "nominate";
      name: string;
      key: string;
      overrides: JsonObject;
      confirmFromMs: number;
      confirmWindows: number;
      index: number;
      confidence: number;
      reason: string;
    }
  | { kind: "confirm"; promotionId: number; name: string; reason: string }
  | { kind: "reject"; promotionId: number; name: string; reason: string }
  | { kind: "withdraw"; promotionId: number; name: string; reason: string }
  | { kind: "revert"; promotionId: number; name: string; reason: string }
  | { kind: "keep"; promotionId: number; name: string; reason: string };

export interface LearnerWindow {
  labRunId: number;
  fromMs: number;
  toMs: number;
}

export interface BaselineSummary {
  trades: number;
  windows: number;
  perTrade: number | null;
  perWindow: number | null;
  perWindowSol: number | null;
  perWindowLow: number | null;
  perWindowHigh: number | null;
}

export interface ScorerEntryEvidence {
  label: string;
  checkpointSec: number;
  validationAuc: number | null;
  baselineAuc: number | null;
  validationRows: number | null;
  validationFromMs: number | null;
  validationToMs: number | null;
  weightsVersion: string | null;
}

export interface ScorerRunEvidence {
  labRunId: number;
  startedAtMs: number;
  weightsBase: string | null;
  entries: ScorerEntryEvidence[];
}

export interface WeightsRunCheck {
  labRunId: number;
  gain: number | null;
  validationRows: number | null;
  weightsVersion: string | null;
  passes: boolean;
}

export type WeightsVerdictKind = "ready" | "collecting" | "not_better";

export interface WeightsCandidate {
  label: string;
  checkpointSec: number;
  latest: WeightsRunCheck;
  previous: WeightsRunCheck | null;
  verdict: WeightsVerdictKind;
  reasons: string[];
}

export interface WeightsReport {
  mode: "report_only";
  activeVersion: string | null;
  rule: WeightsRule;
  candidates: WeightsCandidate[];
  best: WeightsCandidate | null;
}

export interface LearnerReport {
  version: number;
  evaluatedAtMs: number;
  labRunId: number;
  identity: EvidenceIdentity;
  enabled: boolean;
  canPromote: boolean;
  rule: LearnerRule & { alpha: number; comparisons: number; discoveryConfidence: number; nextConfirmConfidence: number };
  windows: LearnerWindow[];
  baseline: BaselineSummary;
  variants: VariantVerdict[];
  paper: PaperCheck;
  confirmation: ConfirmationReport | null;
  probation: ProbationReport | null;
  decision: LearnerDecision;
  weights: WeightsReport;
  promotion: { id: number; status: string; name: string } | null;
}

export interface LearnerInput {
  nowMs: number;
  labRunId: number;
  identity: EvidenceIdentity;
  enabled: boolean;
  canPromote: boolean;
  rule: LearnerRule;
  baselineHoldMs: number;
  variants: readonly PlannedArm[];
  windows: readonly EvidenceWindow[];
  paper: PaperEvidence | null;
  state: LearnerState;
  scorer: { runs: readonly ScorerRunEvidence[]; activeVersion: string | null; rule: WeightsRule };
}

export function learnerRuleOf(config: AutoLearnConfig): LearnerRule {
  return {
    minTrades: config.minTrades,
    minWindows: config.minWindows,
    maxWindows: config.maxWindows,
    confirmWindows: config.confirmWindows,
    windowMs: Math.round(config.windowHours * HOUR_MS),
    familyConfidence: config.familyConfidence,
    bootstrapIterations: config.bootstrapIterations,
    seed: config.seed,
    minPaperTrades: config.minPaperTrades
  };
}

export function weightsRuleOf(config: AutoLearnConfig): WeightsRule {
  return { minAucGain: config.weights.minAucGain, minValidationRows: config.weights.minValidationRows };
}

function rounded(value: number, digits: number): number {
  return Math.round(value * digits) / digits;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function storedTrade(pnl: bigint, cost: bigint): { r: number; sol: number } {
  return { r: rounded(Number(pnl) / Number(cost), R_DIGITS), sol: rounded(lamportsToSol(pnl), SOL_DIGITS) };
}

export function storedTradesOf(trades: readonly ClosedTrade[]): StoredTrade[] {
  return trades
    .filter((trade) => trade.cost > 0n)
    .map((trade) => ({
      ...storedTrade(trade.pnl, trade.cost),
      mint: trade.mint,
      openedAtMs: trade.openedAtMs,
      closedAtMs: trade.closedAtMs,
      exitReason: trade.exitReason
    }));
}

export function parseStoredTrades(value: unknown): EvidenceTrade[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const trades: EvidenceTrade[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const r = finiteOrNull(item.r);
    const sol = finiteOrNull(item.sol);
    const openedAtMs = finiteOrNull(item.openedAtMs);
    if (r === null || sol === null || openedAtMs === null) {
      continue;
    }
    trades.push({ r, sol, openedAtMs, mint: typeof item.mint === "string" && item.mint.length > 0 ? item.mint : null });
  }
  return trades;
}

export function alphaOf(rule: Pick<LearnerRule, "familyConfidence">): number {
  return 1 - rule.familyConfidence;
}

export function discoveryConfidenceOf(familyConfidence: number, comparisons: number): number {
  return 1 - (1 - familyConfidence) / Math.max(1, comparisons);
}

export function confirmConfidenceOf(familyConfidence: number, index: number): number {
  const j = Math.max(1, Math.floor(index));
  return 1 - ((1 - familyConfidence) * 6) / (Math.PI * Math.PI * j * j);
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

function sdOf(values: readonly number[], mean: number): number {
  if (values.length < 2) {
    return 0;
  }
  let acc = 0;
  for (const value of values) {
    acc += (value - mean) * (value - mean);
  }
  return Math.sqrt(acc / (values.length - 1));
}

function sortedQuantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? Number.NaN;
  const high = sorted[upper] ?? low;
  if (low === high) {
    return low;
  }
  return low + (high - low) * (position - lower);
}

function finiteBound(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function tLowerBound(values: readonly number[], confidence: number): number | null {
  const mean = meanOf(values);
  if (mean === null || values.length < 2) {
    return null;
  }
  const sd = sdOf(values, mean);
  if (sd === 0) {
    return mean;
  }
  return finiteBound(mean - studentTQuantile(confidence, values.length - 1) * (sd / Math.sqrt(values.length)));
}

export function tUpperBound(values: readonly number[], confidence: number): number | null {
  const negated = tLowerBound(
    values.map((value) => -value),
    confidence
  );
  return negated === null ? null : -negated;
}

export function bootstrapTLowerBound(values: readonly number[], confidence: number, rng: Rng, iterations: number): number | null {
  const n = values.length;
  const mean = meanOf(values);
  if (mean === null || n < 2) {
    return null;
  }
  const sd = sdOf(values, mean);
  if (sd === 0) {
    return mean;
  }
  const scale = Math.sqrt(n);
  const stats = new Float64Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    let total = 0;
    let squares = 0;
    for (let j = 0; j < n; j += 1) {
      const value = values[Math.floor(rng() * n)] ?? 0;
      total += value;
      squares += value * value;
    }
    const resampled = total / n;
    const spread = Math.sqrt(Math.max(0, (squares - n * resampled * resampled) / (n - 1)));
    if (spread > 1e-12 * Math.max(1, Math.abs(resampled))) {
      stats[i] = (resampled - mean) / (spread / scale);
    } else {
      stats[i] = resampled > mean ? Number.POSITIVE_INFINITY : resampled < mean ? Number.NEGATIVE_INFINITY : 0;
    }
  }
  stats.sort();
  return finiteBound(mean - sortedQuantile(stats, confidence) * (sd / scale));
}

export function meanLowerBound(values: readonly number[], confidence: number, rng: Rng, iterations: number): number | null {
  const t = tLowerBound(values, confidence);
  const boot = bootstrapTLowerBound(values, confidence, rng, iterations);
  if (t === null || boot === null) {
    return null;
  }
  return Math.min(t, boot);
}

function seedFor(rule: LearnerRule, ...parts: Array<string | number>): Rng {
  return createRng([rule.seed, ...parts].join("|"));
}

function lengthMatches(window: EvidenceWindow, windowMs: number): boolean {
  return Math.abs(window.toMs - window.fromMs - windowMs) <= WINDOW_LENGTH_TOLERANCE_MS;
}

function matchesIdentity(window: EvidenceWindow, identity: EvidenceIdentity): boolean {
  return window.settingsHash === identity.settingsHash && window.engineVersion === identity.engineVersion && window.weightsVersion === identity.weightsVersion;
}

export function entryEndMs(window: Pick<EvidenceWindow, "toMs">, holdMs: number): number {
  return window.toMs - holdMs;
}

function baselineTradesOf(window: EvidenceWindow): EvidenceTrade[] | null {
  return window.arms.find((arm) => arm.isBaseline)?.trades ?? null;
}

function armTradesOf(window: EvidenceWindow, key: string): EvidenceTrade[] | null {
  return window.arms.find((arm) => !arm.isBaseline && arm.key === key)?.trades ?? null;
}

export function eligibleWindows(windows: readonly EvidenceWindow[], identity: EvidenceIdentity, rule: LearnerRule, holdMs: number): EvidenceWindow[] {
  return windows.filter(
    (window) =>
      matchesIdentity(window, identity) &&
      lengthMatches(window, rule.windowMs) &&
      entryEndMs(window, holdMs) > window.fromMs &&
      baselineTradesOf(window) !== null
  );
}

function entryOverlaps(a: EvidenceWindow, b: EvidenceWindow, holdMs: number): boolean {
  return a.fromMs < entryEndMs(b, holdMs) - ENTRY_OVERLAP_TOLERANCE_MS && b.fromMs < entryEndMs(a, holdMs) - ENTRY_OVERLAP_TOLERANCE_MS;
}

function byTime(a: EvidenceWindow, b: EvidenceWindow): number {
  return a.fromMs - b.fromMs || a.labRunId - b.labRunId;
}

export function selectWindows(windows: readonly EvidenceWindow[], identity: EvidenceIdentity, rule: LearnerRule, holdMs: number): EvidenceWindow[] {
  const candidates = eligibleWindows(windows, identity, rule, holdMs).sort((a, b) => b.toMs - a.toMs || b.labRunId - a.labRunId);
  const picked: EvidenceWindow[] = [];
  for (const window of candidates) {
    if (picked.length >= rule.maxWindows) {
      break;
    }
    if (!picked.some((chosen) => entryOverlaps(chosen, window, holdMs))) {
      picked.push(window);
    }
  }
  return picked.sort(byTime);
}

export function windowsAfter(
  windows: readonly EvidenceWindow[],
  identity: EvidenceIdentity,
  rule: LearnerRule,
  holdMs: number,
  fromMs: number,
  accept: (window: EvidenceWindow) => boolean,
  limit: number
): EvidenceWindow[] {
  const candidates = eligibleWindows(windows, identity, rule, holdMs)
    .filter((window) => window.fromMs >= fromMs && accept(window))
    .sort(byTime);
  const picked: EvidenceWindow[] = [];
  for (const window of candidates) {
    if (picked.length >= limit) {
      break;
    }
    if (!picked.some((chosen) => entryOverlaps(chosen, window, holdMs))) {
      picked.push(window);
    }
  }
  return picked;
}

function counted(trades: readonly EvidenceTrade[], fromMs: number, cutoffMs: number): EvidenceTrade[] {
  return trades.filter((trade) => trade.openedAtMs >= fromMs && trade.openedAtMs < cutoffMs);
}

function sumOf(trades: readonly EvidenceTrade[], pick: (trade: EvidenceTrade) => number): number {
  let total = 0;
  for (const trade of trades) {
    total += pick(trade);
  }
  return total;
}

export function pairedResults(windows: readonly EvidenceWindow[], key: string, holdMs: number): WindowResult[] {
  const results: WindowResult[] = [];
  for (const window of windows) {
    const base = baselineTradesOf(window);
    const arm = armTradesOf(window, key);
    if (!base || !arm) {
      continue;
    }
    const cutoffMs = entryEndMs(window, holdMs);
    const v = counted(arm, window.fromMs, cutoffMs);
    const b = counted(base, window.fromMs, cutoffMs);
    const variant = sumOf(v, (trade) => trade.r);
    const baseline = sumOf(b, (trade) => trade.r);
    const variantSol = sumOf(v, (trade) => trade.sol);
    const baselineSol = sumOf(b, (trade) => trade.sol);
    results.push({
      labRunId: window.labRunId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      variantTrades: v.length,
      baselineTrades: b.length,
      variant,
      baseline,
      variantSol,
      baselineSol,
      gain: variant - baseline,
      gainSol: variantSol - baselineSol
    });
  }
  return results;
}

function withoutBestMean(values: readonly number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] ?? Number.NEGATIVE_INFINITY) > (values[best] ?? Number.NEGATIVE_INFINITY)) {
      best = i;
    }
  }
  return meanOf(values.filter((_, index) => index !== best));
}

export function gainStats(results: readonly WindowResult[], confidence: number, rule: LearnerRule, seedParts: ReadonlyArray<string | number>): GainStats {
  const gains = results.map((result) => result.gain);
  const own = results.map((result) => result.variant);
  const variantTrades = results.reduce((total, result) => total + result.variantTrades, 0);
  const baselineTrades = results.reduce((total, result) => total + result.baselineTrades, 0);
  const split = Math.floor(results.length / 2);
  const olderGains = gains.slice(0, split);
  const newerGains = gains.slice(split);
  const ids = results.map((result) => result.labRunId).join(",");
  return {
    windows: results.length,
    confidence,
    variantTrades,
    baselineTrades,
    variantPerTrade: variantTrades > 0 ? results.reduce((total, result) => total + result.variant, 0) / variantTrades : null,
    baselinePerTrade: baselineTrades > 0 ? results.reduce((total, result) => total + result.baseline, 0) / baselineTrades : null,
    gain: meanOf(gains),
    gainSol: meanOf(results.map((result) => result.gainSol)),
    gainLow: meanLowerBound(gains, confidence, seedFor(rule, ...seedParts, ids, "gain"), rule.bootstrapIterations),
    gainHigh: tUpperBound(gains, confidence),
    own: meanOf(own),
    ownSol: meanOf(results.map((result) => result.variantSol)),
    ownLow: meanLowerBound(own, OWN_CONFIDENCE, seedFor(rule, ...seedParts, ids, "own"), rule.bootstrapIterations),
    baselineMean: meanOf(results.map((result) => result.baseline)),
    positive: gains.filter((gain) => gain > 0).length,
    negative: gains.filter((gain) => gain < 0).length,
    withoutBest: withoutBestMean(gains),
    halves: { older: meanOf(olderGains), newer: meanOf(newerGains), olderWindows: olderGains.length, newerWindows: newerGains.length }
  };
}

export function betsText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

export function pctText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

export function levelText(confidence: number): string {
  return `${(confidence * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function gainFailures(stats: GainStats, marginPerWindow: number): string[] {
  const reasons: string[] = [];
  const level = levelText(stats.confidence);
  if (stats.gainLow === null || stats.gainLow <= 0) {
    reasons.push(`with ${level} confidence the gain is not above zero (${betsText(stats.gain)} bets per window, lower bound ${betsText(stats.gainLow)})`);
  }
  if (stats.ownLow === null || stats.ownLow <= marginPerWindow) {
    const need = marginPerWindow > 0 ? `, needs more than ${betsText(marginPerWindow)} to cover the replay's optimism` : "";
    reasons.push(`it does not clearly make money on its own (${betsText(stats.own)} bets per window, ${levelText(OWN_CONFIDENCE)} lower bound ${betsText(stats.ownLow)}${need})`);
  }
  if (stats.positive <= stats.negative) {
    reasons.push(`better in ${stats.positive} of ${stats.windows} windows and worse in ${stats.negative}, so not in most of them`);
  }
  if (stats.withoutBest === null || stats.withoutBest <= 0) {
    reasons.push(`without its single best window the gain is ${betsText(stats.withoutBest)} bets per window`);
  }
  const pooled = stats.gain ?? 0;
  const { older, newer } = stats.halves;
  if (older === null || newer === null || older <= 0 || newer <= 0 || older < pooled / 2 || newer < pooled / 2) {
    reasons.push(`the gain is not steady over time (older half ${betsText(older)}, newer half ${betsText(newer)} bets per window; each needs at least half of ${betsText(pooled)})`);
  }
  return reasons;
}

interface Context {
  input: LearnerInput;
  windows: EvidenceWindow[];
  confidence: number;
  marginPerTrade: number;
}

function emptyProgress(): { trades: number; windows: number } {
  return { trades: 0, windows: 0 };
}

function discoveryVerdict(context: Context, planned: PlannedArm): VariantVerdict {
  const { input } = context;
  const { rule, state } = input;
  const base: VariantVerdict = {
    name: planned.name,
    key: planned.key,
    description: planned.description,
    overrides: planned.overrides,
    ownerOnly: planned.ownerOnly,
    stats: null,
    progress: emptyProgress(),
    verdict: "not_run",
    reasons: []
  };
  const holdMs = Math.max(input.baselineHoldMs, planned.holdMs);
  const results = pairedResults(context.windows, planned.key, holdMs);
  let verdict: VariantVerdictKind;
  const reasons: string[] = [];
  let stats: GainStats | null = null;
  let progress = emptyProgress();
  if (results.length === 0) {
    verdict = "not_run";
    reasons.push("no replay window with the current settings ran this variant yet (it may be identical to the baseline or only change settings a replay does not use)");
  } else {
    stats = gainStats(results, context.confidence, rule, [input.identity.settingsHash, planned.key, "discovery"]);
    const fewest = Math.min(stats.variantTrades, stats.baselineTrades);
    progress = { trades: Math.min(1, fewest / rule.minTrades), windows: Math.min(1, stats.windows / rule.minWindows) };
    if (fewest < rule.minTrades) {
      reasons.push(`needs ${rule.minTrades} trades in both arms, has ${fewest}`);
    }
    if (stats.windows < rule.minWindows) {
      reasons.push(`needs ${rule.minWindows} non-overlapping windows, has ${stats.windows}`);
    }
    if (reasons.length > 0) {
      verdict = "collecting";
    } else if (stats.gainHigh !== null && stats.gainHigh < 0) {
      verdict = "worse";
      reasons.push(`with ${levelText(stats.confidence)} confidence it earns less than the baseline (${betsText(stats.gain)} bets per window, upper bound ${betsText(stats.gainHigh)})`);
    } else {
      reasons.push(...gainFailures(stats, context.marginPerTrade * (stats.variantTrades / Math.max(1, stats.windows))));
      verdict = reasons.length === 0 ? "candidate" : "not_better";
    }
  }
  if (planned.ownerOnly.length > 0) {
    reasons.unshift(
      `changes settings only the owner changes (${planned.ownerOnly.join(", ")})${verdict === "candidate" ? "; its replays would meet the discovery rule" : ""}`
    );
    verdict = "owner_only";
  } else if (state.confirming?.key === planned.key) {
    verdict = "confirming";
  } else if (state.tried.has(planned.key)) {
    reasons.unshift("was already applied, rejected or undone once for these settings");
    verdict = "tried";
  }
  return { ...base, stats, progress, verdict, reasons };
}

function matchedPaper(windows: readonly EvidenceWindow[], paper: PaperEvidence, holdMs: number) {
  const diffs: number[] = [];
  let replayOnly = 0;
  let paperOnly = 0;
  let replaySum = 0;
  let paperSum = 0;
  let replayCount = 0;
  let paperCount = 0;
  let covered = 0;
  for (const window of windows) {
    if (window.fromMs < paper.startedAtMs) {
      continue;
    }
    covered += 1;
    const cutoffMs = entryEndMs(window, holdMs);
    const replay = counted(baselineTradesOf(window) ?? [], window.fromMs, cutoffMs);
    const fills = counted(paper.trades, window.fromMs, cutoffMs);
    replayCount += replay.length;
    paperCount += fills.length;
    replaySum += sumOf(replay, (trade) => trade.r);
    paperSum += sumOf(fills, (trade) => trade.r);
    const replayByMint = new Map<string, EvidenceTrade>();
    for (const trade of [...replay].sort((a, b) => a.openedAtMs - b.openedAtMs)) {
      if (trade.mint !== null && !replayByMint.has(trade.mint)) {
        replayByMint.set(trade.mint, trade);
      }
    }
    const seen = new Set<string>();
    for (const trade of [...fills].sort((a, b) => a.openedAtMs - b.openedAtMs)) {
      const match = trade.mint === null || seen.has(trade.mint) ? undefined : replayByMint.get(trade.mint);
      if (match && trade.mint !== null) {
        seen.add(trade.mint);
        diffs.push(match.r - trade.r);
      } else {
        paperOnly += 1;
      }
    }
    replayOnly += replay.length - seen.size;
  }
  return { diffs, replayOnly, paperOnly, covered, replayCount, paperCount, replaySum, paperSum };
}

export function paperCheckOf(input: LearnerInput, windows: readonly EvidenceWindow[]): PaperCheck {
  const empty: PaperCheck = {
    status: "no_run",
    runId: null,
    windows: 0,
    matched: 0,
    replayOnly: 0,
    paperOnly: 0,
    coverage: null,
    bias: null,
    biasLow: null,
    biasHigh: null,
    paperPerTrade: null,
    replayPerTrade: null,
    marginPerTrade: 0,
    needed: Math.max(2, input.rule.minPaperTrades)
  };
  const paper = input.paper;
  if (!paper) {
    return empty;
  }
  if (!paper.configMatches) {
    return { ...empty, status: "other_settings", runId: paper.runId };
  }
  const match = matchedPaper(windows, paper, input.baselineHoldMs);
  const total = match.diffs.length + match.replayOnly + match.paperOnly;
  const bias = meanOf(match.diffs);
  const biasLow = tLowerBound(match.diffs, PAPER_CONFIDENCE);
  const biasHigh = tUpperBound(match.diffs, PAPER_CONFIDENCE);
  const check: PaperCheck = {
    status: "consistent",
    runId: paper.runId,
    windows: match.covered,
    matched: match.diffs.length,
    replayOnly: match.replayOnly,
    paperOnly: match.paperOnly,
    coverage: total > 0 ? match.diffs.length / total : null,
    bias,
    biasLow,
    biasHigh,
    paperPerTrade: match.paperCount > 0 ? match.paperSum / match.paperCount : null,
    replayPerTrade: match.replayCount > 0 ? match.replaySum / match.replayCount : null,
    marginPerTrade: Math.max(0, biasHigh ?? 0),
    needed: empty.needed
  };
  if (match.diffs.length < check.needed) {
    return { ...check, status: "too_few" };
  }
  if ((check.coverage ?? 0) < MIN_PAPER_MATCH) {
    return { ...check, status: "unmatched" };
  }
  if (biasLow !== null && biasLow > PAPER_BIAS_TOLERANCE) {
    return { ...check, status: "replay_optimistic" };
  }
  return check;
}

export function paperProblem(paper: PaperCheck): string | null {
  switch (paper.status) {
    case "consistent":
      return null;
    case "no_run":
      return "no paper run is open, so the replay cannot be checked against real paper fills";
    case "other_settings":
      return "the open paper run started with other settings, so its fills cannot check this replay";
    case "too_few":
      return `only ${paper.matched} paper trades match a replayed trade (needs ${paper.needed})`;
    case "unmatched":
      return `the paper trader and the replay took different coins (${Math.round((paper.coverage ?? 0) * 100)}% matched, needs ${Math.round(MIN_PAPER_MATCH * 100)}%)`;
    case "replay_optimistic":
      return `the replay earns ${pctText(paper.bias)} per trade more than the paper fills of the same coins (${levelText(PAPER_CONFIDENCE)} lower bound ${pctText(paper.biasLow)})`;
    default:
      return "the paper check failed";
  }
}

function confirmWindowsFor(rule: LearnerRule, stats: GainStats): number {
  const perWindow = Math.min(stats.variantTrades, stats.baselineTrades) / Math.max(1, stats.windows);
  const needed = perWindow > 0 ? Math.ceil((CONFIRM_TRADE_MARGIN * rule.minTrades) / perWindow) : rule.maxWindows;
  return Math.min(rule.maxWindows, Math.max(rule.confirmWindows, needed));
}

function hasArm(key: string): (window: EvidenceWindow) => boolean {
  return (window) => armTradesOf(window, key) !== null;
}

function confirmationOf(input: LearnerInput, candidate: OpenCandidate, paper: PaperCheck): { report: ConfirmationReport; decision: LearnerDecision } {
  const { rule } = input;
  const planned = input.variants.find((variant) => variant.key === candidate.key);
  const holdMs = Math.max(input.baselineHoldMs, planned?.holdMs ?? input.baselineHoldMs);
  const windows = windowsAfter(input.windows, input.identity, rule, input.baselineHoldMs, candidate.confirmFromMs, hasArm(candidate.key), candidate.confirmWindows);
  const results = pairedResults(windows, candidate.key, holdMs);
  const confidence = confirmConfidenceOf(rule.familyConfidence, candidate.index);
  const report: ConfirmationReport = {
    promotionId: candidate.promotionId,
    name: candidate.name,
    key: candidate.key,
    index: candidate.index,
    confidence,
    fromMs: candidate.confirmFromMs,
    needed: candidate.confirmWindows,
    collected: results.length,
    variantTrades: results.reduce((total, result) => total + result.variantTrades, 0),
    baselineTrades: results.reduce((total, result) => total + result.baselineTrades, 0),
    complete: results.length >= candidate.confirmWindows,
    stats: null,
    reasons: []
  };
  if (!planned && input.canPromote) {
    return {
      report,
      decision: { kind: "withdraw", promotionId: candidate.promotionId, name: candidate.name, reason: `${candidate.name} is no longer in the lab's variant list` }
    };
  }
  if (!report.complete) {
    return {
      report,
      decision: {
        kind: "hold",
        name: candidate.name,
        reason: `${candidate.name} is being confirmed on fresh data: ${results.length} of ${candidate.confirmWindows} windows so far, tested once at the end`
      }
    };
  }
  const stats = gainStats(results.slice(0, candidate.confirmWindows), confidence, rule, [input.identity.settingsHash, candidate.key, "confirm", candidate.index]);
  const reasons: string[] = [];
  if (Math.min(stats.variantTrades, stats.baselineTrades) < rule.minTrades) {
    reasons.push(`only ${Math.min(stats.variantTrades, stats.baselineTrades)} trades in the confirmation windows (needs ${rule.minTrades} in both arms)`);
  }
  reasons.push(...gainFailures(stats, paper.marginPerTrade * (stats.variantTrades / Math.max(1, stats.windows))));
  const problem = paperProblem(paper);
  if (problem) {
    reasons.push(problem);
  }
  const confirmed: ConfirmationReport = { ...report, stats, reasons };
  if (reasons.length > 0) {
    return {
      report: confirmed,
      decision: { kind: "reject", promotionId: candidate.promotionId, name: candidate.name, reason: `${candidate.name} did not confirm on fresh data: ${reasons.join("; ")}` }
    };
  }
  return {
    report: confirmed,
    decision: {
      kind: "confirm",
      promotionId: candidate.promotionId,
      name: candidate.name,
      reason: `${candidate.name} confirmed on ${stats.windows} fresh windows: ${betsText(stats.gain)} bets per window over the baseline (lower bound ${betsText(stats.gainLow)} at ${levelText(confidence)}), ${stats.variantTrades} trades`
    }
  };
}

function probationOf(input: LearnerInput, probation: ProbationState): { report: ProbationReport; decision: LearnerDecision } {
  const { rule } = input;
  const planned = input.variants.find((variant) => variant.key === probation.undoKey);
  const holdMs = Math.max(input.baselineHoldMs, planned?.holdMs ?? input.baselineHoldMs);
  const windows = windowsAfter(input.windows, input.identity, rule, input.baselineHoldMs, probation.fromMs, hasArm(probation.undoKey), probation.windows);
  const results = pairedResults(windows, probation.undoKey, holdMs);
  const report: ProbationReport = {
    promotionId: probation.promotionId,
    name: probation.name,
    undoName: probation.undoName,
    fromMs: probation.fromMs,
    needed: probation.windows,
    collected: results.length,
    complete: results.length >= probation.windows,
    stats: null,
    result: null
  };
  if (!report.complete) {
    const available = windowsAfter(input.windows, input.identity, rule, input.baselineHoldMs, probation.fromMs, () => true, probation.windows * 2).length;
    if (available >= probation.windows * 2) {
      return {
        report: { ...report, result: "kept" },
        decision: {
          kind: "keep",
          promotionId: probation.promotionId,
          name: probation.name,
          reason: `the old settings could not be replayed often enough after ${probation.name} was applied, so the change stays`
        }
      };
    }
    return {
      report,
      decision: {
        kind: "hold",
        name: probation.name,
        reason: `${probation.name} is on probation: ${results.length} of ${probation.windows} fresh windows replayed against the old settings`
      }
    };
  }
  const stats = gainStats(results.slice(0, probation.windows), OWN_CONFIDENCE, rule, [input.identity.settingsHash, probation.undoKey, "probation"]);
  if (stats.gain === null || stats.gain >= 0) {
    return {
      report: { ...report, stats, result: "revert" },
      decision: {
        kind: "revert",
        promotionId: probation.promotionId,
        name: probation.undoName,
        reason: `on ${stats.windows} fresh windows after ${probation.name} was applied the old settings did as well or better (${betsText(stats.gain)} bets per window), so the change is undone`
      }
    };
  }
  return {
    report: { ...report, stats, result: "kept" },
    decision: {
      kind: "keep",
      promotionId: probation.promotionId,
      name: probation.name,
      reason: `${probation.name} kept beating the old settings on ${stats.windows} fresh windows (by ${betsText(-stats.gain)} bets per window), so it stays`
    }
  };
}

function discoveryDecision(input: LearnerInput, context: Context, variants: readonly VariantVerdict[], paper: PaperCheck, latestToMs: number): LearnerDecision {
  const ready = variants
    .filter((variant) => variant.verdict === "candidate" && variant.stats !== null)
    .sort((a, b) => (b.stats?.gainLow ?? 0) - (a.stats?.gainLow ?? 0) || a.name.localeCompare(b.name));
  const best = ready[0];
  if (!best || !best.stats) {
    const collecting = variants.filter((variant) => variant.verdict === "collecting").length;
    return {
      kind: "hold",
      name: null,
      reason: collecting > 0 ? `no variant meets the discovery rule yet; ${collecting} still collecting evidence` : "no variant meets the discovery rule"
    };
  }
  const problem = paperProblem(paper);
  if (problem) {
    return { kind: "hold", name: best.name, reason: `${best.name} looks better in the replays, but ${problem}, so nothing is tested yet` };
  }
  if (!input.canPromote) {
    return { kind: "hold", name: best.name, reason: `${best.name} looks better, but this lab run is report-only, so only the scheduled lab run nominates it` };
  }
  const index = input.state.nominations + 1;
  const confidence = confirmConfidenceOf(input.rule.familyConfidence, index);
  const confirmWindows = confirmWindowsFor(input.rule, best.stats);
  return {
    kind: "nominate",
    name: best.name,
    key: best.key,
    overrides: best.overrides,
    confirmFromMs: latestToMs,
    confirmWindows,
    index,
    confidence,
    reason: `${best.name} looks better on ${best.stats.windows} past windows (${betsText(best.stats.gain)} bets per window, lower bound ${betsText(best.stats.gainLow)} at ${levelText(context.confidence)}); it now has to confirm on ${confirmWindows} fresh windows, tested once at ${levelText(confidence)}`
  };
}

export function promotableKeysWithEvidence(windows: readonly EvidenceWindow[], tried: ReadonlySet<string>): string[] {
  const keys = new Set<string>();
  for (const window of windows) {
    for (const arm of window.arms) {
      if (!arm.isBaseline && arm.promotable && arm.trades !== null && !arm.name.startsWith(UNDO_PREFIX) && !tried.has(arm.key)) {
        keys.add(arm.key);
      }
    }
  }
  return [...keys].sort();
}

function baselineSummary(input: LearnerInput, windows: readonly EvidenceWindow[]): BaselineSummary {
  const sums: number[] = [];
  const sols: number[] = [];
  let trades = 0;
  for (const window of windows) {
    const base = counted(baselineTradesOf(window) ?? [], window.fromMs, entryEndMs(window, input.baselineHoldMs));
    trades += base.length;
    sums.push(sumOf(base, (trade) => trade.r));
    sols.push(sumOf(base, (trade) => trade.sol));
  }
  const total = sums.reduce((acc, value) => acc + value, 0);
  return {
    trades,
    windows: windows.length,
    perTrade: trades > 0 ? total / trades : null,
    perWindow: meanOf(sums),
    perWindowSol: meanOf(sols),
    perWindowLow: tLowerBound(sums, OWN_CONFIDENCE),
    perWindowHigh: tUpperBound(sums, OWN_CONFIDENCE)
  };
}

function pendingDecision(input: LearnerInput, pending: PendingPromotion): LearnerDecision {
  const how = input.enabled ? "waits for the paper trader to apply it" : "waits, and lab.autoLearn.enabled is off, so nothing changes until it is turned on";
  return { kind: "hold", name: pending.name, reason: `${pending.kind === "revert" ? "undo " : ""}promotion #${pending.promotionId} (${pending.name}) ${how}` };
}

export function evaluateLearning(input: LearnerInput): LearnerReport {
  const { rule, state } = input;
  const windows = selectWindows(input.windows, input.identity, rule, input.baselineHoldMs);
  const comparisons = Math.max(1, promotableKeysWithEvidence(windows, state.tried).length);
  const confidence = discoveryConfidenceOf(rule.familyConfidence, comparisons);
  const paper = paperCheckOf(input, windows);
  const context: Context = { input, windows, confidence, marginPerTrade: paper.marginPerTrade };
  const variants = input.variants.filter((planned) => !planned.name.startsWith(UNDO_PREFIX)).map((planned) => discoveryVerdict(context, planned));
  const latestToMs = input.windows.reduce((latest, window) => Math.max(latest, window.toMs), 0);
  let confirmation: ConfirmationReport | null = null;
  let probation: ProbationReport | null = null;
  let decision: LearnerDecision;
  if (state.pending) {
    decision = pendingDecision(input, state.pending);
  } else if (state.probation) {
    const outcome = probationOf(input, state.probation);
    probation = outcome.report;
    decision = outcome.decision;
  } else if (state.confirming) {
    const outcome = confirmationOf(input, state.confirming, paper);
    confirmation = outcome.report;
    decision = outcome.decision;
  } else {
    decision = discoveryDecision(input, context, variants, paper, latestToMs);
  }
  return {
    version: LEARNER_REPORT_VERSION,
    evaluatedAtMs: input.nowMs,
    labRunId: input.labRunId,
    identity: input.identity,
    enabled: input.enabled,
    canPromote: input.canPromote,
    rule: {
      ...rule,
      alpha: alphaOf(rule),
      comparisons,
      discoveryConfidence: confidence,
      nextConfirmConfidence: confirmConfidenceOf(rule.familyConfidence, state.nominations + 1)
    },
    windows: windows.map((window) => ({ labRunId: window.labRunId, fromMs: window.fromMs, toMs: window.toMs })),
    baseline: baselineSummary(input, windows),
    variants: variants.map((variant) => (state.pending && variant.name === state.pending.name && state.pending.kind === "variant" ? { ...variant, verdict: "pending" as const } : variant)),
    paper,
    confirmation,
    probation,
    decision,
    weights: evaluateWeights(input.scorer.runs, input.scorer.activeVersion, input.scorer.rule),
    promotion: null
  };
}

function scorerKey(label: string, checkpointSec: number): string {
  return `${label}@${checkpointSec}`;
}

function gainOf(entry: ScorerEntryEvidence): number | null {
  return entry.validationAuc === null || entry.baselineAuc === null ? null : entry.validationAuc - entry.baselineAuc;
}

function hasWindow(entry: ScorerEntryEvidence): entry is ScorerEntryEvidence & { validationFromMs: number; validationToMs: number } {
  return entry.validationFromMs !== null && entry.validationToMs !== null && entry.validationToMs >= entry.validationFromMs;
}

function runCheck(run: ScorerRunEvidence, entry: ScorerEntryEvidence, rule: WeightsRule, activeVersion: string | null): WeightsRunCheck {
  const gain = gainOf(entry);
  const passes =
    gain !== null &&
    gain >= rule.minAucGain &&
    (entry.validationRows ?? 0) >= rule.minValidationRows &&
    entry.weightsVersion !== null &&
    run.weightsBase === activeVersion;
  return { labRunId: run.labRunId, gain, validationRows: entry.validationRows, weightsVersion: entry.weightsVersion, passes };
}

function auc(value: number | null): string {
  return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function failReasons(check: WeightsRunCheck, run: ScorerRunEvidence, rule: WeightsRule, activeVersion: string | null, which: string): string[] {
  const reasons: string[] = [];
  if (check.gain === null || check.gain < rule.minAucGain) {
    reasons.push(`${which} run #${check.labRunId} gains ${auc(check.gain)} AUC (needs +${rule.minAucGain.toFixed(3)})`);
  }
  if ((check.validationRows ?? 0) < rule.minValidationRows) {
    reasons.push(`${which} run #${check.labRunId} has ${check.validationRows ?? 0} validation rows (needs ${rule.minValidationRows})`);
  }
  if (run.weightsBase !== activeVersion) {
    reasons.push(`${which} run #${check.labRunId} compared against ${run.weightsBase ?? "unknown"} weights, not the active ${activeVersion ?? "unknown"}`);
  }
  return reasons;
}

export function evaluateWeights(runs: readonly ScorerRunEvidence[], activeVersion: string | null, rule: WeightsRule): WeightsReport {
  const ordered = [...runs].sort((a, b) => b.startedAtMs - a.startedAtMs || b.labRunId - a.labRunId);
  const latest = ordered[0];
  const candidates: WeightsCandidate[] = [];
  for (const entry of latest?.entries ?? []) {
    if (!latest || entry.weightsVersion === null || !hasWindow(entry)) {
      continue;
    }
    const key = scorerKey(entry.label, entry.checkpointSec);
    const latestCheck = runCheck(latest, entry, rule, activeVersion);
    let previousRun: ScorerRunEvidence | null = null;
    let previousEntry: ScorerEntryEvidence | null = null;
    for (const run of ordered.slice(1)) {
      const candidate = run.entries.find((item) => scorerKey(item.label, item.checkpointSec) === key && item.weightsVersion !== null && hasWindow(item));
      if (candidate && hasWindow(candidate) && candidate.validationToMs <= entry.validationFromMs) {
        previousRun = run;
        previousEntry = candidate;
        break;
      }
    }
    const previousCheck = previousRun && previousEntry ? runCheck(previousRun, previousEntry, rule, activeVersion) : null;
    const reasons = failReasons(latestCheck, latest, rule, activeVersion, "latest");
    let verdict: WeightsVerdictKind;
    if (latestCheck.gain !== null && latestCheck.gain < rule.minAucGain) {
      verdict = "not_better";
    } else if (!latestCheck.passes) {
      verdict = "collecting";
    } else if (!previousCheck || !previousRun) {
      verdict = "collecting";
      reasons.push("waiting for an earlier lab run with a non-overlapping validation window");
    } else if (!previousCheck.passes) {
      verdict = "collecting";
      reasons.push(...failReasons(previousCheck, previousRun, rule, activeVersion, "previous"));
    } else {
      verdict = "ready";
    }
    candidates.push({ label: entry.label, checkpointSec: entry.checkpointSec, latest: latestCheck, previous: previousCheck, verdict, reasons });
  }
  const best =
    candidates
      .filter((candidate) => candidate.verdict === "ready")
      .sort((a, b) => Math.min(b.latest.gain ?? 0, b.previous?.gain ?? 0) - Math.min(a.latest.gain ?? 0, a.previous?.gain ?? 0))[0] ?? null;
  return { mode: "report_only", activeVersion, rule, candidates, best };
}
