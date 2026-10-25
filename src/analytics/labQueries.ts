import { toNullableNumber, toNumber, type Db } from "../db/pool.js";
import { overridePaths } from "../lab/identity.js";
import { formatInterval, formatSol } from "./format.js";
import type { Narrative } from "./narrative.js";

export const LAB_LABEL_PREFIX = "lab:";
export const LAB_RUN_IDS_SQL = `SELECT id FROM strategy_runs WHERE label LIKE '${LAB_LABEL_PREFIX}%'`;
export const DEFAULT_LAB_HISTORY = 20;
export const MIN_LAB_TRADES = 30;
const MAX_FEATURES = 15;
const UNDEFINED_TABLE = "42P01";
const UNDEFINED_COLUMN = "42703";
export const LEARNING_PROMOTIONS = 6;
const MAX_REASONS = 6;
const MAX_CHANGE_TEXT = 140;

type DbRecord = Record<string, unknown>;

export type LabRunStatus = "running" | "done" | "failed";

export interface LabRunInfo {
  id: number;
  startedAtMs: number;
  finishedAtMs: number | null;
  status: LabRunStatus;
  error: string | null;
  dataFromMs: number | null;
  dataToMs: number | null;
  notes: Record<string, unknown>;
}

export interface LabExitReason {
  reason: string;
  n: number;
  pnlSol: number | null;
}

export interface LabVariantSummary {
  trades: number;
  wins: number;
  winRate: number | null;
  expectancySol: number | null;
  ciLowSol: number | null;
  ciHighSol: number | null;
  totalPnlSol: number | null;
  maxDrawdownSol: number | null;
  avgHoldSec: number | null;
  verdict: string | null;
  exitReasons: LabExitReason[];
}

export interface LabVariantRow {
  id: number;
  name: string;
  description: string;
  isBaseline: boolean;
  overrides: unknown;
  strategyRunId: number | null;
  summary: LabVariantSummary | null;
  error: string | null;
  vsBaselineSol: number | null;
  sameTradesAsBaseline: boolean;
}

export interface LabFeature {
  name: string;
  auc: number | null;
  direction: string | null;
  coverage: number | null;
  weight: number | null;
}

export interface LabCalibrationRow {
  bucket: string;
  n: number;
  positiveRate: number | null;
}

export interface LabScorerEntry {
  label: string;
  checkpointSec: number | null;
  rows: number;
  positives: number;
  validationRows: number | null;
  validationAuc: number | null;
  baselineAuc: number | null;
  features: LabFeature[];
  calibration: LabCalibrationRow[];
  weightsVersion: string | null;
  skipReason: string | null;
}

export interface LabBaselinePoint {
  labRunId: number;
  startedAtMs: number;
  dataFromMs: number | null;
  dataToMs: number | null;
  trades: number;
  expectancySol: number | null;
  ciLowSol: number | null;
  ciHighSol: number | null;
  totalPnlSol: number | null;
}

export interface LearningStats {
  windows: number;
  confidence: number | null;
  variantTrades: number;
  baselineTrades: number;
  variantPerTrade: number | null;
  baselinePerTrade: number | null;
  gain: number | null;
  gainSol: number | null;
  gainLow: number | null;
  gainHigh: number | null;
  own: number | null;
  ownLow: number | null;
  positive: number;
  negative: number;
  withoutBest: number | null;
  older: number | null;
  newer: number | null;
}

export interface LearningVariant {
  name: string;
  description: string;
  verdict: string;
  reasons: string[];
  changes: string[];
  stats: LearningStats | null;
  tradeProgress: number;
  windowProgress: number;
}

export interface LearningBaseline {
  trades: number;
  windows: number;
  perTrade: number | null;
  perWindow: number | null;
  perWindowSol: number | null;
  perWindowLow: number | null;
  perWindowHigh: number | null;
}

