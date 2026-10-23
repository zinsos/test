import { runBacktest, type BacktestProgress } from "../backtest/runner.js";
import type { StrategyConfig } from "../config/strategy.js";
import { SystemClock, type Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Db } from "../db/pool.js";
import { datasetMaturityOf, type DatasetLabelName } from "../scorer/dataset.js";
import { loadScoringModel } from "../scorer/model.js";
import { runScorerLab, type LabScorerEntry, type LabScorerResult, type LabScorerSkip } from "./scorerLab.js";
import {
  acquireLabLock,
  createLabRun,
  DEFAULT_PRUNE_KEEP,
  failInterruptedLabRuns,
  finishLabRun,
  insertLabVariant,
  pruneLabRuns,
  saveLabNotes,
  saveLabScorer,
  updateLabVariant,
  type LabPruneResult,
  type LabStatus
} from "./store.js";
import { labSummaryOf, type LabVariantSummary } from "./summary.js";
import {
  applyOverrides,
  BASELINE_NAME,
  changedSettings,
  inertReason,
  labRunLabel,
  type JsonObject,
  type LabVariant
} from "./variants.js";

const log = moduleLogger("lab");
const HOUR_MS = 3_600_000;

export const DEFAULT_LAB_HOURS = 6;
export const MAX_LAB_HOURS = 48;
export const DEFAULT_LAB_LABELS: readonly DatasetLabelName[] = ["survived_15m", "rugged_1h", "migrated"];
export const DEFAULT_LAB_CHECKPOINTS: readonly number[] = [30, 60];
export const DEFAULT_TRAIN_HOURS = 12;
export const DEFAULT_MAX_TRAIN_ROWS = 30_000;
export const DEFAULT_MIN_TRAIN_ROWS = 100;
export const DEFAULT_MIN_CLASS_ROWS = 10;

export type LabProgress =
  | { phase: "start"; labRunId: number; dataFromMs: number; dataToMs: number; variants: number }
  | { phase: "scorer"; labRunId: number; entry: LabScorerEntry }
  | { phase: "variant-start"; labRunId: number; name: string; index: number; total: number }
  | { phase: "variant-progress"; labRunId: number; name: string; progress: BacktestProgress }
  | { phase: "variant-done"; labRunId: number; result: LabVariantResult; index: number; total: number };

export interface RunLabOptions {
  config: StrategyConfig;
  variants: readonly LabVariant[];
  nowMs?: number;
  hours?: number;
  checkpoints?: readonly number[];
  labels?: readonly DatasetLabelName[];
  maxVariants?: number | null;
  baselineDescription?: string;
  trainHours?: number;
  maxTrainRows?: number;
  minTrainRows?: number;
  minClassRows?: number;
  pruneKeep?: number | null;
  includeIncomplete?: boolean;
  clock?: Clock;
  timer?: () => number;
  onProgress?: ((progress: LabProgress) => void) | null;
}

export interface LabVariantResult {
  variantId: number;
  name: string;
  description: string;
  isBaseline: boolean;
  strategyRunId: number | null;
  summary: LabVariantSummary | null;
  error: string | null;
  changed: string[];
  runtimeMs: number | null;
  events: number | null;
  weightsVersion: string | null;
}

export interface LabResult {
  labRunId: number;
  status: Exclude<LabStatus, "running">;
  error: string | null;
  dataFromMs: number;
  dataToMs: number;
  scorer: LabScorerResult[];
  scorerSkipped: LabScorerSkip[];
  variants: LabVariantResult[];
  skippedVariants: string[];
  scorerRuntimeMs: number;
  runtimeMs: number;
  pruned: LabPruneResult | null;
}

interface PlannedVariant {
  variant: LabVariant;
  isBaseline: boolean;
  config: StrategyConfig | null;
  changed: string[];
  error: string | null;
}

