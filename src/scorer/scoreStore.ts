import { moduleLogger } from "../core/logger.js";
import type { LaunchScore, Pubkey } from "../core/types.js";
import type { Db } from "../db/pool.js";
import type { ScoreExtras } from "./types.js";

const log = moduleLogger("score-store");

export interface LaunchScoreStoreOptions {
  db: Db;
  flushIntervalMs?: number;
  maxAttempts?: number;
  maxBuffered?: number;
}

interface PendingScore {
  score: LaunchScore;
  insiders: readonly Pubkey[];
  attempts: number;
}

const UPSERT_SQL = `
INSERT INTO launch_scores (launch_id, checkpoint_sec, mint, computed_at, slot, score, hard_blocked, flags,
                           features, contributions, weights_version, insiders)
SELECT l.id, v.checkpoint_sec, v.mint, v.computed_at, v.slot, v.score, v.hard_blocked,
       ARRAY(SELECT jsonb_array_elements_text(v.flags)), v.features, v.contributions, v.weights_version,
       ARRAY(SELECT jsonb_array_elements_text(v.insiders))
  FROM unnest($1::text[], $2::int[], $3::timestamptz[], $4::bigint[], $5::float8[], $6::bool[], $7::jsonb[],
              $8::jsonb[], $9::jsonb[], $10::text[], $11::jsonb[])
       AS v(mint, checkpoint_sec, computed_at, slot, score, hard_blocked, flags, features, contributions,
            weights_version, insiders)
  JOIN launches l ON l.mint = v.mint
ON CONFLICT (launch_id, checkpoint_sec) DO UPDATE SET
  mint = EXCLUDED.mint,
  computed_at = EXCLUDED.computed_at,
  slot = EXCLUDED.slot,
  score = EXCLUDED.score,
  hard_blocked = EXCLUDED.hard_blocked,
  flags = EXCLUDED.flags,
  features = EXCLUDED.features,
  contributions = EXCLUDED.contributions,
  weights_version = EXCLUDED.weights_version,
  insiders = EXCLUDED.insiders
RETURNING mint, checkpoint_sec`;

function keyOf(mint: Pubkey, checkpointSec: number): string {
  return `${mint}:${checkpointSec}`;
}

function finiteFeatures(features: LaunchScore["features"]): Record<string, number | null> {
  const clean: Record<string, number | null> = {};
  for (const [name, value] of Object.entries(features)) {
    clean[name] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return clean;
}

export class LaunchScoreStore {
  private pending = new Map<string, PendingScore>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private readonly flushIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly maxBuffered: number;
  private written = 0;
  private dropped = 0;

  constructor(private readonly options: LaunchScoreStoreOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? 2_000;
    this.maxAttempts = options.maxAttempts ?? 30;
    this.maxBuffered = options.maxBuffered ?? 20_000;
  }

  readonly sink = (score: LaunchScore, extras: ScoreExtras): void => {
    this.push(score, extras.insiders);
  };

  push(score: LaunchScore, insiders: readonly Pubkey[] = []): void {
    const key = keyOf(score.mint, score.checkpointSec);
    if (!this.pending.has(key) && this.pending.size >= this.maxBuffered) {
      this.dropped += 1;
      log.warn({ mint: score.mint }, "launch score buffer full, score dropped");
      return;
    }
    this.pending.set(key, { score, insiders, attempts: 0 });
  }

  stats(): { buffered: number; written: number; dropped: number } {
    return { buffered: this.pending.size, written: this.written, dropped: this.dropped };
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
    }
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  private async flushOnce(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }
    const batch = this.pending;
    this.pending = new Map();
    const entries = [...batch.values()];
    let stored: Set<string>;
    try {
      stored = await this.write(entries);
    } catch (error) {
      log.warn({ err: error, rows: entries.length }, "launch score write failed, will retry");
      stored = new Set();
    }
    this.written += stored.size;
    for (const entry of entries) {
      const key = keyOf(entry.score.mint, entry.score.checkpointSec);
      if (stored.has(key) || this.pending.has(key)) {
        continue;
      }
      entry.attempts += 1;
      if (entry.attempts >= this.maxAttempts) {
        this.dropped += 1;
        log.warn({ mint: entry.score.mint, checkpointSec: entry.score.checkpointSec }, "launch row never appeared, score dropped");
        continue;
      }
      this.pending.set(key, entry);
    }
  }

  private async write(entries: readonly PendingScore[]): Promise<Set<string>> {
    const result = await this.options.db.query<{ mint: string; checkpoint_sec: number }>(UPSERT_SQL, [
      entries.map((entry) => entry.score.mint),
      entries.map((entry) => entry.score.checkpointSec),
      entries.map((entry) => new Date(entry.score.computedAtMs)),
      entries.map((entry) => entry.score.slot.toString()),
      entries.map((entry) => entry.score.score),
      entries.map((entry) => entry.score.hardBlocked),
      entries.map((entry) => JSON.stringify(entry.score.flags)),
      entries.map((entry) => JSON.stringify(finiteFeatures(entry.score.features))),
      entries.map((entry) => JSON.stringify(entry.score.contributions)),
      entries.map((entry) => entry.score.weightsVersion),
      entries.map((entry) => JSON.stringify(entry.insiders))
    ]);
    return new Set(result.rows.map((row) => keyOf(row.mint, row.checkpoint_sec)));
  }
}
