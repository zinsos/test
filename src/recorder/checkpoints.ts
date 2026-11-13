import { randomUUID } from "node:crypto";
import { toNullableNumber, toNumber, type Db } from "../db/pool.js";

export interface StreamPosition {
  slot: number;
  atMs: number;
}

export interface PredecessorCoverage {
  slot: number | null;
  atMs: number | null;
  liveInstances: number;
  source: "checkpoints" | "launches" | "none";
}

interface CoverageRow {
  slot: unknown;
  at: Date | null;
  live: unknown;
  streamed: unknown;
}

interface LegacyRow {
  slot: unknown;
  at: Date | null;
  tracked: unknown;
}

const RETENTION_DAYS = 30;

function dateOf(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

export class RecorderCheckpointStore {
  readonly instance: string;

  constructor(
    private readonly db: Db,
    instance?: string
  ) {
    this.instance = instance ?? randomUUID();
  }

  async register(startedAtMs: number): Promise<void> {
    await this.db.query(
      `INSERT INTO recorder_checkpoints (instance, started_at, updated_at) VALUES ($1, $2, $2)
       ON CONFLICT (instance) DO UPDATE SET started_at = EXCLUDED.started_at, updated_at = EXCLUDED.updated_at, stopped_at = NULL`,
      [this.instance, new Date(startedAtMs)]
    );
    await this.db.query("DELETE FROM recorder_checkpoints WHERE updated_at < $1", [
      new Date(startedAtMs - RETENTION_DAYS * 86_400_000)
    ]);
  }

  async save(first: StreamPosition | null, durable: StreamPosition | null, nowMs: number, stopped: boolean): Promise<void> {
    await this.db.query(
      `UPDATE recorder_checkpoints
          SET first_slot = COALESCE(first_slot, $2::bigint),
              first_event_at = COALESCE(first_event_at, $3::timestamptz),
              last_slot = GREATEST(last_slot, $4::bigint),
              last_event_at = CASE WHEN last_slot IS NULL OR $4::bigint >= last_slot THEN COALESCE($5::timestamptz, last_event_at) ELSE last_event_at END,
              updated_at = $6,
              stopped_at = CASE WHEN $7 THEN $6 ELSE stopped_at END
        WHERE instance = $1`,
      [this.instance, first?.slot ?? null, dateOf(first?.atMs), durable?.slot ?? null, dateOf(durable?.atMs), new Date(nowMs), stopped]
    );
  }

  async checkpointCoverage(firstSlot: number, liveSinceMs: number): Promise<PredecessorCoverage> {
    const result = await this.db.query<CoverageRow>(
      `SELECT max(last_slot) AS slot,
              (array_agg(last_event_at ORDER BY last_slot DESC NULLS LAST))[1] AS at,
              count(*) FILTER (WHERE stopped_at IS NULL AND updated_at >= $3) AS live,
              count(*) FILTER (WHERE last_slot IS NOT NULL) AS streamed
         FROM recorder_checkpoints
        WHERE instance <> $1 AND first_slot IS NOT NULL AND first_slot <= $2`,
      [this.instance, firstSlot, new Date(liveSinceMs)]
    );
    const row = result.rows[0];
    const liveInstances = row ? toNumber(row.live) : 0;
    if (!row || toNumber(row.streamed) === 0) {
      return { slot: null, atMs: null, liveInstances, source: "none" };
    }
    return { slot: toNullableNumber(row.slot), atMs: row.at ? row.at.getTime() : null, liveInstances, source: "checkpoints" };
  }

  async legacyCoverage(firstSlot: number): Promise<PredecessorCoverage> {
    const result = await this.db.query<LegacyRow>(
      `SELECT max(last_trade_slot) AS slot, max(GREATEST(last_trade_at, created_at)) AS at, count(*) AS tracked
         FROM launches WHERE tracking_ended_at IS NULL AND create_slot < $1`,
      [firstSlot]
    );
    const row = result.rows[0];
    if (!row || toNumber(row.tracked) === 0) {
      return { slot: null, atMs: null, liveInstances: 0, source: "none" };
    }
    return { slot: toNullableNumber(row.slot), atMs: row.at ? row.at.getTime() : null, liveInstances: 0, source: "launches" };
  }
}
