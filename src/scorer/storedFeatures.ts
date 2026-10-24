import type { FeatureVector, Pubkey } from "../core/types.js";
import type { Db } from "../db/pool.js";
import { REPLAY_STORED_FEATURES } from "./featureNames.js";
import type { StoredFeatures, StoredFeaturesLookup } from "./types.js";

interface StoredEntry {
  checkpointSec: number;
  slot: number;
  computedAtMs: number;
  insiders: readonly Pubkey[];
}

export interface StoredFeaturesLoadOptions {
  from?: Date | null;
  to?: Date | null;
  keys?: readonly string[];
  pageSize?: number;
}

const NO_INSIDERS: readonly Pubkey[] = Object.freeze([]);
const INITIAL_SLOTS = 64;

export class StoredFeaturesIndex {
  private readonly byMint = new Map<Pubkey, StoredEntry[]>();
  private readonly width: number;
  private values: Float64Array;
  private present: Uint8Array;
  private slots = 0;

  constructor(readonly keys: readonly string[] = REPLAY_STORED_FEATURES) {
    this.width = keys.length;
    this.values = new Float64Array(INITIAL_SLOTS * this.width);
    this.present = new Uint8Array(INITIAL_SLOTS * this.width);
  }

  get size(): number {
    return this.byMint.size;
  }

  add(mint: Pubkey, checkpointSec: number, features: Record<string, unknown>, computedAtMs: number, insiders: readonly Pubkey[]): void {
    let entries = this.byMint.get(mint);
    if (!entries) {
      entries = [];
      this.byMint.set(mint, entries);
    }
    const slot = this.allocate();
    const base = slot * this.width;
    for (let index = 0; index < this.width; index += 1) {
      const key = this.keys[index] as string;
      if (!(key in features)) {
        continue;
      }
      const value = features[key];
      this.present[base + index] = 1;
      this.values[base + index] = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
    }
    const entry: StoredEntry = { checkpointSec, slot, computedAtMs, insiders: insiders.length === 0 ? NO_INSIDERS : insiders };
    const existing = entries.findIndex((candidate) => candidate.checkpointSec === checkpointSec);
    if (existing >= 0) {
      entries[existing] = entry;
    } else {
      entries.push(entry);
    }
  }

  get(mint: Pubkey, checkpointSec: number): StoredFeatures | null {
    const entries = this.byMint.get(mint);
    if (!entries) {
      return null;
    }
    let stored: StoredEntry | undefined;
    for (const entry of entries) {
      if (entry.checkpointSec === checkpointSec) {
        stored = entry;
        break;
      }
    }
    if (!stored) {
      return null;
    }
    const base = stored.slot * this.width;
    const features: FeatureVector = {};
    for (let index = 0; index < this.width; index += 1) {
      if (this.present[base + index] === 1) {
        const value = this.values[base + index] ?? Number.NaN;
        features[this.keys[index] as string] = Number.isNaN(value) ? null : value;
      }
    }
    return { features, computedAtMs: stored.computedAtMs, insiders: stored.insiders };
  }

  checkpoints(mint: Pubkey): number[] {
    return (this.byMint.get(mint) ?? []).map((entry) => entry.checkpointSec).sort((a, b) => a - b);
  }

  lookup(): StoredFeaturesLookup {
    return (mint, checkpointSec) => this.get(mint, checkpointSec);
  }

  seal(): void {
    const used = this.slots * this.width;
    if (used < this.values.length) {
      this.values = this.values.slice(0, used);
      this.present = this.present.slice(0, used);
    }
  }

  private allocate(): number {
    const needed = (this.slots + 1) * this.width;
    if (needed > this.values.length) {
      const capacity = Math.max(needed, this.values.length * 2, INITIAL_SLOTS * this.width);
      const values = new Float64Array(capacity);
      values.set(this.values);
      const present = new Uint8Array(capacity);
      present.set(this.present);
      this.values = values;
      this.present = present;
    }
    const slot = this.slots;
    this.slots += 1;
    return slot;
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
  index.seal();
  return index;
}