export interface LearningPaper {
  status: string;
  windows: number;
  matched: number;
  replayOnly: number;
  paperOnly: number;
  needed: number;
  coverage: number | null;
  bias: number | null;
  biasLow: number | null;
  biasHigh: number | null;
  paperPerTrade: number | null;
  replayPerTrade: number | null;
}

export interface LearningConfirmation {
  promotionId: number;
  name: string;
  index: number;
  confidence: number | null;
  fromMs: number | null;
  needed: number;
  collected: number;
  variantTrades: number;
  baselineTrades: number;
  complete: boolean;
  stats: LearningStats | null;
  reasons: string[];
}

export interface LearningProbation {
  promotionId: number;
  name: string;
  undoName: string;
  fromMs: number | null;
  needed: number;
  collected: number;
  complete: boolean;
  stats: LearningStats | null;
  result: string | null;
}

export interface LearningWeights {
  label: string;
  checkpointSec: number | null;
  verdict: string;
  latestRunId: number | null;
  latestGain: number | null;
  latestRows: number | null;
  previousRunId: number | null;
  previousGain: number | null;
  reasons: string[];
}

export interface LearningReport {
  labRunId: number;
  evaluatedAtMs: number | null;
  settings: string;
  engine: string | null;
  enabled: boolean;
  canPromote: boolean;
  windowHours: number | null;
  minTrades: number;
  minWindows: number;
  maxWindows: number;
  confirmWindows: number;
  comparisons: number;
  familyConfidence: number | null;
  discoveryConfidence: number | null;
  nextConfirmConfidence: number | null;
  windows: number;
  windowsFromMs: number | null;
  windowsToMs: number | null;
  baseline: LearningBaseline;
  variants: LearningVariant[];
  paper: LearningPaper;
  confirmation: LearningConfirmation | null;
  probation: LearningProbation | null;
  decision: { kind: string; name: string | null; reason: string };
  weights: LearningWeights[];
  weightsActive: string | null;
  weightsMinGain: number | null;
  weightsMinRows: number | null;
  promotion: { id: number; status: string; name: string } | null;
}

export interface LearningPromotion {
  id: number;
  kind: string;
  name: string;
  status: string;
  note: string | null;
  changes: string[];
  createdAtMs: number | null;
  updatedAtMs: number | null;
  appliedAtMs: number | null;
  labRunId: number | null;
  confirmIndex: number | null;
  confirmWindows: number | null;
  windows: number | null;
  trades: number | null;
  gain: number | null;
  gainSol: number | null;
  gainLow: number | null;
  probationResult: string | null;
  endedRunId: number | null;
}

export interface LearnedInEffect {
  autoLearn: boolean;
  promotionId: number | null;
  name: string | null;
  appliedAtMs: number | null;
  changes: string[];
  problem: string | null;
}

export interface LabLearning {
  available: boolean;
  report: LearningReport | null;
  error: string | null;
  promotions: LearningPromotion[];
  inEffect: LearnedInEffect | null;
}

