import { feeAmount } from "../chain/curve.js";
import type { ExecutionConfig, StrategyConfig } from "../config/strategy.js";
import { SOL_QUOTE } from "../core/constants.js";
import type { TradingMode } from "../core/types.js";
import { toBigInt, toNullableNumber, toNumber, type Db } from "../db/pool.js";
import { platformFeeOn } from "../execution/fees.js";
import { attemptCosts } from "../execution/model.js";
import { isUsablePrice, valueAtPrice } from "../exits/math.js";
import { dayKeyFor } from "../risk/day.js";
import { isMintAddress } from "./http.js";
import { LAB_LABEL_PREFIX } from "./labQueries.js";
import { clampLimit } from "./tradeQueries.js";
import { lamportsToSol } from "./units.js";

export const PUMP_COIN_URL = "https://pump.fun/coin/";
export const DEFAULT_OPEN_POSITION_LIMIT = 200;
export const DEFAULT_RECENT_CLOSED_LIMIT = 50;
export const MAX_RECENT_CLOSED_LIMIT = 500;
export const ACTIVITY_WINDOW_HOURS = 24;
export const MAX_POSITION_FILLS = 100;
const HOUR_MS = 3_600_000;
const BPS_SCALE = 10_000;
const MAX_SKIP_REASONS = 6;
const LIVE_MODES: readonly string[] = ["paper", "live"];

type DbRecord = Record<string, unknown>;

export interface SellFeeDefaults {
  curveBps: number;
  poolBps: number;
  extraPlatformBps: number;
  closeTxLamports: bigint;
  rentRefundLamports: bigint;
}

export interface SellFee {
  venueBps: number;
  platformBps: number;
  bps: number;
  source: SellFeeSource;
}

export interface EntryRules {
  enabled: string[];
  cooldownPerMintSec: number;
  maxOpenPositions: number;
  scorerMaxRisk: number;
  scoreMomentum: {
    checkpointSec: number;
    maxRiskScore: number;
    minUniqueBuyersPerMin: number;
    minBuySellRatio: number;
    minMcapSol: number;
    maxMcapSol: number;
  };
  convergence: {
    windowSec: number;
    minWallets: number;
    maxRiskScore: number;
  };
}

export interface PositionsRun {
  id: number;
  mode: string;
  label: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  active: boolean;
}

export interface BankrollView {
  startingSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number | null;
  equitySol: number | null;
  peakEquitySol: number;
  dayKey: string;
  dayStartEquitySol: number;
  dayPnlSol: number | null;
  haltedForDay: boolean;
  haltedUntilMs: number | null;
  killed: boolean;
  killReason: string | null;
  updatedAtMs: number | null;
}

export type SellFeeSource = "last_trade" | "default";

export interface LastTradeFees {
  protocolBps: number;
  creatorBps: number;
  lpBps: number;
}

export interface OpenPositionView {
  id: string;
  mode: string;
  status: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  signalType: string;
  riskScore: number | null;
  openedAtMs: number;
  ageSec: number;
  entryCostSol: number;
  budgetSol: number | null;
  entryPrice: number | null;
  lastPrice: number | null;
  peakPrice: number | null;
  multiple: number | null;
  peakMultiple: number | null;
  entryTokens: bigint;
  tokensHeld: bigint;
  soldPct: number | null;
  proceedsSol: number;
  feesPaidSol: number;
  sellFeeBps: number;
  sellFeeSource: SellFeeSource;
  estimatedValueSol: number | null;
  estimatedPnlSol: number | null;
  estimatedPnlPct: number | null;
  takeProfitLevelsHit: number;
  migrated: boolean;
  exiting: string | null;
  lastTradeAtMs: number | null;
  pumpUrl: string | null;
}

export interface ClosedPositionView {
  id: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  signalType: string;
  riskScore: number | null;
  openedAtMs: number;
  closedAtMs: number;
  holdSec: number;
  costSol: number;
  proceedsSol: number;
  feesPaidSol: number;
  pnlSol: number;
  pnlPct: number | null;
  peakMultiple: number | null;
  exitReason: string;
  pumpUrl: string | null;
}