export class LabBusyError extends Error {
  constructor() {
    super("another lab run is in progress");
    this.name = "LabBusyError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultTimer(): number {
  return performance.now();
}

function progressEmitter(listener: ((progress: LabProgress) => void) | null | undefined): (progress: LabProgress) => void {
  return (progress) => {
    if (!listener) {
      return;
    }
    try {
      listener(progress);
    } catch (error) {
      log.warn({ err: error, phase: progress.phase }, "lab progress listener failed");
    }
  };
}

function releaseMemory(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

export function planVariants(
  baseline: StrategyConfig,
  variants: readonly LabVariant[],
  maxVariants: number | null,
  baselineDescription: string
): { planned: PlannedVariant[]; skipped: string[] } {
  const limit = maxVariants === null ? variants.length : Math.max(0, Math.floor(maxVariants));
  const planned: PlannedVariant[] = [
    {
      variant: { name: BASELINE_NAME, description: baselineDescription, overrides: {} },
      isBaseline: true,
      config: baseline,
      changed: [],
      error: null
    }
  ];
  for (const variant of variants.slice(0, limit)) {
    try {
      const merged = applyOverrides(baseline, variant.overrides);
      const changed = changedSettings(baseline, merged);
      const inert = inertReason(merged, changed);
      planned.push({ variant, isBaseline: false, config: inert ? null : merged, changed, error: inert ? `skipped: ${inert}` : null });
    } catch (error) {
      planned.push({ variant, isBaseline: false, config: null, changed: [], error: messageOf(error) });
    }
  }
  return { planned, skipped: variants.slice(limit).map((variant) => variant.name) };
}

interface VariantContext {
  db: Db;
  labRunId: number;
  dataFromMs: number;
  dataToMs: number;
  includeIncomplete: boolean;
  timer: () => number;
  onProgress: ((progress: LabProgress) => void) | null;
}

async function runVariant(ctx: VariantContext, plan: PlannedVariant, variantId: number): Promise<LabVariantResult> {
  const base: LabVariantResult = {
    variantId,
    name: plan.variant.name,
    description: plan.variant.description,
    isBaseline: plan.isBaseline,
    strategyRunId: null,
    summary: null,
    error: plan.error,
    changed: plan.changed,
    runtimeMs: null,
    events: null,
    weightsVersion: null
  };
  if (!plan.config) {
    return base;
  }
  const startedAt = ctx.timer();
  try {
    const result = await runBacktest({
      db: ctx.db,
      fromMs: ctx.dataFromMs,
      toMs: ctx.dataToMs,
      config: plan.config,
      label: labRunLabel(ctx.labRunId, plan.variant.name),
      includeIncomplete: ctx.includeIncomplete,
      weightsFile: plan.config.scorer.weightsFile,
      recordRejectedSignals: false,
      progressEveryMs: HOUR_MS,
      onProgress: ctx.onProgress
        ? (progress) => ctx.onProgress?.({ phase: "variant-progress", labRunId: ctx.labRunId, name: plan.variant.name, progress })
        : null
    });
    const summary = labSummaryOf(result.closedTrades, result.summary.trades);
    await updateLabVariant(ctx.db, variantId, { strategyRunId: result.runId, summary, error: null });
    return {
      ...base,
      strategyRunId: result.runId,
      summary,
      error: null,
      runtimeMs: ctx.timer() - startedAt,
      events: result.summary.counts.events,
      weightsVersion: result.summary.weightsVersion
    };
  } catch (error) {
    const message = messageOf(error);
    log.error({ err: error, labRunId: ctx.labRunId, variant: plan.variant.name }, "lab variant failed");
    await updateLabVariant(ctx.db, variantId, { error: message }).catch(() => undefined);
    return { ...base, error: message, runtimeMs: ctx.timer() - startedAt };
  }
}

function variantNotes(results: readonly LabVariantResult[]): JsonObject {
  const notes: JsonObject = {};
  for (const result of results) {
    notes[result.name] = {
      changed: result.changed,
      runtimeMs: result.runtimeMs === null ? null : Math.round(result.runtimeMs),
      events: result.events,
      weightsVersion: result.weightsVersion
    };
  }
  return notes;
}

export async function runLab(db: Db, options: RunLabOptions): Promise<LabResult> {
  const clock = options.clock ?? new SystemClock();
  const emit = progressEmitter(options.onProgress);
  const timer = options.timer ?? defaultTimer;
  const nowMs = options.nowMs ?? clock.nowMs();
  const hours = options.hours ?? DEFAULT_LAB_HOURS;
  if (!(hours > 0 && hours <= MAX_LAB_HOURS)) {
    throw new Error(`lab hours must be in (0, ${MAX_LAB_HOURS}], got ${hours}`);
  }
  const labels = options.labels ?? DEFAULT_LAB_LABELS;
  const checkpoints = options.checkpoints ?? DEFAULT_LAB_CHECKPOINTS;
  const dataToMs = nowMs;
  const dataFromMs = nowMs - Math.round(hours * HOUR_MS);
  const { planned, skipped } = planVariants(
    options.config,
    options.variants,
    options.maxVariants ?? null,
    options.baselineDescription ?? "the strategy config the service runs"
  );
  const lock = await acquireLabLock(db);
  if (!lock) {
    throw new LabBusyError();
  }
  const startedAt = timer();
  try {
    await failInterruptedLabRuns(db, clock.nowMs());
    const notes: JsonObject = {
      hours,
      labels: [...labels],
      checkpoints: [...checkpoints],
      trainHours: options.trainHours ?? DEFAULT_TRAIN_HOURS,
      maxTrainRows: options.maxTrainRows ?? DEFAULT_MAX_TRAIN_ROWS,
      skippedVariants: skipped
    };
    const labRunId = await createLabRun(db, { startedAtMs: clock.nowMs(), dataFromMs, dataToMs, notes });
    const result: LabResult = {
      labRunId,
      status: "done",
      error: null,
      dataFromMs,
      dataToMs,
      scorer: [],
      scorerSkipped: [],
      variants: [],
      skippedVariants: skipped,
      scorerRuntimeMs: 0,
      runtimeMs: 0,
      pruned: null
    };
    try {
      const variantIds: number[] = [];
      for (const plan of planned) {
        variantIds.push(
          await insertLabVariant(db, {
            labRunId,
            name: plan.variant.name,
            description: plan.variant.description,
            isBaseline: plan.isBaseline,
            overrides: plan.variant.overrides,
            error: plan.error
          })
        );
      }
      emit({ phase: "start", labRunId, dataFromMs, dataToMs, variants: planned.length });
      const scorerStartedAt = timer();
      const current = await loadScoringModel({ db, filePath: options.config.scorer.weightsFile });
      const stored: LabScorerEntry[] = [];
      const scorer = await runScorerLab({
        db,
        labRunId,
        nowMs,
        labels,
        checkpoints,
        maturity: datasetMaturityOf(options.config.recorder.outcome),
        soloFrom: current.model.weights,
        trainHours: options.trainHours ?? DEFAULT_TRAIN_HOURS,
        maxRows: options.maxTrainRows ?? DEFAULT_MAX_TRAIN_ROWS,
        minRows: options.minTrainRows ?? DEFAULT_MIN_TRAIN_ROWS,
        minClassRows: options.minClassRows ?? DEFAULT_MIN_CLASS_ROWS,
        onEntry: async (entry) => {
          stored.push(entry);
          await saveLabScorer(db, labRunId, stored);
          emit({ phase: "scorer", labRunId, entry });
        }
      });
      result.scorer = scorer.results;
      result.scorerSkipped = scorer.skipped;
      result.scorerRuntimeMs = timer() - scorerStartedAt;
      notes.scorerSkipped = scorer.skipped.map((skip) => ({ ...skip }));
      notes.scorerWeightsBase = current.model.version;
      notes.scorerRuntimeMs = Math.round(result.scorerRuntimeMs);
      await saveLabNotes(db, labRunId, notes);
      const context: VariantContext = {
        db,
        labRunId,
        dataFromMs,
        dataToMs,
        includeIncomplete: options.includeIncomplete ?? false,
        timer,
        onProgress: options.onProgress ? emit : null
      };
      for (const [index, plan] of planned.entries()) {
        emit({ phase: "variant-start", labRunId, name: plan.variant.name, index, total: planned.length });
        const outcome = await runVariant(context, plan, variantIds[index] ?? 0);
        releaseMemory();
        result.variants.push(outcome);
        notes.variants = variantNotes(result.variants);
        await saveLabNotes(db, labRunId, notes);
        emit({ phase: "variant-done", labRunId, result: outcome, index, total: planned.length });
      }
      const baseline = result.variants.find((variant) => variant.isBaseline);
      if (baseline?.error) {
        result.status = "failed";
        result.error = `baseline backtest failed: ${baseline.error}`;
      }
    } catch (error) {
      result.status = "failed";
      result.error = messageOf(error);
      log.error({ err: error, labRunId }, "lab run failed");
    }
    result.runtimeMs = timer() - startedAt;
    notes.runtimeMs = Math.round(result.runtimeMs);
    await finishLabRun(db, labRunId, { status: result.status, finishedAtMs: clock.nowMs(), error: result.error, notes });
    const keep = options.pruneKeep === undefined ? DEFAULT_PRUNE_KEEP : options.pruneKeep;
    if (keep !== null) {
      result.pruned = await pruneLabRuns(db, keep).catch((error: unknown) => {
        log.warn({ err: error }, "lab prune failed");
        return null;
      });
    }
    return result;
  } finally {
    await lock.release();
  }
}
