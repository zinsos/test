import type { StrategyConfig } from "../config/strategy.js";
import { moduleLogger } from "../core/logger.js";
import { jsonSafe, toBigInt, toNumber, type Db } from "../db/pool.js";
import { ownerOnlySettings, storedStrategyHash, variantKey } from "./identity.js";
import {
  evaluateLearning,
  learnerRuleOf,
  parseStoredTrades,
  selectWindows,
  storedTrade,
  UNDO_PREFIX,
  weightsRuleOf,
  type EvidenceArm,
  type EvidenceIdentity,
  type EvidenceTrade,
  type EvidenceWindow,
  type LearnerReport,
  type PaperEvidence,
  type PlannedArm,
  type ScorerEntryEvidence,
  type ScorerRunEvidence
} from "./learner.js";
import { loadLearnerState, reconcilePromotions } from "./promotions.js";
import { isPlainObject, type JsonObject } from "./variants.js";

const log = moduleLogger("lab.learner");
const RUNS_PER_WINDOW = 8;
const SCORER_RUNS = 48;

type DbRecord = Record<string, unknown>;

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function weightsVersionOf(notes: unknown): string | null {
  if (!isPlainObject(notes) || !isPlainObject(notes.variants)) {
    return null;
  }
  const baseline = notes.variants.baseline;
  return isPlainObject(baseline) ? text(baseline.weightsVersion) : null;
}

export function promotableFor(config: StrategyConfig, name: string, overrides: JsonObject): boolean {
  if (name.startsWith(UNDO_PREFIX)) {
    return false;
  }
  try {
    return ownerOnlySettings(overrides, config).length === 0;
  } catch {
    return false;
  }
}

export interface EvidenceQuery {
  currentLabRunId: number;
  settingsHash: string;
  maxWindows: number;
  config: StrategyConfig;
}

export async function loadEvidenceWindows(db: Db, query: EvidenceQuery): Promise<EvidenceWindow[]> {
  const runs = await db.query<DbRecord>(
    `SELECT id, data_from, data_to, baseline_hash, engine_version, notes FROM lab_runs
      WHERE (status = 'done' OR id = $1) AND data_from IS NOT NULL AND data_to IS NOT NULL AND baseline_hash = $2
      ORDER BY data_to DESC, id DESC
      LIMIT $3`,
    [query.currentLabRunId, query.settingsHash, Math.max(1, query.maxWindows) * RUNS_PER_WINDOW]
  );
  if (runs.rows.length === 0) {
    return [];
  }
  const runIds = runs.rows.map((row) => toNumber(row.id));
  const variants = await db.query<DbRecord>(
    `SELECT lab_run_id, name, is_baseline, overrides, trades, error
       FROM lab_variants WHERE lab_run_id = ANY($1::bigint[]) ORDER BY lab_run_id, id`,
    [runIds.map(String)]
  );
  const armsByRun = new Map<number, EvidenceArm[]>();
  for (const row of variants.rows) {
    const labRunId = toNumber(row.lab_run_id);
    const name = text(row.name) ?? "unnamed";
    const overrides: JsonObject = isPlainObject(row.overrides) ? row.overrides : {};
    const isBaseline = row.is_baseline === true;
    const arms = armsByRun.get(labRunId) ?? [];
    arms.push({
      name,
      key: variantKey(name, overrides),
      isBaseline,
      promotable: !isBaseline && promotableFor(query.config, name, overrides),
      trades: row.error != null ? null : parseStoredTrades(row.trades)
    });
    armsByRun.set(labRunId, arms);
  }
  return runs.rows.map((row) => {
    const labRunId = toNumber(row.id);
    return {
      labRunId,
      fromMs: msOf(row.data_from) ?? 0,
      toMs: msOf(row.data_to) ?? 0,
      settingsHash: text(row.baseline_hash),
      engineVersion: text(row.engine_version),
      weightsVersion: weightsVersionOf(row.notes),
      arms: armsByRun.get(labRunId) ?? []
    };
  });
}

export async function loadPaperEvidence(db: Db, input: { settingsHash: string; sinceMs: number }): Promise<PaperEvidence | null> {
  const runs = await db.query<DbRecord>(
    `SELECT id, started_at, config FROM strategy_runs WHERE mode = 'paper' AND ended_at IS NULL ORDER BY id DESC LIMIT 1`
  );
  const run = runs.rows[0];
  if (!run) {
    return null;
  }
  const runId = toNumber(run.id);
  const result = await db.query<DbRecord>(
    `SELECT mint, opened_at, entry_cost, coalesce(realized_pnl, proceeds - entry_cost) AS pnl
       FROM positions
      WHERE run_id = $1 AND status = 'closed' AND shadow_of IS NULL AND entry_cost > 0 AND opened_at >= $2
      ORDER BY opened_at, id`,
    [runId, new Date(input.sinceMs)]
  );
  return {
    runId,
    startedAtMs: msOf(run.started_at) ?? 0,
    configMatches: storedStrategyHash(run.config) === input.settingsHash,
    trades: result.rows.map((row): EvidenceTrade => {
      const { r, sol } = storedTrade(toBigInt(row.pnl), toBigInt(row.entry_cost));
      return { r, sol, mint: text(row.mint), openedAtMs: msOf(row.opened_at) ?? 0 };
    })
  };
}

