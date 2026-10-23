import { marketCapQuote } from "../chain/curve.js";
import type { CurveCompleteEvent, MigrationEvent, Pubkey, TradeEvent } from "../core/types.js";
import type { Db } from "../db/pool.js";
import { chunk, dateOrNull, valuesList } from "./sql.js";

interface LastTrade {
  atMs: number;
  slot: number;
  seq: number;
  eventIndex: number;
  virtualToken: bigint;
  virtualQuote: bigint;
  realToken: bigint | null;
  realQuote: bigint | null;
}

interface PeakPoint {
  mcapQuote: bigint;
  atMs: number;
  slot: number;
}

export interface AggregateDelta {
  launchId: number;
  trades: number;
  buys: number;
  sells: number;
  walletsSeen: number;
  last: LastTrade | null;
  peak: PeakPoint | null;
  completedAtMs: number | null;
  completedSlot: number | null;
  migratedAtMs: number | null;
  migratedSlot: number | null;
  pool: Pubkey | null;
}

function isLater(candidate: LastTrade, current: LastTrade | null): boolean {
  if (!current) {
    return true;
  }
  if (candidate.slot !== current.slot) {
    return candidate.slot > current.slot;
  }
  if (candidate.seq !== current.seq) {
    return candidate.seq > current.seq;
  }
  return candidate.eventIndex >= current.eventIndex;
}

export class LaunchAggregate {
  private trades = 0;
  private buys = 0;
  private sells = 0;
  private readonly wallets = new Set<Pubkey>();
  private last: LastTrade | null = null;
  private peak: PeakPoint | null = null;
  private completedAtMs: number | null = null;
  private completedSlot: number | null = null;
  private migratedAtMs: number | null = null;
  private migratedSlot: number | null = null;
  private pool: Pubkey | null = null;
  dirty = false;

  constructor(
    readonly launchId: number,
    readonly mint: Pubkey,
    private readonly tokenTotalSupply: bigint,
    public needsWalletSeed = false
  ) {}

  get walletCount(): number {
    return this.wallets.size;
  }

  seedWallets(wallets: Iterable<Pubkey>): void {
    for (const wallet of wallets) {
      this.wallets.add(wallet);
    }
    this.needsWalletSeed = false;
  }

  applyTrade(event: TradeEvent, atMs: number): void {
    if (!this.wallets.has(event.wallet)) {
      this.wallets.add(event.wallet);
      this.dirty = true;
    }
    const candidate: LastTrade = {
      atMs,
      slot: event.tx.slot,
      seq: event.tx.seq,
      eventIndex: event.tx.eventIndex,
      virtualToken: event.virtualTokenReserves,
      virtualQuote: event.virtualQuoteReserves,
      realToken: event.realTokenReserves,
      realQuote: event.realQuoteReserves
    };
    if (isLater(candidate, this.last)) {
      this.last = candidate;
    }
    const mcap = marketCapQuote(event, this.tokenTotalSupply);
    if (!this.peak || mcap > this.peak.mcapQuote) {
      this.peak = { mcapQuote: mcap, atMs, slot: event.tx.slot };
    }
    if (event.venue === "pool" && event.pool && !this.pool) {
      this.pool = event.pool;
    }
    this.dirty = true;
  }

  countInserted(isBuy: boolean): void {
    this.trades += 1;
    if (isBuy) {
      this.buys += 1;
    } else {
      this.sells += 1;
    }
    this.dirty = true;
  }

  applyComplete(event: CurveCompleteEvent): void {
    if (this.completedAtMs === null) {
      this.completedAtMs = event.timestampMs > 0 ? event.timestampMs : event.tx.receivedAtMs;
      this.completedSlot = event.tx.slot;
      this.dirty = true;
    }
  }

  applyMigration(event: MigrationEvent): void {
    if (this.migratedAtMs === null) {
      this.migratedAtMs = event.timestampMs > 0 ? event.timestampMs : event.tx.receivedAtMs;
      this.migratedSlot = event.tx.slot;
    }
    this.pool = event.pool;
    this.dirty = true;
  }

  takeDelta(): AggregateDelta {
    const delta: AggregateDelta = {
      launchId: this.launchId,
      trades: this.trades,
      buys: this.buys,
      sells: this.sells,
      walletsSeen: this.wallets.size,
      last: this.last,
      peak: this.peak,
      completedAtMs: this.completedAtMs,
      completedSlot: this.completedSlot,
      migratedAtMs: this.migratedAtMs,
      migratedSlot: this.migratedSlot,
      pool: this.pool
    };
    this.trades = 0;
    this.buys = 0;
    this.sells = 0;
    this.dirty = false;
    return delta;
  }

  restoreDelta(delta: AggregateDelta): void {
    this.trades += delta.trades;
    this.buys += delta.buys;
    this.sells += delta.sells;
    this.dirty = true;
  }
}

const AGGREGATE_CASTS = [
  "bigint",
  "int",
  "int",
  "int",
  "int",
  "timestamptz",
  "bigint",
  "bigint",
  "bigint",
  "bigint",
  "bigint",
  "bigint",
  "timestamptz",
  "bigint",
  "timestamptz",
  "bigint",
  "timestamptz",
  "bigint",
  "text"
] as const;

