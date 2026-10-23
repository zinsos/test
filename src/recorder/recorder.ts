import type { RecorderConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type {
  ChainEvent,
  CurveCompleteEvent,
  IngestGap,
  LaunchCreatedEvent,
  MigrationEvent,
  Pubkey,
  TradeEvent,
  TradeVenue
} from "../core/types.js";
import type { BatchTableSpec } from "../db/batch.js";
import { ensureTradePartitions } from "../db/partitions.js";
import { toNullableNumber, toNumber, type Db } from "../db/pool.js";
import { BoundedSet } from "../ingest/lru.js";
import type { MarketState } from "../market/state.js";
import { LaunchAggregate, writeAggregateDeltas } from "./aggregates.js";
import type { LaunchRegistry, TrackedLaunch } from "./registry.js";
import { SerialBatchWriter, type SerialBatchWriterOptions } from "./serialWriter.js";
import { cleanText } from "./sql.js";

const log = moduleLogger("recorder");
const HOUR_MS = 3_600_000;

export const VENUE_CODES: Record<TradeVenue, number> = { curve: 0, pool: 1, curve_post_complete: 2 };

export const TRADES_TABLE_SPEC: BatchTableSpec = {
  table: "trades",
  columns: [
    "launch_id",
    "block_time",
    "slot",
    "seq",
    "signature",
    "event_index",
    "venue",
    "wallet",
    "is_buy",
    "token_amount",
    "quote_amount",
    "user_quote",
    "protocol_fee",
    "creator_fee",
    "lp_fee",
    "protocol_fee_bps",
    "creator_fee_bps",
    "lp_fee_bps",
    "virtual_token",
    "virtual_quote",
    "real_token",
    "real_quote",
    "ix_name"
  ],
  conflict: "ON CONFLICT DO NOTHING"
};

type FollowUpEvent = TradeEvent | CurveCompleteEvent | MigrationEvent;

interface PendingLaunch {
  event: LaunchCreatedEvent;
  queue: FollowUpEvent[];
}

interface LaunchRow {
  id: unknown;
  tracking_ended_at: Date | null;
}

export interface RegisteredLaunch {
  launchId: number;
  mint: Pubkey;
  event: LaunchCreatedEvent;
  inserted: boolean;
}

export type RegisteredListener = (launch: RegisteredLaunch) => void;

export interface RecorderServiceOptions {
  db: Db;
  bus: Bus;
  market: MarketState;
  clock: Clock;
  config: RecorderConfig;
  registry: LaunchRegistry;
  writerOptions?: Partial<SerialBatchWriterOptions>;
  aggregateFlushMs?: number;
  partitionCheckMs?: number;
  partitionDaysBack?: number;
  maxPendingLaunches?: number;
  maxQueuedPerLaunch?: number;
  maxQueuedTotal?: number;
  insertRetries?: number;
  insertRetryDelayMs?: number;
  dedupeCapacity?: number;
  recordRestartGap?: boolean;
  manageTradePartitions?: boolean;
}

export function tradeBlockTimeMs(event: { timestampMs: number; tx: { receivedAtMs: number } }): number {
  return event.timestampMs > 0 ? event.timestampMs : event.tx.receivedAtMs;
}

export function tradeRow(launchId: number, event: TradeEvent): unknown[] {
  return [
    launchId,
    new Date(tradeBlockTimeMs(event)),
    event.tx.slot,
    event.tx.seq,
    event.tx.signature,
    event.tx.eventIndex,
    VENUE_CODES[event.venue],
    event.wallet,
    event.isBuy,
    event.tokenAmount,
    event.quoteAmount,
    event.userQuote,
    event.protocolFee,
    event.creatorFee,
    event.lpFee,
    event.protocolFeeBps,
    event.creatorFeeBps,
    event.lpFeeBps,
    event.virtualTokenReserves,
    event.virtualQuoteReserves,
    event.realTokenReserves,
    event.realQuoteReserves,
    event.ixName === null ? null : cleanText(event.ixName, 64)
  ];
}

function launchInsertParams(event: LaunchCreatedEvent, observedAtMs: number): unknown[] {
  return [
    event.mint,
    event.bondingCurve,
    event.devWallet,
    event.creator,
    cleanText(event.name, 200),
    cleanText(event.symbol, 64),
    cleanText(event.uri, 1_000),
    event.quoteMint,
    event.tokenProgram,
    event.isMayhemMode,
    event.isCashback,
    event.isHolderReward,
    event.creatorFeeBps,
    event.depth,
    event.tx.signature,
    event.tx.slot,
    new Date(tradeBlockTimeMs(event)),
    new Date(observedAtMs),
    event.tokenTotalSupply.toString(),
    event.virtualTokenReserves.toString(),
    event.virtualQuoteReserves.toString(),
    event.realTokenReserves.toString()
  ];
}

const INSERT_LAUNCH_SQL = `
  INSERT INTO launches (
    mint, bonding_curve, dev_wallet, creator, name, symbol, uri, quote_mint, token_program,
    is_mayhem, is_cashback, is_holder_reward, creator_fee_bps, depth, create_signature, create_slot,
    created_at, observed_at, token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
  ON CONFLICT (mint) DO NOTHING
  RETURNING id, tracking_ended_at`;

export class RecorderService {
  private readonly db: Db;
  private readonly bus: Bus;
  private readonly market: MarketState;
  private readonly clock: Clock;
  private readonly config: RecorderConfig;
  private readonly registry: LaunchRegistry;
  private readonly writer: SerialBatchWriter;
  private readonly aggregateFlushMs: number;
  private readonly partitionCheckMs: number;
  private readonly partitionDaysBack: number;
  private readonly maxPendingLaunches: number;
  private readonly maxQueuedPerLaunch: number;
  private readonly maxQueuedTotal: number;
  private readonly insertRetries: number;
  private readonly insertRetryDelayMs: number;
  private readonly recordRestartGap: boolean;
  private readonly manageTradePartitions: boolean;
  private readonly trackMaxAgeMs: number;
  private readonly recentTrades: BoundedSet<string>;
  private readonly pending = new Map<Pubkey, PendingLaunch>();
  private readonly aggregates = new Map<Pubkey, LaunchAggregate>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly registeredListeners = new Set<RegisteredListener>();
  private readonly wakers = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  private aggregateTimer: TimerHandle | null = null;
  private partitionTimer: TimerHandle | null = null;
  private aggregateFlush: Promise<void> | null = null;
  private queuedTotal = 0;
  private running = false;
  private stopping = false;
  private readonly counters = {
    launchesInserted: 0,
    launchesExisting: 0,
    launchesAlreadyFinalized: 0,
    launchInsertFailures: 0,
    launchesDroppedPendingFull: 0,
    tradesRecorded: 0,
    tradeDuplicates: 0,
    tradesReplayedBeforeResume: 0,
    tradesPastTrackingWindow: 0,
    queuedEvents: 0,
    queuedDropped: 0,
    untrackedEvents: 0,
    completions: 0,
    migrations: 0,
    gapsRecorded: 0,
    gapErrors: 0,
    aggregateFlushes: 0,
    aggregateRowsUpdated: 0,
    aggregateErrors: 0,
    partitionRuns: 0
  };

  constructor(options: RecorderServiceOptions) {
    this.db = options.db;
    this.bus = options.bus;
    this.market = options.market;
    this.clock = options.clock;
    this.config = options.config;
    this.registry = options.registry;
    this.aggregateFlushMs = options.aggregateFlushMs ?? 5_000;
    this.partitionCheckMs = options.partitionCheckMs ?? 6 * HOUR_MS;
    this.partitionDaysBack = options.partitionDaysBack ?? 1;
    this.maxPendingLaunches = options.maxPendingLaunches ?? 20_000;
    this.maxQueuedPerLaunch = options.maxQueuedPerLaunch ?? 5_000;
    this.maxQueuedTotal = options.maxQueuedTotal ?? 200_000;
    this.insertRetries = options.insertRetries ?? 5;
    this.insertRetryDelayMs = options.insertRetryDelayMs ?? 500;
    this.recordRestartGap = options.recordRestartGap ?? true;
    this.manageTradePartitions = options.manageTradePartitions ?? true;
    this.trackMaxAgeMs = options.config.trackMaxAgeHours * HOUR_MS;
    this.recentTrades = new BoundedSet<string>(options.dedupeCapacity ?? 50_000);
    this.writer = new SerialBatchWriter(options.db, [TRADES_TABLE_SPEC], {
      flushIntervalMs: 1_000,
      flushAtRows: 2_000,
      maxRetries: 6,
      ...options.writerOptions
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;
    const loaded = await this.registry.load();
    if (this.manageTradePartitions) {
      await this.ensurePartitions();
    }
    if (this.recordRestartGap && loaded > 0) {
      await this.recordRestart();
    }
    this.unsubscribers = [
      this.bus.on("chain", (event) => this.handleChain(event)),
      this.bus.on("gap", (gap) => this.handleGap(gap)),
      this.registry.onUntrack((launch) => this.aggregates.delete(launch.mint))
    ];
    this.writer.start();
    this.scheduleAggregateFlush();
    if (this.manageTradePartitions) {
      this.schedulePartitionCheck();
    }
    log.info({ tracked: this.registry.size }, "recorder started");
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.stopping = true;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.cancelTimers();
    this.wakeSleepers();
    await this.settleInflight();
    await this.flush();
    await this.writer.stop();
    this.running = false;
    log.info({ stats: this.stats() }, "recorder stopped");
  }

  onLaunchRegistered(listener: RegisteredListener): () => void {
    this.registeredListeners.add(listener);
    return () => {
      this.registeredListeners.delete(listener);
    };
  }

  readonly handleChain = (event: ChainEvent): void => {
    if (this.stopping) {
      return;
    }
    if (event.kind === "create") {
      this.handleCreate(event);
      return;
    }
    this.route(event);
  };

  readonly handleGap = (gap: IngestGap): void => {
    this.track(this.recordGap(gap, false));
  };

  async flushTrades(): Promise<void> {
    await this.writer.flush();
  }

  async flush(): Promise<void> {
    await this.writer.flush();
    await this.flushAggregates();
  }

  async settleInflight(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  queuedCount(mint: Pubkey): number {
    return this.pending.get(mint)?.queue.length ?? 0;
  }

  stats(): Record<string, number> {
    const writer = this.writer.stats();
    let dirty = 0;
    for (const aggregate of this.aggregates.values()) {
      if (aggregate.dirty) {
        dirty += 1;
      }
    }
    return {
      ...this.counters,
      tracked: this.registry.size,
      pendingLaunches: this.pending.size,
      queuedNow: this.queuedTotal,
      aggregates: this.aggregates.size,
      aggregatesDirty: dirty,
      inflight: this.inflight.size,
      tradesBuffered: writer.buffered,
      tradesWritten: writer.written,
      tradesDropped: writer.dropped
    };
  }

  async flushAggregates(): Promise<void> {
    while (this.aggregateFlush) {
      await this.aggregateFlush;
    }
    const run = this.writeDirtyAggregates().finally(() => {
      this.aggregateFlush = null;
    });
    this.aggregateFlush = run;
    await run;
  }

  private async writeDirtyAggregates(): Promise<void> {
    const dirty: LaunchAggregate[] = [];
    for (const aggregate of this.aggregates.values()) {
      if (aggregate.dirty) {
        dirty.push(aggregate);
      }
    }
    if (dirty.length === 0) {
      return;
    }
    const byLaunch = new Map<number, LaunchAggregate>();
    for (const aggregate of dirty) {
      byLaunch.set(aggregate.launchId, aggregate);
    }
    const result = await writeAggregateDeltas(
      this.db,
      dirty.map((aggregate) => aggregate.takeDelta())
    );
    this.counters.aggregateFlushes += 1;
    this.counters.aggregateRowsUpdated += result.updated;
    if (result.failed.length > 0) {
      this.counters.aggregateErrors += 1;
      log.error({ err: result.error, launches: result.failed.length }, "aggregate flush failed, will retry");
      for (const delta of result.failed) {
        byLaunch.get(delta.launchId)?.restoreDelta(delta);
      }
    }
  }

  private handleCreate(event: LaunchCreatedEvent): void {
    const tracked = this.registry.get(event.mint);
    if (tracked) {
      this.attachLaunchId(event.mint, tracked.launchId);
      return;
    }
    if (this.pending.has(event.mint)) {
      return;
    }
    if (this.pending.size >= this.maxPendingLaunches) {
      this.counters.launchesDroppedPendingFull += 1;
      return;
    }
    this.pending.set(event.mint, { event, queue: [] });
    this.track(this.insertLaunch(event));
  }

  private route(event: FollowUpEvent): void {
    const tracked = this.registry.get(event.mint);
    if (tracked) {
      this.recordEvent(tracked, event);
      return;
    }
    const pending = this.pending.get(event.mint);
    if (!pending) {
      this.counters.untrackedEvents += 1;
      return;
    }
    if (event.kind === "migrate") {
      this.registry.registerPool(event.mint, event.pool);
    }
    if (pending.queue.length >= this.maxQueuedPerLaunch || this.queuedTotal >= this.maxQueuedTotal) {
      this.counters.queuedDropped += 1;
      return;
    }
    pending.queue.push(event);
    this.queuedTotal += 1;
    this.counters.queuedEvents += 1;
  }

  private recordEvent(tracked: TrackedLaunch, event: FollowUpEvent): void {
    switch (event.kind) {
      case "trade":
        this.recordTrade(tracked, event);
        return;
      case "complete":
        this.counters.completions += 1;
        this.aggregateFor(tracked).applyComplete(event);
        return;
      case "migrate":
        this.counters.migrations += 1;
        this.registry.registerPool(tracked.mint, event.pool);
        this.aggregateFor(tracked).applyMigration(event);
        return;
      default:
        return;
    }
  }

  private recordTrade(tracked: TrackedLaunch, event: TradeEvent): void {
    const atMs = tradeBlockTimeMs(event);
    if (atMs - tracked.createdAtMs > this.trackMaxAgeMs) {
      this.counters.tradesPastTrackingWindow += 1;
      return;
    }
    if (!this.recentTrades.addIfAbsent(`${event.tx.signature}:${event.tx.eventIndex}`)) {
      this.counters.tradeDuplicates += 1;
      return;
    }
    this.writer.push(TRADES_TABLE_SPEC.table, tradeRow(tracked.launchId, event));
    this.counters.tradesRecorded += 1;
    if (tracked.resumeSlot !== null && event.tx.slot <= tracked.resumeSlot) {
      this.counters.tradesReplayedBeforeResume += 1;
      return;
    }
    this.aggregateFor(tracked).applyTrade(event, atMs);
  }

  private aggregateFor(tracked: TrackedLaunch): LaunchAggregate {
    let aggregate = this.aggregates.get(tracked.mint);
    if (!aggregate || aggregate.launchId !== tracked.launchId) {
      aggregate = new LaunchAggregate(tracked.launchId, tracked.mint, tracked.tokenTotalSupply);
      this.aggregates.set(tracked.mint, aggregate);
    }
    return aggregate;
  }

  private attachLaunchId(mint: Pubkey, launchId: number): void {
    const launch = this.market.get(mint);
    if (launch && launch.launchId === null) {
      launch.launchId = launchId;
    }
  }

  private async insertLaunch(event: LaunchCreatedEvent): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const row = await this.upsertLaunch(event);
        this.resolvePending(event, row);
        return;
      } catch (error) {
        if (attempt >= this.insertRetries || this.stopping) {
          this.counters.launchInsertFailures += 1;
          const dropped = this.takePending(event.mint)?.queue.length ?? 0;
          log.error({ err: error, mint: event.mint, droppedEvents: dropped }, "launch insert failed");
          return;
        }
        await this.sleep(this.insertRetryDelayMs * 2 ** attempt);
      }
    }
  }

  private async upsertLaunch(event: LaunchCreatedEvent): Promise<{ id: number; inserted: boolean; ended: boolean }> {
    const inserted = await this.db.query<LaunchRow>(INSERT_LAUNCH_SQL, launchInsertParams(event, this.clock.nowMs()));
    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      return { id: toNumber(insertedRow.id), inserted: true, ended: insertedRow.tracking_ended_at !== null };
    }
    const existing = await this.db.query<LaunchRow>("SELECT id, tracking_ended_at FROM launches WHERE mint = $1", [
      event.mint
    ]);
    const existingRow = existing.rows[0];
    if (!existingRow) {
      throw new Error(`launch ${event.mint} neither inserted nor found`);
    }
    return { id: toNumber(existingRow.id), inserted: false, ended: existingRow.tracking_ended_at !== null };
  }

  private resolvePending(event: LaunchCreatedEvent, row: { id: number; inserted: boolean; ended: boolean }): void {
    const pending = this.takePending(event.mint);
    if (row.inserted) {
      this.counters.launchesInserted += 1;
    } else {
      this.counters.launchesExisting += 1;
    }
    if (row.ended) {
      this.counters.launchesAlreadyFinalized += 1;
      return;
    }
    const pool = this.registry.get(event.mint)?.pool ?? this.market.get(event.mint)?.pool ?? null;
    const tracked: TrackedLaunch = {
      launchId: row.id,
      mint: event.mint,
      createdAtMs: tradeBlockTimeMs(event),
      createdSlot: event.tx.slot,
      tokenTotalSupply: event.tokenTotalSupply,
      pool,
      resumeSlot: null
    };
    this.registry.track(tracked);
    this.attachLaunchId(event.mint, row.id);
    this.aggregateFor(tracked);
    for (const queued of pending?.queue ?? []) {
      this.recordEvent(tracked, queued);
    }
    this.notifyRegistered({ launchId: row.id, mint: event.mint, event, inserted: row.inserted });
  }

  private takePending(mint: Pubkey): PendingLaunch | undefined {
    const pending = this.pending.get(mint);
    if (pending) {
      this.pending.delete(mint);
      this.queuedTotal -= pending.queue.length;
    }
    return pending;
  }

  private notifyRegistered(launch: RegisteredLaunch): void {
    for (const listener of this.registeredListeners) {
      try {
        listener(launch);
      } catch (error) {
        log.error({ err: error, mint: launch.mint }, "registered listener failed");
      }
    }
  }

  private async recordRestart(): Promise<void> {
    const result = await this.db.query<{ slot: unknown; at: Date | null }>(
      `SELECT max(last_trade_slot) AS slot, max(GREATEST(last_trade_at, created_at)) AS at
         FROM launches WHERE tracking_ended_at IS NULL`
    );
    const row = result.rows[0];
    const now = this.clock.nowMs();
    await this.recordGap(
      {
        source: "recorder",
        fromSlot: toNullableNumber(row?.slot),
        toSlot: null,
        startedAtMs: row?.at ? row.at.getTime() : now,
        endedAtMs: now,
        reason: "restart"
      },
      true
    );
  }

  private markMemoryIncomplete(gap: IngestGap, allTracked: boolean): void {
    for (const launch of this.market.all()) {
      const affected = allTracked
        ? this.registry.isTracked(launch.mint)
        : gap.fromSlot !== null
          ? launch.info.createdSlot <= gap.fromSlot
          : launch.info.createdAtMs <= gap.endedAtMs;
      if (affected) {
        launch.dataComplete = false;
      }
    }
  }

  private async recordGap(gap: IngestGap, allTracked: boolean): Promise<void> {
    this.markMemoryIncomplete(gap, allTracked);
    const affectedCondition = allTracked
      ? "tracking_ended_at IS NULL"
      : `(CASE WHEN $2::bigint IS NOT NULL THEN create_slot <= $2::bigint ELSE created_at <= $5 END)
         AND (tracking_ended_at IS NULL OR tracking_ended_at >= $4)`;
    try {
      await this.db.query(
        `WITH affected AS (
           UPDATE launches SET data_complete = false
            WHERE data_complete AND ${affectedCondition}
            RETURNING 1
         )
         INSERT INTO ingest_gaps (source, from_slot, to_slot, started_at, ended_at, reason, affected_launches)
         SELECT $1, $2::bigint, $3::bigint, $4, $5, $6, (SELECT count(*)::int FROM affected)`,
        [
          gap.source,
          gap.fromSlot,
          gap.toSlot,
          new Date(gap.startedAtMs),
          new Date(Math.max(gap.endedAtMs, gap.startedAtMs)),
          cleanText(gap.reason, 500)
        ]
      );
      this.counters.gapsRecorded += 1;
    } catch (error) {
      this.counters.gapErrors += 1;
      log.error({ err: error, gap }, "failed to record ingest gap");
    }
  }

  private async ensurePartitions(): Promise<void> {
    this.counters.partitionRuns += 1;
    try {
      await ensureTradePartitions(this.db, this.clock.nowMs(), this.partitionDaysBack, this.config.partitionDaysAhead);
    } catch (error) {
      log.error({ err: error }, "trade partition maintenance failed");
    }
  }

  private scheduleAggregateFlush(): void {
    this.aggregateTimer = this.clock.schedule(this.clock.nowMs() + this.aggregateFlushMs, async () => {
      this.aggregateTimer = null;
      if (this.stopping) {
        return;
      }
      try {
        await this.flushAggregates();
      } catch (error) {
        log.error({ err: error }, "aggregate flush crashed");
      }
      if (!this.stopping) {
        this.scheduleAggregateFlush();
      }
    });
  }

  private schedulePartitionCheck(): void {
    this.partitionTimer = this.clock.schedule(this.clock.nowMs() + this.partitionCheckMs, async () => {
      this.partitionTimer = null;
      if (this.stopping) {
        return;
      }
      await this.ensurePartitions();
      if (!this.stopping) {
        this.schedulePartitionCheck();
      }
    });
  }

  private cancelTimers(): void {
    if (this.aggregateTimer) {
      this.clock.cancel(this.aggregateTimer);
      this.aggregateTimer = null;
    }
    if (this.partitionTimer) {
      this.clock.cancel(this.partitionTimer);
      this.partitionTimer = null;
    }
  }

  private track(promise: Promise<unknown>): void {
    this.inflight.add(promise);
    promise
      .catch((error: unknown) => {
        log.error({ err: error }, "recorder task failed");
      })
      .finally(() => {
        this.inflight.delete(promise);
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        this.wakers.delete(wake);
        this.clock.cancel(timer);
        resolve();
      };
      const timer = this.clock.schedule(this.clock.nowMs() + ms, wake);
      this.wakers.add(wake);
    });
  }

  private wakeSleepers(): void {
    for (const wake of [...this.wakers]) {
      wake();
    }
  }
}
