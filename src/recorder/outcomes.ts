import { marketCapQuote } from "../chain/curve.js";
import type { RecorderConfig, StrategyConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import { SystemClock, type Clock, type TimerHandle } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { ChainEvent, Pubkey, TradeVenue } from "../core/types.js";
import { toBigInt, toNumber, type Db } from "../db/pool.js";
import type { LaunchState, MarketState } from "../market/state.js";
import {
  computeOutcome,
  type LaunchOutcome,
  type OutcomeLaunch,
  type OutcomeParams,
  type OutcomeTrade
} from "./outcomeLabels.js";
import type { LaunchRegistry, TrackedLaunch } from "./registry.js";
import { chunk, dateOrNull, jsonText, valuesList } from "./sql.js";

export * from "./outcomeLabels.js";

const log = moduleLogger("outcomes");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const VENUES: readonly TradeVenue[] = ["curve", "pool", "curve_post_complete"];

export interface OutcomeSubject {
  launchId: number;
  launch: OutcomeLaunch;
  trades: readonly OutcomeTrade[];
}

interface LaunchInputRow {
  id: unknown;
  created_at: Date;
  create_slot: unknown;
  dev_wallet: string;
  creator: string;
  token_total_supply: unknown;
  initial_virtual_token: unknown;
  initial_virtual_quote: unknown;
  completed_at: Date | null;
  migrated_at: Date | null;
  tracking_ended_at: Date | null;
}

interface TradeInputRow {
  launch_id: unknown;
  block_time: Date;
  slot: unknown;
  wallet: string;
  is_buy: boolean;
  venue: unknown;
  token_amount: unknown;
  quote_amount: unknown;
  virtual_token: unknown;
  virtual_quote: unknown;
}

export interface LoadedSubject extends OutcomeSubject {
  trades: OutcomeTrade[];
  trackingEnded: boolean;
}

export function outcomeParamsFrom(recorder: RecorderConfig, bundleSlotWindow: number): OutcomeParams {
  return {
    outcome: recorder.outcome,
    postMigrationTrackHours: recorder.postMigrationTrackHours,
    bundleSlotWindow
  };
}

export function subjectFromLaunchState(launchId: number, launch: LaunchState): OutcomeSubject {
  return {
    launchId,
    launch: {
      createdAtMs: launch.info.createdAtMs,
      createdSlot: launch.info.createdSlot,
      initialMcapQuote: launch.initialMcapQuote(),
      devWallets: [launch.info.devWallet, launch.info.creator],
      completedAtMs: launch.completedAtMs,
      migratedAtMs: launch.migratedAtMs,
      knownInsiders: launch.insiders
    },
    trades: launch.trades
  };
}

export async function loadStoredInsiders(db: Db, launchIds: readonly number[]): Promise<Map<number, Pubkey[]>> {
  const insiders = new Map<number, Pubkey[]>();
  if (launchIds.length === 0) {
    return insiders;
  }
  const result = await db.query<{ launch_id: unknown; insiders: string[] }>(
    `SELECT s.launch_id, array_agg(DISTINCT w ORDER BY w) AS insiders
       FROM launch_scores s CROSS JOIN LATERAL unnest(s.insiders) AS w
      WHERE s.launch_id = ANY($1::bigint[])
      GROUP BY s.launch_id`,
    [launchIds.map(String)]
  );
  for (const row of result.rows) {
    insiders.set(toNumber(row.launch_id), row.insiders);
  }
  return insiders;
}

export function withStoredInsiders<T extends OutcomeSubject>(subject: T, insiders: ReadonlyMap<number, readonly Pubkey[]>): T {
  return { ...subject, launch: { ...subject.launch, knownInsiders: insiders.get(subject.launchId) ?? [] } };
}

export async function loadOutcomeSubjects(db: Db, launchIds: readonly number[], trackHours: number): Promise<Map<number, LoadedSubject>> {
  const subjects = new Map<number, LoadedSubject>();
  if (launchIds.length === 0) {
    return subjects;
  }
  const launches = await db.query<LaunchInputRow>(
    `SELECT id, created_at, create_slot, dev_wallet, creator, token_total_supply, initial_virtual_token,
            initial_virtual_quote, completed_at, migrated_at, tracking_ended_at
       FROM launches WHERE id = ANY($1::bigint[])`,
    [launchIds.map(String)]
  );
  const supplies = new Map<number, bigint>();
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const row of launches.rows) {
    const launchId = toNumber(row.id);
    const supply = toBigInt(row.token_total_supply);
    const createdAtMs = row.created_at.getTime();
    supplies.set(launchId, supply);
    earliest = Math.min(earliest, createdAtMs);
    latest = Math.max(latest, createdAtMs);
    subjects.set(launchId, {
      launchId,
      trackingEnded: row.tracking_ended_at !== null,
      launch: {
        createdAtMs,
        createdSlot: toNumber(row.create_slot),
        initialMcapQuote: marketCapQuote(
          {
            virtualTokenReserves: toBigInt(row.initial_virtual_token),
            virtualQuoteReserves: toBigInt(row.initial_virtual_quote)
          },
          supply
        ),
        devWallets: [row.dev_wallet, row.creator],
        completedAtMs: row.completed_at ? row.completed_at.getTime() : null,
        migratedAtMs: row.migrated_at ? row.migrated_at.getTime() : null
      },
      trades: []
    });
  }
  if (subjects.size === 0) {
    return subjects;
  }
  const trades = await db.query<TradeInputRow>(
    `SELECT launch_id, block_time, slot, wallet, is_buy, venue, token_amount, quote_amount, virtual_token, virtual_quote
       FROM trades
      WHERE launch_id = ANY($1::bigint[]) AND block_time >= $2 AND block_time <= $3
      ORDER BY launch_id, slot, seq, event_index`,
    [[...subjects.keys()].map(String), new Date(earliest - DAY_MS), new Date(latest + trackHours * HOUR_MS + DAY_MS)]
  );
  const insiders = await loadStoredInsiders(db, [...subjects.keys()]);
  for (const [launchId, subject] of subjects) {
    subjects.set(launchId, withStoredInsiders(subject, insiders));
  }
  for (const row of trades.rows) {
    const launchId = toNumber(row.launch_id);
    const subject = subjects.get(launchId);
    const supply = supplies.get(launchId);
    if (!subject || supply === undefined) {
      continue;
    }
    subject.trades.push({
      atMs: row.block_time.getTime(),
      slot: toNumber(row.slot),
      wallet: row.wallet,
      isBuy: row.is_buy,
      venue: VENUES[toNumber(row.venue)] ?? "curve",
      tokenAmount: toBigInt(row.token_amount),
      quoteAmount: toBigInt(row.quote_amount),
      mcapQuote: marketCapQuote(
        { virtualTokenReserves: toBigInt(row.virtual_token), virtualQuoteReserves: toBigInt(row.virtual_quote) },
        supply
      )
    });
  }
  return subjects;
}

