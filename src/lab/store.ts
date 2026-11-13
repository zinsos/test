import { hashString } from "../core/rng.js";
import { jsonSafe, toNumber, withTransaction, type Db, type DbClient } from "../db/pool.js";
import type { LabScorerEntry } from "./scorerLab.js";
import type { LabVariantSummary } from "./summary.js";
import { LAB_LABEL_PREFIX, type JsonObject } from "./variants.js";

export const LAB_LOCK_NAME = "snypra-edge:lab";
export const DEFAULT_PRUNE_KEEP = 20;

export type LabStatus = "running" | "done" | "failed";

export interface NewLabRun {
  startedAtMs: number;
  dataFromMs: number;
  dataToMs: number;
  notes: JsonObject;
}

export interface NewLabVariant {
  labRunId: number;
  name: string;
  description: string;
  isBaseline: boolean;
  overrides: JsonObject;
  error?: string | null;
}

export interface LabVariantUpdate {
  strategyRunId?: number | null;
  summary?: LabVariantSummary | null;
  error?: string | null;
}

export interface LabPruneResult {
  kept: number;
  strategyRuns: number;
  positions: number;
  fills: number;
  signals: number;
  weights: number;
}

export interface LabLock {
  release(): Promise<void>;
}

function json(value: unknown): string {
  return JSON.stringify(jsonSafe(value));
}

export async function acquireLabLock(db: Db): Promise<LabLock | null> {
  const key = hashString(LAB_LOCK_NAME) | 0;
  const client: DbClient = await db.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key]);
    locked = result.rows[0]?.locked === true;
  } finally {
    if (!locked) {
      client.release();
    }
  }
  if (!locked) {
    return null;
  }
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [key]);
        client.release();
      } catch {
        client.release(true);
      }
    }
  };
}

export async function failInterruptedLabRuns(db: Db, atMs: number): Promise<number> {
  const result = await db.query(
    `UPDATE lab_runs SET status = 'failed', finished_at = $1, error = 'interrupted before it finished'
      WHERE status = 'running'`,
    [new Date(atMs)]
  );
  return result.rowCount ?? 0;
}

export async function createLabRun(db: Db, input: NewLabRun): Promise<number> {
  const result = await db.query<{ id: unknown }>(
    `INSERT INTO lab_runs (started_at, status, data_from, data_to, notes)
     VALUES ($1, 'running', $2, $3, $4) RETURNING id`,
    [new Date(input.startedAtMs), new Date(input.dataFromMs), new Date(input.dataToMs), json(input.notes)]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("lab run insert returned no id");
  }
  return toNumber(row.id);
}

export async function saveLabScorer(db: Db, labRunId: number, scorer: readonly LabScorerEntry[]): Promise<void> {
  await db.query("UPDATE lab_runs SET scorer = $2 WHERE id = $1", [labRunId, json(scorer)]);
}

export async function saveLabNotes(db: Db, labRunId: number, notes: JsonObject): Promise<void> {
  await db.query("UPDATE lab_runs SET notes = $2 WHERE id = $1", [labRunId, json(notes)]);
}

export async function finishLabRun(
  db: Db,
  labRunId: number,
  input: { status: Exclude<LabStatus, "running">; finishedAtMs: number; error: string | null; notes: JsonObject }
): Promise<void> {
  await db.query("UPDATE lab_runs SET status = $2, finished_at = $3, error = $4, notes = $5 WHERE id = $1", [
    labRunId,
    input.status,
    new Date(input.finishedAtMs),
    input.error,
    json(input.notes)
  ]);
}

export async function insertLabVariant(db: Db, input: NewLabVariant): Promise<number> {
  const result = await db.query<{ id: unknown }>(
    `INSERT INTO lab_variants (lab_run_id, name, description, is_baseline, overrides, error)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.labRunId, input.name, input.description, input.isBaseline, json(input.overrides), input.error ?? null]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("lab variant insert returned no id");
  }
  return toNumber(row.id);
}

export async function updateLabVariant(db: Db, variantId: number, update: LabVariantUpdate): Promise<void> {
  await db.query(
    `UPDATE lab_variants
        SET strategy_run_id = CASE WHEN $2::boolean THEN $3::bigint ELSE strategy_run_id END,
            summary = CASE WHEN $4::boolean THEN $5::jsonb ELSE summary END,
            error = CASE WHEN $6::boolean THEN $7::text ELSE error END
      WHERE id = $1`,
    [
      variantId,
      update.strategyRunId !== undefined,
      update.strategyRunId ?? null,
      update.summary !== undefined,
      update.summary === undefined || update.summary === null ? null : json(update.summary),
      update.error !== undefined,
      update.error ?? null
    ]
  );
}

const PRUNABLE_RUNS_SQL = `
WITH kept AS (SELECT id FROM lab_runs ORDER BY id DESC LIMIT $1)
SELECT r.id
  FROM strategy_runs r
 WHERE r.mode = 'backtest'
   AND r.label ~ '^${LAB_LABEL_PREFIX}[0-9]+:'
   AND NOT EXISTS (SELECT 1 FROM kept k WHERE r.label LIKE '${LAB_LABEL_PREFIX}' || k.id || ':%')`;

const PRUNE_WEIGHTS_SQL = `
WITH kept AS (SELECT id FROM lab_runs ORDER BY id DESC LIMIT $1)
DELETE FROM scorer_weights w
 WHERE NOT w.active
   AND w.version ~ '^lab-[0-9]+-'
   AND w.metrics->>'source' = 'lab'
   AND NOT EXISTS (SELECT 1 FROM kept k WHERE w.version LIKE 'lab-' || k.id || '-%')`;

export async function pruneLabRuns(db: Db, keep: number = DEFAULT_PRUNE_KEEP): Promise<LabPruneResult> {
  const kept = Math.max(1, Math.floor(keep));
  return withTransaction(db, async (client) => {
    const weights = (await client.query(PRUNE_WEIGHTS_SQL, [kept])).rowCount ?? 0;
    const runs = await client.query<{ id: unknown }>(PRUNABLE_RUNS_SQL, [kept]);
    const ids = runs.rows.map((row) => String(row.id));
    if (ids.length === 0) {
      return { kept, strategyRuns: 0, positions: 0, fills: 0, signals: 0, weights };
    }
    const counts = await client.query<{ positions: number; fills: number; signals: number }>(
      `SELECT (SELECT count(*)::int FROM positions WHERE run_id = ANY($1::bigint[])) AS positions,
              (SELECT count(*)::int FROM fills f JOIN positions p ON p.id = f.position_id WHERE p.run_id = ANY($1::bigint[])) AS fills,
              (SELECT count(*)::int FROM signals WHERE run_id = ANY($1::bigint[])) AS signals`,
      [ids]
    );
    await client.query("DELETE FROM risk_events WHERE run_id = ANY($1::bigint[])", [ids]);
    await client.query("DELETE FROM strategy_runs WHERE id = ANY($1::bigint[])", [ids]);
    const row = counts.rows[0];
    return { kept, strategyRuns: ids.length, positions: row?.positions ?? 0, fills: row?.fills ?? 0, signals: row?.signals ?? 0, weights };
  });
}
