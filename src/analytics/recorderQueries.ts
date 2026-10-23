import { SOL_QUOTE, WSOL_MINT } from "../core/constants.js";
import { toNullableNumber, toNumber, type Db } from "../db/pool.js";

type DbRecord = Record<string, unknown>;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const DEFAULT_OUTCOME_WINDOW_HOURS = 168;
export const DEFAULT_GAP_LIMIT = 20;
export const PUMP_QUOTE_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface RecorderHealthOptions {
  nowMs: number;
  outcomeWindowHours?: number;
  gapLimit?: number;
}

export interface HourCount {
  hourStartMs: number;
  count: number;
}

export interface MinuteCount {
  minuteStartMs: number;
  count: number;
}

export interface IngestGapItem {
  source: string;
  fromSlot: number | null;
  toSlot: number | null;
  startedAtMs: number;
  endedAtMs: number;
  durationSec: number;
  reason: string;
  affectedLaunches: number | null;
}

export interface QuoteMintCount {
  quoteMint: string;
  label: string;
  count: number;
}

export interface OutcomeStatusCount {
  status: string;
  finalized: boolean;
  count: number;
}

export interface RecorderHealth {
  nowMs: number;
  recordingSinceMs: number | null;
  recordingDays: number | null;
  lastLaunchAtMs: number | null;
  lastLaunchAgeSec: number | null;
  lastTradeAtMs: number | null;
  lastTradeAgeSec: number | null;
  launchesLast24h: number;
  tradesLastHour: number;
  launchesPerHour: HourCount[];
  tradesPerMinute: MinuteCount[];
  gaps24h: { count: number; totalSec: number; recent: IngestGapItem[] };
  launchesByQuoteMint: QuoteMintCount[];
  outcomeStatus: { windowHours: number; counts: OutcomeStatusCount[] };
  activeTracking: number;
}

export function quoteMintLabel(quoteMint: string): string {
  if (quoteMint === SOL_QUOTE || quoteMint === WSOL_MINT) {
    return "SOL";
  }
  if (quoteMint === PUMP_QUOTE_MINT) {
    return "PUMP";
  }
  if (quoteMint === USDC_MINT) {
    return "USDC";
  }
  return quoteMint.length > 10 ? `${quoteMint.slice(0, 4)}...${quoteMint.slice(-4)}` : quoteMint;
}

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function ageSec(nowMs: number, atMs: number | null): number | null {
  return atMs === null ? null : Math.max(0, (nowMs - atMs) / 1000);
}

export function fillSeries(counts: ReadonlyMap<number, number>, startIndex: number, length: number): number[] {
  const series: number[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    series.push(counts.get(startIndex + offset) ?? 0);
  }
  return series;
}

function bucketCounts(rows: readonly DbRecord[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const row of rows) {
    counts.set(toNumber(row.bucket), toNumber(row.n));
  }
  return counts;
}

async function launchesPerHour(db: Db, nowMs: number): Promise<HourCount[]> {
  const currentHour = Math.floor(nowMs / HOUR_MS);
  const firstHour = currentHour - 23;
  const result = await db.query<DbRecord>(
    `SELECT floor(extract(epoch FROM created_at) / 3600)::bigint AS bucket, count(*)::int AS n
     FROM launches
     WHERE created_at >= $1 AND created_at < $2
     GROUP BY 1`,
    [new Date(firstHour * HOUR_MS), new Date((currentHour + 1) * HOUR_MS)]
  );
  return fillSeries(bucketCounts(result.rows), firstHour, 24).map((count, offset) => ({
    hourStartMs: (firstHour + offset) * HOUR_MS,
    count
  }));
}

async function tradesPerMinute(db: Db, nowMs: number): Promise<MinuteCount[]> {
  const currentMinute = Math.floor(nowMs / MINUTE_MS);
  const firstMinute = currentMinute - 59;
  const result = await db.query<DbRecord>(
    `SELECT floor(extract(epoch FROM block_time) / 60)::bigint AS bucket, count(*)::int AS n
     FROM trades
     WHERE block_time >= $1 AND block_time < $2
     GROUP BY 1`,
    [new Date(firstMinute * MINUTE_MS), new Date((currentMinute + 1) * MINUTE_MS)]
  );
  return fillSeries(bucketCounts(result.rows), firstMinute, 60).map((count, offset) => ({
    minuteStartMs: (firstMinute + offset) * MINUTE_MS,
    count
  }));
}

async function lastTradeAt(db: Db, nowMs: number): Promise<number | null> {
  const result = await db.query<DbRecord>(
    `SELECT block_time FROM trades WHERE block_time <= $1 ORDER BY block_time DESC LIMIT 1`,
    [new Date(nowMs + MINUTE_MS)]
  );
  return msOf(result.rows[0]?.block_time);
}

async function launchRange(db: Db): Promise<{ first: number | null; last: number | null }> {
  const result = await db.query<DbRecord>(`SELECT min(created_at) AS first, max(created_at) AS last FROM launches`);
  const row = result.rows[0];
  return { first: msOf(row?.first), last: msOf(row?.last) };
}