export interface LabOverview {
  available: boolean;
  runs: number;
  latest: LabRunInfo | null;
  run: LabRunInfo | null;
  variants: LabVariantRow[];
  scorer: LabScorerEntry[];
  history: LabBaselinePoint[];
  takeaway: Narrative | null;
  learning: LabLearning;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number {
  const parsed = finite(value);
  return parsed === null ? 0 : Math.max(0, Math.round(parsed));
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function statusOf(value: unknown): LabRunStatus {
  return value === "running" || value === "failed" ? value : "done";
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function runFromRecord(row: DbRecord): LabRunInfo {
  return {
    id: toNumber(row.id),
    startedAtMs: msOf(row.started_at) ?? 0,
    finishedAtMs: msOf(row.finished_at),
    status: statusOf(row.status),
    error: textOrNull(row.error),
    dataFromMs: msOf(row.data_from),
    dataToMs: msOf(row.data_to),
    notes: isRecord(row.notes) ? row.notes : {}
  };
}

export function parseVariantSummary(value: unknown): LabVariantSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    trades: count(value.trades),
    wins: count(value.wins),
    winRate: finite(value.winRate),
    expectancySol: finite(value.expectancySol),
    ciLowSol: finite(value.ciLowSol),
    ciHighSol: finite(value.ciHighSol),
    totalPnlSol: finite(value.totalPnlSol),
    maxDrawdownSol: finite(value.maxDrawdownSol),
    avgHoldSec: finite(value.avgHoldSec),
    verdict: textOrNull(value.verdict),
    exitReasons: arrayOf(value.exitReasons)
      .filter(isRecord)
      .map((item) => ({ reason: textOrNull(item.reason) ?? "unknown", n: count(item.n), pnlSol: finite(item.pnlSol) }))
  };
}

export function parseScorerEntries(value: unknown): LabScorerEntry[] {
  return arrayOf(value)
    .filter(isRecord)
    .map((entry) => ({
      label: textOrNull(entry.label) ?? "unknown",
      checkpointSec: finite(entry.checkpointSec),
      rows: count(entry.rows),
      positives: count(entry.positives),
      validationRows: finite(entry.validationRows),
      validationAuc: finite(entry.validationAuc),
      baselineAuc: finite(entry.baselineAuc),
      features: arrayOf(entry.features)
        .filter(isRecord)
        .slice(0, MAX_FEATURES)
        .map((feature) => ({
          name: textOrNull(feature.name) ?? "unknown",
          auc: finite(feature.auc),
          direction: textOrNull(feature.direction),
          coverage: finite(feature.coverage),
          weight: finite(feature.weight)
        })),
      calibration: arrayOf(entry.calibration)
        .filter(isRecord)
        .map((row) => ({ bucket: textOrNull(row.bucket) ?? String(row.bucket ?? ""), n: count(row.n), positiveRate: finite(row.positiveRate) })),
      weightsVersion: textOrNull(entry.weightsVersion),
      skipReason: textOrNull(entry.reason)
    }));
}

function expectancyOf(row: LabVariantRow): number | null {
  return row.summary && row.summary.trades > 0 ? row.summary.expectancySol : null;
}

export function sortVariants(rows: readonly LabVariantRow[]): LabVariantRow[] {
  return [...rows].sort((a, b) => {
    const ea = expectancyOf(a);
    const eb = expectancyOf(b);
    if (ea === null || eb === null) {
      if (ea === eb) {
        return a.isBaseline === b.isBaseline ? a.id - b.id : a.isBaseline ? -1 : 1;
      }
      return ea === null ? 1 : -1;
    }
    return eb - ea || a.id - b.id;
  });
}

function variantLabel(row: LabVariantRow): string {
  return row.name.split(/[_-]+/).join(" ");
}

function capitalized(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function rangeOf(summary: LabVariantSummary): string {
  return summary.ciLowSol !== null && summary.ciHighSol !== null ? formatInterval({ low: summary.ciLowSol, high: summary.ciHighSol }) : "n/a";
}

function baselineSentence(baseline: LabVariantRow | null): string {
  if (!baseline?.summary) {
    return "No baseline ran in this lab run.";
  }
  const summary = baseline.summary;
  if (summary.trades === 0) {
    return "The baseline made no trades in this window.";
  }
  return `Baseline ${formatSol(summary.expectancySol)} SOL per trade over ${summary.trades} trades (95% range ${rangeOf(summary)}).`;
}

const CAVEAT = "Backtests flatter results; paper trade a winner before changing the live strategy.";

export function labTakeaway(rows: readonly LabVariantRow[]): Narrative | null {
  if (rows.length === 0) {
    return null;
  }
  const baseline = rows.find((row) => row.isBaseline) ?? null;
  const traded = sortVariants(rows).filter((row) => expectancyOf(row) !== null);
  if (traded.length === 0) {
    return {
      tone: "neutral",
      headline: "No strategy traded in this window",
      detail: "Every variant made zero trades. A longer data window or looser entry filters are needed before the lab can compare anything."
    };
  }
  const baseExpectancy = baseline ? expectancyOf(baseline) : null;
  const challengers = traded.filter((row) => !row.isBaseline);
  const best = challengers[0] ?? null;
  if (!best || !best.summary) {
    return { tone: "neutral", headline: "Only the baseline traded", detail: `${baselineSentence(baseline)} ${CAVEAT}` };
  }
  const bestExpectancy = expectancyOf(best) ?? 0;
  if (baseExpectancy === null || !baseline?.summary) {
    return {
      tone: bestExpectancy > 0 ? "warn" : "bad",
      headline: `${capitalized(variantLabel(best))} leads with ${formatSol(bestExpectancy)} SOL per trade over ${best.summary.trades} trades`,
      detail: `${baselineSentence(baseline)} ${CAVEAT}`
    };
  }
  const diff = bestExpectancy - baseExpectancy;
  if (diff <= 0) {
    return {
      tone: "neutral",
      headline: `The baseline is still the best of ${traded.length} strategies`,
      detail: `Closest challenger: ${variantLabel(best)} at ${formatSol(diff)} SOL per trade against the baseline. ${baselineSentence(baseline)}`
    };
  }
  const enough = best.summary.trades >= MIN_LAB_TRADES;
  const separated = best.summary.ciLowSol !== null && baseline.summary.ciHighSol !== null && best.summary.ciLowSol > baseline.summary.ciHighSol;
  const significant = enough && separated;
  const qualifier = !enough ? ", too few trades to tell" : significant ? "" : ", not yet significant";
  return {
    tone: significant ? "good" : "warn",
    headline: `${capitalized(variantLabel(best))} beat the baseline by ${formatSol(diff)} SOL per trade over ${best.summary.trades} trades${qualifier}`,
    detail:
      `${capitalized(variantLabel(best))} made ${formatSol(bestExpectancy)} SOL per trade (95% range ${rangeOf(best.summary)}). ${baselineSentence(baseline)} ` +
      (significant ? CAVEAT : `It counts once its range sits above the baseline's with ${MIN_LAB_TRADES}+ trades. ${CAVEAT}`)
  };
}

function variantFromRecord(row: DbRecord): LabVariantRow {
  const runId = row.strategy_run_id;
  return {
    id: toNumber(row.id),
    name: textOrNull(row.name) ?? "unnamed",
    description: typeof row.description === "string" ? row.description : "",
    isBaseline: row.is_baseline === true,
    overrides: row.overrides ?? {},
    strategyRunId: runId === null || runId === undefined ? null : toNumber(runId),
    summary: parseVariantSummary(row.summary),
    error: textOrNull(row.error),
    vsBaselineSol: null,
    sameTradesAsBaseline: false
  };
}

function withBaselineDelta(rows: readonly LabVariantRow[]): LabVariantRow[] {
  const baseline = rows.find((row) => row.isBaseline);
  const base = baseline ? expectancyOf(baseline) : null;
  return rows.map((row) => {
    const own = expectancyOf(row);
    return { ...row, vsBaselineSol: base === null || own === null || row.isBaseline ? null : own - base };
  });
}

export function withRunNotes(rows: readonly LabVariantRow[], notes: Record<string, unknown>): LabVariantRow[] {
  const byName = isRecord(notes.variants) ? notes.variants : {};
  return rows.map((row) => {
    const note = byName[row.name];
    return { ...row, sameTradesAsBaseline: !row.isBaseline && isRecord(note) && note.sameTradesAsBaseline === true };
  });
}

const RUN_COLUMNS = "id, started_at, finished_at, status, error, data_from, data_to, notes";

async function latestRun(db: Db, doneOnly: boolean): Promise<LabRunInfo | null> {
  const result = await db.query<DbRecord>(
    `SELECT ${RUN_COLUMNS} FROM lab_runs WHERE ($1::boolean IS FALSE OR status = 'done') ORDER BY started_at DESC, id DESC LIMIT 1`,
    [doneOnly]
  );
  const row = result.rows[0];
  return row ? runFromRecord(row) : null;
}

export async function loadLabVariants(db: Db, labRunId: number): Promise<LabVariantRow[]> {
  const result = await db.query<DbRecord>(
    `SELECT id, name, description, is_baseline, overrides, strategy_run_id, summary, error
     FROM lab_variants WHERE lab_run_id = $1 ORDER BY id`,
    [labRunId]
  );
  return sortVariants(withBaselineDelta(result.rows.map(variantFromRecord)));
}

export async function loadLabScorer(db: Db, labRunId: number): Promise<LabScorerEntry[]> {
  const result = await db.query<DbRecord>("SELECT scorer FROM lab_runs WHERE id = $1", [labRunId]);
  return parseScorerEntries(result.rows[0]?.scorer);
}

export async function loadBaselineHistory(db: Db, limit: number = DEFAULT_LAB_HISTORY): Promise<LabBaselinePoint[]> {
  const result = await db.query<DbRecord>(
    `SELECT r.id, r.started_at, r.data_from, r.data_to, v.summary
     FROM lab_runs r
     JOIN LATERAL (
       SELECT summary FROM lab_variants WHERE lab_run_id = r.id AND is_baseline ORDER BY id LIMIT 1
     ) v ON TRUE
     WHERE r.status = 'done'
     ORDER BY r.started_at DESC, r.id DESC
     LIMIT $1`,
    [Math.max(1, Math.min(200, Math.floor(limit)))]
  );
  return result.rows
    .map((row) => {
      const summary = parseVariantSummary(row.summary);
      return {
        labRunId: toNumber(row.id),
        startedAtMs: msOf(row.started_at) ?? 0,
        dataFromMs: msOf(row.data_from),
        dataToMs: msOf(row.data_to),
        trades: summary?.trades ?? 0,
        expectancySol: summary && summary.trades > 0 ? summary.expectancySol : null,
        ciLowSol: summary?.ciLowSol ?? null,
        ciHighSol: summary?.ciHighSol ?? null,
        totalPnlSol: summary?.totalPnlSol ?? null
      };
    })
    .reverse();
}

export function emptyLearning(available: boolean): LabLearning {
  return { available, report: null, error: null, promotions: [], inEffect: null };
}

export function emptyLabOverview(available: boolean): LabOverview {
  return { available, runs: 0, latest: null, run: null, variants: [], scorer: [], history: [], takeaway: null, learning: emptyLearning(available) };
}

function isUndefinedTable(error: unknown): boolean {
  return isRecord(error) && error.code === UNDEFINED_TABLE;
}

function isMissingSchema(error: unknown): boolean {
  return isRecord(error) && (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN);
}

function textList(value: unknown, limit = MAX_REASONS): string[] {
  return arrayOf(value)
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, limit);
}

function valueText(value: unknown): string {
  const raw = JSON.stringify(value) ?? "null";
  return raw.length > MAX_CHANGE_TEXT ? `${raw.slice(0, MAX_CHANGE_TEXT - 1)}…` : raw;
}

function valueAt(overrides: Record<string, unknown>, setting: string): unknown {
  let current: unknown = overrides;
  for (const part of setting.split(".")) {
    current = isRecord(current) ? current[part] : undefined;
  }
  return current;
}

export function changeList(overrides: unknown): string[] {
  if (!isRecord(overrides)) {
    return [];
  }
  return overridePaths(overrides)
    .slice(0, 12)
    .map((setting) => `${setting} = ${valueText(valueAt(overrides, setting))}`);
}

export function parseLearningStats(value: unknown): LearningStats | null {
  if (!isRecord(value)) {
    return null;
  }
  const halves = isRecord(value.halves) ? value.halves : {};
  return {
    windows: count(value.windows),
    confidence: finite(value.confidence),
    variantTrades: count(value.variantTrades),
    baselineTrades: count(value.baselineTrades),
    variantPerTrade: finite(value.variantPerTrade),
    baselinePerTrade: finite(value.baselinePerTrade),
    gain: finite(value.gain),
    gainSol: finite(value.gainSol),
    gainLow: finite(value.gainLow),
    gainHigh: finite(value.gainHigh),
    own: finite(value.own),
    ownLow: finite(value.ownLow),
    positive: count(value.positive),
    negative: count(value.negative),
    withoutBest: finite(value.withoutBest),
    older: finite(halves.older),
    newer: finite(halves.newer)
  };
}

function parseLearningVariant(value: unknown): LearningVariant | null {
  if (!isRecord(value) || typeof value.name !== "string") {
    return null;
  }
  const progress = isRecord(value.progress) ? value.progress : {};
  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : "",
    verdict: textOrNull(value.verdict) ?? "unknown",
    reasons: textList(value.reasons),
    changes: changeList(value.overrides),
    stats: parseLearningStats(value.stats),
    tradeProgress: Math.min(1, Math.max(0, finite(progress.trades) ?? 0)),
    windowProgress: Math.min(1, Math.max(0, finite(progress.windows) ?? 0))
  };
}

