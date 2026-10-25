import type { FeatureVector } from "../core/types.js";
import { toNullableNumber, toNumber, type Db } from "../db/pool.js";
import { FEATURE_NAMES } from "./featureNames.js";

export type DatasetLabelName = "survived_15m" | "rugged_1h" | "migrated" | "rugged" | "died";

export const DATASET_LABELS: readonly DatasetLabelName[] = ["survived_15m", "rugged_1h", "migrated", "rugged", "died"];

export const FAST_LABELS: readonly DatasetLabelName[] = ["survived_15m", "rugged_1h"];

export interface DatasetLabels {
  survived15m: boolean | null;
  rugged1h: boolean | null;
  migrated: boolean | null;
  rugged: boolean | null;
  died: boolean | null;
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

export interface LabelMaturity {
  labelHorizonHours: number;
  surviveCheckSec: number;
  rugLookaheadSec: number;
}

export interface DatasetQuery extends Partial<LabelMaturity> {
  checkpointSec?: number | null;
  from?: Date | null;
  to?: Date | null;
  quoteMint?: string | null;
  limit?: number | null;
  asOf?: Date | null;
  label?: DatasetLabelName | null;
}

export const DEFAULT_LABEL_HORIZON_HOURS = 24;
export const SURVIVE_SETTLE_SEC = 300;
export const RUG_1H_WINDOW_SEC = 3_600;

const DEFAULT_MATURITY: LabelMaturity = {
  labelHorizonHours: DEFAULT_LABEL_HORIZON_HOURS,
  surviveCheckSec: 900,
  rugLookaheadSec: 300
};

export function datasetMaturityOf(outcome: {
  finalizeAfterHours: number;
  surviveCheckSec: number;
  rugLookaheadSec: number;
}): LabelMaturity {
  return {
    labelHorizonHours: outcome.finalizeAfterHours,
    surviveCheckSec: outcome.surviveCheckSec,
    rugLookaheadSec: outcome.rugLookaheadSec
  };
}

function maturityOf(query: Partial<LabelMaturity>): LabelMaturity {
  return {
    labelHorizonHours: query.labelHorizonHours ?? DEFAULT_MATURITY.labelHorizonHours,
    surviveCheckSec: query.surviveCheckSec ?? DEFAULT_MATURITY.surviveCheckSec,
    rugLookaheadSec: query.rugLookaheadSec ?? DEFAULT_MATURITY.rugLookaheadSec
  };
}

export function isFastLabel(label: DatasetLabelName): boolean {
  return FAST_LABELS.includes(label);
}

export function labelMaturitySec(label: DatasetLabelName, maturity: Partial<LabelMaturity> = {}): number {
  const resolved = maturityOf(maturity);
  switch (label) {
    case "survived_15m":
      return resolved.surviveCheckSec + SURVIVE_SETTLE_SEC;
    case "rugged_1h":
      return RUG_1H_WINDOW_SEC + resolved.rugLookaheadSec;
    default:
      return resolved.labelHorizonHours * 3_600;
  }
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
  rugged_1h: boolean | null;
  migrated: boolean | null;
  rugged: boolean | null;
  died: boolean | null;
  peak_multiple_from_1m: unknown;
  return_15m_from_1m: unknown;
}

const DATASET_SQL = `
SELECT d.* FROM (
SELECT s.launch_id, l.mint, l.created_at, l.quote_mint, s.checkpoint_sec, s.score, s.hard_blocked, s.features,
       CASE WHEN m.survived THEN o.survived_15m END AS survived_15m,
       CASE WHEN m.rug_1h AND (o.finalized OR o.computed_at >= l.created_at + make_interval(secs => ${RUG_1H_WINDOW_SEC}))
            THEN COALESCE(o.rug_at <= l.created_at + make_interval(secs => ${RUG_1H_WINDOW_SEC}), FALSE) END AS rugged_1h,
       CASE WHEN m.settled THEN o.migrated END AS migrated,
       CASE WHEN m.settled THEN o.rugged END AS rugged,
       CASE WHEN m.settled THEN o.died END AS died,
       CASE WHEN m.settled THEN o.peak_multiple_from_1m END AS peak_multiple_from_1m,
       CASE WHEN m.survived THEN o.return_15m_from_1m END AS return_15m_from_1m
  FROM launch_scores s
  JOIN launches l ON l.id = s.launch_id
  JOIN launch_outcomes o ON o.launch_id = s.launch_id
  CROSS JOIN LATERAL (
    SELECT l.created_at <= COALESCE($9::timestamptz, now()) - make_interval(secs => $12::float8) AS survived,
           l.created_at <= COALESCE($9::timestamptz, now()) - make_interval(secs => $13::float8) AS rug_1h,
           l.created_at <= COALESCE($9::timestamptz, now()) - make_interval(secs => $14::float8)
             AND (o.finalized OR o.outcome_known_at IS NOT NULL) AS settled
  ) m
 WHERE l.created_at <= COALESCE($9::timestamptz, now()) - make_interval(secs => $10::float8)
   AND (NOT $11::boolean OR o.finalized OR o.outcome_known_at IS NOT NULL)
   AND ($1::int IS NULL OR s.checkpoint_sec = $1)
   AND ($2::timestamptz IS NULL OR l.created_at >= $2)
   AND ($3::timestamptz IS NULL OR l.created_at < $3)
   AND ($4::text IS NULL OR l.quote_mint = $4)
   AND (l.created_at, s.launch_id, s.checkpoint_sec) > ($5::timestamptz, $6::bigint, $7::int)
) d
 WHERE CASE $15::text
         WHEN 'survived_15m' THEN d.survived_15m IS NOT NULL
         WHEN 'rugged_1h' THEN d.rugged_1h IS NOT NULL
         WHEN 'migrated' THEN d.migrated IS NOT NULL
         WHEN 'rugged' THEN d.rugged IS NOT NULL
         WHEN 'died' THEN d.died IS NOT NULL
         ELSE TRUE
       END
 ORDER BY d.created_at, d.launch_id, d.checkpoint_sec
 LIMIT $8`;

export const LABEL_COLUMNS = [
  "survived_15m",
  "migrated",
  "rugged",
  "died",
  "peak_multiple_from_1m",
  "return_15m_from_1m",
  "rugged_1h"
] as const;

export const BASE_COLUMNS = ["launch_id", "mint", "created_at", "checkpoint_sec", "score", "hard_blocked"] as const;

interface EntryRule {
  entrySec: number;
  requireSettled: boolean;
}

export function entryRuleOf(query: DatasetQuery): EntryRule {
  if (query.label) {
    return { entrySec: labelMaturitySec(query.label, query), requireSettled: !isFastLabel(query.label) };
  }
  return { entrySec: Math.max(...DATASET_LABELS.map((label) => labelMaturitySec(label, query))), requireSettled: true };
}

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
      rugged1h: row.rugged_1h,
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
  const rule = entryRuleOf(query);
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
      take,
      query.asOf ?? null,
      rule.entrySec,
      rule.requireSettled,
      labelMaturitySec("survived_15m", query),
      labelMaturitySec("rugged_1h", query),
      labelMaturitySec("migrated", query),
      query.label ?? null
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
    case "rugged_1h":
      return row.labels.rugged1h;
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
    csvCell(row.labels.return15mFrom1m),
    csvCell(row.labels.rugged1h)
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
