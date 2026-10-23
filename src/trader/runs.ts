import type { TradingStore } from "../core/contracts.js";
import type { Position, TradingMode } from "../core/types.js";
import { toNumber, type Db } from "../db/pool.js";
import { positionFromRow, POSITION_COLUMNS } from "./rows.js";

export const KILL_RESET_REQUEST_KIND = "kill_reset_requested";

export interface OpenRun {
  runId: number;
  label: string | null;
  startedAtMs: number;
  config: unknown;
}

export interface ResumedRun {
  runId: number;
  resumed: boolean;
  configChanged: boolean;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner === "bigint") {
      return inner.toString();
    }
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return inner;
  });
}

export async function findOpenRun(db: Db, mode: TradingMode): Promise<OpenRun | null> {
  const result = await db.query<{ id: unknown; label: string | null; started_at: Date; config: unknown }>(
    `SELECT id, label, started_at, config FROM strategy_runs
      WHERE mode = $1 AND ended_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [mode]
  );
  const row = result.rows[0];
  return row ? { runId: toNumber(row.id), label: row.label, startedAtMs: row.started_at.getTime(), config: row.config } : null;
}

export async function resumeOrCreateRun(
  db: Db,
  store: Pick<TradingStore, "createRun">,
  input: { mode: TradingMode; label: string | null; config: unknown }
): Promise<ResumedRun> {
  const open = await findOpenRun(db, input.mode);
  if (open) {
    return { runId: open.runId, resumed: true, configChanged: canonicalJson(open.config) !== canonicalJson(input.config) };
  }
  const runId = await store.createRun({ ...input, dataFrom: null, dataTo: null });
  return { runId, resumed: false, configChanged: false };
}

export async function loadOpenPositions(db: Db, runId: number): Promise<Position[]> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${POSITION_COLUMNS.join(", ")} FROM positions
      WHERE run_id = $1 AND status IN ('open', 'pending')
      ORDER BY opened_at, id`,
    [runId]
  );
  return result.rows.map(positionFromRow);
}

export async function countOpenPositions(db: Db, mode: TradingMode | null): Promise<number> {
  const result = await db.query<{ open: number }>(
    `SELECT count(*)::int AS open FROM positions WHERE status IN ('open', 'pending') AND ($1::text IS NULL OR mode = $1)`,
    [mode]
  );
  return result.rows[0]?.open ?? 0;
}

export async function runExists(db: Db, runId: number): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM strategy_runs WHERE id = $1", [runId]);
  return (result.rowCount ?? 0) > 0;
}

export async function requestKillReset(db: Db, runId: number, reason: string): Promise<number> {
  const result = await db.query<{ id: unknown }>(
    `INSERT INTO risk_events (run_id, at, kind, detail) VALUES ($1, now(), $2, $3) RETURNING id`,
    [runId, KILL_RESET_REQUEST_KIND, JSON.stringify({ reason })]
  );
  return toNumber(result.rows[0]?.id);
}

export async function latestKillResetRequestId(db: Db, runId: number): Promise<number> {
  const result = await db.query<{ id: unknown }>(
    `SELECT coalesce(max(id), 0) AS id FROM risk_events WHERE run_id = $1 AND kind = $2`,
    [runId, KILL_RESET_REQUEST_KIND]
  );
  return toNumber(result.rows[0]?.id);
}

export interface KillResetRequest {
  id: number;
  reason: string;
}

export async function killResetRequestsAfter(db: Db, runId: number, afterId: number): Promise<KillResetRequest[]> {
  const result = await db.query<{ id: unknown; detail: unknown }>(
    `SELECT id, detail FROM risk_events WHERE run_id = $1 AND kind = $2 AND id > $3 ORDER BY id`,
    [runId, KILL_RESET_REQUEST_KIND, afterId]
  );
  return result.rows.map((row) => {
    const detail = row.detail as { reason?: unknown } | null;
    return { id: toNumber(row.id), reason: typeof detail?.reason === "string" ? detail.reason : "manual" };
  });
}