export interface StoredFill {
  side: string;
  reason: string | null;
  atMs: number;
  price: number | null;
  tokenAmount: bigint;
  userQuote: bigint;
}

export interface PositionCounts {
  open: number;
  pending: number;
  closed: number;
  wins: number;
  realizedSol: number;
  closedCostSol: number;
  openedLast24h: number;
  closedLast24h: number;
  winsLast24h: number;
  realizedLast24hSol: number;
  lastOpenedAtMs: number | null;
  lastClosedAtMs: number | null;
}

export interface SignalTypeActivity {
  type: string;
  total: number;
  acted: number;
  lastAtMs: number | null;
}

export interface SkipReasonCount {
  reason: string;
  count: number;
}

export interface SignalActivity {
  windowHours: number;
  byType: SignalTypeActivity[];
  skipReasons: SkipReasonCount[];
}

export interface PositionsSnapshot {
  readAtMs: number;
  run: PositionsRun | null;
  bankroll: BankrollView | null;
  openPnlEstimateSol: number;
  equityEstimateSol: number | null;
  todayKey: string;
  todayPnlEstimateSol: number | null;
  open: OpenPositionView[];
  recentClosed: ClosedPositionView[];
  counts: PositionCounts;
  activity: SignalActivity;
}

export interface PositionsQuery {
  closedLimit?: number | null;
  nowMs: number;
  fees: SellFeeDefaults;
  dayResetUtcHour: number;
}

export function sellFeeDefaultsOf(execution: ExecutionConfig): SellFeeDefaults {
  const landedSell = attemptCosts(execution, true, true);
  return {
    curveBps: execution.defaultProtocolFeeBps + execution.defaultCreatorFeeBps,
    poolBps: execution.defaultPoolLpFeeBps + execution.defaultPoolProtocolFeeBps + execution.defaultPoolCreatorFeeBps,
    extraPlatformBps: execution.extraPlatformFeeBps,
    closeTxLamports: landedSell.networkFee + landedSell.tip,
    rentRefundLamports: execution.refundAtaOnClose ? BigInt(execution.ataRentLamports) : 0n
  };
}

export function entryRulesOf(config: StrategyConfig): EntryRules {
  const momentum = config.signals.scoreMomentum;
  const convergence = config.tracker.convergence;
  return {
    enabled: [...config.signals.enabled],
    cooldownPerMintSec: config.signals.cooldownPerMintSec,
    maxOpenPositions: config.risk.maxConcurrent,
    scorerMaxRisk: config.scorer.maxRisk,
    scoreMomentum: {
      checkpointSec: momentum.checkpointSec,
      maxRiskScore: momentum.maxRiskScore,
      minUniqueBuyersPerMin: momentum.minUniqueBuyersPerMin,
      minBuySellRatio: momentum.minBuySellRatio,
      minMcapSol: momentum.minMcapSol,
      maxMcapSol: momentum.maxMcapSol
    },
    convergence: {
      windowSec: convergence.windowSec,
      minWallets: convergence.minWallets,
      maxRiskScore: convergence.maxRiskScore
    }
  };
}

export function pumpCoinUrl(mint: string): string | null {
  return isMintAddress(mint) ? `${PUMP_COIN_URL}${mint}` : null;
}

function boundedBps(bps: number): number {
  return Number.isFinite(bps) ? Math.max(0, Math.min(BPS_SCALE, Math.round(bps))) : 0;
}

function sellFee(venueBps: number, platformBps: number, source: SellFeeSource): SellFee {
  const venue = boundedBps(venueBps);
  const platform = boundedBps(platformBps);
  return { venueBps: venue, platformBps: platform, bps: venue + platform, source };
}

export function sellFeeBpsFor(lastTrade: LastTradeFees | null, migrated: boolean, defaults: SellFeeDefaults): SellFee {
  if (lastTrade && lastTrade.protocolBps > 0) {
    return sellFee(lastTrade.protocolBps + lastTrade.creatorBps + lastTrade.lpBps, defaults.extraPlatformBps, "last_trade");
  }
  return sellFee(migrated ? defaults.poolBps : defaults.curveBps, defaults.extraPlatformBps, "default");
}

