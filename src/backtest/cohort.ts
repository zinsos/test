import type { StrategyConfig } from "../config/strategy.js";
import { Bus } from "../core/bus.js";
import { VirtualClock, type Clock } from "../core/clock.js";
import type { RiskStatus, ScoreProvider, TradingStore } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { ClosedTrade, LaunchScore, Position } from "../core/types.js";
import { jsonSafe, withTransaction, type Db } from "../db/pool.js";
import { PaperExecutor } from "../execution/paperExecutor.js";
import { ExitEventWatcher } from "../exits/watcher.js";
import { MarketState } from "../market/state.js";
import { RiskManager } from "../risk/manager.js";
import { softFlags } from "../scorer/features.js";
import { createScorerModule, seedTrending, TrendingTracker, type ScorerModule } from "../scorer/index.js";
import type { ScoringModel } from "../scorer/model.js";
import { createTrackerModule, TrackedWalletRegistry, type TrackerModule } from "../tracker/index.js";
import { closedTradeOf } from "../trader/accounting.js";
import { PgTradingStore } from "../trader/store.js";
import { Trader, type TraderStats } from "../trader/trader.js";
import { earliest, ScopedClock } from "./laneClock.js";
import { evictableAt, evictionWindowOf, LaneMarket } from "./laneMarket.js";
import { CohortScoring, LaneScoring } from "./laneScoring.js";
import { applyReplayEvent, BacktestLoader, scheduleIncomplete, type ObservationModel } from "./loader.js";
import { RollingStoredFeatures } from "./storedScores.js";
import { BACKTEST_END_REASON, buildSummary, type BacktestProgress, type BacktestResult, type BacktestSummary } from "./summary.js";
import { selectBacktestWeights, type SelectedWeights } from "./weights.js";

const log = moduleLogger("backtest.cohort");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const REGISTRY_REFRESH_MS = 15 * MINUTE_MS;

export interface ManagedTradingStore extends TradingStore {
  start?(): void;
  stop?(): Promise<void>;
  prepare?(): Promise<void>;
}

export interface CohortLane {
  key: string;
  config: StrategyConfig;
  label?: string | null;
  weightsFile?: string | null;
  store?: ManagedTradingStore | null;
  recordRejectedSignals?: boolean;
  onProgress?: ((progress: BacktestProgress) => void) | null;
}

export interface CohortBacktestOptions {
  db: Db;
  fromMs: number;
  toMs: number;
  lanes: readonly CohortLane[];
  includeIncomplete?: boolean;
  walkForward?: boolean;
  model?: ScoringModel | null;
  allowInSampleWeights?: boolean;
  windowMs?: number;
  observation?: ObservationModel;
  storedChunkMs?: number;
  settleMs?: number;
  evictEveryMs?: number;
  recordRejectedSignals?: boolean;
  progressEveryMs?: number;
  isolateLanes?: boolean;
}

export interface CohortLaneResult {
  key: string;
  result: BacktestResult | null;
  error: string | null;
  fallback: string | null;
}

export interface CohortPass {
  lanes: string[];
  events: number;
  isolated: boolean;
  hiddenWhileHeld: number;
}

export interface CohortBacktestResult {
  lanes: CohortLaneResult[];
  passes: CohortPass[];
}

interface Lane {
  spec: CohortLane;
  runId: number;
  label: string | null;
  store: ManagedTradingStore;
  ownsStore: boolean;
  clock: Clock;
  scopedClock: ScopedClock | null;
  bus: Bus;
  market: LaneMarket;
  scoring: LaneScoring | null;
  tracker: TrackerModule;
  risk: RiskManager;
  trader: Trader;
  closedTrades: ClosedTrade[];
  detachClosed: () => void;
  rescore: ((score: LaunchScore) => LaunchScore) | null;
  running: boolean;
  stopped: boolean;
  closedAtEnd: number;
  ending: LaneEnding | null;
  divergence: string | null;
}

interface LaneEnding {
  riskStatus: RiskStatus;
  traderStats: TraderStats;
  signalStats: { accepted: number; rejected: number };
}

interface PassOutcome {
  results: CohortLaneResult[];
  diverged: CohortLane[];
  pass: CohortPass;
}

export interface CohortGroupOptions {
  splitHardBlocks?: boolean;
}

