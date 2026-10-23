import { createHash } from "node:crypto";
import {
  allBreakdowns,
  describeSummary,
  summarizeTrades,
  type Breakdown,
  type Narrative,
  type TradeSummary
} from "../analytics/index.js";
import type { StrategyConfig } from "../config/strategy.js";
import { Bus } from "../core/bus.js";
import { VirtualClock } from "../core/clock.js";
import type { TradingStore } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { ClosedTrade, Position } from "../core/types.js";
import { jsonSafe, type Db } from "../db/pool.js";
import { PaperExecutor } from "../execution/paperExecutor.js";
import { marketDataSource } from "../execution/marketSource.js";
import { ExitEventWatcher } from "../exits/watcher.js";
import { MarketState } from "../market/state.js";
import { RiskManager } from "../risk/manager.js";
import { createScorerModule } from "../scorer/index.js";
import type { ScoringModel } from "../scorer/model.js";
import { createTrackerModule } from "../tracker/index.js";
import { closedTradeOf } from "../trader/accounting.js";
import { PgTradingStore } from "../trader/store.js";
import { Trader } from "../trader/trader.js";
import { applyReplayEvent, BacktestLoader, type LoaderCounts } from "./loader.js";
import { RollingStoredFeatures } from "./storedScores.js";

const log = moduleLogger("backtest");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export const BACKTEST_END_REASON = "backtest_end";

export interface ManagedTradingStore extends TradingStore {
  start?(): void;
  stop?(): Promise<void>;
  prepare?(): Promise<void>;
}

export interface BacktestProgress {
  virtualNowMs: number;
  fromMs: number;
  toMs: number;
  events: number;
  openPositions: number;
  closedTrades: number;
}

export interface BacktestOptions {
  db: Db;
  fromMs: number;
  toMs: number;
  config: StrategyConfig;
  label?: string | null;
  includeIncomplete?: boolean;
  walkForward?: boolean;
  model?: ScoringModel | null;
  weightsFile?: string | null;
  windowMs?: number;
  storedChunkMs?: number;
  settleMs?: number;
  evictEveryMs?: number;
  recordRejectedSignals?: boolean;
  store?: ManagedTradingStore | null;
  onProgress?: ((progress: BacktestProgress) => void) | null;
  progressEveryMs?: number;
}

export interface BacktestCounts extends LoaderCounts {
  events: number;
  signalsAccepted: number;
  signalsRejected: number;
  traderSignals: number;
  entriesAttempted: number;
  entriesFilled: number;
  entriesFailed: number;
  skipped: number;
  rejectedByRisk: number;
  closedTrades: number;
  closedAtEnd: number;
  storedScoreLaunches: number;
}

export interface BacktestSummary {
  runId: number;
  label: string | null;
  fromMs: number;
  toMs: number;
  weightsVersion: string;
  trackedVersionAtEnd: string;
  counts: BacktestCounts;
  exitReasons: Record<string, number>;
  risk: {
    killed: boolean;
    killReason: string | null;
    haltedForDay: boolean;
    realizedPnlLamports: bigint;
    peakEquityLamports: bigint;
    equityLamports: bigint;
  };
  trades: TradeSummary;
  breakdowns: Breakdown[];
  narrative: Narrative;
  fingerprint: string;
}

export interface BacktestResult {
  runId: number;
  summary: BacktestSummary;
  closedTrades: ClosedTrade[];
}