export function netSellValue(tokens: bigint, price: number, fee: Pick<SellFee, "venueBps" | "platformBps">): bigint {
  const gross = valueAtPrice(tokens, price);
  const afterVenue = gross - feeAmount(gross, boundedBps(fee.venueBps));
  if (afterVenue <= 0n) {
    return 0n;
  }
  const net = afterVenue - platformFeeOn(afterVenue, boundedBps(fee.platformBps));
  return net > 0n ? net : 0n;
}

export function estimatedCloseProceeds(
  tokens: bigint,
  price: number,
  fee: Pick<SellFee, "venueBps" | "platformBps">,
  defaults: Pick<SellFeeDefaults, "closeTxLamports" | "rentRefundLamports">
): bigint {
  if (tokens <= 0n) {
    return 0n;
  }
  return netSellValue(tokens, price, fee) - defaults.closeTxLamports + defaults.rentRefundLamports;
}

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function usablePrice(value: unknown): number | null {
  const price = toNullableNumber(value);
  return price !== null && isUsablePrice(price) ? price : null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) {
    return null;
  }
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

function pctOf(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) {
    return null;
  }
  return (Number(numerator) / Number(denominator)) * 100;
}

function soldPctOf(entryTokens: bigint, tokensHeld: bigint): number | null {
  const pct = pctOf(entryTokens - tokensHeld, entryTokens);
  return pct === null ? null : Math.max(0, Math.min(100, pct));
}

function lamportsOrNull(value: unknown): bigint | null {
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  return typeof value === "bigint" ? value : null;
}

function runFromRecord(row: DbRecord): PositionsRun {
  const endedAtMs = msOf(row.ended_at);
  return {
    id: toNumber(row.id),
    mode: text(row.mode, "paper"),
    label: textOrNull(row.label),
    startedAtMs: msOf(row.started_at) ?? 0,
    endedAtMs,
    active: endedAtMs === null
  };
}

export async function selectPositionsRun(
  db: Db,
  options: { runId?: number | null; mode?: TradingMode | null }
): Promise<PositionsRun | null> {
  const result = await db.query<DbRecord>(
    `SELECT r.id, r.mode, r.label, r.started_at, r.ended_at
     FROM strategy_runs r
     WHERE ($1::bigint IS NULL OR r.id = $1)
       AND ($2::text IS NULL OR r.mode = $2)
       AND ($1::bigint IS NOT NULL OR r.label IS NULL OR r.label NOT LIKE '${LAB_LABEL_PREFIX}%')
     ORDER BY (r.mode = ANY($3::text[])) DESC,
              (r.ended_at IS NULL) DESC,
              EXISTS (SELECT 1 FROM positions p WHERE p.run_id = r.id) DESC,
              r.started_at DESC, r.id DESC
     LIMIT 1`,
    [options.runId ?? null, options.mode ?? null, LIVE_MODES]
  );
  const row = result.rows[0];
  return row ? runFromRecord(row) : null;
}

interface BankrollRecord {
  view: BankrollView;
  ledgerLamports: bigint;
  dayStartLamports: bigint;
}

interface OpenPositionRecord {
  view: OpenPositionView;
  pnlLamports: bigint | null;
}

