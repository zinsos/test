import { Connection, PublicKey } from "@solana/web3.js";
import { hydrateLaunches } from "../backtest/loader.js";
import { requireEnv, type Env } from "../config/env.js";
import { tradingRunConfig, type StrategyConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock } from "../core/clock.js";
import type { Executor } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { Signal, TradingMode } from "../core/types.js";
import type { Db } from "../db/pool.js";
import { loadKeypair } from "../execution/keys.js";
import { LiveExecutor } from "../execution/liveExecutor.js";
import { marketDataSource } from "../execution/marketSource.js";
import { PaperExecutor } from "../execution/paperExecutor.js";
import { ExitEventWatcher } from "../exits/watcher.js";
import type { MarketState } from "../market/state.js";
import { RiskManager } from "../risk/manager.js";
import { loadRiskState } from "../risk/persistence.js";
import { HotColdSweeper } from "../risk/sweeper.js";
import type { TrackerModule } from "../tracker/index.js";
import { killResetRequestsAfter, latestKillResetRequestId, loadOpenPositions, resumeOrCreateRun } from "../trader/runs.js";
import { PgTradingStore } from "../trader/store.js";
import { Trader } from "../trader/trader.js";
import { Repeater } from "./repeater.js";

const log = moduleLogger("app.trading");

export interface TradingParts {
  trader: Trader;
  risk: RiskManager;
  store: PgTradingStore;
  runId: number;
  mode: TradingMode;
  live: LiveExecutor | null;
  connection: Connection | null;
}

export interface TradingShared {
  db: Db;
  bus: Bus;
  market: MarketState;
  clock: Clock;
  tracker: TrackerModule;
}

export function tradingModeOf(env: Pick<Env, "TRADING_MODE">): TradingMode {
  return env.TRADING_MODE === "live" ? "live" : "paper";
}

export function tradingLockName(mode: TradingMode): string {
  return `snypra-edge:trader:${mode}`;
}

function createLiveExecutor(env: Env, config: StrategyConfig, clock: Clock, market: MarketState): { live: LiveExecutor; connection: Connection } {
  const connection = new Connection(requireEnv(env, "RPC_HTTP_URL"), { commitment: "confirmed" });
  const live = new LiveExecutor({
    connection,
    keypair: loadKeypair(requireEnv(env, "HOT_WALLET_SECRET_KEY")),
    config: config.execution,
    dryRun: env.LIVE_DRY_RUN,
    clock,
    market: marketDataSource(market, clock),
    jitoEndpoint: env.JITO_BLOCK_ENGINE_URL && env.JITO_BLOCK_ENGINE_URL.length > 0 ? env.JITO_BLOCK_ENGINE_URL : null
  });
  log.warn(
    { wallet: live.wallet, dryRun: env.LIVE_DRY_RUN },
    env.LIVE_DRY_RUN ? "LIVE DRY RUN: transactions are simulated, never sent" : "LIVE TRADING ENABLED"
  );
  return { live, connection };
}