export function tradeFingerprint(trades: readonly ClosedTrade[]): string {
  const hash = createHash("sha256");
  for (const trade of trades) {
    hash.update(
      [
        trade.mint,
        trade.signalType,
        trade.openedAtMs,
        trade.closedAtMs,
        trade.cost.toString(),
        trade.proceeds.toString(),
        trade.fees.toString(),
        trade.exitReason,
        trade.riskScore ?? "null"
      ].join("|")
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function countExitReasons(trades: readonly ClosedTrade[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trade of trades) {
    counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1;
  }
  return counts;
}

function createBacktestMarket(config: StrategyConfig): MarketState {
  const memory = config.recorder.memory;
  return new MarketState({
    maxTradesPerLaunch: memory.maxTradesPerLaunch,
    evictInactiveMs: memory.evictInactiveMinutes * MINUTE_MS,
    evictMaxAgeMs: memory.evictMaxAgeHours * HOUR_MS,
    quoteMints: config.signals.quoteMints
  });
}

export async function runBacktest(options: BacktestOptions): Promise<BacktestResult> {
  const { db, config, fromMs, toMs } = options;
  const label = options.label ?? null;
  const store: ManagedTradingStore = options.store ?? new PgTradingStore({ db });
  const loader = new BacktestLoader({
    db,
    fromMs,
    toMs,
    includeIncomplete: options.includeIncomplete ?? false,
    tradeQuoteMints: config.signals.quoteMints,
    windowMs: options.windowMs
  });
  const runId = await store.createRun({
    mode: "backtest",
    label,
    config: {
      strategy: config,
      backtest: {
        includeIncomplete: options.includeIncomplete ?? false,
        walkForward: options.walkForward ?? false,
        weightsFile: options.weightsFile ?? null,
        weightsVersion: options.model?.version ?? null
      }
    },
    dataFrom: new Date(fromMs),
    dataTo: new Date(toMs)
  });
  await store.prepare?.();
  store.start?.();
  const clock = new VirtualClock(fromMs);
  const bus = new Bus();
  const market = createBacktestMarket(config);
  const source = marketDataSource(market, clock);
  const stored = new RollingStoredFeatures({
    db,
    fromMs,
    toMs,
    chunkMs: options.storedChunkMs,
    retentionMs: Math.max(2 * HOUR_MS, 2 * config.tracker.convergence.maxLaunchAgeSec * 1000)
  });
  await stored.advanceTo(fromMs);
  const scorer = createScorerModule({
    db,
    rpc: null,
    bus,
    market,
    clock,
    config: config.scorer,
    mode: "replay",
    storedFeatures: stored.lookup(),
    model: options.model ?? null,
    weightsFile: options.weightsFile ?? null,
    persistScores: false
  });
  let trader: Trader | null = null;
  const recordRejected = options.recordRejectedSignals ?? true;
  const tracker = createTrackerModule({
    db,
    rpc: null,
    bus,
    market,
    clock,
    config,
    scores: scorer.service,
    mode: "backtest",
    backtestRange: { fromMs, toMs },
    onRejected: recordRejected ? (signal, reason) => trader?.recordRejection(signal, reason) : null
  });
  if (options.walkForward) {
    const runs = await tracker.prepareWalkForward(fromMs, toMs);
    log.info({ runs: runs.length }, "walk-forward wallet rankings ready");
  }
  const risk = new RiskManager({ runId, config: config.risk, clock, mode: "backtest", store, bus });
  const executor = new PaperExecutor({ clock, market: source, config: config.execution, mode: "backtest" });
  const watcher = new ExitEventWatcher({ market: source, creationWindowSlots: config.scorer.bundleSlotWindow });
  trader = new Trader({
    runId,
    mode: "backtest",
    clock,
    bus,
    market: source,
    executor,
    risk,
    exits: config.exits,
    execution: config.execution,
    watcher,
    store,
    smartExitCount: (mint, sinceMs) => tracker.signals.smartExitCount(mint, sinceMs),
    tradableQuoteMints: config.signals.quoteMints
  });
  const activeTrader = trader;
  const closedTrades: ClosedTrade[] = [];
  const detachClosed = bus.on("positionClosed", (position: Position) => {
    if (position.shadowOf === null) {
      closedTrades.push(closedTradeOf(position));
    }
  });
  await scorer.start();
  await tracker.start();
  activeTrader.start();
  const stopComponents = async (): Promise<void> => {
    await activeTrader.stop();
    await tracker.stop();
    await scorer.stop();
    detachClosed();
  };
  let events = 0;
  let closedAtEnd = 0;
  try {
    const evictEveryMs = options.evictEveryMs ?? MINUTE_MS;
    const progressEveryMs = options.progressEveryMs ?? 6 * HOUR_MS;
    let lastEvictMs = fromMs;
    let lastProgressMs = fromMs;
    for await (const window of loader.windows()) {
      for (const replay of window) {
        if (stored.needsAdvance(replay.atMs)) {
          await stored.advanceTo(replay.atMs);
        }
        const due = clock.nextDueMs();
        if (replay.atMs > clock.nowMs() || (due !== null && due <= replay.atMs)) {
          await clock.advanceTo(replay.atMs);
        }
        applyReplayEvent(market, replay);
        bus.emit("chain", replay.event);
        events += 1;
        await tracker.signals.idle();
        if (replay.atMs - lastEvictMs >= evictEveryMs) {
          market.evict(clock.nowMs(), (launch) => activeTrader.hasOpenPosition(launch.mint));
          lastEvictMs = replay.atMs;
        }
        if (options.onProgress && replay.atMs - lastProgressMs >= progressEveryMs) {
          lastProgressMs = replay.atMs;
          options.onProgress({
            virtualNowMs: clock.nowMs(),
            fromMs,
            toMs,
            events,
            openPositions: activeTrader.primaryPositions().length,
            closedTrades: closedTrades.length
          });
        }
      }
    }
    await clock.advanceTo(toMs);
    await settleOrders(clock, activeTrader, toMs + (options.settleMs ?? MINUTE_MS));
    await tracker.signals.idle();
    closedAtEnd = activeTrader.liquidateAll(BACKTEST_END_REASON);
  } catch (error) {
    await stopComponents();
    await store.stop?.().catch(() => undefined);
    throw error;
  }
  await stopComponents();
  const summary = buildSummary({
    runId,
    label,
    fromMs,
    toMs,
    closedTrades,
    risk,
    loaderCounts: loader.stats(),
    events,
    closedAtEnd,
    trader: activeTrader,
    signalStats: tracker.signals.stats(),
    weightsVersion: scorer.service.currentModel().version,
    trackedVersion: tracker.registry.version(),
    storedScoreLaunches: stored.size
  });
  await store.finishRun(runId, jsonSafe(summary));
  await store.stop?.();
  return { runId, summary, closedTrades };
}

async function settleOrders(clock: VirtualClock, trader: Trader, deadlineMs: number): Promise<void> {
  while (trader.inFlightCount() > 0) {
    const due = clock.nextDueMs();
    if (due === null || due > deadlineMs) {
      break;
    }
    await clock.advanceTo(due);
  }
}

interface SummaryInput {
  runId: number;
  label: string | null;
  fromMs: number;
  toMs: number;
  closedTrades: ClosedTrade[];
  risk: RiskManager;
  loaderCounts: LoaderCounts;
  events: number;
  closedAtEnd: number;
  trader: Trader;
  signalStats: { accepted: number; rejected: number };
  weightsVersion: string;
  trackedVersion: string;
  storedScoreLaunches: number;
}

function buildSummary(input: SummaryInput): BacktestSummary {
  const trades = summarizeTrades(input.closedTrades);
  const traderStats = input.trader.stats();
  const status = input.risk.status();
  return {
    runId: input.runId,
    label: input.label,
    fromMs: input.fromMs,
    toMs: input.toMs,
    weightsVersion: input.weightsVersion,
    trackedVersionAtEnd: input.trackedVersion,
    counts: {
      ...input.loaderCounts,
      events: input.events,
      signalsAccepted: input.signalStats.accepted,
      signalsRejected: input.signalStats.rejected,
      traderSignals: traderStats.signals,
      entriesAttempted: traderStats.entriesAttempted,
      entriesFilled: traderStats.entriesFilled,
      entriesFailed: traderStats.entriesFailed,
      skipped: traderStats.skipped,
      rejectedByRisk: traderStats.rejectedByRisk,
      closedTrades: input.closedTrades.length,
      closedAtEnd: input.closedAtEnd,
      storedScoreLaunches: input.storedScoreLaunches
    },
    exitReasons: countExitReasons(input.closedTrades),
    risk: {
      killed: status.killed,
      killReason: status.killReason,
      haltedForDay: status.haltedForDay,
      realizedPnlLamports: status.realizedPnlLamports,
      peakEquityLamports: status.peakEquityLamports,
      equityLamports: status.equityLamports
    },
    trades,
    breakdowns: allBreakdowns(input.closedTrades),
    narrative: describeSummary(trades),
    fingerprint: tradeFingerprint(input.closedTrades)
  };
}
