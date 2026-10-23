import type { FeatureVector, Pubkey } from "../core/types.js";
import type { Db } from "../db/pool.js";
import { REPLAY_STORED_FEATURES } from "./featureNames.js";
import type { StoredFeatures, StoredFeaturesLookup } from "./types.js";

interface CompactStored {
  values: Float64Array;
  present: Uint8Array;
  computedAtMs: number;
  insiders: readonly Pubkey[];
}

export interface StoredFeaturesLoadOptions {
  from?: Date | null;
  to?: Date | null;
  keys?: readonly string[];
  pageSize?: number;
}

function compact(features: Record<string, unknown>, keys: readonly string[]): Pick<CompactStored, "values" | "present"> {
  const values = new Float64Array(keys.length);
  const present = new Uint8Array(keys.length);
  keys.forEach((key, index) => {
    if (!(key in features)) {
      return;
    }
    const value = features[key];
    present[index] = 1;
    values[index] = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  });
  return { values, present };
}

export class StoredFeaturesIndex {
  private readonly byMint = new Map<Pubkey, Map<number, CompactStored>>();

  constructor(readonly keys: readonly string[] = REPLAY_STORED_FEATURES) {}

  get size(): number {
    return this.byMint.size;
  }

  add(mint: Pubkey, checkpointSec: number, features: Record<string, unknown>, computedAtMs: number, insiders: readonly Pubkey[]): void {
    let checkpoints = this.byMint.get(mint);
    if (!checkpoints) {
      checkpoints = new Map();
      this.byMint.set(mint, checkpoints);
    }
    checkpoints.set(checkpointSec, { ...compact(features, this.keys), computedAtMs, insiders });
  }

  get(mint: Pubkey, checkpointSec: number): StoredFeatures | null {
    const stored = this.byMint.get(mint)?.get(checkpointSec);
    if (!stored) {
      return null;
    }
    const features: FeatureVector = {};
    this.keys.forEach((key, index) => {
      if (stored.present[index] === 1) {
        const value = stored.values[index] ?? Number.NaN;
        features[key] = Number.isNaN(value) ? null : value;
      }
    });
    return { features, computedAtMs: stored.computedAtMs, insiders: stored.insiders };
  }

  checkpoints(mint: Pubkey): number[] {
    return [...(this.byMint.get(mint)?.keys() ?? [])].sort((a, b) => a - b);
  }

  lookup(): StoredFeaturesLookup {
    return (mint, checkpointSec) => this.get(mint, checkpointSec);
  }
}

interface StoredRow {
  launch_id: unknown;
  checkpoint_sec: number;
  mint: string;
  computed_at: Date;
  features: Record<string, unknown>;
  insiders: string[] | null;
}

export async function loadStoredFeatures(db: Db, options: StoredFeaturesLoadOptions = {}): Promise<StoredFeaturesIndex> {
  const index = new StoredFeaturesIndex(options.keys ?? REPLAY_STORED_FEATURES);
  const pageSize = options.pageSize ?? 5_000;
  let afterLaunch = "0";
  let afterCheckpoint = -1;
  for (;;) {
    const result = await db.query<StoredRow>(
      `SELECT s.launch_id, s.checkpoint_sec, s.mint, s.computed_at, s.features, s.insiders
         FROM launch_scores s
         JOIN launches l ON l.id = s.launch_id
        WHERE ($1::timestamptz IS NULL OR l.created_at >= $1)
          AND ($2::timestamptz IS NULL OR l.created_at < $2)
          AND (s.launch_id, s.checkpoint_sec) > ($3::bigint, $4::int)
        ORDER BY s.launch_id, s.checkpoint_sec
        LIMIT $5`,
      [options.from ?? null, options.to ?? null, afterLaunch, afterCheckpoint, pageSize]
    );
    for (const row of result.rows) {
      index.add(row.mint, row.checkpoint_sec, row.features, row.computed_at.getTime(), row.insiders ?? []);
    }
    const last = result.rows[result.rows.length - 1];
    if (!last || result.rows.length < pageSize) {
      break;
    }
    afterLaunch = String(last.launch_id);
    afterCheckpoint = last.checkpoint_sec;
  }
  return index;
}