async function loadBankrollRecord(db: Db, runId: number, nowMs: number): Promise<BankrollRecord | null> {
  const result = await db.query<DbRecord>(
    `SELECT starting_bankroll, realized_pnl, peak_equity, day_key, day_start_equity, halted_until, killed, kill_reason, updated_at,
            state->>'unrealizedPnlLamports' AS unrealized
     FROM risk_state WHERE run_id = $1`,
    [runId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const starting = toBigInt(row.starting_bankroll);
  const realized = toBigInt(row.realized_pnl);
  const dayStart = toBigInt(row.day_start_equity);
  const unrealized = lamportsOrNull(row.unrealized);
  const equity = unrealized === null ? null : starting + realized + unrealized;
  const haltedUntilMs = msOf(row.halted_until);
  const view: BankrollView = {
    startingSol: lamportsToSol(starting),
    realizedPnlSol: lamportsToSol(realized),
    unrealizedPnlSol: unrealized === null ? null : lamportsToSol(unrealized),
    equitySol: equity === null ? null : lamportsToSol(equity),
    peakEquitySol: lamportsToSol(toBigInt(row.peak_equity)),
    dayKey: text(row.day_key, ""),
    dayStartEquitySol: lamportsToSol(dayStart),
    dayPnlSol: equity === null ? null : lamportsToSol(equity - dayStart),
    haltedForDay: haltedUntilMs !== null && haltedUntilMs > nowMs,
    haltedUntilMs,
    killed: row.killed === true,
    killReason: textOrNull(row.kill_reason),
    updatedAtMs: msOf(row.updated_at)
  };
  return { view, ledgerLamports: starting + realized, dayStartLamports: dayStart };
}

export async function loadBankroll(db: Db, runId: number, nowMs: number): Promise<BankrollView | null> {
  return (await loadBankrollRecord(db, runId, nowMs))?.view ?? null;
}

function lastTradeFeesOf(row: DbRecord): LastTradeFees | null {
  if (row.fee_protocol_bps === null || row.fee_protocol_bps === undefined) {
    return null;
  }
  return {
    protocolBps: toNumber(row.fee_protocol_bps),
    creatorBps: toNumber(row.fee_creator_bps),
    lpBps: toNumber(row.fee_lp_bps)
  };
}

function openPositionFromRecord(row: DbRecord, nowMs: number, fees: SellFeeDefaults): OpenPositionRecord {
  const mint = text(row.mint, "");
  const status = text(row.status, "open");
  const openedAtMs = msOf(row.opened_at) ?? nowMs;
  const entryCost = toBigInt(row.entry_cost);
  const proceeds = toBigInt(row.proceeds);
  const entryTokens = toBigInt(row.entry_tokens);
  const tokensHeld = toBigInt(row.tokens_held);
  const entryPrice = usablePrice(row.entry_price);
  const lastPrice = usablePrice(row.last_price);
  const peakPrice = usablePrice(row.peak_price);
  const migrated = row.migrated_seen === true || row.migrated_at instanceof Date || toNumber(row.fee_venue) === 1;
  const fee = sellFeeBpsFor(lastTradeFeesOf(row), migrated, fees);
  const filled = status === "open" && entryTokens > 0n;
  const value = filled && lastPrice !== null ? estimatedCloseProceeds(tokensHeld, lastPrice, fee, fees) : null;
  const pnl = value === null ? null : proceeds + value - entryCost;
  const budget = lamportsOrNull(row.budget);
  const view: OpenPositionView = {
    id: text(row.id, ""),
    mode: text(row.mode, "paper"),
    status,
    mint,
    name: textOrNull(row.name),
    symbol: textOrNull(row.symbol),
    signalType: text(row.signal_type, "unknown"),
    riskScore: toNullableNumber(row.risk_score),
    openedAtMs,
    ageSec: Math.max(0, (nowMs - openedAtMs) / 1000),
    entryCostSol: lamportsToSol(entryCost),
    budgetSol: budget === null ? null : lamportsToSol(budget),
    entryPrice,
    lastPrice,
    peakPrice,
    multiple: ratio(lastPrice, entryPrice),
    peakMultiple: ratio(peakPrice, entryPrice),
    entryTokens,
    tokensHeld,
    soldPct: entryTokens > 0n ? soldPctOf(entryTokens, tokensHeld) : null,
    proceedsSol: lamportsToSol(proceeds),
    feesPaidSol: lamportsToSol(toBigInt(row.fees_paid)),
    sellFeeBps: fee.bps,
    sellFeeSource: fee.source,
    estimatedValueSol: value === null ? null : lamportsToSol(value),
    estimatedPnlSol: pnl === null ? null : lamportsToSol(pnl),
    estimatedPnlPct: pnl === null ? null : pctOf(pnl, entryCost),
    takeProfitLevelsHit: toNumber(row.take_profit_levels_hit),
    migrated,
    exiting: textOrNull(row.exiting),
    lastTradeAtMs: msOf(row.fee_seen_at) ?? msOf(row.last_trade_at),
    pumpUrl: pumpCoinUrl(mint)
  };
  return { view, pnlLamports: pnl };
}

async function loadOpenPositionRecords(db: Db, runId: number, nowMs: number, fees: SellFeeDefaults, limit: number): Promise<OpenPositionRecord[]> {
  const result = await db.query<DbRecord>(
    `SELECT p.id, p.mode, p.status, p.mint, p.signal_type, p.risk_score, p.opened_at, p.entry_price, p.last_price, p.peak_price,
            p.entry_tokens, p.tokens_held, p.entry_cost, p.proceeds, p.fees_paid, p.take_profit_levels_hit, p.migrated_seen,
            p.meta #>> '{exit,liquidating,reason}' AS exiting,
            p.meta #>> '{pendingEntry,quoteBudget}' AS budget,
            l.name, l.symbol, l.migrated_at, l.last_trade_at,
            f.protocol_fee_bps AS fee_protocol_bps, f.creator_fee_bps AS fee_creator_bps, f.lp_fee_bps AS fee_lp_bps,
            f.venue AS fee_venue, f.block_time AS fee_seen_at
     FROM positions p
     LEFT JOIN launches l ON l.mint = p.mint
     LEFT JOIN LATERAL (
       SELECT t.protocol_fee_bps, t.creator_fee_bps, t.lp_fee_bps, t.venue, t.block_time
       FROM trades t
       WHERE t.launch_id = l.id AND t.block_time >= l.created_at - interval '1 hour'
       ORDER BY t.slot DESC, t.seq DESC, t.event_index DESC
       LIMIT 1
     ) f ON TRUE
     WHERE p.run_id = $1 AND p.status IN ('open', 'pending') AND p.shadow_of IS NULL
       AND (l.id IS NULL OR l.quote_mint = $3)
     ORDER BY p.opened_at DESC, p.id DESC
     LIMIT $2`,
    [runId, clampLimit(limit, DEFAULT_OPEN_POSITION_LIMIT, 1_000), SOL_QUOTE]
  );
  return result.rows.map((row) => openPositionFromRecord(row, nowMs, fees));
}

export async function loadOpenPositionViews(
  db: Db,
  runId: number,
  nowMs: number,
  fees: SellFeeDefaults,
  limit = DEFAULT_OPEN_POSITION_LIMIT
): Promise<OpenPositionView[]> {
  return (await loadOpenPositionRecords(db, runId, nowMs, fees, limit)).map((record) => record.view);
}

function closedPositionFromRecord(row: DbRecord): ClosedPositionView {
  const mint = text(row.mint, "");
  const openedAtMs = msOf(row.opened_at) ?? 0;
  const closedAtMs = msOf(row.closed_at) ?? openedAtMs;
  const cost = toBigInt(row.entry_cost);
  const proceeds = toBigInt(row.proceeds);
  const realized = row.realized_pnl;
  const pnl = realized === null || realized === undefined ? proceeds - cost : toBigInt(realized);
  return {
    id: text(row.id, ""),
    mint,
    name: textOrNull(row.name),
    symbol: textOrNull(row.symbol),
    signalType: text(row.signal_type, "unknown"),
    riskScore: toNullableNumber(row.risk_score),
    openedAtMs,
    closedAtMs,
    holdSec: toNullableNumber(row.hold_sec) ?? Math.max(0, (closedAtMs - openedAtMs) / 1000),
    costSol: lamportsToSol(cost),
    proceedsSol: lamportsToSol(proceeds),
    feesPaidSol: lamportsToSol(toBigInt(row.fees_paid)),
    pnlSol: lamportsToSol(pnl),
    pnlPct: pctOf(pnl, cost),
    peakMultiple: toNullableNumber(row.peak_multiple),
    exitReason: text(row.exit_reason, "unknown"),
    pumpUrl: pumpCoinUrl(mint)
  };
}

export async function loadRecentClosedPositions(db: Db, runId: number, limit = DEFAULT_RECENT_CLOSED_LIMIT): Promise<ClosedPositionView[]> {
  const result = await db.query<DbRecord>(
    `SELECT p.id, p.mint, p.signal_type, p.risk_score, p.opened_at, p.closed_at, p.hold_sec, p.entry_cost, p.proceeds, p.fees_paid,
            p.realized_pnl, p.peak_multiple, p.exit_reason, l.name, l.symbol
     FROM positions p
     LEFT JOIN launches l ON l.mint = p.mint
     WHERE p.run_id = $1 AND p.status = 'closed' AND p.closed_at IS NOT NULL AND p.shadow_of IS NULL
       AND (l.id IS NULL OR l.quote_mint = $3)
     ORDER BY p.closed_at DESC, p.id DESC
     LIMIT $2`,
    [runId, clampLimit(limit, DEFAULT_RECENT_CLOSED_LIMIT, MAX_RECENT_CLOSED_LIMIT), SOL_QUOTE]
  );
  return result.rows.map(closedPositionFromRecord);
}

export async function loadPositionCounts(db: Db, runId: number, sinceMs: number): Promise<PositionCounts> {
  const result = await db.query<DbRecord>(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status = 'closed')::int AS closed,
            count(*) FILTER (WHERE status = 'closed' AND coalesce(realized_pnl, proceeds - entry_cost) > 0)::int AS wins,
            coalesce(sum(coalesce(realized_pnl, proceeds - entry_cost)) FILTER (WHERE status = 'closed'), 0)::bigint AS pnl_closed,
            coalesce(sum(entry_cost) FILTER (WHERE status = 'closed'), 0)::bigint AS cost_closed,
            count(*) FILTER (WHERE opened_at >= $2)::int AS opened_recent,
            count(*) FILTER (WHERE status = 'closed' AND closed_at >= $2)::int AS closed_recent,
            count(*) FILTER (WHERE status = 'closed' AND closed_at >= $2 AND coalesce(realized_pnl, proceeds - entry_cost) > 0)::int AS wins_recent,
            coalesce(sum(coalesce(realized_pnl, proceeds - entry_cost)) FILTER (WHERE status = 'closed' AND closed_at >= $2), 0)::bigint AS pnl_recent,
            max(opened_at) AS last_opened,
            max(closed_at) FILTER (WHERE status = 'closed') AS last_closed
     FROM positions p
     WHERE p.run_id = $1 AND p.shadow_of IS NULL
       AND NOT EXISTS (SELECT 1 FROM launches l WHERE l.mint = p.mint AND l.quote_mint <> $3)`,
    [runId, new Date(sinceMs), SOL_QUOTE]
  );
  const row = result.rows[0] ?? {};
  return {
    open: toNumber(row.open),
    pending: toNumber(row.pending),
    closed: toNumber(row.closed),
    wins: toNumber(row.wins),
    realizedSol: lamportsToSol(toBigInt(row.pnl_closed)),
    closedCostSol: lamportsToSol(toBigInt(row.cost_closed)),
    openedLast24h: toNumber(row.opened_recent),
    closedLast24h: toNumber(row.closed_recent),
    winsLast24h: toNumber(row.wins_recent),
    realizedLast24hSol: lamportsToSol(toBigInt(row.pnl_recent)),
    lastOpenedAtMs: msOf(row.last_opened),
    lastClosedAtMs: msOf(row.last_closed)
  };
}

function storedFillFromRecord(row: DbRecord): StoredFill {
  return {
    side: text(row.side, ""),
    reason: textOrNull(row.reason),
    atMs: msOf(row.at) ?? 0,
    price: toNullableNumber(row.fill_price),
    tokenAmount: toBigInt(row.token_amount),
    userQuote: toBigInt(row.user_quote)
  };
}

export async function loadPositionFills(db: Db, positionId: string): Promise<StoredFill[]> {
  const result = await db.query<DbRecord>(
    `SELECT side, reason, coalesce(filled_at, requested_at) AS at, fill_price, token_amount, user_quote
     FROM fills
     WHERE position_id = $1 AND success
     ORDER BY coalesce(filled_at, requested_at), id
     LIMIT $2`,
    [positionId, MAX_POSITION_FILLS]
  );
  return result.rows.map(storedFillFromRecord);
}

export async function loadSignalActivity(db: Db, runId: number, sinceMs: number): Promise<SignalActivity> {
  const result = await db.query<DbRecord>(
    `SELECT type, acted, skip_reason, count(*)::int AS n, max(at) AS last_at
     FROM signals
     WHERE run_id = $1 AND at >= $2
     GROUP BY type, acted, skip_reason`,
    [runId, new Date(sinceMs)]
  );
  const byType = new Map<string, SignalTypeActivity>();
  const skips = new Map<string, number>();
  for (const row of result.rows) {
    const type = text(row.type, "unknown");
    const count = toNumber(row.n);
    const lastAtMs = msOf(row.last_at);
    const entry = byType.get(type) ?? { type, total: 0, acted: 0, lastAtMs: null };
    entry.total += count;
    if (row.acted === true) {
      entry.acted += count;
    } else {
      const reason = text(row.skip_reason, "not_traded");
      skips.set(reason, (skips.get(reason) ?? 0) + count);
    }
    if (lastAtMs !== null && (entry.lastAtMs === null || lastAtMs > entry.lastAtMs)) {
      entry.lastAtMs = lastAtMs;
    }
    byType.set(type, entry);
  }
  return {
    windowHours: ACTIVITY_WINDOW_HOURS,
    byType: [...byType.values()].sort((a, b) => b.total - a.total || (a.type < b.type ? -1 : 1)),
    skipReasons: [...skips.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1))
      .slice(0, MAX_SKIP_REASONS)
  };
}

function emptyCounts(): PositionCounts {
  return {
    open: 0,
    pending: 0,
    closed: 0,
    wins: 0,
    realizedSol: 0,
    closedCostSol: 0,
    openedLast24h: 0,
    closedLast24h: 0,
    winsLast24h: 0,
    realizedLast24hSol: 0,
    lastOpenedAtMs: null,
    lastClosedAtMs: null
  };
}

export function emptyPositionsSnapshot(nowMs: number, dayResetUtcHour: number): PositionsSnapshot {
  return {
    readAtMs: nowMs,
    run: null,
    bankroll: null,
    openPnlEstimateSol: 0,
    equityEstimateSol: null,
    todayKey: dayKeyFor(nowMs, dayResetUtcHour),
    todayPnlEstimateSol: null,
    open: [],
    recentClosed: [],
    counts: emptyCounts(),
    activity: { windowHours: ACTIVITY_WINDOW_HOURS, byType: [], skipReasons: [] }
  };
}

export async function loadPositionsSnapshot(db: Db, run: PositionsRun, query: PositionsQuery): Promise<PositionsSnapshot> {
  const sinceMs = query.nowMs - ACTIVITY_WINDOW_HOURS * HOUR_MS;
  const todayKey = dayKeyFor(query.nowMs, query.dayResetUtcHour);
  const [bankroll, open, recentClosed, counts, activity] = await Promise.all([
    loadBankrollRecord(db, run.id, query.nowMs),
    loadOpenPositionRecords(db, run.id, query.nowMs, query.fees, DEFAULT_OPEN_POSITION_LIMIT),
    loadRecentClosedPositions(db, run.id, query.closedLimit ?? DEFAULT_RECENT_CLOSED_LIMIT),
    loadPositionCounts(db, run.id, sinceMs),
    loadSignalActivity(db, run.id, sinceMs)
  ]);
  let openPnl = 0n;
  for (const record of open) {
    openPnl += record.pnlLamports ?? 0n;
  }
  const equity = bankroll ? bankroll.ledgerLamports + openPnl : null;
  const today = bankroll && equity !== null && bankroll.view.dayKey === todayKey ? equity - bankroll.dayStartLamports : null;
  return {
    readAtMs: query.nowMs,
    run,
    bankroll: bankroll?.view ?? null,
    openPnlEstimateSol: lamportsToSol(openPnl),
    equityEstimateSol: equity === null ? null : lamportsToSol(equity),
    todayKey,
    todayPnlEstimateSol: today === null ? null : lamportsToSol(today),
    open: open.map((record) => record.view),
    recentClosed,
    counts,
    activity
  };
}
