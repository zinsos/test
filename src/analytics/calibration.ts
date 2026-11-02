export type CalibrationVerdict = "insufficient_data" | "scorer_works" | "scorer_inverted" | "inconclusive";

export const DEFAULT_MIN_CALIBRATION_LAUNCHES = 200;
export const DEFAULT_MIN_CALIBRATION_GROUP = 30;
export const DEFAULT_CALIBRATION_MAX_RISK = 55;
const Z_95 = 1.96;

export interface OutcomeCounts {
  n: number;
  survivedKnown: number;
  survived: number;
  migrated: number;
  rugged: number;
  died: number;
  hardBlocked: number;
}

export interface OutcomeRates {
  survived15mRate: number | null;
  migratedRate: number | null;
  ruggedRate: number | null;
  diedRate: number | null;
}

export interface CalibrationGroup extends OutcomeCounts, OutcomeRates {
  medianPeakMultiple: number | null;
  medianPeakFromScore: number | null;
}

export interface CalibrationBucket extends CalibrationGroup {
  index: number;
  low: number;
  high: number;
  label: string;
}

export interface CalibrationAssessment {
  n: number;
  minLaunches: number;
  minGroup: number;
  maxRisk: number;
  survivalLift: number | null;
  survivalZ: number | null;
  rugReduction: number | null;
  rugZ: number | null;
  verdict: CalibrationVerdict;
}

export interface AssessOptions {
  maxRisk?: number;
  minLaunches?: number;
  minGroup?: number;
}

export const EMPTY_COUNTS: OutcomeCounts = {
  n: 0,
  survivedKnown: 0,
  survived: 0,
  migrated: 0,
  rugged: 0,
  died: 0,
  hardBlocked: 0
};

function share(count: number, total: number): number | null {
  return total > 0 ? count / total : null;
}

export function outcomeRates(counts: OutcomeCounts): OutcomeRates {
  return {
    survived15mRate: share(counts.survived, counts.survivedKnown),
    migratedRate: share(counts.migrated, counts.n),
    ruggedRate: share(counts.rugged, counts.n),
    diedRate: share(counts.died, counts.n)
  };
}

export function twoProportionZ(successesA: number, totalA: number, successesB: number, totalB: number): number | null {
  if (totalA <= 0 || totalB <= 0) {
    return null;
  }
  const pooled = (successesA + successesB) / (totalA + totalB);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  if (!Number.isFinite(standardError) || standardError === 0) {
    return null;
  }
  return (successesA / totalA - successesB / totalB) / standardError;
}

function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

export function calibrationVerdict(
  pass: OutcomeCounts,
  block: OutcomeCounts,
  survivalZ: number | null,
  minLaunches: number,
  minGroup: number
): CalibrationVerdict {
  if (pass.n + block.n < minLaunches || pass.survivedKnown < minGroup || block.survivedKnown < minGroup) {
    return "insufficient_data";
  }
  if (survivalZ === null) {
    return "inconclusive";
  }
  if (survivalZ > Z_95) {
    return "scorer_works";
  }
  return survivalZ < -Z_95 ? "scorer_inverted" : "inconclusive";
}

export function assessCalibration(pass: OutcomeCounts, block: OutcomeCounts, options: AssessOptions = {}): CalibrationAssessment {
  const minLaunches = options.minLaunches ?? DEFAULT_MIN_CALIBRATION_LAUNCHES;
  const minGroup = options.minGroup ?? DEFAULT_MIN_CALIBRATION_GROUP;
  const passRates = outcomeRates(pass);
  const blockRates = outcomeRates(block);
  const survivalZ = twoProportionZ(pass.survived, pass.survivedKnown, block.survived, block.survivedKnown);
  return {
    n: pass.n + block.n,
    minLaunches,
    minGroup,
    maxRisk: options.maxRisk ?? DEFAULT_CALIBRATION_MAX_RISK,
    survivalLift: difference(passRates.survived15mRate, blockRates.survived15mRate),
    survivalZ,
    rugReduction: difference(blockRates.ruggedRate, passRates.ruggedRate),
    rugZ: twoProportionZ(block.rugged, block.n, pass.rugged, pass.n),
    verdict: calibrationVerdict(pass, block, survivalZ, minLaunches, minGroup)
  };
}
