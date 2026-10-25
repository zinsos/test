import { describe, expect, it } from "vitest";
import { createRng } from "../src/core/rng.js";
import type { DatasetRow } from "../src/scorer/dataset.js";
import { fitLogistic, predictLogistic, sigmoid, solveLinearSystem } from "../src/scorer/logistic.js";
import { ScoringModel } from "../src/scorer/model.js";
import { badOutcome, calibrationTable, riskShape, targetDescription, timeSplit, tune } from "../src/scorer/tune.js";
import { parseWeights } from "../src/scorer/weights.js";

const T = Date.UTC(2026, 9, 1);

function syntheticRows(count: number, seed: string): DatasetRow[] {
  const rng = createRng(seed);
  const rows: DatasetRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const bundleShare = rng() * 0.3;
    const bad = rng() < sigmoid(-2.5 + 18 * bundleShare);
    rows.push({
      launchId: index + 1,
      mint: `m${index}`,
      createdAtMs: T + index * 60_000,
      quoteMint: "SOL",
      checkpointSec: 30,
      score: Math.min(100, Math.max(0, (bundleShare / 0.3) * 80 + rng() * 20)),
      hardBlocked: false,
      features: {
        age_sec: 30 + rng(),
        bundle_share: bundleShare,
        dev_share: rng() * 0.1,
        unique_buyers_per_min: rng() * 60,
        copycat: rng() < 0.2 ? 1 : 0,
        fresh_wallet_ratio: rng() < 0.5 ? null : rng(),
        top10_share: 0.1 + rng() * 0.4,
        intel_coverage: rng()
      },
      labels: {
        survived15m: !bad,
        rugged1h: null,
        migrated: false,
        rugged: bad,
        died: false,
        peakMultipleFrom1m: null,
        return15mFrom1m: null
      }
    });
  }
  return rows;
}

describe("logistic regression", () => {
  it("solves small linear systems with pivoting", () => {
    const solution = solveLinearSystem(Float64Array.from([0, 2, 1, 1]), Float64Array.from([4, 3]), 2);
    expect(solution[0]).toBeCloseTo(1, 10);
    expect(solution[1]).toBeCloseTo(2, 10);
  });

  it("recovers known coefficients", () => {
    const rng = createRng("logit");
    const n = 6_000;
    const x = new Float64Array(n * 2);
    const y = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      const a = rng() * 2 - 1;
      const b = rng() * 2 - 1;
      x[i * 2] = a;
      x[i * 2 + 1] = b;
      y[i] = rng() < sigmoid(0.5 + 2 * a - b) ? 1 : 0;
    }
    const fit = fitLogistic(x, y, n, 2, { l2: 0.01, maxIterations: 50, tolerance: 1e-8 });
    expect(fit.converged).toBe(true);
    expect(fit.intercept).toBeCloseTo(0.5, 0);
    expect(fit.coefficients[0]).toBeGreaterThan(1.7);
    expect(fit.coefficients[0]).toBeLessThan(2.3);
    expect(fit.coefficients[1]).toBeGreaterThan(-1.3);
    expect(fit.coefficients[1]).toBeLessThan(-0.7);
    expect(predictLogistic(fit, [1, -1])).toBeGreaterThan(0.9);
  });

  it("stays finite on perfectly separable data thanks to the penalty", () => {
    const x = Float64Array.from([-2, -1, 1, 2]);
    const y = Uint8Array.from([0, 0, 1, 1]);
    const fit = fitLogistic(x, y, 4, 1, { l2: 1, maxIterations: 100, tolerance: 1e-9 });
    expect(Number.isFinite(fit.coefficients[0] ?? Number.NaN)).toBe(true);
    expect(fit.coefficients[0]).toBeGreaterThan(0);
  });
});