const OUTCOME_COLUMNS = [
  "launch_id",
  "status",
  "migrated",
  "rugged",
  "died",
  "survived_15m",
  "initial_mcap_quote",
  "mcap_30s",
  "mcap_1m",
  "mcap_5m",
  "mcap_15m",
  "mcap_1h",
  "peak_mcap_quote",
  "peak_at",
  "time_to_peak_sec",
  "final_mcap_quote",
  "max_drawdown_from_peak",
  "peak_multiple_from_1m",
  "return_15m_from_1m",
  "dev_sold_at",
  "dev_sold_fraction",
  "rug_at",
  "last_trade_at",
  "trade_count",
  "unique_traders",
  "total_volume_quote",
  "outcome_known_at",
  "finalized",
  "computed_at",
  "details"
] as const;

function finiteOrNull(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : value;
}

export function outcomeRow(launchId: number, outcome: LaunchOutcome, finalized: boolean, computedAtMs: number): unknown[] {
  return [
    launchId,
    outcome.status,
    outcome.migrated,
    outcome.rugged,
    outcome.died,
    outcome.survived15m,
    outcome.initialMcapQuote,
    outcome.mcap30s,
    outcome.mcap1m,
    outcome.mcap5m,
    outcome.mcap15m,
    outcome.mcap1h,
    outcome.peakMcapQuote,
    new Date(outcome.peakAtMs),
    finiteOrNull(outcome.timeToPeakSec),
    outcome.finalMcapQuote,
    finiteOrNull(outcome.maxDrawdownFromPeak),
    finiteOrNull(outcome.peakMultipleFrom1m),
    finiteOrNull(outcome.return15mFrom1m),
    dateOrNull(outcome.devSoldAtMs),
    finiteOrNull(outcome.devSoldFraction),
    dateOrNull(outcome.rugAtMs),
    dateOrNull(outcome.lastTradeAtMs),
    outcome.tradeCount,
    outcome.uniqueTraders,
    outcome.totalVolumeQuote,
    dateOrNull(outcome.outcomeKnownAtMs),
    finalized,
    new Date(computedAtMs),
    jsonText(outcome.details)
  ];
}

