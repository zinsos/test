import type { Db } from "../db/pool.js";
import {
  iterateDataset,
  labelMaturitySec,
  labelValue,
  type DatasetLabelName,
  type DatasetQuery,
  type DatasetRow,
  type LabelMaturity
} from "../scorer/dataset.js";
import { badWhenTrue, tune, type CalibrationBucket, type Direction, type FeatureReport, type TuneResult } from "../scorer/tune.js";
import { saveWeights, type WeightsFile } from "../scorer/weights.js";

const HOUR_MS = 3_600_000;
export const LAB_TOP_FEATURES = 15;

export interface LabFeature {
  name: string;
  auc: number | null;
  direction: Direction;
  coverage: number;
  weight: number;
}

export interface LabCalibrationBucket {
  bucket: string;
  n: number;
  positiveRate: number | null;
}

export interface LabScorerResult {
  label: DatasetLabelName;
  checkpointSec: number;
  rows: number;
  positives: number;
  validationRows: number | null;
  validationFromMs: number | null;
  validationToMs: number | null;
  validationAuc: number | null;
  baselineAuc: number | null;
  features: LabFeature[];
  calibration: LabCalibrationBucket[];
  weightsVersion: string;
}

export interface LabScorerSkip {
  label: DatasetLabelName;
  checkpointSec: number;
  rows: number;
  positives: number;
  reason: string;
}

export interface LabScorerSkipEntry {
  label: DatasetLabelName;
  checkpointSec: number;
  rows: number;
  positives: number;
  validationRows: null;
  validationFromMs: null;
  validationToMs: null;
  validationAuc: null;
  baselineAuc: null;
  features: LabFeature[];
  calibration: LabCalibrationBucket[];
  weightsVersion: null;
  reason: string;
}

export type LabScorerEntry = LabScorerResult | LabScorerSkipEntry;

export function skippedEntry(skip: LabScorerSkip): LabScorerSkipEntry {
  return {
    label: skip.label,
    checkpointSec: skip.checkpointSec,
    rows: skip.rows,
    positives: skip.positives,
    validationRows: null,
    validationFromMs: null,
    validationToMs: null,
    validationAuc: null,
    baselineAuc: null,
    features: [],
    calibration: [],
    weightsVersion: null,
    reason: skip.reason
  };
}

export interface ScorerLabOptions {
  db: Db;
  labRunId: number;
  nowMs: number;
  labels: readonly DatasetLabelName[];
  checkpoints: readonly number[];
  maturity: LabelMaturity;
  soloFrom: WeightsFile;
  trainHours: number;
  maxRows: number;
  minRows: number;
  minClassRows: number;
  validationFraction?: number;
  onEntry?: (entry: LabScorerEntry) => Promise<void> | void;
}

export interface ScorerLabOutcome {
  results: LabScorerResult[];
  skipped: LabScorerSkip[];
  entries: LabScorerEntry[];
}

export function labWeightsVersion(labRunId: number, label: DatasetLabelName, checkpointSec: number): string {
  return `lab-${labRunId}-${label}-${checkpointSec}`;
}

export function trainingWindow(nowMs: number, label: DatasetLabelName, maturity: LabelMaturity, trainHours: number): { fromMs: number; toMs: number } {
  const maturedBeforeMs = nowMs - labelMaturitySec(label, maturity) * 1_000;
  return { fromMs: maturedBeforeMs - trainHours * HOUR_MS, toMs: maturedBeforeMs };
}

export async function loadRecentRows(db: Db, query: DatasetQuery, maxRows: number): Promise<DatasetRow[]> {
  let kept: DatasetRow[] = [];
  for await (const page of iterateDataset(db, query)) {
    kept.push(...page);
    if (kept.length > 2 * maxRows) {
      kept = kept.slice(kept.length - maxRows);
    }
  }
  return kept.length > maxRows ? kept.slice(kept.length - maxRows) : kept;
}

export function labelCounts(rows: readonly DatasetRow[], label: DatasetLabelName): { rows: number; positives: number; negatives: number } {
  let positives = 0;
  let negatives = 0;
  for (const row of rows) {
    const value = labelValue(row, label);
    if (value === true) {
      positives += 1;
    } else if (value === false) {
      negatives += 1;
    }
  }
  return { rows: positives + negatives, positives, negatives };
}

function byImportance(a: FeatureReport, b: FeatureReport): number {
  return b.suggestedWeight - a.suggestedWeight || (b.orientedAuc ?? -1) - (a.orientedAuc ?? -1) || a.feature.localeCompare(b.feature);
}