export async function createTrading(env: Env, config: StrategyConfig, shared: TradingShared): Promise<TradingParts> {
  const { db, bus, market, clock, tracker } = shared;
  const mode = tradingModeOf(env);
  const source = marketDataSource(market, clock);
  const store = new PgTradingStore({ db });
  await store.prepare();
  store.start();
  const label = mode === "live" && env.LIVE_DRY_RUN ? "live-dry-run" : null;
  const run = await resumeOrCreateRun(db, store, { mode, label, config: tradingRunConfig(config) });
  if (run.configChanged) {
    log.warn(
      { runId: run.runId },
      "strategy config differs from the one this run started with; results before and after the change are mixed in this run"
    );
  }
  const persisted = await loadRiskState(db, run.runId);
  const risk = new RiskManager({ runId: run.runId, config: config.risk, clock, mode, store, persisted, bus });
  const liveParts = mode === "live" ? createLiveExecutor(env, config, clock, market) : null;
  const executor: Executor = liveParts?.live ?? new PaperExecutor({ clock, market: source, config: config.execution, mode: "paper" });
  const shadowExecutor = liveParts ? new PaperExecutor({ clock, market: source, config: config.execution, mode: "shadow" }) : null;
  const live = liveParts?.live ?? null;
  const watcher = new ExitEventWatcher({
    market: source,
    creationWindowSlots: config.scorer.bundleSlotWindow,
    excludeWallets: live ? [live.wallet] : []
  });
  const trader = new Trader({
    runId: run.runId,
    mode,
    clock,
    bus,
    market: source,
    executor,
    shadowExecutor,
    risk,
    exits: config.exits,
    execution: config.execution,
    watcher,
    store,
    smartExitCount: (mint, sinceMs) => tracker.signals.smartExitCount(mint, sinceMs),
    reconcile: live ? (order, signature) => live.reconcile(order, signature) : null,
    tradableQuoteMints: config.signals.quoteMints
  });
  const open = await loadOpenPositions(db, run.runId);
  if (open.length > 0) {
    const hydrated = await hydrateLaunches(db, market, open.map((position) => position.mint));
    log.info({ open: open.length, hydrated }, "restoring open positions");
  }
  trader.restore(open);
  log.info({ runId: run.runId, mode, resumed: run.resumed, restored: open.length }, "trader ready");
  return { trader, risk, store, runId: run.runId, mode, live, connection: liveParts?.connection ?? null };
}

export interface TradingTimerOptions {
  killResetPollMs?: number;
  balanceIntervalMs?: number;
}

export async function tradingRepeaters(parts: TradingParts, db: Db, clock: Clock, options: TradingTimerOptions): Promise<Repeater[]> {
  let lastResetId = await latestKillResetRequestId(db, parts.runId);
  const repeaters = [
    new Repeater({
      clock,
      name: "kill-reset",
      intervalMs: options.killResetPollMs ?? 30_000,
      run: async () => {
        for (const request of await killResetRequestsAfter(db, parts.runId, lastResetId)) {
          lastResetId = request.id;
          parts.risk.resetKill(`cli: ${request.reason}`);
          log.warn({ runId: parts.runId, reason: request.reason }, "kill switch reset by request");
        }
      }
    })
  ];
  if (parts.live && parts.connection) {
    const connection = parts.connection;
    const wallet = new PublicKey(parts.live.wallet);
    const pollBalance = async (): Promise<void> => {
      parts.risk.setAvailableBalance(BigInt(await connection.getBalance(wallet, "confirmed")));
    };
    await pollBalance().catch((error: unknown) => log.error({ err: error }, "hot wallet balance check failed"));
    repeaters.push(new Repeater({ clock, name: "balance", intervalMs: options.balanceIntervalMs ?? 15_000, run: pollBalance }));
  }
  return repeaters;
}

export function createSweeper(env: Env, config: StrategyConfig, parts: TradingParts, db: Db, clock: Clock): HotColdSweeper | null {
  if (!parts.live || !parts.connection || !config.sweeper.enabled) {
    return null;
  }
  if (!env.COLD_WALLET_ADDRESS) {
    log.warn("sweeper.enabled is true but COLD_WALLET_ADDRESS is not set; sweeping is off");
    return null;
  }
  return new HotColdSweeper({
    connection: parts.connection,
    hotKeypair: loadKeypair(requireEnv(env, "HOT_WALLET_SECRET_KEY")),
    coldAddress: env.COLD_WALLET_ADDRESS,
    config: config.sweeper,
    db,
    clock,
    dryRun: env.LIVE_DRY_RUN,
    isBusy: () => parts.trader.isBusy()
  });
}

export interface SignalObserver {
  store: PgTradingStore;
  record(signal: Signal, reason: string | null): void;
  detach(): void;
}

export function createSignalObserver(db: Db, bus: Bus, market: MarketState): SignalObserver {
  const store = new PgTradingStore({ db });
  const record = (signal: Signal, reason: string | null): void => {
    void store
      .recordSignal(0, { signal, acted: false, skipReason: reason, launchId: market.get(signal.mint)?.launchId ?? null })
      .catch(() => null);
  };
  const detach = bus.on("signal", (signal) => record(signal, null));
  return { store, record, detach };
}