export interface OutcomeWrite {
  launchId: number;
  outcome: LaunchOutcome;
  finalized: boolean;
}

export async function upsertOutcomes(db: Db, writes: readonly OutcomeWrite[], computedAtMs: number): Promise<void> {
  const updates = OUTCOME_COLUMNS.filter((column) => column !== "launch_id")
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(", ");
  for (const part of chunk(writes, 500)) {
    const params: unknown[] = [];
    const values = valuesList(
      part.map((write) => outcomeRow(write.launchId, write.outcome, write.finalized, computedAtMs)),
      [],
      params
    );
    await db.query(
      `INSERT INTO launch_outcomes (${OUTCOME_COLUMNS.join(", ")}) VALUES ${values}
       ON CONFLICT (launch_id) DO UPDATE SET ${updates}`,
      params
    );
  }
}

export async function endTracking(db: Db, writes: readonly OutcomeWrite[], endedAtMs: number): Promise<void> {
  for (const part of chunk(writes, 1_000)) {
    const params: unknown[] = [];
    const values = valuesList(
      part.map((write) => [
        write.launchId,
        write.outcome.tradeCount,
        write.outcome.buyCount,
        write.outcome.sellCount,
        write.outcome.uniqueTraders
      ]),
      ["bigint", "int", "int", "int", "int"],
      params
    );
    params.push(new Date(endedAtMs));
    await db.query(
      `UPDATE launches AS l
          SET tracking_ended_at = $${params.length}, trade_count = v.trade_count, buy_count = v.buy_count,
              sell_count = v.sell_count, unique_traders = v.unique_traders
         FROM (VALUES ${values}) AS v(id, trade_count, buy_count, sell_count, unique_traders)
        WHERE l.id = v.id AND l.tracking_ended_at IS NULL`,
      params
    );
  }
}

export interface OutcomeFinalizerOptions {
  db: Db;
  clock: Clock;
  market: MarketState;
  registry: LaunchRegistry;
  config: RecorderConfig;
  bundleSlotWindow: number;
  bus?: Bus;
  batchSize?: number;
  dbRecomputeMinSec?: number;
  catchUpDelayMs?: number;
  beforeLoad?: () => Promise<void>;
}

interface FinalizerState {
  nextCheckAtMs: number;
  lastComputedAtMs: number;
}

export interface FinalizerTickResult {
  computed: number;
  finalized: number;
  remaining: number;
}

interface Candidate {
  entry: TrackedLaunch;
  priority: number;
}

export class OutcomeFinalizer {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly market: MarketState;
  private readonly registry: LaunchRegistry;
  private readonly config: RecorderConfig;
  private readonly params: OutcomeParams;
  private readonly bus: Bus | undefined;
  private readonly batchSize: number;
  private readonly dbRecomputeMinMs: number;
  private readonly catchUpDelayMs: number;
  private readonly beforeLoad: (() => Promise<void>) | undefined;
  private readonly states = new Map<Pubkey, FinalizerState>();
  private readonly dirty = new Set<Pubkey>();
  private unsubscribers: Array<() => void> = [];
  private timer: TimerHandle | null = null;
  private ticking: Promise<FinalizerTickResult> | null = null;
  private running = false;
  private readonly counters = {
    ticks: 0,
    computed: 0,
    fromMemory: 0,
    fromDatabase: 0,
    finalized: 0,
    errors: 0
  };

