import type { Rng } from "./rng.js";

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

export function variance(values: readonly number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const avg = sum(values) / values.length;
  let acc = 0;
  for (const value of values) {
    acc += (value - avg) * (value - avg);
  }
  return acc / (values.length - 1);
}

export function stdev(values: readonly number[]): number | null {
  const v = variance(values);
  return v === null ? null : Math.sqrt(v);
}

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  if (trials <= 0) {
    return 0;
  }
  const phat = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = phat + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * trials)) / trials);
  return (centre - margin) / denominator;
}

const T_CRITICAL_95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12,
  2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042
];

export function tCritical95(degreesOfFreedom: number): number {
  if (degreesOfFreedom <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (degreesOfFreedom <= T_CRITICAL_95.length) {
    return T_CRITICAL_95[degreesOfFreedom - 1] ?? 1.96;
  }
  if (degreesOfFreedom <= 60) {
    return 2.0;
  }
  if (degreesOfFreedom <= 120) {
    return 1.98;
  }
  return 1.96;
}

export interface Interval {
  low: number;
  high: number;
}

export function meanConfidenceInterval95(values: readonly number[]): Interval | null {
  if (values.length < 2) {
    return null;
  }
  const avg = sum(values) / values.length;
  const sd = stdev(values) ?? 0;
  const margin = tCritical95(values.length - 1) * (sd / Math.sqrt(values.length));
  return { low: avg - margin, high: avg + margin };
}

export function bootstrapMeanInterval(
  values: readonly number[],
  rng: Rng,
  iterations = 2000,
  confidence = 0.95
): Interval | null {
  if (values.length < 2) {
    return null;
  }
  const means: number[] = new Array<number>(iterations);
  const n = values.length;
  for (let i = 0; i < iterations; i += 1) {
    let acc = 0;
    for (let j = 0; j < n; j += 1) {
      acc += values[Math.floor(rng() * n)] ?? 0;
    }
    means[i] = acc / n;
  }
  const alpha = (1 - confidence) / 2;
  return { low: quantile(means, alpha) ?? 0, high: quantile(means, 1 - alpha) ?? 0 };
}

export function rocAuc(scores: readonly number[], labels: readonly boolean[]): number | null {
  const pairs = scores.map((score, index) => ({ score, label: labels[index] === true }));
  const positives = pairs.filter((pair) => pair.label).length;
  const negatives = pairs.length - positives;
  if (positives === 0 || negatives === 0) {
    return null;
  }
  pairs.sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let index = 0;
  while (index < pairs.length) {
    let end = index;
    while (end + 1 < pairs.length && pairs[end + 1]?.score === pairs[index]?.score) {
      end += 1;
    }
    const averageRank = (index + end + 2) / 2;
    for (let k = index; k <= end; k += 1) {
      if (pairs[k]?.label) {
        rankSum += averageRank;
      }
    }
    index = end + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

export function herfindahl(amounts: readonly number[]): number {
  const total = sum(amounts);
  if (total <= 0) {
    return 0;
  }
  let acc = 0;
  for (const amount of amounts) {
    const share = amount / total;
    acc += share * share;
  }
  return acc;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function maxDrawdown(equityCurve: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const value of equityCurve) {
    peak = Math.max(peak, value);
    worst = Math.max(worst, peak - value);
  }
  return worst;
}
