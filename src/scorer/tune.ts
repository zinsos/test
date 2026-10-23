import { quantile, rocAuc } from "../core/stats.js";
import { labelValue, type DatasetLabelName, type DatasetRow } from "./dataset.js";
import { FEATURE_NAMES, NON_PREDICTIVE_FEATURES } from "./featureNames.js";
import { fitLogistic, predictLogistic } from "./logistic.js";
import { ScoringModel } from "./model.js";
import { DEFAULT_WEIGHTS, type FeatureWeight, type WeightsFile } from "./weights.js";

export type Direction = "higher_riskier" | "lower_riskier" | "none";

export interface TuneOptions {
  validationFraction?: number;
  l2?: number;
  maxIterations?: number;
  features?: readonly string[];
  minCoverage?: number;
  bucketWidth?: number;
  maxWeight?: number;
  version?: string;
  zClip?: number;
  soloFrom?: WeightsFile;
}

export interface FeatureReport {
  feature: string;
  coverage: number;
  auc: number | null;
  orientedAuc: number | null;
  validationAuc: number | null;
  direction: Direction;
  coefficient: number | null;
  usedInModel: boolean;
  suggestedWeight: number;
}

export interface CalibrationBucket {
  from: number;
  to: number;
  count: number;
  badRate: number | null;
  meanScore: number | null;
}

export interface TuneResult {
  label: DatasetLabelName;
  target: string;
  rows: number;
  trainRows: number;
  validationRows: number;
  splitAtMs: number | null;
  baseRate: number | null;
  features: FeatureReport[];
  model: {
    intercept: number;
    coefficients: Record<string, number>;
    means: Record<string, number>;
    stds: Record<string, number>;
    l2: number;
    iterations: number;
    converged: boolean;
  };
  validation: {
    modelAuc: number | null;
    currentScoreAuc: number | null;
    suggestedScoreAuc: number | null;
  };
  calibration: CalibrationBucket[];
  suggestedCalibration: CalibrationBucket[];
  suggestedWeights: WeightsFile;
}

interface Labeled {
  row: DatasetRow;
  bad: boolean;
}

interface Standardizer {
  mean: number;
  std: number;
}

const MIN_ROWS_FOR_SPLIT = 20;
const SHAPE_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
const CATEGORICAL_MAX_DISTINCT = 6;
const SMOOTHING = 10;

export function badOutcome(row: DatasetRow, label: DatasetLabelName): boolean | null {
  const value = labelValue(row, label);
  if (value === null) {
    return null;
  }
  return label === "rugged" || label === "died" ? value : !value;
}

export function targetDescription(label: DatasetLabelName): string {
  return label === "rugged" || label === "died" ? `${label} = true` : `${label} = false`;
}

function labeledRows(rows: readonly DatasetRow[], label: DatasetLabelName): Labeled[] {
  const labeled: Labeled[] = [];
  for (const row of rows) {
    const bad = badOutcome(row, label);
    if (bad !== null) {
      labeled.push({ row, bad });
    }
  }
  labeled.sort(
    (a, b) =>
      a.row.createdAtMs - b.row.createdAtMs || a.row.launchId - b.row.launchId || a.row.checkpointSec - b.row.checkpointSec
  );
  return labeled;
}

export function timeSplit<T extends { row: DatasetRow }>(
  rows: readonly T[],
  validationFraction: number
): { train: T[]; validation: T[]; splitAtMs: number | null } {
  if (rows.length < MIN_ROWS_FOR_SPLIT || validationFraction <= 0) {
    return { train: [...rows], validation: [], splitAtMs: null };
  }
  let index = Math.floor(rows.length * (1 - Math.min(0.9, validationFraction)));
  while (index > 0 && index < rows.length && rows[index]?.row.launchId === rows[index - 1]?.row.launchId) {
    index += 1;
  }
  if (index <= 0 || index >= rows.length) {
    return { train: [...rows], validation: [], splitAtMs: null };
  }
  return { train: rows.slice(0, index), validation: rows.slice(index), splitAtMs: rows[index]?.row.createdAtMs ?? null };
}