  constructor(options: OutcomeFinalizerOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.market = options.market;
    this.registry = options.registry;
    this.config = options.config;
    this.params = outcomeParamsFrom(options.config, options.bundleSlotWindow);
    this.bus = options.bus;
    this.batchSize = options.batchSize ?? 300;
    this.dbRecomputeMinMs = (options.dbRecomputeMinSec ?? 300) * 1_000;
    this.catchUpDelayMs = options.catchUpDelayMs ?? 5_000;
    this.beforeLoad = options.beforeLoad;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const subscriptions: Array<() => void> = [
      this.registry.onUntrack((launch) => {
        this.states.delete(launch.mint);
        this.dirty.delete(launch.mint);
      })
    ];
    if (this.bus) {
      subscriptions.push(this.bus.on("chain", (event) => this.observe(event)));
    }
    this.unsubscribers = subscriptions;
    this.scheduleTick(this.config.finalizeIntervalSec * 1_000);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    if (this.timer) {
      this.clock.cancel(this.timer);
      this.timer = null;
    }
    if (this.ticking) {
      await this.ticking.catch(() => undefined);
    }
  }

  markDirty(mint: Pubkey): void {
    if (this.registry.isTracked(mint)) {
      this.dirty.add(mint);
    }
  }

  stats(): Record<string, number> {
    return { ...this.counters, states: this.states.size, dirty: this.dirty.size };
  }

  async tick(): Promise<FinalizerTickResult> {
    while (this.ticking) {
      await this.ticking.catch(() => undefined);
    }
    const run = this.runTick().finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    return run;
  }

  private observe(event: ChainEvent): void {
    if (event.kind !== "create") {
      this.markDirty(event.mint);
    }
  }

  private memoryLaunch(entry: TrackedLaunch): LaunchState | null {
    const launch = this.market.get(entry.mint);
    if (!launch || launch.droppedTrades > 0) {
      return null;
    }
    if (launch.launchId !== null && launch.launchId !== entry.launchId) {
      return null;
    }
    return launch;
  }