function gapFromRecord(row: DbRecord): IngestGapItem {
  const startedAtMs = msOf(row.started_at) ?? 0;
  const endedAtMs = msOf(row.ended_at) ?? startedAtMs;
  return {
    source: String(row.source ?? ""),
    fromSlot: toNullableNumber(row.from_slot),
    toSlot: toNullableNumber(row.to_slot),
    startedAtMs,
    endedAtMs,
    durationSec: Math.max(0, (endedAtMs - startedAtMs) / 1000),
    reason: String(row.reason ?? ""),
    affectedLaunches: toNullableNumber(row.affected_launches)
  };
}

async function recentGaps(db: Db, nowMs: number, limit: number): Promise<RecorderHealth["gaps24h"]> {
  const since = new Date(nowMs - DAY_MS);
  const totals = await db.query<DbRecord>(
    `SELECT count(*)::int AS n,
            coalesce(sum(extract(epoch FROM (ended_at - started_at))), 0)::float8 AS seconds
     FROM ingest_gaps WHERE ended_at >= $1`,
    [since]
  );
  const recent = await db.query<DbRecord>(
    `SELECT source, from_slot, to_slot, started_at, ended_at, reason, affected_launches
     FROM ingest_gaps WHERE ended_at >= $1
     ORDER BY started_at DESC
     LIMIT $2`,
    [since, limit]
  );
  const row = totals.rows[0];
  return { count: toNumber(row?.n), totalSec: toNumber(row?.seconds), recent: recent.rows.map(gapFromRecord) };
}

async function launchesByQuoteMint(db: Db, nowMs: number): Promise<QuoteMintCount[]> {
  const result = await db.query<DbRecord>(
    `SELECT quote_mint, count(*)::int AS n FROM launches WHERE created_at >= $1
     GROUP BY quote_mint ORDER BY count(*) DESC, quote_mint LIMIT 20`,
    [new Date(nowMs - DAY_MS)]
  );
  return result.rows.map((row) => {
    const quoteMint = String(row.quote_mint ?? "");
    return { quoteMint, label: quoteMintLabel(quoteMint), count: toNumber(row.n) };
  });
}

async function outcomeStatusCounts(db: Db, nowMs: number, windowHours: number): Promise<OutcomeStatusCount[]> {
  const result = await db.query<DbRecord>(
    `SELECT coalesce(o.status, 'pending') AS status, coalesce(o.finalized, FALSE) AS finalized, count(*)::int AS n
     FROM launches l
     LEFT JOIN launch_outcomes o ON o.launch_id = l.id
     WHERE l.created_at >= $1
     GROUP BY 1, 2
     ORDER BY count(*) DESC, 1, 2`,
    [new Date(nowMs - windowHours * HOUR_MS)]
  );
  return result.rows.map((row) => ({
    status: String(row.status ?? "pending"),
    finalized: row.finalized === true,
    count: toNumber(row.n)
  }));
}

async function activeTracking(db: Db): Promise<number> {
  const result = await db.query<DbRecord>(`SELECT count(*)::int AS n FROM launches WHERE tracking_ended_at IS NULL`);
  return toNumber(result.rows[0]?.n);
}

function sumCounts(items: readonly { count: number }[]): number {
  let total = 0;
  for (const item of items) {
    total += item.count;
  }
  return total;
}

export async function recorderHealth(db: Db, options: RecorderHealthOptions): Promise<RecorderHealth> {
  const nowMs = options.nowMs;
  const windowHours = options.outcomeWindowHours ?? DEFAULT_OUTCOME_WINDOW_HOURS;
  const hours = await launchesPerHour(db, nowMs);
  const minutes = await tradesPerMinute(db, nowMs);
  const lastTrade = await lastTradeAt(db, nowMs);
  const range = await launchRange(db);
  const gaps = await recentGaps(db, nowMs, options.gapLimit ?? DEFAULT_GAP_LIMIT);
  const quoteMints = await launchesByQuoteMint(db, nowMs);
  const outcomes = await outcomeStatusCounts(db, nowMs, windowHours);
  const tracking = await activeTracking(db);
  return {
    nowMs,
    recordingSinceMs: range.first,
    recordingDays: range.first === null ? null : Math.max(0, (nowMs - range.first) / DAY_MS),
    lastLaunchAtMs: range.last,
    lastLaunchAgeSec: ageSec(nowMs, range.last),
    lastTradeAtMs: lastTrade,
    lastTradeAgeSec: ageSec(nowMs, lastTrade),
    launchesLast24h: sumCounts(hours),
    tradesLastHour: sumCounts(minutes),
    launchesPerHour: hours,
    tradesPerMinute: minutes,
    gaps24h: gaps,
    launchesByQuoteMint: quoteMints,
    outcomeStatus: { windowHours, counts: outcomes },
    activeTracking: tracking
  };
}
