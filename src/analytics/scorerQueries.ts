import { toBigInt, toNullableNumber, toNumber, type Db } from "../db/pool.js";
import {
  assessCalibration,
  DEFAULT_CALIBRATION_MAX_RISK,
  EMPTY_COUNTS,
  outcomeRates,
  type CalibrationAssessment,
  type CalibrationBucket,
  type CalibrationGroup,
  type OutcomeCounts
} from "./calibration.js";
import { DEFAULT_RISK_BUCKET_WIDTH, riskBucketBounds, riskBucketCount, riskBucketLabel } from "./dimensions.js";
import { clampLimit } from "./tradeQueries.js";
import { lamportsRatio } from "./units.js";

type DbRecord = Record<string, unknown>;

export const MAX_DATASET_ROWS = 2_000_000;
export const MAX_FEATURE_KEYS = 1_000;

export interface CalibrationQuery {
  checkpointSec: number;
  bucketWidth?: number;
  maxRisk?: number;
  fromMs?: number | null;
  toMs?: number | null;
  quoteMint?: string | null;
  minLaunches?: number;
  minGroup?: number;
}

export interface ScorerCalibration {
  checkpointSec: number;
  bucketWidth: number;
  maxRisk: number;
  quoteMint: string | null;
  buckets: CalibrationBucket[];
  pass: CalibrationGroup;
  block: CalibrationGroup;
  assessment: CalibrationAssessment;
}

export interface ScorerDatasetQuery {
  checkpointSec?: number | null;
  fromMs?: number | null;
  toMs?: number | null;
  quoteMint?: string | null;
  includeUnknown?: boolean;
  limit?: number | null;
}

export interface DatasetOutcome {
  status: string;
  finalized: boolean;
  outcomeKnownAtMs: number | null;
  survived15m: boolean | null;
  migrated: boolean;
  rugged: boolean;
  died: boolean;
  initialMcapQuote: bigint | null;
  peakMcapQuote: bigint | null;
  finalMcapQuote: bigint | null;
  mcap1m: bigint | null;
  mcap5m: bigint | null;
  mcap15m: bigint | null;
  timeToPeakSec: number | null;
  peakMultipleFrom1m: number | null;
  return15mFrom1m: number | null;
  maxDrawdownFromPeak: number | null;
  devSoldFraction: number | null;
}

export interface ScorerDatasetRecord {
  launchId: number;
  mint: string;
  quoteMint: string;
  createdAtMs: number;
  checkpointSec: number;
  computedAtMs: number;
  slot: number;
  score: number;
  hardBlocked: boolean;
  flags: string[];
  weightsVersion: string;
  features: Record<string, unknown>;
  outcome: DatasetOutcome;
}