  private selectCandidates(nowMs: number): { batch: Candidate[]; remaining: number } {
    const candidates: Candidate[] = [];
    for (const entry of this.registry.entries()) {
      const state = this.states.get(entry.mint);
      if (!state) {
        candidates.push({ entry, priority: 0 });
        continue;
      }
      const minGap = this.memoryLaunch(entry) ? 0 : this.dbRecomputeMinMs;
      const dirtyReady = this.dirty.has(entry.mint) && nowMs - state.lastComputedAtMs >= minGap;
      if (dirtyReady || nowMs >= state.nextCheckAtMs) {
        candidates.push({ entry, priority: Math.min(state.nextCheckAtMs, state.lastComputedAtMs) });
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    const batch = candidates.slice(0, this.batchSize);
    return { batch, remaining: candidates.length - batch.length };
  }

  private async collectSubjects(batch: readonly Candidate[]): Promise<OutcomeSubject[]> {
    const fromMemory: OutcomeSubject[] = [];
    const fromDb: number[] = [];
    for (const { entry } of batch) {
      const launch = this.memoryLaunch(entry);
      if (launch) {
        fromMemory.push(subjectFromLaunchState(entry.launchId, launch));
        this.counters.fromMemory += 1;
      } else {
        fromDb.push(entry.launchId);
      }
    }
    const insiders = await loadStoredInsiders(
      this.db,
      fromMemory.map((subject) => subject.launchId)
    );
    const subjects = fromMemory.map((subject) => withStoredInsiders(subject, insiders));
    if (fromDb.length > 0) {
      const trackHours = this.config.outcome.finalizeAfterHours + this.config.postMigrationTrackHours;
      const loaded = await loadOutcomeSubjects(this.db, fromDb, trackHours);
      for (const subject of loaded.values()) {
        subjects.push(subject);
        this.counters.fromDatabase += 1;
      }
    }
    return subjects;
  }

  private async runTick(): Promise<FinalizerTickResult> {
    this.counters.ticks += 1;
    const nowMs = this.clock.nowMs();
    const { batch, remaining } = this.selectCandidates(nowMs);
    if (batch.length === 0) {
      return { computed: 0, finalized: 0, remaining: 0 };
    }
    try {
      await this.beforeLoad?.();
      const subjects = await this.collectSubjects(batch);
      const writes: OutcomeWrite[] = subjects.map((subject) => {
        const outcome = computeOutcome({ launch: subject.launch, trades: subject.trades, nowMs, params: this.params });
        return { launchId: subject.launchId, outcome, finalized: outcome.finalized };
      });
      await upsertOutcomes(this.db, writes, nowMs);
      const finalized = writes.filter((write) => write.finalized);
      await endTracking(this.db, finalized, nowMs);
      this.applyResults(batch, writes, nowMs);
      this.counters.computed += writes.length;
      this.counters.finalized += finalized.length;
      return { computed: writes.length, finalized: finalized.length, remaining };
    } catch (error) {
      this.counters.errors += 1;
      log.error({ err: error, batch: batch.length }, "outcome finalizer tick failed");
      return { computed: 0, finalized: 0, remaining: remaining + batch.length };
    }
  }

  private applyResults(batch: readonly Candidate[], writes: readonly OutcomeWrite[], nowMs: number): void {
    const byLaunch = new Map(writes.map((write) => [write.launchId, write]));
    for (const { entry } of batch) {
      this.dirty.delete(entry.mint);
      const write = byLaunch.get(entry.launchId);
      if (!write) {
        this.states.set(entry.mint, { nextCheckAtMs: nowMs + this.dbRecomputeMinMs, lastComputedAtMs: nowMs });
        continue;
      }
      if (write.finalized) {
        this.registry.untrack(entry.mint);
        continue;
      }
      this.states.set(entry.mint, {
        nextCheckAtMs: write.outcome.nextCheckAtMs ?? nowMs + this.config.finalizeIntervalSec * 1_000,
        lastComputedAtMs: nowMs
      });
    }
  }

  private scheduleTick(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = this.clock.schedule(this.clock.nowMs() + delayMs, async () => {
      this.timer = null;
      if (!this.running) {
        return;
      }
      const result = await this.tick().catch(() => ({ computed: 0, finalized: 0, remaining: 0 }));
      this.scheduleTick(result.remaining > 0 ? this.catchUpDelayMs : this.config.finalizeIntervalSec * 1_000);
    });
  }
}

export interface RecomputeOutcomesOptions {
  from: Date;
  to: Date;
  config: StrategyConfig;
  nowMs?: number;
  batchSize?: number;
}

export interface RecomputeOutcomesResult {
  launches: number;
  finalized: number;
}

export async function recomputeOutcomes(db: Db, options: RecomputeOutcomesOptions): Promise<RecomputeOutcomesResult> {
  const nowMs = options.nowMs ?? new SystemClock().nowMs();
  const batchSize = options.batchSize ?? 500;
  const params = outcomeParamsFrom(options.config.recorder, options.config.scorer.bundleSlotWindow);
  const trackHours = options.config.recorder.outcome.finalizeAfterHours + options.config.recorder.postMigrationTrackHours;
  const result: RecomputeOutcomesResult = { launches: 0, finalized: 0 };
  let afterId = 0;
  for (;;) {
    const ids = await db.query<{ id: unknown }>(
      `SELECT id FROM launches WHERE created_at >= $1 AND created_at < $2 AND id > $3 ORDER BY id LIMIT $4`,
      [options.from, options.to, afterId, batchSize]
    );
    if (ids.rows.length === 0) {
      return result;
    }
    const launchIds = ids.rows.map((row) => toNumber(row.id));
    afterId = launchIds[launchIds.length - 1] ?? afterId;
    const subjects = await loadOutcomeSubjects(db, launchIds, trackHours);
    const writes: OutcomeWrite[] = [...subjects.values()].map((subject) => {
      const outcome = computeOutcome({ launch: subject.launch, trades: subject.trades, nowMs, params });
      return { launchId: subject.launchId, outcome, finalized: subject.trackingEnded };
    });
    await upsertOutcomes(db, writes, nowMs);
    result.launches += writes.length;
    result.finalized += writes.filter((write) => write.finalized).length;
    log.info({ processed: result.launches }, "outcomes recomputed");
  }
}