function valueOf(row: DatasetRow, name: string): number | null {
  const value = row.features[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNullPairs(rows: readonly Labeled[], name: string): { values: number[]; bad: boolean[] } {
  const values: number[] = [];
  const bad: boolean[] = [];
  for (const entry of rows) {
    const value = valueOf(entry.row, name);
    if (value !== null) {
      values.push(value);
      bad.push(entry.bad);
    }
  }
  return { values, bad };
}

function directionOf(auc: number | null): Direction {
  if (auc === null || Math.abs(auc - 0.5) < 1e-9) {
    return "none";
  }
  return auc > 0.5 ? "higher_riskier" : "lower_riskier";
}

function orient(auc: number | null, direction: Direction): number | null {
  if (auc === null) {
    return null;
  }
  return direction === "lower_riskier" ? 1 - auc : auc;
}

function standardizer(rows: readonly Labeled[], name: string): Standardizer | null {
  const values = nonNullPairs(rows, name).values;
  if (values.length < 2) {
    return null;
  }
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
  const std = Math.sqrt(variance);
  return std > 1e-12 ? { mean, std } : null;
}

function standardizedRow(row: DatasetRow, names: readonly string[], scalers: readonly Standardizer[], zClip: number): number[] {
  return names.map((name, index) => {
    const value = valueOf(row, name);
    const scaler = scalers[index];
    if (value === null || !scaler) {
      return 0;
    }
    return Math.max(-zClip, Math.min(zClip, (value - scaler.mean) / scaler.std));
  });
}

function poolAdjacentViolators(values: readonly number[], weights: readonly number[], increasing: boolean): number[] {
  const blocks: Array<{ value: number; weight: number; size: number }> = [];
  values.forEach((raw, index) => {
    const value = increasing ? raw : -raw;
    blocks.push({ value, weight: Math.max(weights[index] ?? 0, 1e-9), size: 1 });
    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];
      if (!last || !previous || previous.value <= last.value) {
        break;
      }
      const weight = previous.weight + last.weight;
      blocks.splice(blocks.length - 2, 2, {
        value: (previous.value * previous.weight + last.value * last.weight) / weight,
        weight,
        size: previous.size + last.size
      });
    }
  });
  const result: number[] = [];
  for (const block of blocks) {
    for (let k = 0; k < block.size; k += 1) {
      result.push(increasing ? block.value : -block.value);
    }
  }
  return result;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function significant(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(6));
}

function knotsFor(values: readonly number[]): number[] {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  if (distinct.length <= CATEGORICAL_MAX_DISTINCT) {
    return distinct;
  }
  const knots = SHAPE_QUANTILES.map((q) => significant(quantile(values, q) ?? 0));
  return [...new Set(knots)].sort((a, b) => a - b);
}

