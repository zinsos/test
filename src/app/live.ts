import {
  entryRulesOf,
  latestSkipReason,
  LiveHub,
  sellFeeDefaultsOf,
  SolPriceFeed,
  startAnalyticsServer,
  thresholdsOf,
  type TradingControls,
  type WalletSnapshot
} from "../analytics/index.js";
import { createRpcKeyControls } from "./rpcKey.js";
import type { RpcClient } from "../chain/rpc.js";
import type { Env, ModuleName } from "../config/env.js";
import type { StrategyConfig } from "../config/strategy.js";
import { Bus } from "../core/bus.js";
import { SystemClock, type Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Signal } from "../core/types.js";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/pool.js";
import { waitForDatabase } from "../db/wait.js";
import { createIngestModule, type IngestModule, type StreamSource } from "../ingest/index.js";
import type { MarketState } from "../market/state.js";
import { createRecorderModule, type RecorderModule } from "../recorder/index.js";
import type { RiskManager } from "../risk/manager.js";
import { createScorerModule, type ScorerModule } from "../scorer/index.js";
import { createTrackerModule, TrackedWalletRegistry, type TrackerModule } from "../tracker/index.js";
import type { Trader } from "../trader/trader.js";
import { createMarket, createRpc, openDatabase } from "./context.js";
import { startHealthServer } from "./health.js";
import { Repeater } from "./repeater.js";
import {
  createSignalObserver,
  createSweeper,
  createTrading,
  tradingLockName,
  tradingModeOf,
  tradingRepeaters,
  type SignalObserver,
  type TradingParts
} from "./trading.js";
import { TradingLock } from "./tradingLock.js";

const log = moduleLogger("app");
const MINUTE_MS = 60_000;
const MIN_DASHBOARD_TOKEN_LENGTH = 24;
const SKIP_REASON_LOOKBACK_MS = 1_000;
const PLACEHOLDER_DASHBOARD_TOKEN = "change-me-to-a-long-random-string";


const RPC_KEY_RESTART_DELAY_MS = 1_000;

function walletSnapshotOf(parts: TradingParts): WalletSnapshot {
  const status = parts.risk.status();
  return {
    mode: parts.mode,
    address: parts.live?.wallet ?? null,
    walletLamports: parts.live ? parts.risk.availableBalanceLamports() : null,
    equityLamports: status.equityLamports,
    entriesPaused: status.killed,
    killReason: status.killReason,
    haltedForDay: status.haltedForDay
  };
}

function tradingControlsOf(parts: () => TradingParts | null): TradingControls {
  return {
    closeAll: (reason) => parts()?.trader.closeAll(reason) ?? null,
    resume: (reason) => {
      const current = parts();
      return current ? current.trader.resumeEntries(reason) : null;
    }
  };
}

export function dashboardTokenProblem(token: string | undefined): string | null {
  const value = token?.trim() ?? "";
  if (value.length === 0) {
    return "DASHBOARD_TOKEN is not set";
  }
  if (value === PLACEHOLDER_DASHBOARD_TOKEN) {
    return "DASHBOARD_TOKEN is still the .env.example placeholder";
  }
  if (value.length < MIN_DASHBOARD_TOKEN_LENGTH) {
    return `DASHBOARD_TOKEN is shorter than ${MIN_DASHBOARD_TOKEN_LENGTH} characters`;
  }
  return null;
}

export function fetchesWalletIntel(modules: ReadonlySet<ModuleName>): boolean {
  return modules.has("recorder") || modules.has("scorer");
}

export interface LiveAppOptions {
  env: Env;
  config: StrategyConfig;
  clock?: Clock;
  db?: Db;
  rpc?: RpcClient | null;
  source?: StreamSource;
  port?: number;
  migrate?: boolean;
  healthIntervalMs?: number;
  evictIntervalMs?: number;
  balanceIntervalMs?: number;
  killResetPollMs?: number;
  lockRetryMs?: number;
  databaseWaitMs?: number;
  allowOpenDashboard?: boolean;
  abort?: () => boolean;
}

export interface LiveApp {
  readonly modules: ReadonlySet<ModuleName>;
  readonly bus: Bus;
  readonly market: MarketState;
  readonly ingest: IngestModule | null;
  readonly recorder: RecorderModule | null;
  readonly scorer: ScorerModule | null;
  readonly tracker: TrackerModule | null;
  readonly trader: Trader | null;
  readonly risk: RiskManager | null;
  readonly runId: number | null;
  readonly httpPort: number;
  readonly done: Promise<string>;
  stats(): Record<string, unknown>;
  stop(reason?: string): Promise<void>;
}