export function topFeatures(reports: readonly FeatureReport[], limit = LAB_TOP_FEATURES): LabFeature[] {
  return [...reports]
    .sort(byImportance)
    .slice(0, limit)
    .map((report) => ({
      name: report.feature,
      auc: report.validationAuc,
      direction: report.direction,
      coverage: report.coverage,
      weight: report.suggestedWeight
    }));
}

export function positiveCalibration(buckets: readonly CalibrationBucket[], label: DatasetLabelName): LabCalibrationBucket[] {
  const flip = !badWhenTrue(label);
  return buckets.map((bucket) => ({
    bucket: `${bucket.from}-${bucket.to}`,
    n: bucket.count,
    positiveRate: bucket.badRate === null ? null : flip ? 1 - bucket.badRate : bucket.badRate
  }));
}

export function labScorerResult(
  result: TuneResult,
  checkpointSec: number,
  positives: number,
  validationWindow: { fromMs: number | null; toMs: number | null } = { fromMs: result.splitAtMs, toMs: null }
): LabScorerResult {
  return {
    label: result.label,
    checkpointSec,
    rows: result.rows,
    positives,
    validationRows: result.validationRows,
    validationFromMs: result.validationRows > 0 ? validationWindow.fromMs : null,
    validationToMs: result.validationRows > 0 ? validationWindow.toMs : null,
    validationAuc: result.validation.suggestedScoreAuc,
    baselineAuc: result.validation.currentScoreAuc,
    features: topFeatures(result.features),
    calibration: positiveCalibration(result.suggestedCalibration, result.label),
    weightsVersion: result.suggestedWeights.version
  };
}

function skipReason(counts: { rows: number; positives: number; negatives: number }, options: ScorerLabOptions): string | null {
  if (counts.rows < options.minRows) {
    return `only ${counts.rows} matured rows (need ${options.minRows})`;
  }
  const smaller = Math.min(counts.positives, counts.negatives);
  if (smaller < options.minClassRows) {
    return `only ${smaller} rows in the smaller class (need ${options.minClassRows})`;
  }
  return null;
}

async function trainOne(options: ScorerLabOptions, label: DatasetLabelName, checkpointSec: number): Promise<LabScorerResult | LabScorerSkip> {
  const window = trainingWindow(options.nowMs, label, options.maturity, options.trainHours);
  const rows = await loadRecentRows(
    options.db,
    { checkpointSec, from: new Date(window.fromMs), asOf: new Date(options.nowMs), label, ...options.maturity },
    options.maxRows
  );
  const counts = labelCounts(rows, label);
  const reason = skipReason(counts, options);
  if (reason) {
    return { label, checkpointSec, rows: counts.rows, positives: counts.positives, reason };
  }
  const version = labWeightsVersion(options.labRunId, label, checkpointSec);
  const result = tune(rows, label, { version, soloFrom: options.soloFrom, validationFraction: options.validationFraction });
  const firstMs = rows[0]?.createdAtMs ?? window.fromMs;
  await saveWeights(options.db, {
    weights: result.suggestedWeights,
    labelName: label,
    metrics: {
      source: "lab",
      labRunId: options.labRunId,
      checkpointSec,
      from: new Date(firstMs).toISOString(),
      to: new Date(options.nowMs).toISOString(),
      rows: result.rows,
      trainRows: result.trainRows,
      validationRows: result.validationRows,
      splitAtMs: result.splitAtMs,
      baseRate: result.baseRate,
      validation: result.validation
    },
    activate: false
  });
  return labScorerResult(result, checkpointSec, counts.positives, { fromMs: result.splitAtMs, toMs: rows[rows.length - 1]?.createdAtMs ?? window.toMs });
}

function isSkip(value: LabScorerResult | LabScorerSkip): value is LabScorerSkip {
  return "reason" in value;
}

export async function runScorerLab(options: ScorerLabOptions): Promise<ScorerLabOutcome> {
  const results: LabScorerResult[] = [];
  const skipped: LabScorerSkip[] = [];
  const entries: LabScorerEntry[] = [];
  for (const label of options.labels) {
    for (const checkpointSec of options.checkpoints) {
      let outcome: LabScorerResult | LabScorerSkip;
      try {
        outcome = await trainOne(options, label, checkpointSec);
      } catch (error) {
        outcome = { label, checkpointSec, rows: 0, positives: 0, reason: error instanceof Error ? error.message : String(error) };
      }
      const entry = isSkip(outcome) ? skippedEntry(outcome) : outcome;
      if (isSkip(outcome)) {
        skipped.push(outcome);
      } else {
        results.push(outcome);
      }
      entries.push(entry);
      await options.onEntry?.(entry);
    }
  }
  return { results, skipped, entries };
}
