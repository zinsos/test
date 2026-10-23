import { defaultStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import {
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
  ONE_BILLION_SUPPLY,
  SOL_QUOTE
} from "../src/core/constants.js";
import type { Executor, MarketDataSource } from "../src/core/contracts.js";
import type { LaunchCreatedEvent, Signal, TradeEvent, TradingMode } from "../src/core/types.js";
import { PaperExecutor } from "../src/execution/paperExecutor.js";
import { marketDataSource } from "../src/execution/marketSource.js";
import { ExitEventWatcher } from "../src/exits/watcher.js";
import { MarketState } from "../src/market/state.js";
import { RiskManager } from "../src/risk/manager.js";
import { MemoryTradingStore } from "../src/trader/memoryStore.js";
import { Trader, type FillReconciler } from "../src/trader/trader.js";

export const SOL = 1_000_000_000n;
export const T0 = 1_800_000_000_000;
export const SLOT0 = 400_000_000;
export const MINT_A = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const MINT_B = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
export const MINT_C = "MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
export const PUMP_QUOTE = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const CURVE_RESERVE_OFFSET = DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES - DEFAULT_INITIAL_REAL_TOKEN_RESERVES;

export interface TestEnv {
  clock: VirtualClock;
  bus: Bus;
  market: MarketState;
  source: MarketDataSource;
}

export function slotAt(atMs: number): number {
  return SLOT0 + Math.floor((atMs - T0) / 400);
}

export function createEnv(startMs = T0): TestEnv {
  const clock = new VirtualClock(startMs);
  const bus = new Bus();
  const market = new MarketState({ maxTradesPerLaunch: 25_000, evictInactiveMs: 3_600_000, evictMaxAgeMs: 86_400_000, quoteMints: null });
  return { clock, bus, market, source: marketDataSource(market, clock) };
}

export function strategy(overrides: (config: StrategyConfig) => void = () => undefined): StrategyConfig {
  const config = defaultStrategyConfig();
  config.execution.latencyJitterSlots = 0;
  config.execution.failureRate = 0;
  config.risk.startingBankrollSol = 10;
  config.risk.fractionPerTrade = 0.01;
  overrides(config);
  return config;
}

let sequence = 0;

export function launchEvent(mint: string, atMs: number, overrides: Partial<LaunchCreatedEvent> = {}): LaunchCreatedEvent {
  sequence += 1;
  return {
    kind: "create",
    tx: { signature: `create-${mint}-${sequence}`, slot: slotAt(atMs), seq: sequence, eventIndex: 0, receivedAtMs: atMs },
    mint,
    bondingCurve: `${mint.slice(0, 20)}Curve`,
    devWallet: `Dev${mint.slice(4, 12)}`,
    creator: `Dev${mint.slice(4, 12)}`,
    name: "Test",
    symbol: "TEST",
    uri: "",
    timestampMs: atMs,
    virtualTokenReserves: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
    virtualQuoteReserves: DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
    realTokenReserves: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
    tokenTotalSupply: ONE_BILLION_SUPPLY,
    tokenProgram: null,
    quoteMint: SOL_QUOTE,
    isMayhemMode: false,
    isCashback: false,
    isHolderReward: false,
    creatorFeeBps: 30,
    depth: 0,
    ...overrides
  };
}

export async function createLaunch(env: TestEnv, mint: string, atMs: number, overrides: Partial<LaunchCreatedEvent> = {}): Promise<void> {
  await env.clock.advanceTo(atMs);
  const event = launchEvent(mint, atMs, overrides);
  env.market.apply(event);
  env.bus.emit("chain", event);
}

export function tradeToQuoteReserves(env: TestEnv, mint: string, targetQuote: bigint, atMs: number, wallet: string): TradeEvent {
  const launch = env.market.get(mint);
  if (!launch) {
    throw new Error(`unknown launch ${mint}`);
  }
  const k = launch.virtualTokenReserves * launch.virtualQuoteReserves;
  const nextToken = k / targetQuote;
  const isBuy = targetQuote > launch.virtualQuoteReserves;
  const tokenAmount = isBuy ? launch.virtualTokenReserves - nextToken : nextToken - launch.virtualTokenReserves;
  const quoteAmount = isBuy ? targetQuote - launch.virtualQuoteReserves : launch.virtualQuoteReserves - targetQuote;
  const protocolFee = (quoteAmount * 95n) / 10_000n;
  const creatorFee = (quoteAmount * 30n) / 10_000n;
  sequence += 1;
  return {
    kind: "trade",
    tx: { signature: `trade-${sequence}`, slot: slotAt(atMs), seq: sequence, eventIndex: 0, receivedAtMs: atMs },
    venue: "curve",
    mint,
    pool: null,
    wallet,
    isBuy,
    tokenAmount,
    quoteAmount,
    userQuote: isBuy ? quoteAmount + protocolFee + creatorFee : quoteAmount - protocolFee - creatorFee,
    protocolFee,
    creatorFee,
    lpFee: 0n,
    protocolFeeBps: 95,
    creatorFeeBps: 30,
    lpFeeBps: 0,
    virtualTokenReserves: nextToken,
    virtualQuoteReserves: targetQuote,
    realTokenReserves: nextToken - CURVE_RESERVE_OFFSET,
    realQuoteReserves: targetQuote - DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
    timestampMs: atMs,
    ixName: null
  };
}

export async function moveQuoteReserves(env: TestEnv, mint: string, targetQuote: bigint, atMs: number, wallet = "Whale1111"): Promise<TradeEvent> {
  await env.clock.advanceTo(atMs);
  const event = tradeToQuoteReserves(env, mint, targetQuote, atMs, wallet);
  env.market.apply(event);
  env.bus.emit("chain", event);
  return event;
}

export function signalFor(env: TestEnv, mint: string, overrides: Partial<Signal> = {}): Signal {
  const launch = env.market.get(mint);
  return {
    id: null,
    type: "smart_convergence",
    mint,
    atMs: env.clock.nowMs(),
    slot: launch?.lastSlot ?? slotAt(env.clock.nowMs()),
    riskScore: 20,
    wallets: ["SmartA", "SmartB", "SmartC"],
    meta: {},
    ...overrides
  };
}

export interface TraderHarness {
  trader: Trader;
  store: MemoryTradingStore;
  risk: RiskManager;
  executor: Executor;
  config: StrategyConfig;
}

export interface HarnessOptions {
  mode?: TradingMode;
  executor?: Executor;
  shadowExecutor?: Executor | null;
  reconcile?: FillReconciler | null;
  config?: StrategyConfig;
  smartExitCount?: (mint: string, sinceMs: number) => number;
}

export function buildTrader(env: TestEnv, options: HarnessOptions = {}): TraderHarness {
  const config = options.config ?? strategy();
  const mode = options.mode ?? "paper";
  const store = new MemoryTradingStore();
  const risk = new RiskManager({ runId: 1, config: config.risk, clock: env.clock, mode: mode === "live" ? "paper" : mode, store });
  const executor = options.executor ?? new PaperExecutor({ clock: env.clock, market: env.source, config: config.execution, mode: "paper" });
  const watcher = new ExitEventWatcher({ market: env.source, creationWindowSlots: config.scorer.bundleSlotWindow });
  const trader = new Trader({
    runId: 1,
    mode,
    clock: env.clock,
    bus: env.bus,
    market: env.source,
    executor,
    shadowExecutor: options.shadowExecutor ?? null,
    risk,
    exits: config.exits,
    execution: config.execution,
    watcher,
    store,
    reconcile: options.reconcile ?? null,
    smartExitCount: options.smartExitCount ?? null
  });
  trader.start();
  return { trader, store, risk, executor, config };
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}