interface Stoppable {
  name: string;
  stop: () => Promise<void> | void;
}

const SHUTDOWN_ORDER = [
  "ingest",
  "repeater",
  "sweeper",
  "trader",
  "tracker",
  "registry",
  "scorer",
  "recorder",
  "signal-observer",
  "trading-store",
  "trading-lock",
  "http"
];

function pick(source: Record<string, number> | undefined, keys: readonly string[]): Record<string, number> {
  const picked: Record<string, number> = {};
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
}

function lamportsToSol(value: bigint): number {
  return Math.round((Number(value) / 1e9) * 10_000) / 10_000;
}

async function shutdown(stoppables: readonly Stoppable[], reason: string, db: Db | null): Promise<void> {
  log.info({ reason }, "shutting down");
  const ordered = [...stoppables].sort((a, b) => SHUTDOWN_ORDER.indexOf(a.name) - SHUTDOWN_ORDER.indexOf(b.name));
  for (const item of ordered) {
    try {
      await item.stop();
    } catch (error) {
      log.error({ err: error, component: item.name }, "shutdown step failed");
    }
  }
  if (db) {
    await db.end().catch((error: unknown) => log.error({ err: error }, "database close failed"));
  }
  log.info({ reason }, "shutdown complete");
}

interface Components {
  recorder: RecorderModule | null;
  scorer: ScorerModule | null;
  tracker: TrackerModule | null;
  ownRegistry: TrackedWalletRegistry | null;
}

function createComponents(
  options: LiveAppOptions,
  shared: { db: Db; bus: Bus; market: MarketState; clock: Clock; rpc: RpcClient | null },
  modules: ReadonlySet<ModuleName>,
  onRejected: (signal: Signal, reason: string) => void
): Components {
  const { env, config } = options;
  const { db, bus, market, clock, rpc } = shared;
  const trading = modules.has("trader");
  const recorder = modules.has("recorder") ? createRecorderModule({ db, rpc, bus, market, clock, config, env }) : null;
  const scorer =
    modules.has("scorer") || modules.has("tracker") || trading
      ? createScorerModule({
          db,
          rpc,
          bus,
          market,
          clock,
          config: config.scorer,
          mode: "live",
          intelMode: fetchesWalletIntel(modules) ? "fetch" : "stored",
          persistScores: modules.has("scorer")
        })
      : null;
  if (!scorer) {
    return { recorder, scorer, tracker: null, ownRegistry: null };
  }
  if (modules.has("tracker")) {
    const tracker = createTrackerModule({ db, rpc, bus, market, clock, config, scores: scorer.service, mode: "live", onRejected });
    return { recorder, scorer, tracker, ownRegistry: null };
  }
  if (!trading) {
    return { recorder, scorer, tracker: null, ownRegistry: null };
  }
  const ownRegistry = new TrackedWalletRegistry({ db, clock });
  const tracker = createTrackerModule({
    db: null,
    rpc: null,
    bus,
    market,
    clock,
    config,
    scores: scorer.service,
    mode: "live",
    registry: ownRegistry,
    onRejected
  });
  return { recorder, scorer, tracker, ownRegistry };
}

