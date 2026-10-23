import type { ExecutionConfig, ExitConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import { SOL_QUOTE } from "../core/constants.js";
import type { Executor, MarketDataSource, RiskGate, TradingStore } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type {
  ChainEvent,
  CurveView,
  FillResult,
  OrderRequest,
  Position,
  Pubkey,
  Signal,
  TradingMode
} from "../core/types.js";
import { failedFill } from "../execution/fill.js";
import { awaitingMigration, evaluateExit } from "../exits/engine.js";
import { planChunk } from "../exits/liquidity.js";
import { isUsablePrice } from "../exits/math.js";
import { applyExitUpdates, EXIT_META_KEY } from "../exits/state.js";
import type { ExitEvents } from "../exits/types.js";
import type { SmartExitCounter } from "../exits/watcher.js";
import type { LaunchState } from "../market/state.js";
import {
  applySellFill,
  closedTradeOf,
  closePosition,
  failedEntryPosition,
  isDust,
  openPositionFromFill,
  sellOrderFor,
  syntheticCloseFill,
  unrealizedPnlOf,
  type PositionSeed,
  type SellIntent
} from "./accounting.js";
import { entryKey, orderKeyOf, positionIdFor, shadowIdFor, shadowKeyFor, withNextFillSeq } from "./ids.js";

const log = moduleLogger("trader");

export const KILL_SWITCH_REASON = "kill_switch";
export const INCOMPLETE_DATA_REASON = "incomplete_data";

export type FillReconciler = (order: OrderRequest, signature: string) => Promise<FillResult | null>;

export interface TraderRisk extends RiskGate {
  releaseEntry?(mint: Pubkey, nowMs?: number): void;
}

export interface ExitEventSource {
  eventsFor(position: Pick<Position, "mint" | "openedAtMs" | "openedSlot">): ExitEvents;
}

export interface TraderOptions {
  runId: number;
  mode: TradingMode;
  clock: Clock;
  bus: Bus;
  market: MarketDataSource;
  executor: Executor;
  shadowExecutor?: Executor | null;
  risk: TraderRisk;
  exits: ExitConfig;
  execution: ExecutionConfig;
  watcher: ExitEventSource;
  store: TradingStore;
  smartExitCount?: SmartExitCounter | null;
  reconcile?: FillReconciler | null;
  tradableQuoteMints?: readonly string[];
  dustLamports?: bigint;
  reconcileIntervalMs?: number;
  reconcileAttempts?: number;
  stopWaitMs?: number;
}

export interface TraderStats {
  open: number;
  shadows: number;
  sellsInFlight: number;
  pendingEntries: number;
  tasks: number;
  signals: number;
  skipped: number;
  rejectedByRisk: number;
  entriesAttempted: number;
  entriesFilled: number;
  entriesFailed: number;
  shadowEntriesFilled: number;
  sellsSubmitted: number;
  sellsFilled: number;
  sellsFailed: number;
  closed: number;
  unpricedEvaluations: number;
  unconfirmedFills: number;
}

interface Slot {
  position: Position;
  executor: Executor;
  primary: boolean;
  sellInFlight: boolean;
}

interface EntryContext {
  key: string;
  signal: Signal;
  order: OrderRequest;
  launchId: number | null;
  signalId: number | null;
  signalSettled: boolean;
  pending: number;
  closed: Map<string, Position>;
}

function sameExitState(a: Position, b: Position): boolean {
  return JSON.stringify(a.meta[EXIT_META_KEY] ?? null) === JSON.stringify(b.meta[EXIT_META_KEY] ?? null);
}

function positionChanged(before: Position, after: Position): boolean {
  return (
    before.peakPrice !== after.peakPrice ||
    before.lastPrice !== after.lastPrice ||
    before.takeProfitLevelsHit !== after.takeProfitLevelsHit ||
    before.migratedSeen !== after.migratedSeen ||
    !sameExitState(before, after)
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Trader {
  readonly runId: number;
  readonly mode: TradingMode;
  private readonly clock: Clock;
  private readonly bus: Bus;
  private readonly market: MarketDataSource;
  private readonly executor: Executor;
  private readonly shadowExecutor: Executor | null;
  private readonly risk: TraderRisk;
  private readonly exits: ExitConfig;
  private readonly execution: ExecutionConfig;
  private readonly watcher: ExitEventSource;
  private readonly store: TradingStore;
  private readonly smartExitCount: SmartExitCounter | null;
  private readonly reconcile: FillReconciler | null;
  private readonly tradableQuoteMints: readonly string[];
  private readonly dustLamports: bigint;
  private readonly reconcileIntervalMs: number;
  private readonly reconcileAttempts: number;
  private readonly stopWaitMs: number;
  private readonly slots = new Map<string, Slot>();
  private readonly byMint = new Map<Pubkey, Set<string>>();
  private readonly entries = new Map<string, EntryContext>();
  private readonly pendingMints = new Map<Pubkey, number>();
  private readonly tasks = new Set<Promise<unknown>>();
  private unsubscribers: Array<() => void> = [];
  private timer: TimerHandle | null = null;
  private running = false;
  private readonly counters = {
    signals: 0,
    skipped: 0,
    rejectedByRisk: 0,
    entriesAttempted: 0,
    entriesFilled: 0,
    entriesFailed: 0,
    shadowEntriesFilled: 0,
    sellsSubmitted: 0,
    sellsFilled: 0,
    sellsFailed: 0,
    closed: 0,
    unpricedEvaluations: 0,
    unconfirmedFills: 0
  };

  constructor(options: TraderOptions) {
    this.runId = options.runId;
    this.mode = options.mode;
    this.clock = options.clock;
    this.bus = options.bus;
    this.market = options.market;
    this.executor = options.executor;
    this.shadowExecutor = options.shadowExecutor ?? null;
    this.risk = options.risk;
    this.exits = options.exits;
    this.execution = options.execution;
    this.watcher = options.watcher;
    this.store = options.store;
    this.smartExitCount = options.smartExitCount ?? null;
    this.reconcile = options.reconcile ?? null;
    this.tradableQuoteMints = options.tradableQuoteMints ?? [SOL_QUOTE];
    this.dustLamports = options.dustLamports ?? 1_000n;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 10_000;
    this.reconcileAttempts = options.reconcileAttempts ?? 12;
    this.stopWaitMs = options.stopWaitMs ?? 20_000;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.unsubscribers = [
      this.bus.on("signal", (signal) => this.handleSignal(signal)),
      this.bus.on("chain", (event) => this.onChain(event))
    ];
    this.ensureTimer();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    if (this.timer) {
      this.clock.cancel(this.timer);
      this.timer = null;
    }
    if (!this.clock.virtual) {
      await this.waitForTasks(this.stopWaitMs);
    }
    log.info({ runId: this.runId, stats: this.stats() }, "trader stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  restore(positions: readonly Position[]): number {
    let restored = 0;
    for (const position of positions) {
      if (position.status !== "open" || this.slots.has(position.id)) {
        continue;
      }
      const primary = position.shadowOf === null;
      const executor = primary ? this.executor : this.shadowExecutor;
      if (!executor) {
        log.warn({ positionId: position.id }, "shadow position restored without a shadow executor, left untouched");
        continue;
      }
      this.addSlot({ position, executor, primary, sellInFlight: false });
      if (primary) {
        this.risk.onPositionOpened(position);
      }
      restored += 1;
    }
    this.ensureTimer();
    return restored;
  }

  handleSignal(signal: Signal): void {
    this.counters.signals += 1;
    const nowMs = this.clock.nowMs();
    const launch = this.market.launch(signal.mint);
    const launchId = launch?.launchId ?? null;
    const skip = this.entrySkipReason(launch);
    if (skip || !launch) {
      this.counters.skipped += 1;
      this.recordSignal(signal, false, skip ?? "launch_not_in_memory", launchId);
      return;
    }
    const decision = this.risk.evaluateEntry({
      mint: signal.mint,
      devWallet: launch.info.devWallet,
      signal,
      nowMs,
      openPositions: this.primaryPositions()
    });
    if (!decision.allowed) {
      this.counters.rejectedByRisk += 1;
      this.recordSignal(signal, false, decision.reason ?? "risk_rejected", launchId);
      return;
    }
    this.enter(signal, launch, decision.sizeLamports, nowMs);
  }

  recordRejection(signal: Signal, reason: string): void {
    const launchId = this.market.launch(signal.mint)?.launchId ?? null;
    this.recordSignal(signal, false, reason, launchId);
  }

  evaluateMint(mint: Pubkey): void {
    const ids = this.byMint.get(mint);
    if (!ids || ids.size === 0) {
      return;
    }
    const nowMs = this.clock.nowMs();
    for (const id of [...ids]) {
      const slot = this.slots.get(id);
      if (slot) {
        this.evaluateSlot(slot, nowMs);
      }
    }
    this.markToMarket(nowMs);
  }

  evaluateAll(): void {
    const nowMs = this.clock.nowMs();
    for (const slot of [...this.slots.values()]) {
      this.evaluateSlot(slot, nowMs);
    }
    this.markToMarket(nowMs);
  }

  liquidateAll(reason: string): number {
    const nowMs = this.clock.nowMs();
    let closed = 0;
    for (const slot of [...this.slots.values()]) {
      if (slot.sellInFlight) {
        continue;
      }
      const launch = this.market.launch(slot.position.mint);
      const view = this.market.view(slot.position.mint);
      const spot = launch?.price() ?? 0;
      const price = isUsablePrice(spot) ? spot : slot.position.lastPrice;
      const { order, fill } = syntheticCloseFill(slot.position, view, price, this.execution, nowMs, reason, orderKeyOf(slot.position));
      this.applySell(slot, order, fill);
      closed += 1;
    }
    this.markToMarket(nowMs);
    return closed;
  }

  hasOpenPosition(mint: Pubkey): boolean {
    return (this.byMint.get(mint)?.size ?? 0) > 0 || (this.pendingMints.get(mint) ?? 0) > 0;
  }

  isBusy(): boolean {
    return this.slots.size > 0 || this.pendingMints.size > 0;
  }

  inFlightCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      count += entry.pending;
    }
    for (const slot of this.slots.values()) {
      if (slot.sellInFlight) {
        count += 1;
      }
    }
    return count;
  }

  openPositions(): Position[] {
    return [...this.slots.values()].map((slot) => slot.position);
  }

  primaryPositions(): Position[] {
    const positions: Position[] = [];
    for (const slot of this.slots.values()) {
      if (slot.primary) {
        positions.push(slot.position);
      }
    }
    return positions;
  }

  stats(): TraderStats {
    let shadows = 0;
    let sellsInFlight = 0;
    for (const slot of this.slots.values()) {
      if (!slot.primary) {
        shadows += 1;
      }
      if (slot.sellInFlight) {
        sellsInFlight += 1;
      }
    }
    let pendingEntries = 0;
    for (const entry of this.entries.values()) {
      pendingEntries += entry.pending;
    }
    return {
      open: this.slots.size - shadows,
      shadows,
      sellsInFlight,
      pendingEntries,
      tasks: this.tasks.size,
      ...this.counters
    };
  }

  private entrySkipReason(launch: LaunchState | undefined): string | null {
    if (!this.running) {
      return "trader_stopped";
    }
    if (!launch) {
      return "launch_not_in_memory";
    }
    if (!this.tradableQuoteMints.includes(launch.info.quoteMint) || !launch.isSolQuoted) {
      return "quote_mint_not_tradable";
    }
    if (!launch.dataComplete) {
      return INCOMPLETE_DATA_REASON;
    }
    if (launch.complete && !launch.migrated) {
      return "awaiting_migration";
    }
    if (!isUsablePrice(launch.price())) {
      return "no_price";
    }
    return null;
  }

  private enter(signal: Signal, launch: LaunchState, sizeLamports: bigint, nowMs: number): void {
    const key = entryKey(signal.mint, nowMs);
    const order: OrderRequest = {
      side: "buy",
      mint: signal.mint,
      quoteBudget: sizeLamports,
      tokenAmount: null,
      maxSlippageBps: this.execution.buySlippageBps,
      reason: signal.type,
      urgency: "normal",
      signalSlot: signal.slot,
      signalAtMs: nowMs,
      referencePrice: launch.price(),
      positionId: key,
      closesPosition: false
    };
    const entry: EntryContext = {
      key,
      signal,
      order,
      launchId: launch.launchId,
      signalId: null,
      signalSettled: false,
      pending: 0,
      closed: new Map()
    };
    this.entries.set(key, entry);
    this.pendingMints.set(signal.mint, (this.pendingMints.get(signal.mint) ?? 0) + 1);
    this.counters.entriesAttempted += 1;
    this.recordActedSignal(entry);
    this.launchEntry(entry, this.executor, order, true);
    if (this.shadowExecutor) {
      this.launchEntry(entry, this.shadowExecutor, { ...order, positionId: shadowKeyFor(key) }, false);
    }
  }

  private launchEntry(entry: EntryContext, executor: Executor, order: OrderRequest, primary: boolean): void {
    entry.pending += 1;
    this.track(
      this.runEntry(entry, executor, order, primary).finally(() => {
        entry.pending -= 1;
        if (primary) {
          this.releasePendingMint(order.mint);
        }
        this.forgetEntryIfDone(entry);
      })
    );
  }

  private async runEntry(entry: EntryContext, executor: Executor, order: OrderRequest, primary: boolean): Promise<void> {
    const fill = await this.settleUnconfirmed(order, await this.executeSafely(executor, order));
    try {
      this.finishEntry(entry, executor, order, fill, primary);
    } catch (error) {
      log.error({ err: error, mint: order.mint, primary }, "entry bookkeeping failed");
    }
  }

  private seedFor(entry: EntryContext, order: OrderRequest, primary: boolean, nowMs: number): PositionSeed {
    const primaryId = positionIdFor(this.runId, entry.key);
    const launch = this.market.launch(order.mint);
    return {
      id: primary ? primaryId : shadowIdFor(primaryId),
      runId: this.runId,
      mode: primary ? this.mode : "shadow",
      signal: entry.signal,
      signalId: entry.signalId,
      launchId: entry.launchId ?? launch?.launchId ?? null,
      shadowOf: primary ? null : primaryId,
      orderKey: order.positionId ?? entry.key,
      migrated: launch?.migrated ?? false,
      nowMs,
      slot: launch?.lastSlot ?? this.market.latestSlot()
    };
  }

  private finishEntry(entry: EntryContext, executor: Executor, order: OrderRequest, fill: FillResult, primary: boolean): void {
    const nowMs = this.clock.nowMs();
    const seed = this.seedFor(entry, order, primary, nowMs);
    if (fill.success && fill.tokenAmount > 0n) {
      const position = withNextFillSeq(openPositionFromFill(seed, fill));
      this.addSlot({ position, executor, primary, sellInFlight: false });
      this.store.savePosition(position);
      this.store.recordFill(position, order, fill);
      if (primary) {
        this.counters.entriesFilled += 1;
        this.risk.onPositionOpened(position);
      } else {
        this.counters.shadowEntriesFilled += 1;
      }
      this.bus.emit("positionOpened", position);
      this.ensureTimer();
      return;
    }
    this.failEntry(entry, seed, order, fill, primary, nowMs);
  }

  private failEntry(
    entry: EntryContext,
    seed: PositionSeed,
    order: OrderRequest,
    fill: FillResult,
    primary: boolean,
    nowMs: number
  ): void {
    if (primary) {
      this.counters.entriesFailed += 1;
      this.risk.releaseEntry?.(order.mint, nowMs);
    }
    const failed = withNextFillSeq(failedEntryPosition(seed, fill));
    log.info({ mint: order.mint, primary, error: fill.error?.slice(0, 120) ?? null, cost: failed.entryCost.toString() }, "entry not filled");
    if (failed.entryCost <= 0n) {
      return;
    }
    entry.closed.set(failed.id, failed);
    this.store.savePosition(failed);
    this.store.recordFill(failed, order, fill);
    if (primary) {
      this.risk.onPositionClosed(closedTradeOf(failed));
    }
    this.counters.closed += 1;
    this.bus.emit("positionClosed", failed);
    this.markToMarket(nowMs);
  }

  private recordSignal(signal: Signal, acted: boolean, skipReason: string | null, launchId: number | null): void {
    try {
      this.track(
        this.store.recordSignal(this.runId, { signal, acted, skipReason, launchId }).catch((error: unknown) => {
          log.warn({ err: error, mint: signal.mint }, "signal record failed");
          return null;
        })
      );
    } catch (error) {
      log.warn({ err: error, mint: signal.mint }, "signal record failed");
    }
  }

  private recordActedSignal(entry: EntryContext): void {
    const record = { signal: entry.signal, acted: true, skipReason: null, launchId: entry.launchId };
    let pending: Promise<number | null>;
    try {
      pending = this.store.recordSignal(this.runId, record);
    } catch (error) {
      pending = Promise.reject(error);
    }
    this.track(
      pending.then(
        (id) => this.linkSignal(entry, id),
        (error: unknown) => {
          log.warn({ err: error, mint: entry.signal.mint }, "signal record failed");
          this.linkSignal(entry, null);
        }
      )
    );
  }

  private linkSignal(entry: EntryContext, signalId: number | null): void {
    entry.signalSettled = true;
    entry.signalId = signalId;
    if (signalId !== null) {
      const primaryId = positionIdFor(this.runId, entry.key);
      for (const id of [primaryId, shadowIdFor(primaryId)]) {
        const slot = this.slots.get(id);
        if (slot && slot.position.signalId === null) {
          slot.position = { ...slot.position, signalId };
          this.store.savePosition(slot.position);
        }
        const closed = entry.closed.get(id);
        if (closed && closed.signalId === null) {
          this.store.savePosition({ ...closed, signalId });
        }
      }
    }
    this.forgetEntryIfDone(entry);
  }

  private forgetEntryIfDone(entry: EntryContext): void {
    if (entry.pending === 0 && entry.signalSettled) {
      this.entries.delete(entry.key);
    }
  }

  private releasePendingMint(mint: Pubkey): void {
    const count = (this.pendingMints.get(mint) ?? 0) - 1;
    if (count > 0) {
      this.pendingMints.set(mint, count);
    } else {
      this.pendingMints.delete(mint);
    }
  }

  private async executeSafely(executor: Executor, order: OrderRequest): Promise<FillResult> {
    try {
      return await executor.execute(order);
    } catch (error) {
      log.error({ err: error, mint: order.mint, side: order.side }, "executor threw");
      const venue = this.market.view(order.mint)?.venue ?? "curve";
      return failedFill(order, `executor_error:${errorText(error)}`, [], venue);
    }
  }

  private async settleUnconfirmed(order: OrderRequest, fill: FillResult): Promise<FillResult> {
    if (fill.success || fill.error !== "unconfirmed" || !fill.signature || !this.reconcile) {
      return fill;
    }
    this.counters.unconfirmedFills += 1;
    for (let attempt = 0; attempt < this.reconcileAttempts; attempt += 1) {
      await this.clock.sleepUntil(this.clock.nowMs() + this.reconcileIntervalMs);
      try {
        const resolved = await this.reconcile(order, fill.signature);
        if (resolved) {
          return resolved;
        }
      } catch (error) {
        log.warn({ err: error, signature: fill.signature }, "reconcile failed, will retry");
      }
    }
    log.error({ signature: fill.signature, mint: order.mint, side: order.side }, "fill outcome still unknown; check the hot wallet");
    return fill;
  }

  private onChain(event: ChainEvent): void {
    if (event.kind === "create") {
      return;
    }
    this.evaluateMint(event.mint);
  }

  private ensureTimer(): void {
    if (this.timer || !this.running || this.slots.size === 0) {
      return;
    }
    this.timer = this.clock.schedule(this.clock.nowMs() + this.exits.evaluateIntervalMs, () => this.onTimer());
  }

  private onTimer(): void {
    this.timer = null;
    if (!this.running) {
      return;
    }
    try {
      this.evaluateAll();
    } catch (error) {
      log.error({ err: error }, "exit evaluation failed");
    }
    this.ensureTimer();
  }

  private eventsFor(position: Position): ExitEvents {
    const events = this.watcher.eventsFor(position);
    if (!this.smartExitCount) {
      return events;
    }
    const count = this.smartExitCount(position.mint, position.openedAtMs);
    return { ...events, smartWalletsExited: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0 };
  }

  private evaluateSlot(slot: Slot, nowMs: number): void {
    const position = slot.position;
    if (position.status !== "open") {
      return;
    }
    const launch = this.market.launch(position.mint);
    const view = this.market.view(position.mint);
    if (!launch || !view) {
      this.counters.unpricedEvaluations += 1;
      return;
    }
    const price = launch.price();
    const decision = evaluateExit({
      position,
      view,
      price,
      nowMs,
      events: this.eventsFor(position),
      config: this.exits,
      execution: this.execution,
      sellInFlight: slot.sellInFlight,
      migratedSlot: launch.migratedSlot
    });
    const updated = applyExitUpdates(position, decision.updates);
    if (positionChanged(position, updated)) {
      slot.position = updated;
      this.store.savePosition(updated);
    }
    if (slot.sellInFlight) {
      return;
    }
    const intent = this.risk.shouldFlattenAll() ? this.flattenIntent(updated, view, price) : decision.actions[0] ?? null;
    if (intent) {
      this.submitSell(slot, intent, view, price, nowMs);
    }
  }

  private flattenIntent(position: Position, view: CurveView, price: number): SellIntent | null {
    if (position.tokensHeld <= 0n || awaitingMigration(view) || !isUsablePrice(price)) {
      return null;
    }
    const plan = planChunk(position.tokensHeld, view, price, "emergency", this.exits.liquidity);
    if (!plan) {
      return null;
    }
    const tokenAmount = plan.tokenAmount > position.tokensHeld ? position.tokensHeld : plan.tokenAmount;
    return {
      tokenAmount,
      reason: KILL_SWITCH_REASON,
      urgency: "emergency",
      maxSlippageBps: this.execution.emergencySellSlippageBps,
      closesPosition: tokenAmount >= position.tokensHeld
    };
  }

  private submitSell(slot: Slot, intent: SellIntent, view: CurveView, price: number, nowMs: number): void {
    slot.sellInFlight = true;
    this.counters.sellsSubmitted += 1;
    const order = sellOrderFor(slot.position, intent, view, price, nowMs, orderKeyOf(slot.position));
    this.track(this.runSell(slot, order));
  }

  private async runSell(slot: Slot, order: OrderRequest): Promise<void> {
    const fill = await this.settleUnconfirmed(order, await this.executeSafely(slot.executor, order));
    slot.sellInFlight = false;
    if (this.slots.get(slot.position.id) !== slot) {
      return;
    }
    try {
      this.applySell(slot, order, fill);
    } catch (error) {
      log.error({ err: error, positionId: slot.position.id }, "sell bookkeeping failed");
    }
  }

  private applySell(slot: Slot, order: OrderRequest, fill: FillResult): void {
    const nowMs = this.clock.nowMs();
    const position = applySellFill(withNextFillSeq(slot.position), order, fill);
    this.store.recordFill(position, order, fill);
    if (!fill.success) {
      this.counters.sellsFailed += 1;
      slot.position = position;
      this.store.savePosition(position);
      return;
    }
    this.counters.sellsFilled += 1;
    const spot = this.market.launch(position.mint)?.price() ?? position.lastPrice;
    if (isDust(position.tokensHeld, spot, this.dustLamports)) {
      this.close(slot, position, order.reason, nowMs);
      this.markToMarket(nowMs);
      return;
    }
    slot.position = position;
    this.store.savePosition(position);
    this.bus.emit("positionUpdated", position);
    if (this.running) {
      this.evaluateSlot(slot, nowMs);
    }
    this.markToMarket(nowMs);
  }

  private close(slot: Slot, position: Position, reason: string, nowMs: number): void {
    const closed = closePosition(position, nowMs, reason);
    this.removeSlot(slot);
    this.store.savePosition(closed);
    if (slot.primary) {
      this.risk.onPositionClosed(closedTradeOf(closed));
    }
    this.counters.closed += 1;
    this.bus.emit("positionClosed", closed);
  }

  private markToMarket(nowMs: number): void {
    let unrealized = 0n;
    for (const slot of this.slots.values()) {
      if (slot.primary) {
        unrealized += unrealizedPnlOf(slot.position, this.market.view(slot.position.mint), this.execution);
      }
    }
    const wasFlattening = this.risk.shouldFlattenAll();
    this.risk.markToMarket(unrealized, nowMs);
    if (!wasFlattening && this.risk.shouldFlattenAll()) {
      log.warn({ runId: this.runId, open: this.slots.size }, "kill switch tripped, flattening all positions");
      for (const slot of [...this.slots.values()]) {
        this.evaluateSlot(slot, nowMs);
      }
    }
  }

  private addSlot(slot: Slot): void {
    this.slots.set(slot.position.id, slot);
    let ids = this.byMint.get(slot.position.mint);
    if (!ids) {
      ids = new Set();
      this.byMint.set(slot.position.mint, ids);
    }
    ids.add(slot.position.id);
  }

  private removeSlot(slot: Slot): void {
    const id = slot.position.id;
    this.slots.delete(id);
    const ids = this.byMint.get(slot.position.mint);
    ids?.delete(id);
    if (ids && ids.size === 0) {
      this.byMint.delete(slot.position.mint);
    }
  }

  private track(work: Promise<unknown>): void {
    this.tasks.add(work);
    void work
      .catch((error: unknown) => {
        log.error({ err: error }, "trader task failed");
      })
      .finally(() => {
        this.tasks.delete(work);
      });
  }

  private async waitForTasks(maxMs: number): Promise<void> {
    if (this.tasks.size === 0) {
      return;
    }
    let handle: TimerHandle | null = null;
    const deadline = new Promise<void>((resolve) => {
      handle = this.clock.schedule(this.clock.nowMs() + maxMs, resolve);
    });
    await Promise.race([Promise.allSettled([...this.tasks]).then(() => undefined), deadline]);
    if (handle) {
      this.clock.cancel(handle);
    }
    if (this.tasks.size > 0) {
      log.warn({ tasks: this.tasks.size }, "trader stopped with orders still in flight");
    }
  }
}
