import { jsonSafe, toNumber, withTransaction, type Db, type DbClient } from "../db/pool.js";
import { overridesHash, variantKey } from "./identity.js";
import type { EvidenceIdentity, LearnerReport, LearnerState, OpenCandidate, PendingPromotion, ProbationState } from "./learner.js";
import { UNDO_PREFIX } from "./learner.js";
import { isPlainObject, type JsonObject } from "./variants.js";

export type PromotionKind = "variant" | "revert";
export type PromotionStatus = "confirming" | "pending" | "applied" | "rejected" | "superseded" | "reverted";
export const OPEN_STATUSES: readonly PromotionStatus[] = ["confirming", "pending"];
export const TRIED_STATUSES: readonly PromotionStatus[] = ["applied", "rejected", "reverted"];

export interface Promotion {
  id: number;
  kind: PromotionKind;
  name: string;
  overrides: JsonObject;
  overridesHash: string;
  baselineHash: string;
  evidence: JsonObject;
  status: PromotionStatus;
  note: string | null;
  labRunId: number | null;
  confirmFromMs: number | null;
  confirmWindows: number | null;
  confirmIndex: number | null;
  targetId: number | null;
  rootHash: string | null;
  previousOverlay: JsonObject | null;
  overlay: JsonObject | null;
  appliedHash: string | null;
  undo: JsonObject | null;
  probationResult: "kept" | "reverted" | null;
  applyAttempts: number;
  createdAtMs: number;
  updatedAtMs: number;
  appliedAtMs: number | null;
}

export interface PromotionRef {
  id: number;
  status: PromotionStatus;
  name: string;
}

type Queryable = Pick<Db, "query"> | DbClient;

export const PROMOTION_COLUMNS =
  "id, kind, name, overrides, overrides_hash, baseline_hash, evidence, status, note, lab_run_id, confirm_from, confirm_windows, confirm_index, target_id, root_hash, previous_overlay, overlay, applied_hash, undo, probation_result, apply_attempts, created_at, updated_at, applied_at";
const UNDEFINED_TABLE = "42P01";

function json(value: unknown): string {
  return JSON.stringify(jsonSafe(value));
}

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function idOf(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function intOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectOf(value: unknown): JsonObject | null {
  return isPlainObject(value) ? value : null;
}

function kindOf(value: unknown): PromotionKind {
  return value === "revert" ? "revert" : "variant";
}

function statusOf(value: unknown): PromotionStatus {
  return value === "confirming" || value === "applied" || value === "rejected" || value === "superseded" || value === "reverted" ? value : "pending";
}

export function promotionFromRow(row: Record<string, unknown>): Promotion {
  return {
    id: toNumber(row.id),
    kind: kindOf(row.kind),
    name: typeof row.name === "string" ? row.name : "unknown",
    overrides: objectOf(row.overrides) ?? {},
    overridesHash: typeof row.overrides_hash === "string" ? row.overrides_hash : "",
    baselineHash: typeof row.baseline_hash === "string" ? row.baseline_hash : "",
    evidence: objectOf(row.evidence) ?? {},
    status: statusOf(row.status),
    note: typeof row.note === "string" ? row.note : null,
    labRunId: idOf(row.lab_run_id),
    confirmFromMs: msOf(row.confirm_from),
    confirmWindows: intOf(row.confirm_windows),
    confirmIndex: intOf(row.confirm_index),
    targetId: idOf(row.target_id),
    rootHash: textOf(row.root_hash),
    previousOverlay: objectOf(row.previous_overlay),
    overlay: objectOf(row.overlay),
    appliedHash: textOf(row.applied_hash),
    undo: objectOf(row.undo),
    probationResult: row.probation_result === "kept" || row.probation_result === "reverted" ? row.probation_result : null,
    applyAttempts: intOf(row.apply_attempts) ?? 0,
    createdAtMs: msOf(row.created_at) ?? 0,
    updatedAtMs: msOf(row.updated_at) ?? 0,
    appliedAtMs: msOf(row.applied_at)
  };
}

export function isUndefinedTable(error: unknown): boolean {
  return isPlainObject(error) && error.code === UNDEFINED_TABLE;
}

export function promotionKey(promotion: Pick<Promotion, "name" | "overrides">): string {
  return variantKey(promotion.name, promotion.overrides);
}

export function undoName(promotionId: number): string {
  return `${UNDO_PREFIX}${promotionId}`;
}

function identityOf(evidence: JsonObject): EvidenceIdentity | null {
  const identity = evidence.identity;
  if (!isPlainObject(identity) || typeof identity.settingsHash !== "string") {
    return null;
  }
  return {
    settingsHash: identity.settingsHash,
    engineVersion: textOf(identity.engineVersion),
    weightsVersion: textOf(identity.weightsVersion)
  };
}

export function staleReason(row: Promotion, identity: EvidenceIdentity): string | null {
  if (row.baselineHash !== identity.settingsHash) {
    return "the paper settings changed before it finished";
  }
  if (row.status === "confirming") {
    const learned = identityOf(row.evidence);
    if (!learned || learned.engineVersion !== identity.engineVersion || learned.weightsVersion !== identity.weightsVersion) {
      return "the replay code or the scorer weights changed during its confirmation, so its fresh windows are no longer comparable";
    }
  }
  return null;
}

export async function loadOpenPromotions(db: Queryable): Promise<Promotion[]> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE status IN ('confirming', 'pending') ORDER BY id DESC`
  );
  return result.rows.map(promotionFromRow);
}

export async function loadPendingPromotion(db: Queryable): Promise<Promotion | null> {
  const result = await db.query<Record<string, unknown>>(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE status = 'pending' ORDER BY id DESC LIMIT 1`);
  const row = result.rows[0];
  return row ? promotionFromRow(row) : null;
}