const AGGREGATE_COLUMNS =
  "id, trade_delta, buy_delta, sell_delta, wallets_seen, last_at, last_slot, last_vt, last_vq, last_rt, last_rq, peak, peak_at, peak_slot, completed_at, completed_slot, migrated_at, migrated_slot, pool";

const NEWER_LAST = "(v.last_slot IS NOT NULL AND (l.last_trade_slot IS NULL OR v.last_slot >= l.last_trade_slot))";
const HIGHER_PEAK = "(v.peak IS NOT NULL AND (l.peak_mcap_quote IS NULL OR v.peak > l.peak_mcap_quote))";

const AGGREGATE_SET = `
  trade_count = l.trade_count + v.trade_delta,
  buy_count = l.buy_count + v.buy_delta,
  sell_count = l.sell_count + v.sell_delta,
  unique_traders = GREATEST(l.unique_traders, v.wallets_seen),
  last_trade_at = CASE WHEN ${NEWER_LAST} THEN v.last_at ELSE l.last_trade_at END,
  last_trade_slot = CASE WHEN ${NEWER_LAST} THEN v.last_slot ELSE l.last_trade_slot END,
  last_virtual_token = CASE WHEN ${NEWER_LAST} THEN v.last_vt ELSE l.last_virtual_token END,
  last_virtual_quote = CASE WHEN ${NEWER_LAST} THEN v.last_vq ELSE l.last_virtual_quote END,
  last_real_token = CASE WHEN ${NEWER_LAST} THEN v.last_rt ELSE l.last_real_token END,
  last_real_quote = CASE WHEN ${NEWER_LAST} THEN v.last_rq ELSE l.last_real_quote END,
  peak_mcap_quote = CASE WHEN ${HIGHER_PEAK} THEN v.peak ELSE l.peak_mcap_quote END,
  peak_at = CASE WHEN ${HIGHER_PEAK} THEN v.peak_at ELSE l.peak_at END,
  peak_slot = CASE WHEN ${HIGHER_PEAK} THEN v.peak_slot ELSE l.peak_slot END,
  completed_at = COALESCE(l.completed_at, v.completed_at),
  completed_slot = COALESCE(l.completed_slot, v.completed_slot),
  migrated_at = COALESCE(l.migrated_at, v.migrated_at),
  migrated_slot = COALESCE(l.migrated_slot, v.migrated_slot),
  pool = COALESCE(v.pool, l.pool)`;

function deltaRow(delta: AggregateDelta): unknown[] {
  return [
    delta.launchId,
    delta.trades,
    delta.buys,
    delta.sells,
    delta.walletsSeen,
    dateOrNull(delta.last?.atMs ?? null),
    delta.last?.slot ?? null,
    delta.last?.virtualToken ?? null,
    delta.last?.virtualQuote ?? null,
    delta.last?.realToken ?? null,
    delta.last?.realQuote ?? null,
    delta.peak?.mcapQuote ?? null,
    dateOrNull(delta.peak?.atMs ?? null),
    delta.peak?.slot ?? null,
    dateOrNull(delta.completedAtMs),
    delta.completedSlot,
    dateOrNull(delta.migratedAtMs),
    delta.migratedSlot,
    delta.pool
  ];
}

export const AGGREGATE_CHUNK_SIZE = 500;

export interface AggregateWriteResult {
  updated: number;
  failed: AggregateDelta[];
  error: unknown;
}

export async function loadLaunchWallets(db: Db, launchIds: readonly number[]): Promise<Map<number, Pubkey[]>> {
  const wallets = new Map<number, Pubkey[]>();
  if (launchIds.length === 0) {
    return wallets;
  }
  const result = await db.query<{ launch_id: unknown; wallet: string }>(
    "SELECT DISTINCT launch_id, wallet FROM trades WHERE launch_id = ANY($1::bigint[])",
    [launchIds.map(String)]
  );
  for (const row of result.rows) {
    const launchId = Number(row.launch_id);
    const list = wallets.get(launchId) ?? [];
    list.push(row.wallet);
    wallets.set(launchId, list);
  }
  return wallets;
}

export async function writeAggregateDeltas(db: Db, deltas: readonly AggregateDelta[]): Promise<AggregateWriteResult> {
  const outcome: AggregateWriteResult = { updated: 0, failed: [], error: null };
  for (const part of chunk(deltas, AGGREGATE_CHUNK_SIZE)) {
    const params: unknown[] = [];
    const values = valuesList(part.map(deltaRow), AGGREGATE_CASTS, params);
    try {
      const result = await db.query(
        `UPDATE launches AS l SET ${AGGREGATE_SET}
           FROM (VALUES ${values}) AS v(${AGGREGATE_COLUMNS})
          WHERE l.id = v.id AND l.tracking_ended_at IS NULL`,
        params
      );
      outcome.updated += result.rowCount ?? 0;
    } catch (error) {
      outcome.failed.push(...part);
      outcome.error = error;
    }
  }
  return outcome;
}
