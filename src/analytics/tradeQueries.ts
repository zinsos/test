import type { ClosedTrade, OrderSide, SignalType, TradingMode } from "../core/types.js";
import { toBigInt, toNullableNumber, toNumber, type Db } from "../db/pool.js";
import type { FillSummary, PaperLivePair } from "./compare.js";
import { LAB_LABEL_PREFIX, LAB_RUN_IDS_SQL } from "./labQueries.js";
import { equitySeries, type EquityOptions, type EquityPoint } from "./metrics.js";
import { lamportsToSol } from "./units.js";

export const TRADING_MODES: readonly TradingMode[] = ["paper", "live", "backtest", "shadow"];
export const DEFAULT_TRADE_LIMIT = 50_000;
export const MAX_TRADE_LIMIT = 200_000;
export const DEFAULT_PAIR_LIMIT = 2_000;
export const DEFAULT_RUN_LIMIT = 100;
const FILL_CHUNK = 1_000;

export interface TradeFilter {
  runId?: number | null;
  mode?: TradingMode | null;
  fromMs?: number | null;
  toMs?: number | null;
  includeShadows?: boolean;
  limit?: number | null;
}

export interface ClosedTradeRecord extends ClosedTrade {
  shadowOf: string | null;
}

export interface RunInfo {
  id: number;
  mode: string;
  label: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  dataFromMs: number | null;
  dataToMs: number | null;
  closedTrades: number;
  openPositions: number;
  pendingEntries: number;
  shadowTrades: number;
  realizedPnlSol: number;
  lastClosedAtMs: number | null;
}

export interface ModeInfo {
  mode: string;
  closedTrades: number;
  lastClosedAtMs: number | null;
}

type DbRecord = Record<string, unknown>;

export function isTradingMode(value: string): value is TradingMode {
  return (TRADING_MODES as readonly string[]).includes(value);
}

