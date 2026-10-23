import { toNullableNumber, toNumber, type Db } from "../db/pool.js";
import { formatInterval, formatSol } from "./format.js";
import type { Narrative } from "./narrative.js";

export const LAB_LABEL_PREFIX = "lab:";
export const LAB_RUN_IDS_SQL = `SELECT id FROM strategy_runs WHERE label LIKE '${LAB_LABEL_PREFIX}%'`;
export const DEFAULT_LAB_HISTORY = 20;
export const MIN_LAB_TRADES = 30;
const MAX_FEATURES = 15;
const UNDEFINED_TABLE = "42P01";

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

export interface LabOverview {
  available: boolean;
  runs: number;
  latest: LabRunInfo | null;
  run: LabRunInfo | null;
  variants: LabVariantRow[];
  scorer: LabScorerEntry[];
  history: LabBaselinePoint[];
  takeaway: Narrative | null;
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
    vsBaselineSol: null
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

export function emptyLabOverview(available: boolean): LabOverview {
  return { available, runs: 0, latest: null, run: null, variants: [], scorer: [], history: [], takeaway: null };
}

function isUndefinedTable(error: unknown): boolean {
  return isRecord(error) && error.code === UNDEFINED_TABLE;
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
    const variants = await loadLabVariants(db, run.id);
    return {
      available: true,
      runs,
      latest,
      run,
      variants,
      scorer: await loadLabScorer(db, run.id),
      history: await loadBaselineHistory(db, options.historyLimit),
      takeaway: labTakeaway(variants)
    };
  } catch (error) {
    if (isUndefinedTable(error)) {
      return emptyLabOverview(false);
    }
    throw error;
  }
}