function scorerEntryOf(value: unknown): ScorerEntryEvidence | null {
  if (!isPlainObject(value) || typeof value.label !== "string") {
    return null;
  }
  const checkpointSec = finite(value.checkpointSec);
  if (checkpointSec === null) {
    return null;
  }
  return {
    label: value.label,
    checkpointSec,
    validationAuc: finite(value.validationAuc),
    baselineAuc: finite(value.baselineAuc),
    validationRows: finite(value.validationRows),
    validationFromMs: finite(value.validationFromMs),
    validationToMs: finite(value.validationToMs),
    weightsVersion: text(value.weightsVersion)
  };
}

export async function loadScorerEvidence(db: Db, currentLabRunId: number, limit = SCORER_RUNS): Promise<ScorerRunEvidence[]> {
  const result = await db.query<DbRecord>(
    `SELECT id, started_at, scorer, notes FROM lab_runs WHERE status = 'done' OR id = $1 ORDER BY started_at DESC, id DESC LIMIT $2`,
    [currentLabRunId, limit]
  );
  return result.rows.map((row) => {
    const notes = isPlainObject(row.notes) ? row.notes : {};
    return {
      labRunId: toNumber(row.id),
      startedAtMs: msOf(row.started_at) ?? 0,
      weightsBase: text(notes.scorerWeightsBase),
      entries: (Array.isArray(row.scorer) ? row.scorer : []).map(scorerEntryOf).filter((entry): entry is ScorerEntryEvidence => entry !== null)
    };
  });
}

export async function saveLearnerReport(db: Db, labRunId: number, report: LearnerReport | { error: string; evaluatedAtMs: number }): Promise<void> {
  await db.query("UPDATE lab_runs SET learner = $2 WHERE id = $1", [labRunId, JSON.stringify(jsonSafe(report))]);
}

export interface RunLearnerInput {
  labRunId: number;
  nowMs: number;
  config: StrategyConfig;
  identity: EvidenceIdentity;
  activeWeightsVersion: string | null;
  variants: readonly PlannedArm[];
  canPromote: boolean;
}

export async function runLearner(db: Db, input: RunLearnerInput): Promise<LearnerReport> {
  const autoLearn = input.config.lab.autoLearn;
  const rule = learnerRuleOf(autoLearn);
  const baselineHoldMs = input.config.exits.maxHoldSec * 1000;
  const windows = await loadEvidenceWindows(db, {
    currentLabRunId: input.labRunId,
    settingsHash: input.identity.settingsHash,
    maxWindows: rule.maxWindows,
    config: input.config
  });
  const selected = selectWindows(windows, input.identity, rule, baselineHoldMs);
  const earliest = selected[0]?.fromMs ?? input.nowMs;
  const stored = await loadLearnerState(db, input.identity, rule.confirmWindows);
  const report = evaluateLearning({
    nowMs: input.nowMs,
    labRunId: input.labRunId,
    identity: input.identity,
    enabled: autoLearn.enabled,
    canPromote: input.canPromote,
    rule,
    baselineHoldMs,
    variants: input.variants,
    windows,
    paper: await loadPaperEvidence(db, { settingsHash: input.identity.settingsHash, sinceMs: earliest }),
    state: stored.state,
    scorer: {
      runs: await loadScorerEvidence(db, input.labRunId),
      activeVersion: input.activeWeightsVersion,
      rule: weightsRuleOf(autoLearn)
    }
  });
  report.promotion = input.canPromote ? await reconcilePromotions(db, report, input.nowMs) : null;
  await saveLearnerReport(db, input.labRunId, report);
  log.info(
    {
      labRunId: input.labRunId,
      windows: report.windows.length,
      baselineTrades: report.baseline.trades,
      decision: report.decision.kind,
      name: report.decision.name,
      promotion: report.promotion
    },
    "learner evaluated"
  );
  return report;
}

export function plannedArm(config: StrategyConfig, variant: { name: string; description: string; overrides: JsonObject }, merged: StrategyConfig): PlannedArm {
  let ownerOnly: string[];
  try {
    ownerOnly = variant.name.startsWith(UNDO_PREFIX) ? [] : ownerOnlySettings(variant.overrides, config);
  } catch {
    ownerOnly = ["(invalid overrides)"];
  }
  return {
    name: variant.name,
    description: variant.description,
    overrides: variant.overrides,
    key: variantKey(variant.name, variant.overrides),
    ownerOnly,
    holdMs: merged.exits.maxHoldSec * 1000
  };
}