export async function loadPromotion(db: Queryable, id: number): Promise<Promotion | null> {
  const result = await db.query<Record<string, unknown>>(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? promotionFromRow(row) : null;
}

export async function lockPendingPromotion(client: DbClient, id: number): Promise<Promotion | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id]);
  const row = result.rows[0];
  return row ? promotionFromRow(row) : null;
}

export async function loadTriedKeys(db: Queryable, settingsHash: string): Promise<Set<string>> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE kind = 'variant' AND baseline_hash = $1 AND status IN ('applied', 'rejected', 'reverted')`,
    [settingsHash]
  );
  return new Set(result.rows.map((row) => promotionKey(promotionFromRow(row))));
}

export async function countNominations(db: Queryable, settingsHash: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT coalesce(max(confirm_index), 0)::int AS n FROM promotions WHERE kind = 'variant' AND baseline_hash = $1`,
    [settingsHash]
  );
  return result.rows[0]?.n ?? 0;
}

export async function loadProbationPromotion(db: Queryable, settingsHash: string): Promise<Promotion | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions
      WHERE kind = 'variant' AND status = 'applied' AND applied_hash = $1 AND probation_result IS NULL AND undo IS NOT NULL
      ORDER BY applied_at DESC, id DESC LIMIT 1`,
    [settingsHash]
  );
  const row = result.rows[0];
  return row ? promotionFromRow(row) : null;
}

export async function latestEvent(db: Queryable, rootHash: string): Promise<Promotion | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE status IN ('applied', 'reverted') AND root_hash = $1
      ORDER BY applied_at DESC, id DESC LIMIT 1`,
    [rootHash]
  );
  const row = result.rows[0];
  return row ? promotionFromRow(row) : null;
}

export async function latestAppliedAtMs(db: Queryable): Promise<number | null> {
  const result = await db.query<{ at: Date | null }>(`SELECT max(applied_at) AS at FROM promotions WHERE status IN ('applied', 'reverted')`);
  return msOf(result.rows[0]?.at ?? null);
}

export async function recentPromotions(db: Queryable, limit: number): Promise<Promotion[]> {
  const result = await db.query<Record<string, unknown>>(`SELECT ${PROMOTION_COLUMNS} FROM promotions ORDER BY created_at DESC, id DESC LIMIT $1`, [
    Math.max(1, Math.min(50, Math.floor(limit)))
  ]);
  return result.rows.map(promotionFromRow);
}