function parseLearningPaper(value: unknown): LearningPaper {
  const paper = isRecord(value) ? value : {};
  return {
    status: textOrNull(paper.status) ?? "no_run",
    windows: count(paper.windows),
    matched: count(paper.matched),
    replayOnly: count(paper.replayOnly),
    paperOnly: count(paper.paperOnly),
    needed: count(paper.needed),
    coverage: finite(paper.coverage),
    bias: finite(paper.bias),
    biasLow: finite(paper.biasLow),
    biasHigh: finite(paper.biasHigh),
    paperPerTrade: finite(paper.paperPerTrade),
    replayPerTrade: finite(paper.replayPerTrade)
  };
}

function parseConfirmation(value: unknown): LearningConfirmation | null {
  if (!isRecord(value) || typeof value.name !== "string") {
    return null;
  }
  return {
    promotionId: count(value.promotionId),
    name: value.name,
    index: count(value.index),
    confidence: finite(value.confidence),
    fromMs: finite(value.fromMs),
    needed: count(value.needed),
    collected: count(value.collected),
    variantTrades: count(value.variantTrades),
    baselineTrades: count(value.baselineTrades),
    complete: value.complete === true,
    stats: parseLearningStats(value.stats),
    reasons: textList(value.reasons)
  };
}

function parseProbation(value: unknown): LearningProbation | null {
  if (!isRecord(value) || typeof value.name !== "string") {
    return null;
  }
  return {
    promotionId: count(value.promotionId),
    name: value.name,
    undoName: textOrNull(value.undoName) ?? "",
    fromMs: finite(value.fromMs),
    needed: count(value.needed),
    collected: count(value.collected),
    complete: value.complete === true,
    stats: parseLearningStats(value.stats),
    result: textOrNull(value.result)
  };
}

