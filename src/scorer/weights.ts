import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { withTransaction, type Db } from "../db/pool.js";

const RiskPoint = z.tuple([z.number(), z.number().min(0).max(1)]);

export const FeatureWeightSchema = z.object({
  weight: z.number().min(0),
  points: z.array(RiskPoint).min(1),
  missingRisk: z.number().min(0).max(1).default(0.5),
  solo: z.number().min(0).max(100).optional()
});

export const WeightsFileSchema = z.object({
  version: z.string().min(1),
  label: z.string().optional(),
  createdAt: z.string().optional(),
  features: z.record(z.string(), FeatureWeightSchema)
});

export type RiskPoints = Array<[number, number]>;
export type FeatureWeight = z.infer<typeof FeatureWeightSchema>;
export type WeightsFile = z.infer<typeof WeightsFileSchema>;

export function parseWeights(raw: unknown): WeightsFile {
  const parsed = WeightsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`invalid scorer weights: ${issues}`);
  }
  return parsed.data;
}

function feature(weight: number, points: RiskPoints, missingRisk: number, solo?: number): FeatureWeight {
  return solo === undefined ? { weight, points, missingRisk } : { weight, points, missingRisk, solo };
}

export const DEFAULT_WEIGHTS: WeightsFile = {
  version: "hand-v2",
  label: "hand-set defaults: bundles and funding clusters first, then dev, concentration, flow, metadata; strong single red flags score on their own",
  features: {
    bundle_bought_share: feature(18, [[0, 0], [0.02, 0.25], [0.05, 0.6], [0.1, 0.9], [0.2, 1]], 0.3, 85),
    bundle_share: feature(14, [[0, 0], [0.02, 0.2], [0.05, 0.55], [0.1, 0.85], [0.2, 1]], 0.3, 85),
    creation_slot_buyers: feature(10, [[0, 0], [1, 0.2], [2, 0.45], [4, 0.8], [6, 1]], 0.3, 70),
    largest_cluster_share: feature(18, [[0, 0], [0.02, 0.2], [0.05, 0.5], [0.1, 0.8], [0.2, 1]], 0.4, 85),
    largest_cluster_size: feature(12, [[0, 0], [2, 0.45], [3, 0.7], [5, 0.9], [8, 1]], 0.4, 85),
    dev_funded_buyers: feature(12, [[0, 0], [1, 0.6], [2, 0.85], [3, 1]], 0.35, 80),
    cluster_count: feature(2, [[0, 0], [1, 0.4], [3, 1]], 0.4),
    dev_sold_fraction: feature(10, [[0, 0], [0.05, 0.3], [0.25, 0.75], [0.5, 0.95], [1, 1]], 0.3, 80),
    dev_share: feature(8, [[0, 0], [0.02, 0.1], [0.05, 0.35], [0.1, 0.7], [0.2, 1]], 0.4, 75),
    dev_rug_rate: feature(8, [[0, 0], [0.2, 0.2], [0.5, 0.65], [0.8, 1]], 0.35, 75),
    dev_initial_share: feature(2, [[0, 0.1], [0.03, 0.2], [0.08, 0.6], [0.15, 1]], 0.4),
    dev_launch_count: feature(2, [[0, 0.3], [1, 0.25], [3, 0.5], [10, 0.85], [30, 1]], 0.35),
    dev_migration_rate: feature(1.5, [[0, 0.6], [0.1, 0.3], [0.3, 0]], 0.45),
    dev_median_peak_multiple: feature(1.5, [[1, 0.8], [2, 0.5], [5, 0.2], [10, 0]], 0.45),
    fresh_wallet_ratio: feature(6, [[0, 0], [0.2, 0.15], [0.4, 0.45], [0.6, 0.75], [0.8, 1]], 0.4, 60),
    top10_share: feature(5, [[0.1, 0], [0.2, 0.2], [0.3, 0.5], [0.45, 0.85], [0.6, 1]], 0.5, 60),
    wash_ratio: feature(3, [[0, 0], [0.1, 0.3], [0.25, 0.7], [0.5, 1]], 0.3),
    unique_buyers_per_min: feature(2.5, [[0, 1], [3, 0.75], [10, 0.4], [25, 0.15], [60, 0]], 0.6),
    volume_hhi: feature(2.5, [[0.02, 0], [0.05, 0.2], [0.1, 0.45], [0.2, 0.8], [0.35, 1]], 0.5),
    buy_sell_count_ratio: feature(1, [[0.5, 1], [1, 0.6], [1.5, 0.35], [3, 0.1]], 0.5),
    buy_sell_volume_ratio: feature(1, [[0.5, 1], [1, 0.6], [1.5, 0.35], [3, 0.1]], 0.5),
    copycat: feature(2, [[0, 0], [1, 1]], 0.3),
    socials_count: feature(1, [[0, 1], [1, 0.5], [2, 0.2], [3, 0]], 0.5),
    same_ticker_recent: feature(1, [[0, 0], [1, 0.4], [5, 1]], 0.3)
  }
};