export async function rejectPromotion(db: Queryable, id: number, atMs: number, note: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE promotions SET status = 'rejected', note = $2, updated_at = $3 WHERE id = $1 AND status IN ('confirming', 'pending')`,
    [id, note, new Date(atMs)]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function countApplyAttempt(db: Queryable, id: number, atMs: number): Promise<number | null> {
  const result = await db.query<{ attempts: number }>(
    `UPDATE promotions SET apply_attempts = apply_attempts + 1, updated_at = $2 WHERE id = $1 AND status = 'pending' RETURNING apply_attempts AS attempts`,
    [id, new Date(atMs)]
  );
  return result.rows[0]?.attempts ?? null;
}

export function candidateOf(row: Promotion): OpenCandidate | null {
  if (row.kind !== "variant" || row.status !== "confirming" || row.confirmFromMs === null || row.confirmWindows === null || row.confirmIndex === null) {
    return null;
  }
  return {
    promotionId: row.id,
    name: row.name,
    key: promotionKey(row),
    overrides: row.overrides,
    confirmFromMs: row.confirmFromMs,
    confirmWindows: row.confirmWindows,
    index: row.confirmIndex
  };
}

export function probationOf(row: Promotion, minWindows: number): ProbationState | null {
  if (row.undo === null || row.appliedAtMs === null) {
    return null;
  }
  const name = undoName(row.id);
  return {
    promotionId: row.id,
    name: row.name,
    undoName: name,
    undoKey: variantKey(name, row.undo),
    fromMs: row.appliedAtMs,
    windows: Math.max(minWindows, row.confirmWindows ?? 0)
  };
}

export interface StoredLearnerState {
  state: LearnerState;
  stale: Array<{ row: Promotion; reason: string }>;
  probationRow: Promotion | null;
}

export async function loadLearnerState(db: Queryable, identity: EvidenceIdentity, probationWindows: number): Promise<StoredLearnerState> {
  const open = await loadOpenPromotions(db);
  const stale: Array<{ row: Promotion; reason: string }> = [];
  let confirming: OpenCandidate | null = null;
  let pending: PendingPromotion | null = null;
  for (const row of open) {
    const reason = staleReason(row, identity);
    if (reason) {
      stale.push({ row, reason });
    } else if (row.status === "pending") {
      pending = { promotionId: row.id, kind: row.kind, name: row.name };
    } else {
      confirming = candidateOf(row);
    }
  }
  const probationRow = await loadProbationPromotion(db, identity.settingsHash);
  return {
    state: {
      tried: await loadTriedKeys(db, identity.settingsHash),
      nominations: await countNominations(db, identity.settingsHash),
      confirming,
      pending,
      probation: probationRow ? probationOf(probationRow, probationWindows) : null
    },
    stale,
    probationRow
  };
}

function discoveryEvidence(report: LearnerReport, name: string): JsonObject {
  const verdict = report.variants.find((variant) => variant.name === name) ?? null;
  return {
    identity: report.identity,
    labRunId: report.labRunId,
    evaluatedAtMs: report.evaluatedAtMs,
    rule: report.rule,
    windows: report.windows,
    discovery: verdict ? { stats: verdict.stats, reasons: verdict.reasons, description: verdict.description } : null,
    paper: report.paper
  };
}

async function supersede(client: DbClient, id: number, note: string, at: Date): Promise<void> {
  await client.query(`UPDATE promotions SET status = 'superseded', note = $2, updated_at = $3 WHERE id = $1 AND status IN ('confirming', 'pending')`, [
    id,
    note,
    at
  ]);
}

export async function reconcilePromotions(db: Db, report: LearnerReport, nowMs: number): Promise<PromotionRef | null> {
  const decision = report.decision;
  const at = new Date(nowMs);
  return withTransaction(db, async (client) => {
    const locked = await client.query<Record<string, unknown>>(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE status IN ('confirming', 'pending') FOR UPDATE`);
    let open: Promotion | null = null;
    for (const row of locked.rows.map(promotionFromRow)) {
      const reason = staleReason(row, report.identity);
      if (reason) {
        await supersede(client, row.id, `${reason} (lab run #${report.labRunId})`, at);
      } else {
        open = row;
      }
    }
    switch (decision.kind) {
      case "nominate": {
        if (open) {
          return { id: open.id, status: open.status, name: open.name };
        }
        const inserted = await client.query<{ id: unknown }>(
          `INSERT INTO promotions (kind, name, overrides, overrides_hash, baseline_hash, evidence, status, note, lab_run_id,
                                   confirm_from, confirm_windows, confirm_index, created_at, updated_at)
           VALUES ('variant', $1, $2, $3, $4, $5, 'confirming', $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
          [
            decision.name,
            json(decision.overrides),
            overridesHash(decision.overrides),
            report.identity.settingsHash,
            json(discoveryEvidence(report, decision.name)),
            decision.reason,
            report.labRunId,
            new Date(decision.confirmFromMs),
            decision.confirmWindows,
            decision.index,
            at
          ]
        );
        return { id: toNumber(inserted.rows[0]?.id), status: "confirming", name: decision.name };
      }
      case "confirm":
      case "reject":
      case "withdraw": {
        if (!open || open.id !== decision.promotionId || open.status !== "confirming") {
          return open ? { id: open.id, status: open.status, name: open.name } : null;
        }
        const status: PromotionStatus = decision.kind === "confirm" ? "pending" : decision.kind === "reject" ? "rejected" : "superseded";
        await client.query(
          `UPDATE promotions SET status = $2, note = $3, updated_at = $4, lab_run_id = $5, evidence = evidence || $6::jsonb
            WHERE id = $1 AND status = 'confirming'`,
          [open.id, status, decision.reason, at, report.labRunId, json({ confirmation: report.confirmation, confirmationPaper: report.paper })]
        );
        return { id: open.id, status, name: open.name };
      }
      case "revert": {
        if (open) {
          return { id: open.id, status: open.status, name: open.name };
        }
        const target = await client.query<Record<string, unknown>>(
          `SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = $1 AND status = 'applied' AND probation_result IS NULL FOR UPDATE`,
          [decision.promotionId]
        );
        const row = target.rows[0] ? promotionFromRow(target.rows[0]) : null;
        if (!row || row.undo === null) {
          return null;
        }
        await client.query(`UPDATE promotions SET evidence = evidence || $2::jsonb, updated_at = $3 WHERE id = $1`, [
          row.id,
          json({ probation: report.probation }),
          at
        ]);
        const inserted = await client.query<{ id: unknown }>(
          `INSERT INTO promotions (kind, name, overrides, overrides_hash, baseline_hash, evidence, status, note, lab_run_id, target_id, created_at, updated_at)
           VALUES ('revert', $1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $9) RETURNING id`,
          [
            undoName(row.id),
            json(row.undo),
            overridesHash(row.undo),
            report.identity.settingsHash,
            json({ identity: report.identity, probation: report.probation, target: { id: row.id, name: row.name } }),
            decision.reason,
            report.labRunId,
            row.id,
            at
          ]
        );
        return { id: toNumber(inserted.rows[0]?.id), status: "pending", name: undoName(row.id) };
      }
      case "keep": {
        await client.query(
          `UPDATE promotions SET probation_result = 'kept', updated_at = $3, evidence = evidence || $4::jsonb,
                   note = CASE WHEN note IS NULL THEN $2 ELSE note || '; ' || $2 END
            WHERE id = $1 AND status = 'applied' AND probation_result IS NULL`,
          [decision.promotionId, `probation passed at lab run #${report.labRunId}`, at, json({ probation: report.probation })]
        );
        return open ? { id: open.id, status: open.status, name: open.name } : null;
      }
      default:
        return open ? { id: open.id, status: open.status, name: open.name } : null;
    }
  });
}