function parseBaseline(value: unknown): LearningBaseline {
  const base = isRecord(value) ? value : {};
  return {
    trades: count(base.trades),
    windows: count(base.windows),
    perTrade: finite(base.perTrade),
    perWindow: finite(base.perWindow),
    perWindowSol: finite(base.perWindowSol),
    perWindowLow: finite(base.perWindowLow),
    perWindowHigh: finite(base.perWindowHigh)
  };
}

function parseWeightsCandidate(value: unknown): LearningWeights | null {
  if (!isRecord(value) || typeof value.label !== "string") {
    return null;
  }
  const latest = isRecord(value.latest) ? value.latest : {};
  const previous = isRecord(value.previous) ? value.previous : null;
  return {
    label: value.label,
    checkpointSec: finite(value.checkpointSec),
    verdict: textOrNull(value.verdict) ?? "unknown",
    latestRunId: finite(latest.labRunId),
    latestGain: finite(latest.gain),
    latestRows: finite(latest.validationRows),
    previousRunId: previous ? finite(previous.labRunId) : null,
    previousGain: previous ? finite(previous.gain) : null,
    reasons: textList(value.reasons)
  };
}

export function parseLearningReport(labRunId: number, value: unknown): LearningReport | null {
  if (!isRecord(value) || !Array.isArray(value.variants) || !isRecord(value.identity) || typeof value.identity.settingsHash !== "string") {
    return null;
  }
  const rule = isRecord(value.rule) ? value.rule : {};
  const windows = arrayOf(value.windows).filter(isRecord);
  const decision = isRecord(value.decision) ? value.decision : {};
  const weights = isRecord(value.weights) ? value.weights : {};
  const weightsRule = isRecord(weights.rule) ? weights.rule : {};
  const promotion = isRecord(value.promotion) ? value.promotion : null;
  const windowMs = finite(rule.windowMs);
  return {
    labRunId,
    evaluatedAtMs: finite(value.evaluatedAtMs),
    settings: value.identity.settingsHash.slice(0, 8),
    engine: textOrNull(value.identity.engineVersion),
    enabled: value.enabled === true,
    canPromote: value.canPromote === true,
    windowHours: windowMs === null ? null : windowMs / 3_600_000,
    minTrades: count(rule.minTrades),
    minWindows: count(rule.minWindows),
    maxWindows: count(rule.maxWindows),
    confirmWindows: count(rule.confirmWindows),
    comparisons: count(rule.comparisons),
    familyConfidence: finite(rule.familyConfidence),
    discoveryConfidence: finite(rule.discoveryConfidence),
    nextConfirmConfidence: finite(rule.nextConfirmConfidence),
    windows: windows.length,
    windowsFromMs: windows.length > 0 ? finite(windows[0]?.fromMs) : null,
    windowsToMs: windows.length > 0 ? finite(windows[windows.length - 1]?.toMs) : null,
    baseline: parseBaseline(value.baseline),
    variants: value.variants.map(parseLearningVariant).filter((variant): variant is LearningVariant => variant !== null),
    paper: parseLearningPaper(value.paper),
    confirmation: parseConfirmation(value.confirmation),
    probation: parseProbation(value.probation),
    decision: { kind: textOrNull(decision.kind) ?? "hold", name: textOrNull(decision.name), reason: typeof decision.reason === "string" ? decision.reason : "" },
    weights: arrayOf(weights.candidates).map(parseWeightsCandidate).filter((entry): entry is LearningWeights => entry !== null),
    weightsActive: textOrNull(weights.activeVersion),
    weightsMinGain: finite(weightsRule.minAucGain),
    weightsMinRows: finite(weightsRule.minValidationRows),
    promotion:
      promotion && typeof promotion.name === "string"
        ? { id: count(promotion.id), status: textOrNull(promotion.status) ?? "pending", name: promotion.name }
        : null
  };
}

