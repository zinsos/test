import { moduleLogger } from "../core/logger.js";
import type { Db } from "../db/pool.js";
import { ScoringModel } from "../scorer/model.js";
import { DEFAULT_WEIGHTS, loadWeightsFile, parseWeights, type WeightsFile } from "../scorer/weights.js";

const log = moduleLogger("backtest.weights");

export type WeightsSourceKind = "explicit" | "db" | "file" | "default";

export interface WeightsProvenance {
  version: string;
  source: WeightsSourceKind;
  trainedFromMs: number | null;
  trainedToMs: number | null;
  inSample: boolean;
}

export interface SkippedWeights {
  version: string;
  source: WeightsSourceKind;
  trainedFromMs: number | null;
  trainedToMs: number;
}

export interface SelectedWeights {
  model: ScoringModel;
  provenance: WeightsProvenance;
  skipped: SkippedWeights[];
}

export interface SelectWeightsOptions {
  fromMs: number;
  weightsFile: string | null;
  explicit?: ScoringModel | null;
  allowInSample?: boolean;
}

interface WeightsRow {
  version: string;
  weights: unknown;
  metrics: unknown;
  created_at: Date;
}

interface TrainingWindow {
  fromMs: number | null;
  toMs: number;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function trainingWindowOf(row: Pick<WeightsRow, "metrics" | "created_at">): TrainingWindow {
  const metrics = row.metrics !== null && typeof row.metrics === "object" ? (row.metrics as Record<string, unknown>) : {};
  const createdMs = row.created_at.getTime();
  const toMs = isoMs(metrics.to);
  return { fromMs: isoMs(metrics.from), toMs: toMs === null ? createdMs : Math.min(toMs, createdMs) };
}

export function fittedAfter(window: TrainingWindow, fromMs: number): boolean {
  return window.toMs > fromMs;
}

function readable<T>(read: () => T, what: string): T | null {
  try {
    return read();
  } catch (error) {
    log.warn({ err: error }, `ignoring unreadable ${what}`);
    return null;
  }
}

async function readableAsync<T>(read: () => Promise<T>, what: string): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    log.warn({ err: error }, `ignoring unreadable ${what}`);
    return null;
  }
}

async function storedWeights(db: Db, where: string, params: unknown[]): Promise<WeightsRow | null> {
  const result = await db.query<WeightsRow>(
    `SELECT version, weights, metrics, created_at FROM scorer_weights WHERE ${where} ORDER BY created_at DESC LIMIT 1`,
    params
  );
  return result.rows[0] ?? null;
}

function provenance(weights: WeightsFile, source: WeightsSourceKind, row: WeightsRow | null, fromMs: number): WeightsProvenance {
  if (!row) {
    return { version: weights.version, source, trainedFromMs: null, trainedToMs: null, inSample: false };
  }
  const window = trainingWindowOf(row);
  return { version: weights.version, source, trainedFromMs: window.fromMs, trainedToMs: window.toMs, inSample: fittedAfter(window, fromMs) };
}

export async function selectBacktestWeights(db: Db, options: SelectWeightsOptions): Promise<SelectedWeights> {
  const skipped: SkippedWeights[] = [];
  if (options.explicit) {
    const row = await storedWeights(db, "version = $1", [options.explicit.version]);
    return { model: options.explicit, provenance: provenance(options.explicit.weights, "explicit", row, options.fromMs), skipped };
  }
  const candidates: Array<{ weights: WeightsFile; source: WeightsSourceKind; row: WeightsRow | null }> = [];
  const active = await storedWeights(db, "active", []);
  const activeWeights = active ? readable(() => parseWeights(active.weights), "active scorer weights") : null;
  if (active && activeWeights) {
    candidates.push({ weights: activeWeights, source: "db", row: active });
  }
  const file = options.weightsFile;
  const fromFile = file ? await readableAsync(() => loadWeightsFile(file), `scorer weights file ${file}`) : null;
  if (fromFile) {
    candidates.push({ weights: fromFile, source: "file", row: await storedWeights(db, "version = $1", [fromFile.version]) });
  }
  candidates.push({ weights: DEFAULT_WEIGHTS, source: "default", row: null });
  for (const candidate of candidates) {
    const chosen = provenance(candidate.weights, candidate.source, candidate.row, options.fromMs);
    if (!chosen.inSample || options.allowInSample) {
      return { model: new ScoringModel(candidate.weights), provenance: chosen, skipped };
    }
    skipped.push({
      version: chosen.version,
      source: chosen.source,
      trainedFromMs: chosen.trainedFromMs,
      trainedToMs: chosen.trainedToMs ?? options.fromMs
    });
  }
  return {
    model: ScoringModel.default(),
    provenance: { version: DEFAULT_WEIGHTS.version, source: "default", trainedFromMs: null, trainedToMs: null, inSample: false },
    skipped
  };
}
