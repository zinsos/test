import type { ScorerConfig } from "../config/strategy.js";
import { moduleLogger } from "../core/logger.js";
import type { FeatureVector } from "../core/types.js";
import type { Db } from "../db/pool.js";
import { DEFAULT_WEIGHTS, loadActiveWeights, loadWeightsFile, parseWeights, type WeightsFile } from "./weights.js";

const log = moduleLogger("scorer-model");

export type HardBlockConfig = ScorerConfig["hardBlocks"];

export interface ModelScore {
  score: number;
  hardBlocked: boolean;
  flags: string[];
  contributions: Record<string, number>;
  weightsVersion: string;
}

interface ModelEntry {
  name: string;
  weight: number;
  points: Array<[number, number]>;
  missingRisk: number;
}

export function riskAt(points: ReadonlyArray<readonly [number, number]>, x: number): number {
  const first = points[0];
  if (!first) {
    return 0;
  }
  if (x <= first[0]) {
    return first[1];
  }
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    const left = points[index - 1];
    if (!right || !left) {
      continue;
    }
    if (x <= right[0]) {
      const span = right[0] - left[0];
      if (span <= 0) {
        return right[1];
      }
      return left[1] + ((x - left[0]) / span) * (right[1] - left[1]);
    }
  }
  return points[points.length - 1]?.[1] ?? 0;
}

function usable(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function above(features: FeatureVector, name: string, threshold: number): boolean {
  const value = features[name];
  return usable(value) && value > threshold;
}

export function hardBlockFlags(features: FeatureVector, hardBlocks: HardBlockConfig): string[] {
  const flags: string[] = [];
  if (above(features, "dev_share", hardBlocks.devShareAbove)) {
    flags.push("hard_dev_share");
  }
  if (above(features, "bundle_share", hardBlocks.bundleShareAbove)) {
    flags.push("hard_bundle_share");
  }
  if (above(features, "largest_cluster_share", hardBlocks.clusterShareAbove)) {
    flags.push("hard_cluster_share");
  }
  const outcomes = features.dev_outcome_count;
  if (
    above(features, "dev_rug_rate", hardBlocks.devRugRateAbove) &&
    usable(outcomes) &&
    outcomes >= hardBlocks.devRugMinLaunches
  ) {
    flags.push("hard_dev_rug_rate");
  }
  return flags;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class ScoringModel {
  readonly weights: WeightsFile;
  private readonly entries: ModelEntry[];

  constructor(weights: WeightsFile) {
    this.weights = parseWeights(weights);
    this.entries = Object.entries(this.weights.features)
      .filter(([, spec]) => spec.weight > 0)
      .map(([name, spec]) => ({
        name,
        weight: spec.weight,
        points: [...spec.points].sort((a, b) => a[0] - b[0]),
        missingRisk: spec.missingRisk
      }));
  }

  static default(): ScoringModel {
    return new ScoringModel(DEFAULT_WEIGHTS);
  }

  get version(): string {
    return this.weights.version;
  }

  featureNames(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  rawScore(features: FeatureVector): { score: number; contributions: Record<string, number> } {
    const parts: Array<{ name: string; weight: number; risk: number }> = [];
    let totalWeight = 0;
    for (const entry of this.entries) {
      const value = features[entry.name];
      const missing = !usable(value);
      const weight = missing ? entry.weight / 2 : entry.weight;
      const risk = missing ? entry.missingRisk : riskAt(entry.points, value);
      parts.push({ name: entry.name, weight, risk });
      totalWeight += weight;
    }
    const contributions: Record<string, number> = {};
    if (totalWeight <= 0) {
      return { score: 0, contributions };
    }
    let score = 0;
    for (const part of parts) {
      const contribution = (100 * part.weight * part.risk) / totalWeight;
      contributions[part.name] = round(contribution, 3);
      score += contribution;
    }
    return { score: Math.min(100, Math.max(0, score)), contributions };
  }

  score(features: FeatureVector, hardBlocks: HardBlockConfig): ModelScore {
    const { score, contributions } = this.rawScore(features);
    const flags = hardBlockFlags(features, hardBlocks);
    return {
      score: round(score, 2),
      hardBlocked: flags.length > 0,
      flags,
      contributions,
      weightsVersion: this.version
    };
  }
}

export type WeightsSource = "db" | "file" | "default";

export interface LoadModelOptions {
  db?: Db | null;
  filePath?: string | null;
}

export async function loadScoringModel(options: LoadModelOptions): Promise<{ model: ScoringModel; source: WeightsSource }> {
  if (options.db) {
    try {
      const active = await loadActiveWeights(options.db);
      if (active) {
        return { model: new ScoringModel(active), source: "db" };
      }
    } catch (error) {
      log.warn({ err: error }, "failed to load active scorer weights from database");
    }
  }
  if (options.filePath) {
    try {
      const fromFile = await loadWeightsFile(options.filePath);
      if (fromFile) {
        return { model: new ScoringModel(fromFile), source: "file" };
      }
    } catch (error) {
      log.warn({ err: error, file: options.filePath }, "failed to load scorer weights file");
    }
  }
  return { model: ScoringModel.default(), source: "default" };
}

export function exceedsRisk(score: Pick<ModelScore, "score" | "hardBlocked">, maxRisk: number): boolean {
  return score.hardBlocked || score.score > maxRisk;
}