function promotionStats(evidence: Record<string, unknown>): LearningStats | null {
  const confirmation = isRecord(evidence.confirmation) ? evidence.confirmation : null;
  const confirmed = confirmation ? parseLearningStats(confirmation.stats) : null;
  if (confirmed) {
    return confirmed;
  }
  const discovery = isRecord(evidence.discovery) ? evidence.discovery : null;
  return discovery ? parseLearningStats(discovery.stats) : null;
}

export function promotionFromRecord(row: DbRecord): LearningPromotion {
  const evidence = isRecord(row.evidence) ? row.evidence : {};
  const applied = isRecord(evidence.applied) ? evidence.applied : {};
  const stats = promotionStats(evidence);
  const labRunId = row.lab_run_id;
  return {
    id: toNumber(row.id),
    kind: textOrNull(row.kind) ?? "variant",
    name: textOrNull(row.name) ?? "unknown",
    status: textOrNull(row.status) ?? "pending",
    note: textOrNull(row.note),
    changes: changeList(row.overrides),
    createdAtMs: msOf(row.created_at),
    updatedAtMs: msOf(row.updated_at),
    appliedAtMs: msOf(row.applied_at),
    labRunId: labRunId === null || labRunId === undefined ? null : toNumber(labRunId),
    confirmIndex: finite(row.confirm_index),
    confirmWindows: finite(row.confirm_windows),
    windows: stats ? stats.windows : null,
    trades: stats ? stats.variantTrades : null,
    gain: stats?.gain ?? null,
    gainSol: stats?.gainSol ?? null,
    gainLow: stats?.gainLow ?? null,
    probationResult: textOrNull(row.probation_result),
    endedRunId: finite(applied.endedRunId)
  };
}