export function clampLimit(limit: number | null | undefined, fallback: number, max: number): number {
  if (limit === null || limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

function dateParam(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function positionColumns(alias: string, prefix: string): string {
  const columns = [
    "id",
    "run_id",
    "mode",
    "mint",
    "signal_type",
    "risk_score",
    "opened_at",
    "closed_at",
    "hold_sec",
    "entry_cost",
    "proceeds",
    "fees_paid",
    "realized_pnl",
    "exit_reason",
    "peak_multiple",
    "shadow_of"
  ];
  return columns.map((column) => `${alias}.${column} AS ${prefix}${column}`).join(", ");
}

export function closedTradeFromRecord(record: DbRecord, prefix = ""): ClosedTradeRecord {
  const field = (name: string): unknown => record[`${prefix}${name}`];
  const openedAtMs = msOf(field("opened_at")) ?? 0;
  const closedAtMs = msOf(field("closed_at")) ?? openedAtMs;
  const cost = toBigInt(field("entry_cost"));
  const proceeds = toBigInt(field("proceeds"));
  const realized = field("realized_pnl");
  const holdSec = toNullableNumber(field("hold_sec"));
  const shadowOf = field("shadow_of");
  return {
    positionId: text(field("id")),
    runId: toNumber(field("run_id")),
    mode: text(field("mode"), "paper") as TradingMode,
    mint: text(field("mint")),
    signalType: text(field("signal_type"), "unknown") as SignalType,
    riskScore: toNullableNumber(field("risk_score")),
    openedAtMs,
    closedAtMs,
    holdSec: holdSec ?? Math.max(0, (closedAtMs - openedAtMs) / 1000),
    cost,
    proceeds,
    pnl: realized === null || realized === undefined ? proceeds - cost : toBigInt(realized),
    fees: toBigInt(field("fees_paid")),
    exitReason: text(field("exit_reason"), "unknown"),
    peakMultiple: toNullableNumber(field("peak_multiple")) ?? 0,
    shadowOf: typeof shadowOf === "string" ? shadowOf : null
  };
}

function tradeFilterParams(filter: TradeFilter): unknown[] {
  return [
    filter.runId ?? null,
    filter.mode ?? null,
    dateParam(filter.fromMs),
    dateParam(filter.toMs),
    filter.includeShadows === true
  ];
}

const TRADE_FILTER_SQL = `p.status = 'closed' AND p.closed_at IS NOT NULL
   AND ($1::bigint IS NULL OR p.run_id = $1)
   AND ($2::text IS NULL OR p.mode = $2)
   AND ($3::timestamptz IS NULL OR p.closed_at >= $3)
   AND ($4::timestamptz IS NULL OR p.closed_at < $4)
   AND ($5::boolean OR p.shadow_of IS NULL)
   AND ($1::bigint IS NOT NULL OR p.run_id NOT IN (${LAB_RUN_IDS_SQL}))`;

export async function loadClosedTrades(db: Db, filter: TradeFilter = {}): Promise<ClosedTradeRecord[]> {
  const limit = clampLimit(filter.limit, DEFAULT_TRADE_LIMIT, MAX_TRADE_LIMIT);
  const result = await db.query<DbRecord>(
    `SELECT ${positionColumns("p", "")} FROM positions p
     WHERE ${TRADE_FILTER_SQL}
     ORDER BY p.closed_at DESC, p.id DESC
     LIMIT $6`,
    [...tradeFilterParams(filter), limit]
  );
  return result.rows.map((row) => closedTradeFromRecord(row)).reverse();
}

export async function* iterateClosedTrades(
  db: Db,
  filter: TradeFilter = {},
  pageSize = 2_000
): AsyncGenerator<ClosedTradeRecord[]> {
  let remaining = clampLimit(filter.limit, MAX_TRADE_LIMIT, MAX_TRADE_LIMIT);
  let cursorTime = "-infinity";
  let cursorId = "";
  while (remaining > 0) {
    const take = Math.min(pageSize, remaining);
    const result = await db.query<DbRecord>(
      `SELECT ${positionColumns("p", "")}, p.closed_at::text AS cursor_at FROM positions p
       WHERE ${TRADE_FILTER_SQL}
         AND (p.closed_at, p.id) > ($6::timestamptz, $7::text)
       ORDER BY p.closed_at, p.id
       LIMIT $8`,
      [...tradeFilterParams(filter), cursorTime, cursorId, take]
    );
    const page = result.rows.map((row) => closedTradeFromRecord(row));
    const last = result.rows[result.rows.length - 1];
    if (page.length > 0) {
      yield page;
    }
    remaining -= page.length;
    if (!last || page.length < take) {
      return;
    }
    cursorTime = text(last.cursor_at, cursorTime);
    cursorId = text(last.id);
  }
}

export async function loadEquity(db: Db, filter: TradeFilter = {}, options: EquityOptions = {}): Promise<EquityPoint[]> {
  return equitySeries(await loadClosedTrades(db, filter), options);
}

function runFromRecord(row: DbRecord): RunInfo {
  return {
    id: toNumber(row.id),
    mode: text(row.mode),
    label: typeof row.label === "string" ? row.label : null,
    startedAtMs: msOf(row.started_at) ?? 0,
    endedAtMs: msOf(row.ended_at),
    dataFromMs: msOf(row.data_from),
    dataToMs: msOf(row.data_to),
    closedTrades: toNumber(row.closed),
    openPositions: toNumber(row.open),
    pendingEntries: toNumber(row.pending),
    shadowTrades: toNumber(row.shadows),
    realizedPnlSol: lamportsToSol(toBigInt(row.pnl)),
    lastClosedAtMs: msOf(row.last_closed)
  };
}

export function isLabLabel(label: string | null | undefined): boolean {
  return typeof label === "string" && label.startsWith(LAB_LABEL_PREFIX);
}

export async function loadRuns(
  db: Db,
  options: { limit?: number; mode?: TradingMode | null; includeLab?: boolean } = {}
): Promise<RunInfo[]> {
  const limit = clampLimit(options.limit, DEFAULT_RUN_LIMIT, 1_000);
  const result = await db.query<DbRecord>(
    `SELECT r.id, r.mode, r.label, r.started_at, r.ended_at, r.data_from, r.data_to,
            coalesce(p.closed, 0) AS closed, coalesce(p.open, 0) AS open, coalesce(p.pending, 0) AS pending, coalesce(p.shadows, 0) AS shadows,
            coalesce(p.pnl, 0)::bigint AS pnl, p.last_closed
     FROM strategy_runs r
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE status = 'closed' AND shadow_of IS NULL)::int AS closed,
              count(*) FILTER (WHERE status = 'open' AND shadow_of IS NULL)::int AS open,
              count(*) FILTER (WHERE status = 'pending' AND shadow_of IS NULL)::int AS pending,
              count(*) FILTER (WHERE status = 'closed' AND shadow_of IS NOT NULL)::int AS shadows,
              sum(coalesce(realized_pnl, proceeds - entry_cost)) FILTER (WHERE status = 'closed' AND shadow_of IS NULL) AS pnl,
              max(closed_at) FILTER (WHERE shadow_of IS NULL) AS last_closed
       FROM positions WHERE run_id = r.id
     ) p ON TRUE
     WHERE ($2::text IS NULL OR r.mode = $2)
       AND ($3::boolean OR r.label IS NULL OR r.label NOT LIKE '${LAB_LABEL_PREFIX}%')
     ORDER BY r.started_at DESC, r.id DESC
     LIMIT $1`,
    [limit, options.mode ?? null, options.includeLab === true]
  );
  return result.rows.map(runFromRecord);
}

export async function loadModes(db: Db): Promise<ModeInfo[]> {
  const result = await db.query<DbRecord>(
    `SELECT mode, count(*)::int AS closed, max(closed_at) AS last_closed
     FROM positions
     WHERE status = 'closed' AND shadow_of IS NULL AND run_id NOT IN (${LAB_RUN_IDS_SQL})
     GROUP BY mode
     ORDER BY max(closed_at) DESC NULLS LAST`
  );
  return result.rows.map((row) => ({
    mode: text(row.mode),
    closedTrades: toNumber(row.closed),
    lastClosedAtMs: msOf(row.last_closed)
  }));
}

function fillFromRecord(row: DbRecord): FillSummary {
  return {
    side: text(row.side) === "sell" ? "sell" : ("buy" as OrderSide),
    success: row.success === true,
    tokenAmount: toBigInt(row.token_amount),
    quoteAmount: toBigInt(row.quote_amount),
    userQuote: toBigInt(row.user_quote),
    requestedAtMs: msOf(row.requested_at) ?? 0,
    filledAtMs: msOf(row.filled_at),
    attempts: toNumber(row.attempts)
  };
}

export async function loadFills(db: Db, positionIds: readonly string[]): Promise<Map<string, FillSummary[]>> {
  const byPosition = new Map<string, FillSummary[]>();
  for (let start = 0; start < positionIds.length; start += FILL_CHUNK) {
    const chunk = positionIds.slice(start, start + FILL_CHUNK);
    const result = await db.query<DbRecord>(
      `SELECT position_id, side, success, token_amount, quote_amount, user_quote, requested_at, filled_at,
              CASE WHEN jsonb_typeof(attempts) = 'array' THEN jsonb_array_length(attempts) ELSE 0 END AS attempts
       FROM fills
       WHERE position_id = ANY($1::text[])
       ORDER BY id`,
      [chunk]
    );
    for (const row of result.rows) {
      const id = text(row.position_id);
      const list = byPosition.get(id) ?? [];
      list.push(fillFromRecord(row));
      byPosition.set(id, list);
    }
  }
  return byPosition;
}

export async function loadPaperLivePairs(
  db: Db,
  filter: Omit<TradeFilter, "mode" | "includeShadows"> = {}
): Promise<PaperLivePair[]> {
  const limit = clampLimit(filter.limit, DEFAULT_PAIR_LIMIT, 20_000);
  const result = await db.query<DbRecord>(
    `SELECT ${positionColumns("l", "l_")}, ${positionColumns("s", "s_")}
     FROM positions s
     JOIN positions l ON l.id = s.shadow_of
     WHERE s.shadow_of IS NOT NULL AND s.status = 'closed' AND l.status = 'closed'
       AND s.closed_at IS NOT NULL AND l.closed_at IS NOT NULL
       AND ($1::bigint IS NULL OR l.run_id = $1)
       AND ($2::timestamptz IS NULL OR l.closed_at >= $2)
       AND ($3::timestamptz IS NULL OR l.closed_at < $3)
     ORDER BY l.closed_at DESC, l.id DESC
     LIMIT $4`,
    [filter.runId ?? null, dateParam(filter.fromMs), dateParam(filter.toMs), limit]
  );
  const pairs = result.rows.map((row) => ({
    live: closedTradeFromRecord(row, "l_"),
    paper: closedTradeFromRecord(row, "s_")
  }));
  const ids = pairs.flatMap((pair) => [pair.live.positionId, pair.paper.positionId]);
  const fills = await loadFills(db, ids);
  return pairs.reverse().map((pair) => ({
    live: pair.live,
    paper: pair.paper,
    liveFills: fills.get(pair.live.positionId) ?? [],
    paperFills: fills.get(pair.paper.positionId) ?? []
  }));
}