describe("tune", () => {
  it("finds the predictive feature, weights it most and validates on later launches", () => {
    const rows = syntheticRows(3_000, "tune-a");
    const result = tune(rows, "survived_15m");
    expect(result.target).toBe("survived_15m = false");
    expect(result.trainRows + result.validationRows).toBe(3_000);
    expect(result.validationRows).toBeGreaterThan(800);
    const top = result.features[0];
    expect(top?.feature).toBe("bundle_share");
    expect(top?.direction).toBe("higher_riskier");
    expect(top?.orientedAuc).toBeGreaterThan(0.7);
    expect(top?.validationAuc).toBeGreaterThan(0.7);
    for (const report of result.features.slice(1)) {
      expect(report.orientedAuc ?? 0).toBeLessThan(0.6);
    }
    const weights = result.suggestedWeights.features;
    expect(weights.bundle_share?.weight).toBe(10);
    for (const [name, spec] of Object.entries(weights)) {
      if (name !== "bundle_share") {
        expect(spec.weight, name).toBeLessThan(3);
      }
    }
    const points = weights.bundle_share?.points ?? [];
    expect(points[0]?.[1]).toBe(0);
    expect(points[points.length - 1]?.[1]).toBe(1);
    for (let index = 1; index < points.length; index += 1) {
      expect(points[index]?.[1] ?? 0).toBeGreaterThanOrEqual(points[index - 1]?.[1] ?? 0);
    }
    expect(weights.age_sec).toBeUndefined();
    expect(weights.intel_coverage).toBeUndefined();
    expect(result.model.coefficients.bundle_share).toBeGreaterThan(0.5);
    expect(result.validation.modelAuc).toBeGreaterThan(0.7);
    expect(result.validation.suggestedScoreAuc).toBeGreaterThan(0.7);
    expect(result.validation.currentScoreAuc).toBeGreaterThan(0.65);
    expect(() => parseWeights(result.suggestedWeights)).not.toThrow();
    expect(new ScoringModel(result.suggestedWeights).version).toMatch(/^tuned-survived_15m-/);
    const calibrated = result.calibration.reduce((total, bucket) => total + bucket.count, 0);
    expect(calibrated).toBe(result.validationRows);
    const low = result.calibration.find((bucket) => bucket.from === 0);
    const high = result.calibration.find((bucket) => bucket.from === 80);
    expect(high?.badRate ?? 0).toBeGreaterThan((low?.badRate ?? 1) + 0.2);
  });

  it("orients bad-outcome labels directly", () => {
    const rows = syntheticRows(1_500, "tune-b");
    const result = tune(rows, "rugged", { version: "custom", validationFraction: 0.25 });
    expect(result.target).toBe("rugged = true");
    expect(result.features[0]?.feature).toBe("bundle_share");
    expect(result.suggestedWeights.version).toBe("custom");
    expect(result.splitAtMs).not.toBeNull();
  });

  it("carries solo terms over for features that stay higher-is-riskier", () => {
    const rows = syntheticRows(1_500, "tune-solo");
    const base = parseWeights({
      version: "base",
      features: {
        bundle_share: { weight: 1, points: [[0, 0], [1, 1]], solo: 77 },
        unique_buyers_per_min: { weight: 1, points: [[0, 1], [60, 0]], solo: 66 }
      }
    });
    const result = tune(rows, "rugged", { soloFrom: base });
    expect(result.suggestedWeights.features.bundle_share?.solo).toBe(77);
    expect(result.suggestedWeights.features.dev_share?.solo).toBeUndefined();
    expect(tune(rows, "rugged").suggestedWeights.features.bundle_share?.solo).toBe(85);
  });

  it("learns a lower-is-riskier shape", () => {
    const rng = createRng("lower");
    const rows = syntheticRows(2_000, "tune-c").map((row) => {
      const buyers = rng() * 60;
      const bad = rng() < sigmoid(2 - buyers / 8);
      return {
        ...row,
        features: { ...row.features, unique_buyers_per_min: buyers },
        labels: { ...row.labels, rugged: bad, survived15m: !bad }
      };
    });
    const result = tune(rows, "rugged", { features: ["unique_buyers_per_min", "dev_share"] });
    expect(result.features[0]?.feature).toBe("unique_buyers_per_min");
    expect(result.features[0]?.direction).toBe("lower_riskier");
    const points = result.suggestedWeights.features.unique_buyers_per_min?.points ?? [];
    expect(points[0]?.[1]).toBe(1);
    expect(points[points.length - 1]?.[1]).toBe(0);
  });

  it("splits by time without separating checkpoints of one launch", () => {
    const rows = syntheticRows(40, "split").flatMap((row) => [row, { ...row, checkpointSec: 60 }]);
    const labeled = rows.map((row) => ({ row, bad: row.labels.rugged }));
    const { train, validation, splitAtMs } = timeSplit(labeled, 0.3);
    expect(train.length + validation.length).toBe(80);
    const lastTrain = train[train.length - 1]?.row;
    const firstValidation = validation[0]?.row;
    expect(lastTrain?.launchId).not.toBe(firstValidation?.launchId);
    expect((lastTrain?.createdAtMs ?? 0) < (firstValidation?.createdAtMs ?? 0)).toBe(true);
    expect(splitAtMs).toBe(firstValidation?.createdAtMs);
    expect(timeSplit(labeled.slice(0, 10), 0.3).validation).toEqual([]);
  });

  it("skips unknown labels and rejects empty datasets", () => {
    const rows = syntheticRows(30, "empty").map((row) => ({ ...row, labels: { ...row.labels, survived15m: null } }));
    expect(() => tune(rows, "survived_15m")).toThrow(/no rows/);
    expect(() => tune([], "rugged")).toThrow();
    expect(badOutcome(rows[0] as DatasetRow, "survived_15m")).toBeNull();
    expect(badOutcome({ ...(rows[0] as DatasetRow), labels: { ...(rows[0] as DatasetRow).labels, migrated: true } }, "migrated")).toBe(false);
  });

  it("treats a rug within the first hour as the bad outcome and skips launches whose rugged_1h label is not known yet", () => {
    const rows = syntheticRows(60, "rug-1h").map((row) => ({ ...row, labels: { ...row.labels, rugged1h: row.labels.rugged } }));
    const first = rows[0] as DatasetRow;
    expect(badOutcome({ ...first, labels: { ...first.labels, rugged1h: true } }, "rugged_1h")).toBe(true);
    expect(badOutcome({ ...first, labels: { ...first.labels, rugged1h: false } }, "rugged_1h")).toBe(false);
    expect(badOutcome({ ...first, labels: { ...first.labels, rugged1h: null } }, "rugged_1h")).toBeNull();
    expect(targetDescription("rugged_1h")).toBe("rugged_1h = true");
    expect(targetDescription("survived_15m")).toBe("survived_15m = false");
    const unknownTail = rows.map((row, index) => (index >= 50 ? { ...row, labels: { ...row.labels, rugged1h: null } } : row));
    const result = tune(unknownTail, "rugged_1h");
    expect(result.rows).toBe(50);
    expect(result.target).toBe("rugged_1h = true");
    expect(result.baseRate).toBeGreaterThan(0);
  });

  it("builds calibration buckets that include a score of exactly 100", () => {
    const table = calibrationTable([0, 9.99, 10, 55, 100], [false, true, true, false, true], 10);
    expect(table).toHaveLength(10);
    expect(table[0]).toEqual({ from: 0, to: 10, count: 2, badRate: 0.5, meanScore: 4.995 });
    expect(table[1]?.count).toBe(1);
    expect(table[9]).toEqual({ from: 90, to: 100, count: 1, badRate: 1, meanScore: 100 });
    expect(table[3]?.badRate).toBeNull();
  });

  it("gives binary features two-point shapes and missing rows their own risk", () => {
    const rows = syntheticRows(400, "binary").map((row, index) => ({
      row: { ...row, features: { flag: index % 3 === 0 ? null : index % 2 } },
      bad: index % 3 === 0 ? true : index % 2 === 1
    }));
    const shape = riskShape(rows, "flag", true, 0.5);
    expect(shape.points.map((point) => point[0])).toEqual([0, 1]);
    expect(shape.points[0]?.[1]).toBe(0);
    expect(shape.points[1]?.[1]).toBe(1);
    expect(shape.missingRisk).toBe(1);
    expect(riskShape(rows, "absent", true, 0.5)).toEqual({ weight: 0, points: [[0, 0.5]], missingRisk: 0.5 });
  });
});