const PROMOTION_COLUMNS = "id, kind, name, overrides, status, note, evidence, lab_run_id, confirm_index, confirm_windows, probation_result, created_at, updated_at, applied_at";

export async function loadLearning(db: Db, limit: number = LEARNING_PROMOTIONS): Promise<LabLearning> {
  try {
    const latest = await db.query<DbRecord>(
      `SELECT id, learner FROM lab_runs WHERE learner IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1`
    );
    const row = latest.rows[0];
    const attempt = await db.query<DbRecord>(
      `SELECT id, learner IS NOT NULL AS ok, notes->'learner'->>'error' AS error FROM lab_runs
        WHERE learner IS NOT NULL OR notes ? 'learner' ORDER BY started_at DESC, id DESC LIMIT 1`
    );
    const last = attempt.rows[0];
    const promotions = await db.query<DbRecord>(`SELECT ${PROMOTION_COLUMNS} FROM promotions ORDER BY created_at DESC, id DESC LIMIT $1`, [
      Math.max(1, Math.min(50, Math.floor(limit)))
    ]);
    return {
      available: true,
      report: row ? parseLearningReport(toNumber(row.id), row.learner) : null,
      error: last && last.ok !== true ? textOrNull(last.error) : null,
      promotions: promotions.rows.map(promotionFromRecord),
      inEffect: null
    };
  } catch (error) {
    if (isMissingSchema(error)) {
      return emptyLearning(false);
    }
    throw error;
  }
}

