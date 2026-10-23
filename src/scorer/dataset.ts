import type { FeatureVector } from "../core/types.js";
import { toNullableNumber, toNumber, type Db } from "../db/pool.js";
import { FEATURE_NAMES } from "./featureNames.js";

export type DatasetLabelName = "survived_15m" | "migrated" | "rugged" | "died";

export const DATASET_LABELS: readonly DatasetLabelName[] = ["survived_15m", "migrated", "rugged", "died"];

export interface DatasetLabels {
  survived15m: boolean | null;
  migrated: boolean;
  rugged: boolean;
  died: boolean;
  peakMultipleFrom1m: number | null;
  return15mFrom1m: number | null;
}

export interface DatasetRow {
  launchId: number;
  mint: string;
  createdAtMs: number;
  quoteMint: string;
  checkpointSec: number;
  score: number;
  hardBlocked: boolean;
  features: FeatureVector;
  labels: DatasetLabels;
}

export interface DatasetQuery {
  checkpointSec?: number | null;
  from?: Date | null;
  to?: Date | null;
  quoteMint?: string | null;
  limit?: number | null;
}

interface DatasetDbRow {
  launch_id: unknown;
  mint: string;
  created_at: Date;
  quote_mint: string;
  checkpoint_sec: number;
  score: number;
  hard_blocked: boolean;
  features: Record<string, unknown>;
  survived_15m: boolean | null;
  migrated: boolean;
  rugged: boolean;
  died: boolean;
  peak_multiple_from_1m: unknown;
  return_15m_from_1m: unknown;
}

const DATASET_SQL = `
SELECT s.launch_id, l.mint, l.created_at, l.quote_mint, s.checkpoint_sec, s.score, s.hard_blocked, s.features,
       o.survived_15m, o.migrated, o.rugged, o.died, o.peak_multiple_from_1m, o.return_15m_from_1m
  FROM launch_scores s
  JOIN launches l ON l.id = s.launch_id
  JOIN launch_outcomes o ON o.launch_id = s.launch_id
 WHERE (o.finalized OR o.outcome_known_at IS NOT NULL)
   AND ($1::int IS NULL OR s.checkpoint_sec = $1)
   AND ($2::timestamptz IS NULL OR l.created_at >= $2)
   AND ($3::timestamptz IS NULL OR l.created_at < $3)
   AND ($4::text IS NULL OR l.quote_mint = $4)
   AND (l.created_at, s.launch_id, s.checkpoint_sec) > ($5::timestamptz, $6::bigint, $7::int)
 ORDER BY l.created_at, s.launch_id, s.checkpoint_sec
 LIMIT $8`;

export const LABEL_COLUMNS = [
  "survived_15m",
  "migrated",
  "rugged",
  "died",
  "peak_multiple_from_1m",
  "return_15m_from_1m"
] as const;

export const BASE_COLUMNS = ["launch_id", "mint", "created_at", "checkpoint_sec", "score", "hard_blocked"] as const;

function featureVector(raw: Record<string, unknown>): FeatureVector {
  const features: FeatureVector = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    features[name] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return features;
}

function rowFromDb(row: DatasetDbRow): DatasetRow {
  return {
    launchId: toNumber(row.launch_id),
    mint: row.mint,
    createdAtMs: row.created_at.getTime(),
    quoteMint: row.quote_mint,
    checkpointSec: row.checkpoint_sec,
    score: row.score,
    hardBlocked: row.hard_blocked,
    features: featureVector(row.features),
    labels: {
      survived15m: row.survived_15m,
      migrated: row.migrated,
      rugged: row.rugged,
      died: row.died,
      peakMultipleFrom1m: toNullableNumber(row.peak_multiple_from_1m),
      return15mFrom1m: toNullableNumber(row.return_15m_from_1m)
    }
  };
}

async function queryPage(db: Db, params: unknown[]): Promise<DatasetDbRow[]> {
  const result = await db.query<DatasetDbRow>(DATASET_SQL, params);
  return result.rows;
}

export async function* iterateDataset(db: Db, query: DatasetQuery = {}, pageSize = 5_000): AsyncGenerator<DatasetRow[]> {
  let cursorTime: Date | string = "-infinity";
  let cursorLaunch = "0";
  let cursorCheckpoint = -1;
  let remaining = query.limit ?? Number.POSITIVE_INFINITY;
  while (remaining > 0) {
    const take = Math.min(pageSize, remaining);
    const page: DatasetDbRow[] = await queryPage(db, [
      query.checkpointSec ?? null,
      query.from ?? null,
      query.to ?? null,
      query.quoteMint ?? null,
      cursorTime,
      cursorLaunch,
      cursorCheckpoint,
      take
    ]);
    if (page.length === 0) {
      return;
    }
    yield page.map(rowFromDb);
    remaining -= page.length;
    const last: DatasetDbRow | undefined = page[page.length - 1];
    if (!last || page.length < take) {
      return;
    }
    cursorTime = last.created_at;
    cursorLaunch = String(last.launch_id);
    cursorCheckpoint = last.checkpoint_sec;
  }
}

export async function buildDataset(db: Db, query: DatasetQuery = {}): Promise<DatasetRow[]> {
  const rows: DatasetRow[] = [];
  for await (const page of iterateDataset(db, query)) {
    rows.push(...page);
  }
  return rows;
}

export function labelValue(row: DatasetRow, label: DatasetLabelName): boolean | null {
  switch (label) {
    case "survived_15m":
      return row.labels.survived15m;
    case "migrated":
      return row.labels.migrated;
    case "rugged":
      return row.labels.rugged;
    case "died":
      return row.labels.died;
    default:
      return null;
  }
}

export function datasetColumns(featureNames: readonly string[] = FEATURE_NAMES): string[] {
  return [...BASE_COLUMNS, ...featureNames, ...LABEL_COLUMNS];
}

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function csvHeader(featureNames: readonly string[] = FEATURE_NAMES): string {
  return datasetColumns(featureNames).join(",");
}

export function csvLine(row: DatasetRow, featureNames: readonly string[] = FEATURE_NAMES): string {
  const cells = [
    csvCell(row.launchId),
    csvCell(row.mint),
    csvCell(new Date(row.createdAtMs).toISOString()),
    csvCell(row.checkpointSec),
    csvCell(row.score),
    csvCell(row.hardBlocked),
    ...featureNames.map((name) => csvCell(row.features[name] ?? null)),
    csvCell(row.labels.survived15m),
    csvCell(row.labels.migrated),
    csvCell(row.labels.rugged),
    csvCell(row.labels.died),
    csvCell(row.labels.peakMultipleFrom1m),
    csvCell(row.labels.return15mFrom1m)
  ];
  return cells.join(",");
}

export function exportCsv(rows: readonly DatasetRow[], featureNames: readonly string[] = FEATURE_NAMES): string {
  const lines = [csvHeader(featureNames)];
  for (const row of rows) {
    lines.push(csvLine(row, featureNames));
  }
  return `${lines.join("\n")}\n`;
}

export async function* streamDatasetCsv(
  db: Db,
  query: DatasetQuery = {},
  featureNames: readonly string[] = FEATURE_NAMES
): AsyncGenerator<string> {
  yield `${csvHeader(featureNames)}\n`;
  for await (const page of iterateDataset(db, query)) {
    yield page.map((row) => `${csvLine(row, featureNames)}\n`).join("");
  }
}