export async function loadWeightsFile(filePath: string): Promise<WeightsFile | null> {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) {
    return null;
  }
  return parseWeights(JSON.parse(await readFile(resolved, "utf8")));
}

const PAIR_PATTERN = /\[\s*(-?[\d.eE+-]+),\s*(-?[\d.eE+-]+)\s*\]/g;
const POINTS_PATTERN = /"points": \[\s*((?:\[[^\]]*\],?\s*)+)\]/g;

export function formatWeights(weights: WeightsFile): string {
  const pretty = JSON.stringify(weights, null, 2).replace(PAIR_PATTERN, "[$1, $2]");
  return pretty.replace(POINTS_PATTERN, (_match, inner: string) => `"points": [${inner.trim().split(/,\s*(?=\[)/).join(", ")}]`);
}

export async function writeWeightsFile(filePath: string, weights: WeightsFile): Promise<void> {
  const resolved = path.resolve(process.cwd(), filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${formatWeights(weights)}\n`, "utf8");
}

export async function loadActiveWeights(db: Db): Promise<WeightsFile | null> {
  const result = await db.query<{ weights: unknown }>(
    "SELECT weights FROM scorer_weights WHERE active ORDER BY created_at DESC LIMIT 1"
  );
  const row = result.rows[0];
  return row ? parseWeights(row.weights) : null;
}

export async function loadWeightsVersion(db: Db, version: string): Promise<WeightsFile | null> {
  const result = await db.query<{ weights: unknown }>("SELECT weights FROM scorer_weights WHERE version = $1", [version]);
  const row = result.rows[0];
  return row ? parseWeights(row.weights) : null;
}

export interface SaveWeightsInput {
  weights: WeightsFile;
  labelName?: string | null;
  metrics?: unknown;
  activate?: boolean;
  filePath?: string | null;
}

export async function saveWeights(db: Db, input: SaveWeightsInput): Promise<void> {
  const weights = parseWeights(input.weights);
  await withTransaction(db, async (client) => {
    await client.query(
      `INSERT INTO scorer_weights (version, label_name, weights, metrics, active)
       VALUES ($1, $2, $3, $4, FALSE)
       ON CONFLICT (version) DO UPDATE SET label_name = EXCLUDED.label_name, weights = EXCLUDED.weights, metrics = EXCLUDED.metrics`,
      [weights.version, input.labelName ?? null, JSON.stringify(weights), JSON.stringify(input.metrics ?? null)]
    );
    if (input.activate) {
      await client.query("UPDATE scorer_weights SET active = (version = $1) WHERE active OR version = $1", [
        weights.version
      ]);
    }
  });
  if (input.filePath) {
    await writeWeightsFile(input.filePath, weights);
  }
}