export async function loadRecentPromotion(db: Db, sinceMs: number): Promise<LearningPromotion | null> {
  try {
    const result = await db.query<DbRecord>(
      `SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE status IN ('applied', 'reverted') AND applied_at >= $1 ORDER BY applied_at DESC, id DESC LIMIT 1`,
      [new Date(sinceMs)]
    );
    const row = result.rows[0];
    return row ? promotionFromRecord(row) : null;
  } catch (error) {
    if (isMissingSchema(error)) {
      return null;
    }
    throw error;
  }
}

export async function loadLabOverview(db: Db, options: { historyLimit?: number } = {}): Promise<LabOverview> {
  try {
    const counted = await db.query<DbRecord>("SELECT count(*)::int AS n FROM lab_runs");
    const runs = toNullableNumber(counted.rows[0]?.n) ?? 0;
    if (runs === 0) {
      return emptyLabOverview(true);
    }
    const latest = await latestRun(db, false);
    const run = latest && latest.status === "done" ? latest : (await latestRun(db, true)) ?? latest;
    if (!run) {
      return emptyLabOverview(true);
    }
    const variants = withRunNotes(await loadLabVariants(db, run.id), run.notes);
    return {
      available: true,
      runs,
      latest,
      run,
      variants,
      scorer: await loadLabScorer(db, run.id),
      history: await loadBaselineHistory(db, options.historyLimit),
      takeaway: labTakeaway(variants),
      learning: await loadLearning(db)
    };
  } catch (error) {
    if (isUndefinedTable(error)) {
      return emptyLabOverview(false);
    }
    throw error;
  }
}