export function cohortGroupKey(lane: Pick<CohortLane, "config" | "weightsFile">, options: CohortGroupOptions = {}): string {
  const { convergence: _convergence, ...tracker } = lane.config.tracker;
  const { hardBlocks, ...scorer } = lane.config.scorer;
  return JSON.stringify(
    jsonSafe({
      scorer,
      hardBlocks: options.splitHardBlocks ? hardBlocks : null,
      memory: lane.config.recorder.memory,
      quoteMints: lane.config.signals.quoteMints,
      tracker,
      weightsFile: lane.weightsFile ?? null
    })
  );
}

export function groupCohortLanes<T extends Pick<CohortLane, "config" | "weightsFile">>(lanes: readonly T[], options: CohortGroupOptions = {}): T[][] {
  const groups = new Map<string, T[]>();
  for (const lane of lanes) {
    const key = cohortGroupKey(lane, options);
    const group = groups.get(key);
    if (group) {
      group.push(lane);
    } else {
      groups.set(key, [lane]);
    }
  }
  return [...groups.values()];
}

function sameHardBlocks(a: StrategyConfig, b: StrategyConfig): boolean {
  return JSON.stringify(a.scorer.hardBlocks) === JSON.stringify(b.scorer.hardBlocks);
}

export function hardBlockRescorer(scorer: ScorerModule, hardBlocks: StrategyConfig["scorer"]["hardBlocks"]): (score: LaunchScore) => LaunchScore {
  return (score) => {
    const model = scorer.service.currentModel().score(score.features, hardBlocks);
    return {
      ...score,
      score: model.score,
      hardBlocked: model.hardBlocked,
      flags: [...new Set([...model.flags, ...softFlags(score.features)])],
      contributions: model.contributions,
      weightsVersion: model.weightsVersion
    };
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createReplayMarket(config: StrategyConfig): MarketState {
  const memory = config.recorder.memory;
  return new MarketState({
    maxTradesPerLaunch: memory.maxTradesPerLaunch,
    evictInactiveMs: memory.evictInactiveMinutes * MINUTE_MS,
    evictMaxAgeMs: memory.evictMaxAgeHours * HOUR_MS,
    quoteMints: config.signals.quoteMints
  });
}

function storedRetentionMs(lanes: readonly CohortLane[]): number {
  let longest = 0;
  for (const lane of lanes) {
    longest = Math.max(longest, lane.config.tracker.convergence.maxLaunchAgeSec);
  }
  return Math.max(2 * HOUR_MS, 2 * longest * 1000);
}

async function discardRun(db: Db, runId: number): Promise<void> {
  await withTransaction(db, async (client) => {
    await client.query("DELETE FROM risk_events WHERE run_id = $1", [runId]);
    await client.query("DELETE FROM strategy_runs WHERE id = $1", [runId]);
  });
}

export async function runCohortBacktest(options: CohortBacktestOptions): Promise<CohortBacktestResult> {
  const keys = new Set<string>();
  for (const lane of options.lanes) {
    if (keys.has(lane.key)) {
      throw new Error(`duplicate cohort lane key ${lane.key}`);
    }
    keys.add(lane.key);
  }
  if (options.lanes.length === 0) {
    return { lanes: [], passes: [] };
  }
  const results = new Map<string, CohortLaneResult>();
  const passes: CohortPass[] = [];
  for (const group of groupCohortLanes(options.lanes, { splitHardBlocks: options.isolateLanes === false })) {
    const isolated = options.isolateLanes ?? group.length > 1;
    const outcome = await runPass(options, group, isolated);
    passes.push(outcome.pass);
    for (const result of outcome.results) {
      results.set(result.key, result);
    }
    for (const lane of outcome.diverged) {
      const reason = results.get(lane.key)?.fallback ?? "diverged";
      log.warn({ lane: lane.key, reason }, "cohort lane diverged from a standalone replay, replaying it alone");
      const alone = await runPass(options, [lane], false);
      passes.push(alone.pass);
      const result = alone.results[0];
      results.set(lane.key, { key: lane.key, result: result?.result ?? null, error: result?.error ?? null, fallback: reason });
    }
  }
  return {
    lanes: options.lanes.map((lane) => results.get(lane.key) ?? { key: lane.key, result: null, error: "lane was not replayed", fallback: null }),
    passes
  };
}

async function openRun(
  options: CohortBacktestOptions,
  spec: CohortLane,
  weights: SelectedWeights
): Promise<{ runId: number; store: ManagedTradingStore; ownsStore: boolean }> {
  const recordRejected = spec.recordRejectedSignals ?? options.recordRejectedSignals ?? true;
  const ownsStore = !spec.store;
  const store: ManagedTradingStore = spec.store ?? new PgTradingStore({ db: options.db, skipRejectedSignals: !recordRejected });
  const runId = await store.createRun({
    mode: "backtest",
    label: spec.label ?? null,
    config: {
      strategy: spec.config,
      backtest: {
        includeIncomplete: options.includeIncomplete ?? false,
        walkForward: options.walkForward ?? false,
        weightsFile: spec.weightsFile ?? null,
        weightsVersion: weights.model.version,
        weights: weights.provenance
      }
    },
    dataFrom: new Date(options.fromMs),
    dataTo: new Date(options.toMs)
  });
  await store.prepare?.();
  store.start?.();
  return { runId, store, ownsStore };
}

async function runPass(options: CohortBacktestOptions, specs: readonly CohortLane[], isolated: boolean): Promise<PassOutcome> {
  const { db, fromMs, toMs } = options;
  const first = specs[0];
  if (!first) {
    throw new Error("a cohort pass needs at least one lane");
  }
  const config = first.config;
  const pass: CohortPass = { lanes: specs.map((spec) => spec.key), events: 0, isolated, hiddenWhileHeld: 0 };
  const loader = new BacktestLoader({
    db,
    fromMs,
    toMs,
    includeIncomplete: options.includeIncomplete ?? false,
    tradeQuoteMints: config.signals.quoteMints,
    windowMs: options.windowMs,
    observation: options.observation
  });
  const weights = await selectBacktestWeights(db, {
    fromMs,
    weightsFile: first.weightsFile ?? null,
    explicit: options.model ?? null,
    allowInSample: options.allowInSampleWeights ?? false
  });
  for (const skipped of weights.skipped) {
    log.warn({ ...skipped, fromMs }, "skipping scorer weights fitted on data from the backtest window or later");
  }
  if (weights.provenance.inSample) {
    log.warn({ ...weights.provenance, fromMs }, "backtest scores with weights fitted on data from the backtest window or later: results are in-sample");
  }
  const results: CohortLaneResult[] = [];
  const opened: Array<{ spec: CohortLane; runId: number; store: ManagedTradingStore; ownsStore: boolean }> = [];
  for (const spec of specs) {
    try {
      opened.push({ spec, ...(await openRun(options, spec, weights)) });
    } catch (error) {
      log.error({ err: error, lane: spec.key }, "cohort lane could not start");
      results.push({ key: spec.key, result: null, error: messageOf(error), fallback: null });
    }
  }
  if (opened.length === 0) {
    return { results, diverged: [], pass };
  }
  const base = new VirtualClock(fromMs);
  const sharedClock: Clock = isolated ? new ScopedClock(base) : base;
  const sharedScoped = sharedClock instanceof ScopedClock ? sharedClock : null;
  const bus = new Bus();
  const market = createReplayMarket(config);
  const evictionWindow = evictionWindowOf(config.recorder.memory);
  const stored = new RollingStoredFeatures({
    db,
    fromMs,
    toMs,
    chunkMs: options.storedChunkMs,
    retentionMs: storedRetentionMs(opened.map((entry) => entry.spec))
  });
  const lanes: Lane[] = [];
  const detachShared: Array<() => void> = [];
  let scorer: ScorerModule | null = null;
  const stopAll = async (): Promise<void> => {
    for (const lane of lanes) {
      await stopLane(lane);
    }
    await scorer?.stop();
    for (const detach of detachShared) {
      detach();
    }
    detachShared.length = 0;
  };
  try {
    await stored.advanceTo(fromMs);
    scorer = createScorerModule({
      db,
      rpc: null,
      bus,
      market,
      clock: sharedClock,
      config: config.scorer,
      mode: "replay",
      storedFeatures: stored.lookup(),
      model: weights.model,
      weightsFile: null,
      persistScores: false
    });
    const sharedScorer = scorer;
    const registry = new TrackedWalletRegistry({ db, clock: sharedClock, refreshIntervalMs: REGISTRY_REFRESH_MS });
    let walkForwardRuns: number[] | null = null;
    if (options.walkForward) {
      const ranking = createTrackerModule({
        db,
        rpc: null,
        bus,
        market,
        clock: sharedClock,
        config,
        scores: sharedScorer.service,
        mode: "backtest",
        registry,
        backtestRange: { fromMs, toMs }
      });
      walkForwardRuns = await ranking.prepareWalkForward(fromMs, toMs);
      log.info({ runs: walkForwardRuns.length }, "walk-forward wallet rankings ready");
    }
    const scratch = isolated ? new TrendingTracker({ config: config.scorer }) : null;
    const cohortScoring = scratch
      ? new CohortScoring({ db, market, shared: sharedScorer.trending, scratch, stored: (mint, checkpointSec) => stored.get(mint, checkpointSec) })
      : null;
    for (const entry of opened) {
      const lane = createLane(entry, { options, base, isolated, market, registry, scorer: sharedScorer, cohortScoring, stored, weights });
      lane.rescore = isolated && !sameHardBlocks(entry.spec.config, config) ? hardBlockRescorer(sharedScorer, entry.spec.config.scorer.hardBlocks) : null;
      lanes.push(lane);
    }
    await sharedScorer.start();
    if (scratch) {
      await seedTrending(db, scratch, { nowMs: sharedClock.nowMs(), windowMinutes: config.scorer.copycat.trendingWindowMinutes }).catch((error: unknown) => {
        log.warn({ err: error }, "copycat trending seed failed for the cohort scratch tracker");
      });
      if (scratch.size !== sharedScorer.trending.size) {
        for (const lane of lanes) {
          lane.scoring?.diverge("the cohort copycat trackers were seeded differently");
        }
      }
      detachShared.push(scratch.attach(bus));
    }
    await registry.preloadRuns({ fromMs, toMs }, walkForwardRuns);
    registry.setAsOf(sharedClock.nowMs());
    detachShared.push(bus.on("chain", () => registry.setAsOf(sharedClock.nowMs())));
    detachShared.push(
      bus.on("chain", (event) => {
        for (const lane of lanes) {
          if (lane.running) {
            lane.bus.emit("chain", event);
          }
        }
      })
    );
    detachShared.push(
      bus.on("score", (score) => {
        cohortScoring?.onCheckpoint(score);
        for (const lane of lanes) {
          if (lane.running && lane.market.sees(score.mint)) {
            const own = lane.rescore ? lane.rescore(score) : score;
            lane.scoring?.remember(own);
            lane.bus.emit("score", own);
          }
        }
      })
    );
    detachShared.push(
      bus.on("gap", (gap) => {
        for (const lane of lanes) {
          if (lane.running) {
            lane.bus.emit("gap", gap);
          }
        }
      })
    );
    for (const lane of lanes) {
      await lane.tracker.start();
      lane.trader.start();
    }
    const evictEveryMs = options.evictEveryMs ?? MINUTE_MS;
    const progressEveryMs = options.progressEveryMs ?? 6 * HOUR_MS;
    const reportsProgress = lanes.some((lane) => lane.spec.onProgress);
    let events = 0;
    let lastEvictMs = fromMs;
    let lastProgressMs = fromMs;
    for await (const window of loader.windows()) {
      for (const replay of window) {
        const visibleAtMs = replay.visibleAtMs;
        if (stored.needsAdvance(visibleAtMs)) {
          await stored.advanceTo(visibleAtMs);
        }
        const due = base.nextDueMs();
        if (visibleAtMs > base.nowMs() || (due !== null && due <= visibleAtMs)) {
          await base.advanceTo(visibleAtMs);
        }
        applyReplayEvent(market, replay);
        scheduleIncomplete(sharedClock, market, replay);
        bus.emit("chain", replay.event);
        cohortScoring?.eventApplied();
        events += 1;
        for (const lane of lanes) {
          if (lane.running) {
            await lane.tracker.signals.idle();
          }
        }
        const nowMs = base.nowMs();
        if (nowMs - lastEvictMs >= evictEveryMs) {
          pass.hiddenWhileHeld += evictLaunches(market, lanes, nowMs, evictionWindow);
          await stopDivergedLanes(lanes);
          lastEvictMs = nowMs;
        }
        if (reportsProgress && nowMs - lastProgressMs >= progressEveryMs) {
          lastProgressMs = nowMs;
          reportProgress(lanes, { virtualNowMs: nowMs, fromMs, toMs, events });
        }
      }
    }
    pass.events = events;
    await base.advanceTo(toMs);
    await settleLanes(lanes, base, sharedScoped, toMs + (options.settleMs ?? MINUTE_MS));
  } catch (error) {
    await stopAll();
    for (const entry of opened) {
      await entry.store.stop?.().catch(() => undefined);
    }
    throw error;
  }
  await stopAll();
  const diverged: CohortLane[] = [];
  const sharedScorer = scorer;
  for (const lane of lanes) {
    lane.divergence ??= (await lane.scoring?.divergenceReason()) ?? null;
    if (lane.divergence !== null) {
      await lane.store.stop?.().catch(() => undefined);
      if (lane.ownsStore) {
        await discardRun(db, lane.runId).catch((error: unknown) => {
          log.warn({ err: error, runId: lane.runId }, "could not discard a diverged cohort run");
        });
      }
      diverged.push(lane.spec);
      results.push({ key: lane.spec.key, result: null, error: null, fallback: lane.divergence });
      continue;
    }
    try {
      const summary = laneSummary(lane, {
        fromMs,
        toMs,
        events: pass.events,
        loader,
        weights,
        weightsVersion: sharedScorer?.service.currentModel().version ?? weights.model.version,
        trackedVersion: lane.tracker.registry.version(),
        storedScoreLaunches: stored.size
      });
      await lane.store.finishRun(lane.runId, jsonSafe(summary));
      await lane.store.stop?.();
      results.push({ key: lane.spec.key, result: { runId: lane.runId, summary, closedTrades: lane.closedTrades }, error: null, fallback: null });
    } catch (error) {
      log.error({ err: error, lane: lane.spec.key }, "cohort lane could not finish");
      await lane.store.stop?.().catch(() => undefined);
      results.push({ key: lane.spec.key, result: null, error: messageOf(error), fallback: null });
    }
  }
  return { results, diverged, pass };
}

interface LaneContext {
  options: CohortBacktestOptions;
  base: VirtualClock;
  isolated: boolean;
  market: MarketState;
  registry: TrackedWalletRegistry;
  scorer: ScorerModule;
  cohortScoring: CohortScoring | null;
  stored: RollingStoredFeatures;
  weights: SelectedWeights;
}

function createLane(
  entry: { spec: CohortLane; runId: number; store: ManagedTradingStore; ownsStore: boolean },
  ctx: LaneContext
): Lane {
  const { spec, runId, store } = entry;
  const config = spec.config;
  const recordRejected = spec.recordRejectedSignals ?? ctx.options.recordRejectedSignals ?? true;
  const scopedClock = ctx.isolated ? new ScopedClock(ctx.base) : null;
  const clock: Clock = scopedClock ?? ctx.base;
  const bus = new Bus();
  const market = new LaneMarket(ctx.market, clock);
  const scoring = ctx.cohortScoring
    ? new LaneScoring({
        cohort: ctx.cohortScoring,
        market,
        clock,
        bus,
        config: config.scorer,
        model: ctx.weights.model,
        stored: (mint, checkpointSec) => ctx.stored.get(mint, checkpointSec)
      })
    : null;
  const scores: ScoreProvider = scoring ?? ctx.scorer.service;
  let trader: Trader | null = null;
  const tracker = createTrackerModule({
    db: ctx.options.db,
    rpc: null,
    bus,
    market,
    clock,
    config,
    scores,
    mode: "backtest",
    registry: ctx.registry,
    backtestRange: { fromMs: ctx.options.fromMs, toMs: ctx.options.toMs },
    onRejected: recordRejected ? (signal, reason) => trader?.recordRejection(signal, reason) : null
  });
  const risk = new RiskManager({ runId, config: config.risk, clock, mode: "backtest", store, bus });
  const executor = new PaperExecutor({ clock, market, config: config.execution, mode: "backtest" });
  const watcher = new ExitEventWatcher({
    market,
    creationWindowSlots: config.scorer.bundleSlotWindow,
    ...(scoring ? { extraInsiders: (mint: string) => scoring.extraInsiders(mint) } : {})
  });
  trader = new Trader({
    runId,
    mode: "backtest",
    clock,
    bus,
    market,
    executor,
    risk,
    exits: config.exits,
    execution: config.execution,
    watcher,
    store,
    smartExitCount: (mint, sinceMs) => tracker.signals.smartExitCount(mint, sinceMs),
    tradableQuoteMints: config.signals.quoteMints
  });
  const closedTrades: ClosedTrade[] = [];
  const detachClosed = bus.on("positionClosed", (position: Position) => {
    if (position.shadowOf === null) {
      closedTrades.push(closedTradeOf(position));
    }
  });
  return {
    spec,
    runId,
    label: spec.label ?? null,
    store,
    ownsStore: entry.ownsStore,
    clock,
    scopedClock,
    bus,
    market,
    scoring,
    tracker,
    risk,
    trader,
    closedTrades,
    detachClosed,
    rescore: null,
    running: true,
    stopped: false,
    closedAtEnd: 0,
    ending: null,
    divergence: null
  };
}

async function stopLane(lane: Lane): Promise<void> {
  lane.running = false;
  if (lane.stopped) {
    return;
  }
  lane.stopped = true;
  await lane.trader.stop();
  await lane.tracker.stop();
  lane.detachClosed();
  lane.scoring?.stop();
  lane.ending = {
    riskStatus: lane.risk.status(),
    traderStats: lane.trader.stats(),
    signalStats: lane.tracker.signals.stats()
  };
}

async function finishLane(lane: Lane): Promise<void> {
  await lane.tracker.signals.idle();
  lane.closedAtEnd = lane.trader.liquidateAll(BACKTEST_END_REASON);
  await stopLane(lane);
}

async function settleLanes(lanes: readonly Lane[], base: VirtualClock, shared: ScopedClock | null, deadlineMs: number): Promise<void> {
  let pending = lanes.filter((lane) => lane.running);
  for (;;) {
    const next: Lane[] = [];
    let target: number | null = null;
    for (const lane of pending) {
      const due = lane.scopedClock ? earliest(shared?.nextDueMs() ?? null, lane.scopedClock.nextDueMs()) : base.nextDueMs();
      if (lane.trader.inFlightCount() === 0 || due === null || due > deadlineMs) {
        await finishLane(lane);
      } else {
        next.push(lane);
        target = earliest(target, due);
      }
    }
    if (next.length === 0 || target === null) {
      return;
    }
    await base.advanceTo(target);
    pending = next;
  }
}

function evictLaunches(market: MarketState, lanes: readonly Lane[], nowMs: number, window: ReturnType<typeof evictionWindowOf>): number {
  let hiddenWhileHeld = 0;
  const evicted = market.evict(nowMs, (launch) => {
    if (!evictableAt(launch, nowMs, window)) {
      return false;
    }
    let held = false;
    let hidden = 0;
    for (const lane of lanes) {
      if (!lane.running || !lane.market.sees(launch.mint)) {
        continue;
      }
      if (lane.trader.hasOpenPosition(launch.mint)) {
        held = true;
      } else {
        lane.market.hide(launch.mint);
        hidden += 1;
      }
    }
    if (held) {
      hiddenWhileHeld += hidden;
    }
    return held;
  });
  for (const launch of evicted) {
    for (const lane of lanes) {
      lane.market.forget(launch.mint);
      lane.scoring?.forget(launch.mint);
    }
  }
  return hiddenWhileHeld;
}

async function stopDivergedLanes(lanes: readonly Lane[]): Promise<void> {
  for (const lane of lanes) {
    if (lane.running && lane.scoring && !lane.scoring.active()) {
      lane.divergence = (await lane.scoring.divergenceReason()) ?? "diverged";
      await stopLane(lane);
    }
  }
}

function reportProgress(lanes: readonly Lane[], at: Omit<BacktestProgress, "openPositions" | "closedTrades">): void {
  for (const lane of lanes) {
    const listener = lane.spec.onProgress;
    if (!listener || !lane.running) {
      continue;
    }
    listener({ ...at, openPositions: lane.trader.primaryPositions().length, closedTrades: lane.closedTrades.length });
  }
}

interface SummaryContext {
  fromMs: number;
  toMs: number;
  events: number;
  loader: BacktestLoader;
  weights: SelectedWeights;
  weightsVersion: string;
  trackedVersion: string;
  storedScoreLaunches: number;
}

function laneSummary(lane: Lane, ctx: SummaryContext): BacktestSummary {
  const ending = lane.ending;
  if (!ending) {
    throw new Error(`cohort lane ${lane.spec.key} ended without its final state`);
  }
  return buildSummary({
    runId: lane.runId,
    label: lane.label,
    fromMs: ctx.fromMs,
    toMs: ctx.toMs,
    closedTrades: lane.closedTrades,
    riskStatus: ending.riskStatus,
    loaderCounts: ctx.loader.stats(),
    events: ctx.events,
    closedAtEnd: lane.closedAtEnd,
    traderStats: ending.traderStats,
    signalStats: ending.signalStats,
    weightsVersion: ctx.weightsVersion,
    weights: ctx.weights.provenance,
    skippedWeights: ctx.weights.skipped,
    trackedVersion: ctx.trackedVersion,
    storedScoreLaunches: ctx.storedScoreLaunches
  });
}