export async function startLiveApp(options: LiveAppOptions): Promise<LiveApp> {
  const { env, config } = options;
  const modules: ReadonlySet<ModuleName> = new Set<ModuleName>(env.MODULES);
  const clock = options.clock ?? new SystemClock();
  const startedAtMs = clock.nowMs();
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase(env, `snypra-edge:${[...modules].join("+")}`);
  const stoppables: Stoppable[] = [];
  let stopping: Promise<void> | null = null;
  let resolveDone: (reason: string) => void = () => undefined;
  const done = new Promise<string>((resolve) => {
    resolveDone = resolve;
  });
  const stop = (reason = "stop"): Promise<void> => {
    stopping ??= shutdown(stoppables, reason, ownsDb ? db : null);
    return stopping;
  };
  try {
    const allowOpenDashboard = options.allowOpenDashboard ?? env.DASHBOARD_ALLOW_OPEN;
    const tokenProblem = modules.has("dashboard") ? dashboardTokenProblem(env.DASHBOARD_TOKEN) : null;
    if (tokenProblem && !allowOpenDashboard) {
      throw new Error(`${tokenProblem}: set a long random DASHBOARD_TOKEN before serving the dashboard, it exposes trades, positions and wallets`);
    }
    if (tokenProblem) {
      log.warn({ problem: tokenProblem }, "DASHBOARD_ALLOW_OPEN is on: the dashboard API is served without a strong token");
    }
    await waitForDatabase(db, {
      clock,
      abort: () => stopping !== null || (options.abort?.() ?? false),
      maxWaitMs: options.databaseWaitMs
    });
    if (options.migrate ?? true) {
      const applied = await runMigrations(db);
      if (applied.length > 0) {
        log.info({ applied }, "migrations applied");
      }
    }
    const bus = new Bus();
    const market = createMarket(config, modules.has("recorder") ? null : config.signals.quoteMints);
    const rpc = options.rpc !== undefined ? options.rpc : createRpc(env);
    if (!rpc && (modules.has("recorder") || modules.has("scorer") || modules.has("tracker"))) {
      log.warn("RPC_HTTP_URL is not set: wallet intel, RPC holder snapshots and wallet backfills are off");
    }
    if (rpc && !fetchesWalletIntel(modules) && modules.has("trader")) {
      log.info("this service reads wallet intel stored by the recorder/scorer service and makes no wallet-intel RPC calls");
    }
    let tradingParts: TradingParts | null = null;
    let observer: SignalObserver | null = null;
    const onRejected = (signal: Signal, reason: string): void => {
      if (tradingParts) {
        tradingParts.trader.recordRejection(signal, reason);
      } else {
        observer?.record(signal, reason);
      }
    };
    const { recorder, scorer, tracker, ownRegistry } = createComponents(options, { db, bus, market, clock, rpc }, modules, onRejected);
    const streaming = recorder !== null || scorer !== null || tracker !== null;
    const ingest = streaming ? createIngestModule({ env, clock, market, bus, poolLookup: recorder?.poolLookup, source: options.source }) : null;
    const statsSnapshot = (): Record<string, unknown> => {
      const ingestStats = ingest?.stats();
      const status = tradingParts?.risk.status();
      return {
        modules: [...modules],
        uptimeSec: Math.round((clock.nowMs() - startedAtMs) / 1000),
        rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
        market: { launches: market.size, latestSlot: market.latestSlot },
        stream: ingestStats ? pick(ingestStats.source, ["connected", "reconnects", "stalls", "gaps", "events", "lagMs", "msSinceLastNotification"]) : null,
        pipeline: ingestStats ? pick(ingestStats.pipeline, ["emitted", "notInMemory", "unresolvedPoolTrades", "applyErrors", "processingLagMs"]) : null,
        recorder: recorder ? pick(recorder.stats().recorder, ["launchesInserted", "tradesRecorded", "tradesDropped", "tradesBuffered", "pendingLaunches"]) : null,
        signals: tracker ? tracker.signals.stats() : null,
        trader: tradingParts ? tradingParts.trader.stats() : null,
        risk: status
          ? {
              runId: status.runId,
              equitySol: lamportsToSol(status.equityLamports),
              realizedSol: lamportsToSol(status.realizedPnlLamports),
              daySol: lamportsToSol(status.dayPnlLamports),
              halted: status.haltedForDay,
              killed: status.killed
            }
          : null
      };
    };
    const port = options.port ?? env.PORT;
    const ready = recorder ? () => (ingest?.pipeline.stats().batches ?? 0) > 0 : undefined;
    const liveHub = modules.has("dashboard")
      ? new LiveHub({
          bus,
          clock,
          market,
          config: { exits: config.exits, execution: config.execution },
          thresholds: thresholdsOf(config),
          positions: () => tradingParts?.trader.openPositions() ?? [],
          tradingActive: () => tradingParts?.trader.isRunning() ?? false,
          skipReason: (signal) =>
            tradingParts ? latestSkipReason(db, tradingParts.runId, signal.mint, signal.atMs - SKIP_REASON_LOOKBACK_MS) : Promise.resolve(null)
        })
      : null;
    liveHub?.start();
    const http = modules.has("dashboard")
      ? await startAnalyticsServer({
          db,
          port,
          host: env.HOST,
          token: env.DASHBOARD_TOKEN ?? null,
          allowOpen: allowOpenDashboard,
          ready,
          clock,
          scoreLookup: scorer ? (mint) => scorer.service.latest(mint) : null,
          extraHealth: () => statsSnapshot(),
          settings: {
            maxRisk: config.scorer.maxRisk,
            labelHorizonHours: config.recorder.outcome.finalizeAfterHours,
            sellFees: sellFeeDefaultsOf(config.execution),
            entryRules: entryRulesOf(config),
            dayResetUtcHour: config.risk.dayResetUtcHour
          },
          live: liveHub,
          price: new SolPriceFeed({ clock }),
          wallet: () => (tradingParts ? walletSnapshotOf(tradingParts) : null),
          trading: tradingControlsOf(() => tradingParts),
          marketData: ingest
            ? () => {
                const source = ingest.stats().source;
                if (!source) {
                  return null;
                }
                return {
                  connected: Number(source.connected) === 1,
                  lastDataAgoMs: typeof source.msSinceLastNotification === "number" && source.msSinceLastNotification >= 0 ? source.msSinceLastNotification : null
                };
              }
            : null,
          rpcKey: createRpcKeyControls({
            envFile: env.ENV_FILE ?? null,
            currentHttpUrl: env.RPC_HTTP_URL,
            restart: () => {
              clock.schedule(clock.nowMs() + RPC_KEY_RESTART_DELAY_MS, () => {
                process.kill(process.pid, "SIGTERM");
              });
            }
          })
        })
      : await startHealthServer({
          db,
          port,
          host: env.HOST,
          startedAtMs,
          nowMs: () => clock.nowMs(),
          ready
        });
    stoppables.push({
      name: "http",
      stop: async () => {
        await http.close();
        liveHub?.stop();
      }
    });

    if (modules.has("trader") && tracker) {
      const lock = new TradingLock({
        db,
        name: tradingLockName(tradingModeOf(env)),
        clock,
        retryMs: options.lockRetryMs,
        onLost: () => {
          tradingParts?.trader.halt();
          resolveDone("trading lock lost");
        }
      });
      stoppables.push({ name: "trading-lock", stop: () => lock.release() });
      if (!(await lock.acquire(() => stopping !== null || (options.abort?.() ?? false)))) {
        throw new Error("stopped before the trading lock was acquired");
      }
      tradingParts = await createTrading(env, config, { db, bus, market, clock, tracker });
      const store = tradingParts.store;
      stoppables.push({ name: "trading-store", stop: () => store.stop() });
    } else if (tracker) {
      const activeObserver = createSignalObserver(db, bus, market);
      observer = activeObserver;
      await activeObserver.store.prepare();
      activeObserver.store.start();
      stoppables.push({
        name: "signal-observer",
        stop: async () => {
          activeObserver.detach();
          await activeObserver.store.stop();
        }
      });
    }

    if (recorder) {
      await recorder.start();
      stoppables.push({ name: "recorder", stop: () => recorder.stop() });
    }
    if (scorer) {
      await scorer.start();
      stoppables.push({ name: "scorer", stop: () => scorer.stop() });
    }
    if (ownRegistry) {
      await ownRegistry.load(clock.nowMs());
      ownRegistry.startAutoRefresh();
      stoppables.push({ name: "registry", stop: () => ownRegistry.stop() });
    }
    if (tracker) {
      await tracker.start();
      stoppables.push({ name: "tracker", stop: () => tracker.stop() });
    }
    const repeaters: Repeater[] = [
      new Repeater({
        clock,
        name: "evict",
        intervalMs: options.evictIntervalMs ?? MINUTE_MS,
        run: () => {
          const evicted = market.evict(clock.nowMs(), (launch) => tradingParts?.trader.hasOpenPosition(launch.mint) ?? false);
          if (evicted.length > 0) {
            log.debug({ evicted: evicted.length, remaining: market.size }, "market launches evicted");
          }
        }
      }),
      new Repeater({
        clock,
        name: "health",
        intervalMs: options.healthIntervalMs ?? MINUTE_MS,
        run: () => {
          log.info(statsSnapshot(), "health");
        }
      })
    ];
    if (tradingParts) {
      const parts = tradingParts;
      parts.trader.start();
      stoppables.push({ name: "trader", stop: () => parts.trader.stop() });
      repeaters.push(...(await tradingRepeaters(parts, db, clock, options)));
      const sweeper = createSweeper(env, config, parts, db, clock);
      if (sweeper) {
        sweeper.start();
        stoppables.push({ name: "sweeper", stop: () => sweeper.stop() });
      }
    }
    for (const repeater of repeaters) {
      repeater.start();
      stoppables.push({ name: "repeater", stop: () => repeater.stop() });
    }
    if (ingest) {
      await ingest.start();
      stoppables.push({ name: "ingest", stop: () => ingest.stop() });
    }
    log.info({ modules: [...modules], port: http.port, tradingMode: tradingParts?.mode ?? null, runId: tradingParts?.runId ?? null }, "snypra-edge started");
    return {
      modules,
      bus,
      market,
      ingest,
      recorder,
      scorer,
      tracker,
      trader: tradingParts?.trader ?? null,
      risk: tradingParts?.risk ?? null,
      runId: tradingParts?.runId ?? null,
      httpPort: http.port,
      done,
      stats: statsSnapshot,
      stop
    };
  } catch (error) {
    await stop("startup failed");
    throw error;
  }
}
