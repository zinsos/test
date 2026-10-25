import { ExitConfigSchema, type ExitConfig } from "../src/config/strategy.js";
import type { CurveView, LaunchCreatedEvent, Position, TradeEvent } from "../src/core/types.js";
import type { ExitContext, ExitExecutionConfig } from "../src/exits/types.js";
import { NO_EXIT_EVENTS } from "../src/exits/types.js";
import { MarketState, type LaunchState } from "../src/market/state.js";

export const ENTRY_PRICE = 5e-5;
export const ENTRY_TOKENS = 10_000_000_000_000n;
export const MOONBAG_TOKENS = 1_000_000_000_000n;
export const OPENED_AT_MS = 1_800_000_000_000;
export const OPENED_SLOT = 400_000_000;
export const MINT = "Mint111111111111111111111111111111111111111";
export const EXECUTION: ExitExecutionConfig = { sellSlippageBps: 2000, emergencySellSlippageBps: 5000 };

export function exitConfig(overrides: Record<string, unknown> = {}): ExitConfig {
  return ExitConfigSchema.parse(overrides);
}

export function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: "pos-1",
    runId: 1,
    mode: "paper",
    mint: MINT,
    launchId: 1,
    signalId: null,
    signalType: "smart_convergence",
    riskScore: 20,
    openedAtMs: OPENED_AT_MS,
    openedSlot: OPENED_SLOT,
    entryPrice: ENTRY_PRICE,
    entryTokens: ENTRY_TOKENS,
    entryCost: 500_000_000n,
    tokensHeld: ENTRY_TOKENS,
    proceeds: 0n,
    feesPaid: 0n,
    peakPrice: ENTRY_PRICE,
    lastPrice: ENTRY_PRICE,
    takeProfitLevelsHit: 0,
    migratedSeen: false,
    status: "open",
    closedAtMs: null,
    exitReason: null,
    shadowOf: null,
    meta: {},
    ...overrides
  };
}

export function curveView(overrides: Partial<CurveView> = {}): CurveView {
  return {
    mint: MINT,
    slot: OPENED_SLOT + 10,
    atMs: OPENED_AT_MS,
    venue: "curve",
    virtualTokenReserves: 800_000_000_000_000n,
    virtualQuoteReserves: 40_000_000_000n,
    realTokenReserves: 520_000_000_000_000n,
    realQuoteReserves: 10_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    migrated: false,
    protocolFeeBps: 95,
    creatorFeeBps: 30,
    lpFeeBps: -1,
    ...overrides
  };
}

export function poolView(overrides: Partial<CurveView> = {}): CurveView {
  return curveView({
    venue: "pool",
    virtualTokenReserves: 800_000_000_000_000n,
    virtualQuoteReserves: 40_000_000_000n,
    realTokenReserves: 800_000_000_000_000n,
    realQuoteReserves: 40_000_000_000n,
    complete: true,
    migrated: true,
    protocolFeeBps: 5,
    creatorFeeBps: 5,
    lpFeeBps: 20,
    ...overrides
  });
}

export function exitContext(overrides: Partial<ExitContext> = {}): ExitContext {
  return {
    position: makePosition(),
    view: curveView(),
    price: ENTRY_PRICE,
    nowMs: OPENED_AT_MS + 10_000,
    events: NO_EXIT_EVENTS,
    config: exitConfig(),
    execution: EXECUTION,
    sellInFlight: false,
    ...overrides
  };
}

export function atMultiple(multiple: number): number {
  return ENTRY_PRICE * multiple;
}

export const DEV = "Dev1111111111111111111111111111111111111111";
export const CREATOR = "Creator111111111111111111111111111111111111";
export const CREATED_SLOT = 300_000_000;
export const CREATED_AT_MS = 1_700_000_000_000;

let sequence = 0;

function txRef(slot: number, atMs: number) {
  sequence += 1;
  return { signature: `sig-${sequence}`, slot, seq: sequence, eventIndex: 0, receivedAtMs: atMs };
}

export function createEvent(overrides: Partial<LaunchCreatedEvent> = {}): LaunchCreatedEvent {
  return {
    kind: "create",
    tx: txRef(CREATED_SLOT, CREATED_AT_MS),
    mint: MINT,
    bondingCurve: "Curve11111111111111111111111111111111111111",
    devWallet: DEV,
    creator: CREATOR,
    name: "Test",
    symbol: "TEST",
    uri: "",
    timestampMs: CREATED_AT_MS,
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualQuoteReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    tokenProgram: null,
    quoteMint: "SOL",
    isMayhemMode: false,
    isCashback: false,
    isHolderReward: false,
    creatorFeeBps: 30,
    depth: 0,
    ...overrides
  };
}

export function tradeEvent(wallet: string, isBuy: boolean, tokenAmount: bigint, slot: number, atMs?: number): TradeEvent {
  const timestamp = atMs ?? CREATED_AT_MS + (slot - CREATED_SLOT) * 400;
  return {
    kind: "trade",
    tx: txRef(slot, timestamp),
    venue: "curve",
    mint: MINT,
    pool: null,
    wallet,
    isBuy,
    tokenAmount,
    quoteAmount: 1_000_000n,
    userQuote: 1_012_500n,
    protocolFee: 9_500n,
    creatorFee: 3_000n,
    lpFee: 0n,
    protocolFeeBps: 95,
    creatorFeeBps: 30,
    lpFeeBps: 0,
    virtualTokenReserves: 1_000_000_000_000_000n,
    virtualQuoteReserves: 32_000_000_000n,
    realTokenReserves: 720_000_000_000_000n,
    realQuoteReserves: 2_000_000_000n,
    timestampMs: timestamp,
    ixName: isBuy ? "buy" : "sell"
  };
}

export interface LaunchHarness {
  market: MarketState;
  launch: LaunchState;
  trade(wallet: string, isBuy: boolean, tokenAmount: bigint, slot: number, atMs?: number): void;
}

export function launchHarness(maxTradesPerLaunch = 25_000, create: Partial<LaunchCreatedEvent> = {}): LaunchHarness {
  const market = new MarketState({ maxTradesPerLaunch, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
  const outcome = market.apply(createEvent(create));
  if (outcome.kind !== "created") {
    throw new Error("launch not created");
  }
  return {
    market,
    launch: outcome.launch,
    trade(wallet, isBuy, tokenAmount, slot, atMs) {
      market.apply(tradeEvent(wallet, isBuy, tokenAmount, slot, atMs));
    }
  };
}
