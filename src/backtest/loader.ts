import type { Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type {
  ChainEvent,
  CurveCompleteEvent,
  LaunchCreatedEvent,
  MigrationEvent,
  Pubkey,
  TradeEvent,
  TradeVenue
} from "../core/types.js";
import { toBigInt, toNullableBigInt, toNumber, type Db } from "../db/pool.js";
import type { MarketState } from "../market/state.js";

const log = moduleLogger("backtest.loader");
const HOUR_MS = 3_600_000;

export const REPLAY_PHASE = { create: 0, migrate: 1, trade: 2, complete: 3 } as const;

export interface ObservationModel {
  defaultDelayMs: number;
  maxLagMs: number;
}

export const DEFAULT_OBSERVATION: ObservationModel = { defaultDelayMs: 1_500, maxLagMs: 30_000 };

const VENUE_BY_CODE: Record<number, TradeVenue> = { 0: "curve", 1: "pool", 2: "curve_post_complete" };

export interface ReplayEvent {
  atMs: number;
  visibleAtMs: number;
  slot: number;
  phase: number;
  seq: number;
  eventIndex: number;
  tiebreak: string;
  launchId: number;
  event: ChainEvent;
  incompleteFromMs?: number | null;
}

type DbRecord = Record<string, unknown>;

export const LAUNCH_SELECT = `id, mint, bonding_curve, dev_wallet, creator, name, symbol, uri, quote_mint, token_program,
  is_mayhem, is_cashback, is_holder_reward, creator_fee_bps, depth, create_signature, create_slot, created_at, observed_at,
  token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token, pool,
  completed_at, completed_slot, migrated_at, migrated_slot, data_complete, data_incomplete_at`;

export const TRADE_SELECT = `t.launch_id, l.mint, l.pool AS launch_pool, t.block_time, t.slot, t.seq, t.signature, t.event_index,
  t.venue, t.wallet, t.is_buy, t.token_amount, t.quote_amount, t.user_quote, t.protocol_fee, t.creator_fee, t.lp_fee,
  t.protocol_fee_bps, t.creator_fee_bps, t.lp_fee_bps, t.virtual_token, t.virtual_quote, t.real_token, t.real_quote, t.ix_name,
  t.received_at`;

export const REPLAY_TRADE_SELECT = `t.launch_id::float8 AS launch_id, floor(extract(epoch FROM t.block_time) * 1000)::float8 AS block_ms,
  t.slot::float8 AS slot, t.seq::float8 AS seq, t.signature, t.event_index, t.venue, t.wallet, t.is_buy, t.token_amount, t.quote_amount,
  t.user_quote, t.protocol_fee, t.creator_fee, t.lp_fee, t.protocol_fee_bps, t.creator_fee_bps, t.lp_fee_bps, t.virtual_token,
  t.virtual_quote, t.real_token, t.real_quote, t.ix_name, floor(extract(epoch FROM t.received_at) * 1000)::float8 AS received_ms,
  CASE WHEN t.venue = 1 THEN l.pool END AS launch_pool`;

const POOL_VENUE_CODE = 1;

function msOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : toNumber(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function compareReplayEvents(a: ReplayEvent, b: ReplayEvent): number {
  return (
    a.atMs - b.atMs ||
    a.slot - b.slot ||
    a.phase - b.phase ||
    a.seq - b.seq ||
    a.eventIndex - b.eventIndex ||
    (a.tiebreak < b.tiebreak ? -1 : a.tiebreak > b.tiebreak ? 1 : 0)
  );
}

export function observedAtMs(blockMs: number, receivedAt: unknown, observation: ObservationModel = DEFAULT_OBSERVATION): number {
  if (!(receivedAt instanceof Date)) {
    return blockMs + observation.defaultDelayMs;
  }
  return clampObserved(blockMs, receivedAt.getTime(), observation);
}

function clampObserved(blockMs: number, receivedMs: number, observation: ObservationModel): number {
  return Math.min(Math.max(receivedMs, blockMs), blockMs + observation.maxLagMs);
}

export function launchEventFromRow(row: DbRecord, observation: ObservationModel = DEFAULT_OBSERVATION): LaunchCreatedEvent {
  const createdAtMs = msOf(row.created_at);
  const slot = toNumber(row.create_slot);
  return {
    kind: "create",
    tx: {
      signature: text(row.create_signature),
      slot,
      seq: 0,
      eventIndex: 0,
      receivedAtMs: observedAtMs(createdAtMs, row.observed_at, observation)
    },
    mint: text(row.mint),
    bondingCurve: text(row.bonding_curve),
    devWallet: text(row.dev_wallet),
    creator: text(row.creator),
    name: text(row.name),
    symbol: text(row.symbol),
    uri: text(row.uri),
    timestampMs: createdAtMs,
    virtualTokenReserves: toBigInt(row.initial_virtual_token),
    virtualQuoteReserves: toBigInt(row.initial_virtual_quote),
    realTokenReserves: toBigInt(row.initial_real_token),
    tokenTotalSupply: toBigInt(row.token_total_supply),
    tokenProgram: typeof row.token_program === "string" ? row.token_program : null,
    quoteMint: text(row.quote_mint, "SOL"),
    isMayhemMode: row.is_mayhem === true,
    isCashback: row.is_cashback === true,
    isHolderReward: row.is_holder_reward === true,
    creatorFeeBps: toNumber(row.creator_fee_bps),
    depth: toNumber(row.depth)
  };
}

export function tradeEventFromRow(row: DbRecord, observation: ObservationModel = DEFAULT_OBSERVATION): TradeEvent {
  const atMs = msOf(row.block_time);
  const venue = VENUE_BY_CODE[toNumber(row.venue)] ?? "curve";
  return {
    kind: "trade",
    tx: {
      signature: text(row.signature),
      slot: toNumber(row.slot),
      seq: toNumber(row.seq),
      eventIndex: toNumber(row.event_index),
      receivedAtMs: observedAtMs(atMs, row.received_at, observation)
    },
    venue,
    mint: text(row.mint),
    pool: venue === "pool" && typeof row.launch_pool === "string" ? row.launch_pool : null,
    wallet: text(row.wallet),
    isBuy: row.is_buy === true,
    tokenAmount: toBigInt(row.token_amount),
    quoteAmount: toBigInt(row.quote_amount),
    userQuote: toBigInt(row.user_quote),
    protocolFee: toBigInt(row.protocol_fee),
    creatorFee: toBigInt(row.creator_fee),
    lpFee: toBigInt(row.lp_fee),
    protocolFeeBps: toNumber(row.protocol_fee_bps),
    creatorFeeBps: toNumber(row.creator_fee_bps),
    lpFeeBps: toNumber(row.lp_fee_bps),
    virtualTokenReserves: toBigInt(row.virtual_token),
    virtualQuoteReserves: toBigInt(row.virtual_quote),
    realTokenReserves: toNullableBigInt(row.real_token),
    realQuoteReserves: toNullableBigInt(row.real_quote),
    timestampMs: atMs,
    ixName: typeof row.ix_name === "string" ? row.ix_name : null
  };
}

export function tradeEventFromReplayRow(row: DbRecord, mint: Pubkey, observation: ObservationModel = DEFAULT_OBSERVATION): TradeEvent {
  const atMs = row.block_ms as number;
  const receivedMs = row.received_ms;
  const venueCode = row.venue as number;
  const venue = VENUE_BY_CODE[venueCode] ?? "curve";
  return {
    kind: "trade",
    tx: {
      signature: text(row.signature),
      slot: row.slot as number,
      seq: row.seq as number,
      eventIndex: row.event_index as number,
      receivedAtMs: typeof receivedMs === "number" ? clampObserved(atMs, receivedMs, observation) : atMs + observation.defaultDelayMs
    },
    venue,
    mint,
    pool: venueCode === POOL_VENUE_CODE && typeof row.launch_pool === "string" ? row.launch_pool : null,
    wallet: text(row.wallet),
    isBuy: row.is_buy === true,
    tokenAmount: toBigInt(row.token_amount),
    quoteAmount: toBigInt(row.quote_amount),
    userQuote: toBigInt(row.user_quote),
    protocolFee: toBigInt(row.protocol_fee),
    creatorFee: toBigInt(row.creator_fee),
    lpFee: toBigInt(row.lp_fee),
    protocolFeeBps: toNumber(row.protocol_fee_bps),
    creatorFeeBps: toNumber(row.creator_fee_bps),
    lpFeeBps: toNumber(row.lp_fee_bps),
    virtualTokenReserves: toBigInt(row.virtual_token),
    virtualQuoteReserves: toBigInt(row.virtual_quote),
    realTokenReserves: toNullableBigInt(row.real_token),
    realQuoteReserves: toNullableBigInt(row.real_quote),
    timestampMs: atMs,
    ixName: typeof row.ix_name === "string" ? row.ix_name : null
  };
}

export function completeEventFromRow(row: DbRecord): CurveCompleteEvent | null {
  if (!(row.completed_at instanceof Date)) {
    return null;
  }
  const atMs = row.completed_at.getTime();
  const mint = text(row.mint);
  return {
    kind: "complete",
    tx: { signature: `replay-complete-${mint}`, slot: toNumber(row.completed_slot), seq: 0, eventIndex: 0, receivedAtMs: atMs },
    mint,
    bondingCurve: text(row.bonding_curve),
    user: "",
    timestampMs: atMs
  };
}

export function migrateEventFromRow(row: DbRecord, observation: ObservationModel = DEFAULT_OBSERVATION): MigrationEvent | null {
  if (!(row.migrated_at instanceof Date) || typeof row.pool !== "string" || row.pool.length === 0) {
    return null;
  }
  const atMs = row.migrated_at.getTime();
  const mint = text(row.mint);
  return {
    kind: "migrate",
    tx: {
      signature: `replay-migrate-${mint}`,
      slot: toNumber(row.migrated_slot),
      seq: 0,
      eventIndex: 0,
      receivedAtMs: atMs + observation.defaultDelayMs
    },
    mint,
    pool: row.pool,
    bondingCurve: text(row.bonding_curve),
    baseAmount: 0n,
    quoteAmount: 0n,
    migrationFee: 0n,
    timestampMs: atMs
  };
}

export function incompleteFromOf(row: DbRecord): number | null {
  if (row.data_incomplete_at instanceof Date) {
    return row.data_incomplete_at.getTime();
  }
  return row.data_complete === false ? msOf(row.created_at) : null;
}

export function scheduleIncomplete(clock: Clock, market: MarketState, replay: ReplayEvent): void {
  const fromMs = replay.incompleteFromMs ?? null;
  if (replay.event.kind !== "create" || fromMs === null) {
    return;
  }
  const mint = replay.event.mint;
  const mark = (): void => {
    const launch = market.get(mint);
    if (launch && launch.launchId === replay.launchId) {
      launch.dataComplete = false;
    }
  };
  if (fromMs <= clock.nowMs()) {
    mark();
  } else {
    clock.schedule(fromMs, mark);
  }
}

export function replayEventOf(event: ChainEvent, launchId: number): ReplayEvent {
  const atMs = event.timestampMs;
  const visibleAtMs = Math.max(atMs, event.tx.receivedAtMs);
  switch (event.kind) {
    case "create":
      return { atMs, visibleAtMs, slot: event.tx.slot, phase: REPLAY_PHASE.create, seq: -1, eventIndex: -1, tiebreak: event.tx.signature, launchId, event };
    case "migrate":
      return { atMs, visibleAtMs, slot: event.tx.slot, phase: REPLAY_PHASE.migrate, seq: -1, eventIndex: -1, tiebreak: event.tx.signature, launchId, event };
    case "complete":
      return {
        atMs,
        visibleAtMs,
        slot: event.tx.slot,
        phase: REPLAY_PHASE.complete,
        seq: Number.MAX_SAFE_INTEGER,
        eventIndex: 0,
        tiebreak: event.tx.signature,
        launchId,
        event
      };
    default:
      return {
        atMs,
        visibleAtMs,
        slot: event.tx.slot,
        phase: REPLAY_PHASE.trade,
        seq: event.tx.seq,
        eventIndex: event.tx.eventIndex,
        tiebreak: event.tx.signature,
        launchId,
        event
      };
  }
}

export function lifecycleEventsOf(row: DbRecord, observation: ObservationModel = DEFAULT_OBSERVATION): ReplayEvent[] {
  const launchId = toNumber(row.id);
  const events: ReplayEvent[] = [];
  const complete = completeEventFromRow(row);
  if (complete) {
    events.push(replayEventOf(complete, launchId));
  }
  const migrate = migrateEventFromRow(row, observation);
  if (migrate) {
    events.push(replayEventOf(migrate, launchId));
  }
  return events;
}

export interface BacktestLoaderOptions {
  db: Db;
  fromMs: number;
  toMs: number;
  includeIncomplete?: boolean;
  tradeQuoteMints?: readonly string[] | null;
  windowMs?: number;
  observation?: ObservationModel;
}

export interface LoaderCounts {
  launches: number;
  incompleteLaunches: number;
  trades: number;
  lifecycle: number;
  windows: number;
}

export class BacktestLoader {
  readonly fromMs: number;
  readonly toMs: number;
  private readonly db: Db;
  private readonly includeIncomplete: boolean;
  private readonly tradeQuoteMints: readonly string[] | null;
  private readonly windowMs: number;
  private readonly observation: ObservationModel;
  private lifecycle: ReplayEvent[] = [];
  private lifecycleIndex = 0;
  private readonly mints = new Map<number, Pubkey>();
  private readonly counts: LoaderCounts = { launches: 0, incompleteLaunches: 0, trades: 0, lifecycle: 0, windows: 0 };

  constructor(options: BacktestLoaderOptions) {
    if (!(options.toMs > options.fromMs)) {
      throw new Error("backtest range must end after it starts");
    }
    this.db = options.db;
    this.fromMs = options.fromMs;
    this.toMs = options.toMs;
    this.includeIncomplete = options.includeIncomplete ?? false;
    this.tradeQuoteMints = options.tradeQuoteMints ?? null;
    this.windowMs = Math.max(1_000, options.windowMs ?? 60_000);
    this.observation = options.observation ?? DEFAULT_OBSERVATION;
  }

  stats(): LoaderCounts {
    return { ...this.counts };
  }

  async prepare(): Promise<void> {
    const result = await this.db.query<DbRecord>(
      `SELECT ${LAUNCH_SELECT} FROM launches
        WHERE created_at >= $1 AND created_at < $2
          AND ($3::text[] IS NULL OR quote_mint = ANY($3::text[]))
          AND (completed_at IS NOT NULL OR migrated_at IS NOT NULL)`,
      [new Date(this.fromMs), new Date(this.toMs), this.tradeQuoteMints]
    );
    const events: ReplayEvent[] = [];
    for (const row of result.rows) {
      for (const event of lifecycleEventsOf(row, this.observation)) {
        if (event.atMs >= this.fromMs && event.atMs < this.toMs) {
          events.push(event);
        }
      }
    }
    events.sort(compareReplayEvents);
    this.lifecycle = events;
    this.lifecycleIndex = 0;
  }

  async *windows(): AsyncGenerator<ReplayEvent[]> {
    let next: Promise<ReplayEvent[]> | null = this.loadWindow(this.fromMs);
    for (let start = this.fromMs; start < this.toMs; start += this.windowMs) {
      const current = await (next ?? this.loadWindow(start));
      const following = start + this.windowMs;
      next = following < this.toMs ? this.loadWindow(following) : null;
      next?.catch(() => undefined);
      const merged = this.mergeLifecycle(current, Math.min(following, this.toMs));
      this.counts.windows += 1;
      if (merged.length > 0) {
        yield merged;
      }
    }
  }

  private mergeLifecycle(events: ReplayEvent[], endMs: number): ReplayEvent[] {
    while (this.lifecycleIndex < this.lifecycle.length) {
      const event = this.lifecycle[this.lifecycleIndex];
      if (!event || event.atMs >= endMs) {
        break;
      }
      events.push(event);
      this.lifecycleIndex += 1;
      this.counts.lifecycle += 1;
    }
    return events.sort(compareReplayEvents);
  }

  private async loadWindow(startMs: number): Promise<ReplayEvent[]> {
    const endMs = Math.min(startMs + this.windowMs, this.toMs);
    const [launches, rows] = await Promise.all([this.loadLaunches(startMs, endMs), this.loadTradeRows(startMs, endMs)]);
    const trades = await this.tradeEvents(rows);
    this.counts.launches += launches.length;
    this.counts.incompleteLaunches += launches.filter((launch) => launch.incompleteFromMs !== null).length;
    this.counts.trades += trades.length;
    return launches.concat(trades);
  }

  private async loadLaunches(startMs: number, endMs: number): Promise<ReplayEvent[]> {
    const result = await this.db.query<DbRecord>(
      `SELECT ${LAUNCH_SELECT} FROM launches
        WHERE created_at >= $1 AND created_at < $2
        ORDER BY created_at, create_slot, id`,
      [new Date(startMs), new Date(endMs)]
    );
    return result.rows.map((row) => {
      const launchId = toNumber(row.id);
      const event = launchEventFromRow(row, this.observation);
      this.mints.set(launchId, event.mint);
      const replay = replayEventOf(event, launchId);
      replay.incompleteFromMs = this.includeIncomplete ? null : incompleteFromOf(row);
      return replay;
    });
  }

  private async loadTradeRows(startMs: number, endMs: number): Promise<DbRecord[]> {
    const result = await this.db.query<DbRecord>(
      `SELECT ${REPLAY_TRADE_SELECT}
         FROM trades t JOIN launches l ON l.id = t.launch_id
        WHERE t.block_time >= $1 AND t.block_time < $2
          AND l.created_at >= $3 AND l.created_at < $4
          AND ($5::text[] IS NULL OR l.quote_mint = ANY($5::text[]))
        ORDER BY t.block_time, t.slot, t.seq, t.event_index, t.signature`,
      [new Date(startMs), new Date(endMs), new Date(this.fromMs), new Date(this.toMs), this.tradeQuoteMints]
    );
    return result.rows;
  }

  private async tradeEvents(rows: readonly DbRecord[]): Promise<ReplayEvent[]> {
    await this.resolveMints(rows);
    const events: ReplayEvent[] = new Array<ReplayEvent>(rows.length);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as DbRecord;
      const launchId = row.launch_id as number;
      events[index] = replayEventOf(tradeEventFromReplayRow(row, this.mints.get(launchId) ?? "", this.observation), launchId);
    }
    return events;
  }

  private async resolveMints(rows: readonly DbRecord[]): Promise<void> {
    const missing = new Set<number>();
    for (const row of rows) {
      const launchId = row.launch_id as number;
      if (!this.mints.has(launchId)) {
        missing.add(launchId);
      }
    }
    if (missing.size === 0) {
      return;
    }
    const result = await this.db.query<{ id: unknown; mint: unknown }>("SELECT id, mint FROM launches WHERE id = ANY($1::bigint[])", [
      [...missing].map(String)
    ]);
    for (const row of result.rows) {
      this.mints.set(toNumber(row.id), text(row.mint));
    }
  }
}

export function applyReplayEvent(market: MarketState, replay: ReplayEvent): boolean {
  const outcome = market.apply(replay.event);
  if (outcome.kind === "created") {
    outcome.launch.launchId = replay.launchId;
  }
  return outcome.kind !== "ignored";
}

export interface HydrateOptions {
  lookbackMs?: number;
}

export async function hydrateLaunch(db: Db, market: MarketState, mint: Pubkey, options: HydrateOptions = {}): Promise<boolean> {
  if (market.get(mint)) {
    return true;
  }
  const launchResult = await db.query<DbRecord>(`SELECT ${LAUNCH_SELECT} FROM launches WHERE mint = $1`, [mint]);
  const row = launchResult.rows[0];
  if (!row) {
    return false;
  }
  const launchId = toNumber(row.id);
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(0);
  const trades = await db.query<DbRecord>(
    `SELECT ${TRADE_SELECT}
       FROM trades t JOIN launches l ON l.id = t.launch_id
      WHERE t.launch_id = $1 AND t.block_time >= $2
      ORDER BY t.block_time, t.slot, t.seq, t.event_index, t.signature`,
    [launchId, new Date(createdAt.getTime() - (options.lookbackMs ?? HOUR_MS))]
  );
  const events = [
    replayEventOf(launchEventFromRow(row), launchId),
    ...lifecycleEventsOf(row),
    ...trades.rows.map((trade) => replayEventOf(tradeEventFromRow(trade), launchId))
  ].sort(compareReplayEvents);
  for (const event of events) {
    applyReplayEvent(market, event);
  }
  const launch = market.get(mint);
  if (launch) {
    launch.launchId = launchId;
    if (incompleteFromOf(row) !== null) {
      launch.dataComplete = false;
    }
  }
  log.info({ mint, trades: trades.rows.length, hydrated: launch !== undefined }, "launch hydrated from the database");
  return launch !== undefined;
}

export async function hydrateLaunches(db: Db, market: MarketState, mints: Iterable<Pubkey>, options: HydrateOptions = {}): Promise<number> {
  let hydrated = 0;
  for (const mint of new Set(mints)) {
    try {
      if (await hydrateLaunch(db, market, mint, options)) {
        hydrated += 1;
      }
    } catch (error) {
      log.error({ err: error, mint }, "launch hydration failed");
    }
  }
  return hydrated;
}