function nearestKnot(knots: readonly number[], value: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  knots.forEach((knot, index) => {
    const distance = Math.abs(knot - value);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

export function riskShape(rows: readonly Labeled[], name: string, increasing: boolean, baseRate: number): FeatureWeight {
  const { values, bad } = nonNullPairs(rows, name);
  const missingRows = rows.filter((entry) => valueOf(entry.row, name) === null);
  if (values.length === 0) {
    return { weight: 0, points: [[0, 0.5]], missingRisk: 0.5 };
  }
  const knots = knotsFor(values);
  const counts = new Array<number>(knots.length).fill(0);
  const bads = new Array<number>(knots.length).fill(0);
  values.forEach((value, index) => {
    const bin = nearestKnot(knots, value);
    counts[bin] = (counts[bin] ?? 0) + 1;
    bads[bin] = (bads[bin] ?? 0) + (bad[index] ? 1 : 0);
  });
  const smooth = (badCount: number, count: number): number => (badCount + baseRate * SMOOTHING) / (count + SMOOTHING);
  const rates = poolAdjacentViolators(
    knots.map((_, index) => smooth(bads[index] ?? 0, counts[index] ?? 0)),
    counts,
    increasing
  );
  const low = Math.min(...rates);
  const high = Math.max(...rates);
  const span = high - low;
  const ramp = (index: number): number => {
    const t = knots.length > 1 ? index / (knots.length - 1) : 0.5;
    return increasing ? t : 1 - t;
  };
  const points: Array<[number, number]> = knots.map((knot, index) => [
    knot,
    round(span > 1e-6 ? ((rates[index] ?? low) - low) / span : ramp(index), 3)
  ]);
  let missingRisk = 0.5;
  if (missingRows.length > 0 && span > 1e-6) {
    const missingBad = missingRows.filter((entry) => entry.bad).length;
    missingRisk = round(Math.min(1, Math.max(0, (smooth(missingBad, missingRows.length) - low) / span)), 3);
  }
  return { weight: 0, points, missingRisk };
}

export function calibrationTable(scores: readonly number[], bad: readonly boolean[], width = 10): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  const count = Math.max(1, Math.ceil(100 / width));
  for (let index = 0; index < count; index += 1) {
    const from = index * width;
    const to = Math.min(100, from + width);
    const last = index === count - 1;
    let n = 0;
    let badCount = 0;
    let scoreSum = 0;
    scores.forEach((score, position) => {
      if (score >= from && (score < to || (last && score <= to))) {
        n += 1;
        scoreSum += score;
        badCount += bad[position] ? 1 : 0;
      }
    });
    buckets.push({ from, to, count: n, badRate: n > 0 ? badCount / n : null, meanScore: n > 0 ? scoreSum / n : null });
  }
  return buckets;
}

function candidateFeatures(options: TuneOptions): string[] {
  return [...(options.features ?? FEATURE_NAMES.filter((name) => !NON_PREDICTIVE_FEATURES.includes(name)))];
}

function univariate(train: readonly Labeled[], validation: readonly Labeled[], name: string): Omit<FeatureReport, "coefficient" | "usedInModel" | "suggestedWeight"> {
  const trainPairs = nonNullPairs(train, name);
  const auc = rocAuc(trainPairs.values, trainPairs.bad);
  const direction = directionOf(auc);
  const validationPairs = nonNullPairs(validation, name);
  return {
    feature: name,
    coverage: train.length > 0 ? trainPairs.values.length / train.length : 0,
    auc,
    orientedAuc: auc === null ? null : Math.max(auc, 1 - auc),
    validationAuc: orient(rocAuc(validationPairs.values, validationPairs.bad), direction),
    direction
  };
}

export function tune(rows: readonly DatasetRow[], label: DatasetLabelName, options: TuneOptions = {}): TuneResult {
  const labeled = labeledRows(rows, label);
  if (labeled.length === 0) {
    throw new Error(`no rows with a known ${label} label`);
  }
  const l2 = options.l2 ?? 1;
  const zClip = options.zClip ?? 5;
  const maxWeight = options.maxWeight ?? 10;
  const minCoverage = options.minCoverage ?? 0.05;
  const { train, validation, splitAtMs } = timeSplit(labeled, options.validationFraction ?? 0.3);
  const baseRate = train.filter((entry) => entry.bad).length / train.length;
  const candidates = candidateFeatures(options);
  const reports = candidates.map((name) => univariate(train, validation, name));
  const used = reports
    .map((report) => ({ report, scaler: standardizer(train, report.feature) }))
    .filter((entry) => entry.report.coverage >= minCoverage && entry.scaler !== null);
  const names = used.map((entry) => entry.report.feature);
  const scalers = used.map((entry) => entry.scaler as Standardizer);
  const p = names.length;
  const x = new Float64Array(train.length * p);
  const y = new Uint8Array(train.length);
  train.forEach((entry, i) => {
    standardizedRow(entry.row, names, scalers, zClip).forEach((value, j) => {
      x[i * p + j] = value;
    });
    y[i] = entry.bad ? 1 : 0;
  });
  const fit = fitLogistic(x, y, train.length, p, {
    l2,
    maxIterations: options.maxIterations ?? 50,
    tolerance: 1e-6
  });
  const coefficients = new Map<string, number>();
  names.forEach((name, index) => coefficients.set(name, fit.coefficients[index] ?? 0));
  const maxAbs = Math.max(1e-12, ...[...coefficients.values()].map(Math.abs));
  const weightFeatures: Record<string, FeatureWeight> = {};
  const soloBase = options.soloFrom ?? DEFAULT_WEIGHTS;
  const finalReports: FeatureReport[] = reports.map((report) => {
    const coefficient = coefficients.get(report.feature) ?? null;
    const usedInModel = coefficient !== null;
    const increasing = coefficient !== null && Math.abs(coefficient) > 1e-12 ? coefficient > 0 : report.direction !== "lower_riskier";
    const shape = riskShape(train, report.feature, increasing, baseRate);
    const suggestedWeight = usedInModel ? round((maxWeight * Math.abs(coefficient ?? 0)) / maxAbs, 2) : 0;
    const solo = increasing ? soloBase.features[report.feature]?.solo : undefined;
    weightFeatures[report.feature] =
      solo === undefined ? { ...shape, weight: suggestedWeight } : { ...shape, weight: suggestedWeight, solo };
    return { ...report, coefficient, usedInModel, suggestedWeight };
  });
  finalReports.sort((a, b) => (b.orientedAuc ?? -1) - (a.orientedAuc ?? -1));
  const lastMs = labeled[labeled.length - 1]?.row.createdAtMs ?? 0;
  const suggestedWeights: WeightsFile = {
    version: options.version ?? `tuned-${label}-${new Date(lastMs).toISOString().slice(0, 10)}-${labeled.length}`,
    label: `logistic l2=${l2} on ${train.length} rows, target ${targetDescription(label)}`,
    features: weightFeatures
  };
  const validationBad = validation.map((entry) => entry.bad);
  const modelPredictions = validation.map((entry) => predictLogistic(fit, standardizedRow(entry.row, names, scalers, zClip)));
  const currentScores = validation.map((entry) => entry.row.score);
  const suggestedModel = new ScoringModel(suggestedWeights);
  const suggestedScores = validation.map((entry) => suggestedModel.rawScore(entry.row.features).score);
  const width = options.bucketWidth ?? 10;
  return {
    label,
    target: targetDescription(label),
    rows: labeled.length,
    trainRows: train.length,
    validationRows: validation.length,
    splitAtMs,
    baseRate,
    features: finalReports,
    model: {
      intercept: fit.intercept,
      coefficients: Object.fromEntries(coefficients),
      means: Object.fromEntries(names.map((name, index) => [name, scalers[index]?.mean ?? 0])),
      stds: Object.fromEntries(names.map((name, index) => [name, scalers[index]?.std ?? 1])),
      l2,
      iterations: fit.iterations,
      converged: fit.converged
    },
    validation: {
      modelAuc: rocAuc(modelPredictions, validationBad),
      currentScoreAuc: rocAuc(currentScores, validationBad),
      suggestedScoreAuc: rocAuc(suggestedScores, validationBad)
    },
    calibration: calibrationTable(currentScores, validationBad, width),
    suggestedCalibration: calibrationTable(suggestedScores, validationBad, width),
    suggestedWeights
  };
}