function dateParam(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function nullableBigInt(value: unknown): bigint | null {
  return value === null || value === undefined ? null : toBigInt(value);
}

function countsFromRecord(row: DbRecord): OutcomeCounts {
  return {
    n: toNumber(row.n),
    survivedKnown: toNumber(row.survived_known),
    survived: toNumber(row.survived),
    migrated: toNumber(row.migrated),
    rugged: toNumber(row.rugged),
    died: toNumber(row.died),
    hardBlocked: toNumber(row.hard_blocked)
  };
}

function groupFromRecord(row: DbRecord | undefined): CalibrationGroup {
  const counts = row ? countsFromRecord(row) : EMPTY_COUNTS;
  return {
    ...counts,
    ...outcomeRates(counts),
    medianPeakMultiple: row ? toNullableNumber(row.median_peak) : null,
    medianPeakFromScore: row ? toNullableNumber(row.median_peak_from_score) : null
  };
}

const CALIBRATION_SQL = `
WITH scored AS (
  SELECT s.launch_id, s.hard_blocked,
         LEAST(GREATEST(floor(s.score / $2::float8), 0), $3::int)::int AS bucket,
         (s.score <= $4::float8 AND NOT s.hard_blocked) AS passes,
         CASE WHEN jsonb_typeof(s.features -> 'mcap_multiple') = 'number'
              THEN (s.features ->> 'mcap_multiple')::float8 END AS mcap_multiple
  FROM launch_scores s
  JOIN launches l ON l.id = s.launch_id
  WHERE s.checkpoint_sec = $1
    AND ($5::timestamptz IS NULL OR l.created_at >= $5)
    AND ($6::timestamptz IS NULL OR l.created_at < $6)
    AND ($7::text IS NULL OR l.quote_mint = $7)
), labelled AS (
  SELECT sc.*, o.survived_15m, o.migrated, o.rugged, o.died,
         o.peak_mcap_quote::float8 / NULLIF(o.initial_mcap_quote, 0)::float8 AS peak_multiple
  FROM scored sc
  JOIN launch_outcomes o ON o.launch_id = sc.launch_id
  WHERE o.finalized OR o.outcome_known_at IS NOT NULL
)
SELECT GROUPING(bucket) AS by_pass, bucket, passes,
       count(*)::int AS n,
       count(survived_15m)::int AS survived_known,
       (count(*) FILTER (WHERE survived_15m))::int AS survived,
       (count(*) FILTER (WHERE migrated))::int AS migrated,
       (count(*) FILTER (WHERE rugged))::int AS rugged,
       (count(*) FILTER (WHERE died))::int AS died,
       (count(*) FILTER (WHERE hard_blocked))::int AS hard_blocked,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY peak_multiple) AS median_peak,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY peak_multiple / NULLIF(mcap_multiple, 0)) AS median_peak_from_score
FROM labelled
GROUP BY GROUPING SETS ((bucket), (passes))`;

function sanitizeWidth(width: number | undefined): number {
  return width !== undefined && Number.isFinite(width) && width > 0 && width <= 100 ? width : DEFAULT_RISK_BUCKET_WIDTH;
}

export async function scorerCalibration(db: Db, query: CalibrationQuery): Promise<ScorerCalibration> {
  const bucketWidth = sanitizeWidth(query.bucketWidth);
  const maxRisk = query.maxRisk ?? DEFAULT_CALIBRATION_MAX_RISK;
  const result = await db.query<DbRecord>(CALIBRATION_SQL, [
    query.checkpointSec,
    bucketWidth,
    riskBucketCount(bucketWidth) - 1,
    maxRisk,
    dateParam(query.fromMs),
    dateParam(query.toMs),
    query.quoteMint ?? null
  ]);
  const bucketRows = result.rows.filter((row) => toNumber(row.by_pass) === 0);
  const passRows = result.rows.filter((row) => toNumber(row.by_pass) === 1);
  const buckets = bucketRows
    .map((row): CalibrationBucket => {
      const index = toNumber(row.bucket);
      const { low, high } = riskBucketBounds(index, bucketWidth);
      return { index, low, high, label: riskBucketLabel(low, high), ...groupFromRecord(row) };
    })
    .sort((a, b) => a.index - b.index);
  const pass = groupFromRecord(passRows.find((row) => row.passes === true));
  const block = groupFromRecord(passRows.find((row) => row.passes === false));
  return {
    checkpointSec: query.checkpointSec,
    bucketWidth,
    maxRisk,
    quoteMint: query.quoteMint ?? null,
    buckets,
    pass,
    block,
    assessment: assessCalibration(pass, block, { maxRisk, minLaunches: query.minLaunches, minGroup: query.minGroup })
  };
}

export async function scoreCheckpoints(db: Db): Promise<number[]> {
  const result = await db.query<{ checkpoint_sec: number }>(
    `WITH RECURSIVE checkpoints AS (
       (SELECT checkpoint_sec FROM launch_scores ORDER BY checkpoint_sec LIMIT 1)
       UNION ALL
       SELECT (SELECT s.checkpoint_sec FROM launch_scores s WHERE s.checkpoint_sec > c.checkpoint_sec ORDER BY s.checkpoint_sec LIMIT 1)
       FROM checkpoints c
       WHERE c.checkpoint_sec IS NOT NULL
     )
     SELECT checkpoint_sec FROM checkpoints WHERE checkpoint_sec IS NOT NULL LIMIT 100`
  );
  return result.rows.map((row) => toNumber(row.checkpoint_sec));
}

const DATASET_FILTER = `($1::int IS NULL OR s.checkpoint_sec = $1)
  AND ($2::timestamptz IS NULL OR l.created_at >= $2)
  AND ($3::timestamptz IS NULL OR l.created_at < $3)
  AND ($4::text IS NULL OR l.quote_mint = $4)
  AND ($5::boolean OR o.finalized OR o.outcome_known_at IS NOT NULL)`;

function datasetParams(query: ScorerDatasetQuery): unknown[] {
  return [
    query.checkpointSec ?? null,
    dateParam(query.fromMs),
    dateParam(query.toMs),
    query.quoteMint ?? null,
    query.includeUnknown === true
  ];
}

export async function scorerDatasetFeatureKeys(db: Db, query: ScorerDatasetQuery = {}): Promise<string[]> {
  const result = await db.query<{ key: string }>(
    `SELECT DISTINCT k.key
     FROM launch_scores s
     JOIN launches l ON l.id = s.launch_id
     JOIN launch_outcomes o ON o.launch_id = s.launch_id
     CROSS JOIN LATERAL jsonb_object_keys(
       CASE WHEN jsonb_typeof(s.features) = 'object' THEN s.features ELSE '{}'::jsonb END
     ) AS k(key)
     WHERE ${DATASET_FILTER}
     ORDER BY k.key
     LIMIT ${MAX_FEATURE_KEYS}`,
    datasetParams(query)
  );
  return result.rows.map((row) => row.key);
}

function outcomeFromRecord(row: DbRecord): DatasetOutcome {
  return {
    status: String(row.status ?? ""),
    finalized: row.finalized === true,
    outcomeKnownAtMs: msOf(row.outcome_known_at),
    survived15m: typeof row.survived_15m === "boolean" ? row.survived_15m : null,
    migrated: row.migrated === true,
    rugged: row.rugged === true,
    died: row.died === true,
    initialMcapQuote: nullableBigInt(row.initial_mcap_quote),
    peakMcapQuote: nullableBigInt(row.peak_mcap_quote),
    finalMcapQuote: nullableBigInt(row.final_mcap_quote),
    mcap1m: nullableBigInt(row.mcap_1m),
    mcap5m: nullableBigInt(row.mcap_5m),
    mcap15m: nullableBigInt(row.mcap_15m),
    timeToPeakSec: toNullableNumber(row.time_to_peak_sec),
    peakMultipleFrom1m: toNullableNumber(row.peak_multiple_from_1m),
    return15mFrom1m: toNullableNumber(row.return_15m_from_1m),
    maxDrawdownFromPeak: toNullableNumber(row.max_drawdown_from_peak),
    devSoldFraction: toNullableNumber(row.dev_sold_fraction)
  };
}

function datasetRecord(row: DbRecord): ScorerDatasetRecord {
  const features = row.features !== null && typeof row.features === "object" && !Array.isArray(row.features) ? row.features : {};
  return {
    launchId: toNumber(row.launch_id),
    mint: String(row.mint ?? ""),
    quoteMint: String(row.quote_mint ?? ""),
    createdAtMs: msOf(row.created_at) ?? 0,
    checkpointSec: toNumber(row.checkpoint_sec),
    computedAtMs: msOf(row.computed_at) ?? 0,
    slot: toNumber(row.slot),
    score: toNumber(row.score),
    hardBlocked: row.hard_blocked === true,
    flags: Array.isArray(row.flags) ? row.flags.filter((flag): flag is string => typeof flag === "string") : [],
    weightsVersion: String(row.weights_version ?? ""),
    features: features as Record<string, unknown>,
    outcome: outcomeFromRecord(row)
  };
}

export function peakMultipleOf(outcome: DatasetOutcome): number | null {
  if (outcome.initialMcapQuote === null || outcome.peakMcapQuote === null || outcome.initialMcapQuote <= 0n) {
    return null;
  }
  return lamportsRatio(outcome.peakMcapQuote, outcome.initialMcapQuote);
}

export function peakMultipleFromScore(record: ScorerDatasetRecord): number | null {
  const peak = peakMultipleOf(record.outcome);
  const atScore = record.features.mcap_multiple;
  if (peak === null || typeof atScore !== "number" || !Number.isFinite(atScore) || atScore <= 0) {
    return null;
  }
  return peak / atScore;
}

export async function* iterateScorerDataset(
  db: Db,
  query: ScorerDatasetQuery = {},
  pageSize = 2_000
): AsyncGenerator<ScorerDatasetRecord[]> {
  let remaining = clampLimit(query.limit, MAX_DATASET_ROWS, MAX_DATASET_ROWS);
  let cursorLaunch = "0";
  let cursorCheckpoint = -1;
  while (remaining > 0) {
    const take = Math.min(pageSize, remaining);
    const result = await db.query<DbRecord>(
      `SELECT s.launch_id, s.mint, l.quote_mint, l.created_at, s.checkpoint_sec, s.computed_at, s.slot, s.score,
              s.hard_blocked, s.flags, s.weights_version, s.features,
              o.status, o.finalized, o.outcome_known_at, o.survived_15m, o.migrated, o.rugged, o.died,
              o.initial_mcap_quote, o.peak_mcap_quote, o.final_mcap_quote, o.mcap_1m, o.mcap_5m, o.mcap_15m,
              o.time_to_peak_sec, o.peak_multiple_from_1m, o.return_15m_from_1m, o.max_drawdown_from_peak, o.dev_sold_fraction
       FROM launch_scores s
       JOIN launches l ON l.id = s.launch_id
       JOIN launch_outcomes o ON o.launch_id = s.launch_id
       WHERE ${DATASET_FILTER}
         AND (s.launch_id, s.checkpoint_sec) > ($6::bigint, $7::int)
       ORDER BY s.launch_id, s.checkpoint_sec
       LIMIT $8`,
      [...datasetParams(query), cursorLaunch, cursorCheckpoint, take]
    );
    const page = result.rows.map(datasetRecord);
    if (page.length > 0) {
      yield page;
    }
    remaining -= page.length;
    const last = page[page.length - 1];
    if (!last || page.length < take) {
      return;
    }
    cursorLaunch = String(last.launchId);
    cursorCheckpoint = last.checkpointSec;
  }
}
