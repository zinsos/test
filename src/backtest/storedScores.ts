import type { Db } from "../db/pool.js";
import { loadStoredFeatures, type StoredFeaturesIndex } from "../scorer/storedFeatures.js";
import type { StoredFeatures, StoredFeaturesLookup } from "../scorer/types.js";

const MINUTE_MS = 60_000;

export interface RollingStoredFeaturesOptions {
  db: Db;
  fromMs: number;
  toMs: number;
  chunkMs?: number;
  retentionMs?: number;
}

interface Chunk {
  startMs: number;
  endMs: number;
  index: StoredFeaturesIndex;
}

export class RollingStoredFeatures {
  private readonly db: Db;
  private readonly fromMs: number;
  private readonly toMs: number;
  private readonly chunkMs: number;
  private readonly retentionMs: number;
  private chunks: Chunk[] = [];
  private loadedUntilMs: number;
  private launchesLoaded = 0;
  private nextCheckMs = Number.NEGATIVE_INFINITY;

  constructor(options: RollingStoredFeaturesOptions) {
    this.db = options.db;
    this.fromMs = options.fromMs;
    this.toMs = options.toMs;
    this.chunkMs = Math.max(MINUTE_MS, options.chunkMs ?? 30 * MINUTE_MS);
    this.retentionMs = Math.max(this.chunkMs, options.retentionMs ?? 2 * 60 * MINUTE_MS);
    this.loadedUntilMs = options.fromMs;
  }

  get size(): number {
    return this.launchesLoaded;
  }

  chunkCount(): number {
    return this.chunks.length;
  }

  async advanceTo(nowMs: number): Promise<void> {
    const wantedUntil = Math.min(this.toMs, nowMs + this.chunkMs);
    while (this.loadedUntilMs < wantedUntil) {
      const startMs = this.loadedUntilMs;
      const endMs = Math.min(this.toMs, startMs + this.chunkMs);
      const index = await loadStoredFeatures(this.db, { from: new Date(startMs), to: new Date(endMs) });
      this.chunks.push({ startMs, endMs, index });
      this.launchesLoaded += index.size;
      this.loadedUntilMs = endMs;
    }
    const keepAfter = nowMs - this.retentionMs;
    this.chunks = this.chunks.filter((chunk) => chunk.endMs > keepAfter);
    const loadCheckMs = this.loadedUntilMs >= this.toMs ? Number.POSITIVE_INFINITY : this.loadedUntilMs - this.chunkMs + 1;
    const first = this.chunks[0];
    const dropCheckMs = first ? first.endMs + this.retentionMs : Number.POSITIVE_INFINITY;
    this.nextCheckMs = Math.min(loadCheckMs, dropCheckMs);
  }

  needsAdvance(nowMs: number): boolean {
    return nowMs >= this.nextCheckMs;
  }

  get(mint: string, checkpointSec: number): StoredFeatures | null {
    for (let index = this.chunks.length - 1; index >= 0; index -= 1) {
      const found = this.chunks[index]?.index.get(mint, checkpointSec);
      if (found) {
        return found;
      }
    }
    return null;
  }

  lookup(): StoredFeaturesLookup {
    return (mint, checkpointSec) => this.get(mint, checkpointSec);
  }

  loadedRange(): { fromMs: number; untilMs: number } {
    return { fromMs: this.fromMs, untilMs: this.loadedUntilMs };
  }
}
