import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { quoteBuyExactQuoteIn, quoteSell, type CurveReserves } from "../src/chain/curve.js";
import { defaultStrategyConfig, type ExecutionConfig } from "../src/config/strategy.js";
import type { Clock } from "../src/core/clock.js";
import {
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
  ONE_BILLION_SUPPLY,
  SOL_QUOTE
} from "../src/core/constants.js";
import type { MarketDataSource } from "../src/core/contracts.js";
import type { Rng } from "../src/core/rng.js";
import type { CurveView, LaunchCreatedEvent, OrderRequest, TradeEvent } from "../src/core/types.js";
import type { ConfirmedTransaction, TokenBalanceEntry } from "../src/execution/fillParser.js";
import { marketDataSource } from "../src/execution/marketSource.js";
import { MarketState } from "../src/market/state.js";

export const SOL = 1_000_000_000n;
export const T0 = 1_792_000_000_000;
export const SLOT0 = 460_000_000;
export const MINT = "TestMint1111111111111111111111111111111111";
export const PUMP_QUOTE_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";

export function execConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return { ...defaultStrategyConfig().execution, ...overrides };
}

export function initialReserves(): CurveReserves {
  return {
    virtualTokenReserves: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
    virtualQuoteReserves: DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
    realTokenReserves: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
    realQuoteReserves: 0n
  };
}

export function curveView(overrides: Partial<CurveView> = {}): CurveView {
  return {
    mint: MINT,
    slot: SLOT0,
    atMs: T0,
    venue: "curve",
    ...initialReserves(),
    tokenTotalSupply: ONE_BILLION_SUPPLY,
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
    virtualTokenReserves: 206_900_000_000_000n,
    virtualQuoteReserves: 84_990_359_034n,
    realTokenReserves: 206_900_000_000_000n,
    realQuoteReserves: 84_990_359_034n,
    complete: true,
    migrated: true,
    protocolFeeBps: 93,
    creatorFeeBps: 30,
    lpFeeBps: 2,
    ...overrides
  });
}

export function spotPrice(view: Pick<CurveView, "virtualQuoteReserves" | "virtualTokenReserves">): number {
  return Number(view.virtualQuoteReserves) / Number(view.virtualTokenReserves);
}

export function order(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    side: "buy",
    mint: MINT,
    quoteBudget: SOL / 10n,
    tokenAmount: null,
    maxSlippageBps: 1500,
    reason: "test",
    urgency: "normal",
    signalSlot: SLOT0,
    signalAtMs: T0,
    referencePrice: spotPrice(initialReserves()),
    positionId: "pos-1",
    closesPosition: false,
    ...overrides
  };
}

export function constantRng(value: number): Rng {
  return () => value;
}

export function sequenceRng(values: readonly number[]): Rng {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0;
    index += 1;
    return value;
  };
}

export function newMarket(): MarketState {
  return new MarketState({ maxTradesPerLaunch: 25_000, evictInactiveMs: 3_600_000, evictMaxAgeMs: 86_400_000, quoteMints: null });
}

export function createEvent(overrides: Partial<LaunchCreatedEvent> = {}): LaunchCreatedEvent {
  return {
    kind: "create",
    tx: { signature: "createSig", slot: SLOT0, seq: 0, eventIndex: 0, receivedAtMs: T0 },
    mint: MINT,
    bondingCurve: `${MINT}Curve`,
    devWallet: "DevWallet",
    creator: "DevWallet",
    name: "Test",
    symbol: "TEST",
    uri: "",
    timestampMs: T0,
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

let tradeCounter = 0;

export function curveTradeEvent(
  reserves: CurveReserves,
  input: { wallet: string; isBuy: boolean; amount: bigint; atMs: number; slot: number; mint?: string }
): { event: TradeEvent; after: CurveReserves } {
  const fees = { protocolFeeBps: 95, creatorFeeBps: 30 };
  tradeCounter += 1;
  const tx = { signature: `tradeSig${tradeCounter}`, slot: input.slot, seq: tradeCounter, eventIndex: 0, receivedAtMs: input.atMs };
  if (input.isBuy) {
    const quote = quoteBuyExactQuoteIn(reserves, input.amount, fees);
    return {
      after: quote.after,
      event: {
        kind: "trade",
        tx,
        venue: "curve",
        mint: input.mint ?? MINT,
        pool: null,
        wallet: input.wallet,
        isBuy: true,
        tokenAmount: quote.tokensOut,
        quoteAmount: quote.netQuote,
        userQuote: quote.totalCost,
        protocolFee: quote.protocolFee,
        creatorFee: quote.creatorFee,
        lpFee: 0n,
        protocolFeeBps: fees.protocolFeeBps,
        creatorFeeBps: fees.creatorFeeBps,
        lpFeeBps: 0,
        virtualTokenReserves: quote.after.virtualTokenReserves,
        virtualQuoteReserves: quote.after.virtualQuoteReserves,
        realTokenReserves: quote.after.realTokenReserves,
        realQuoteReserves: quote.after.realQuoteReserves,
        timestampMs: input.atMs,
        ixName: "buy_exact_quote_in_v3"
      }
    };
  }
  const quote = quoteSell(reserves, input.amount, fees);
  return {
    after: quote.after,
    event: {
      kind: "trade",
      tx,
      venue: "curve",
      mint: input.mint ?? MINT,
      pool: null,
      wallet: input.wallet,
      isBuy: false,
      tokenAmount: input.amount,
      quoteAmount: quote.grossQuote,
      userQuote: quote.netQuote,
      protocolFee: quote.protocolFee,
      creatorFee: quote.creatorFee,
      lpFee: 0n,
      protocolFeeBps: fees.protocolFeeBps,
      creatorFeeBps: fees.creatorFeeBps,
      lpFeeBps: 0,
      virtualTokenReserves: quote.after.virtualTokenReserves,
      virtualQuoteReserves: quote.after.virtualQuoteReserves,
      realTokenReserves: quote.after.realTokenReserves,
      realQuoteReserves: quote.after.realQuoteReserves,
      timestampMs: input.atMs,
      ixName: "sell_v3"
    }
  };
}

export function marketSource(market: MarketState, clock: Clock): MarketDataSource {
  return marketDataSource(market, clock);
}

export interface FixtureTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface FixtureTx {
  signature: string;
  slot: number;
  blockTime: number;
  category: string;
  logs: string[];
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: FixtureTokenBalance[];
  postTokenBalances: FixtureTokenBalance[];
}

export const fixtures: FixtureTx[] = JSON.parse(
  readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8")
) as FixtureTx[];

export function fixture(prefix: string): FixtureTx {
  const found = fixtures.find((candidate) => candidate.signature.startsWith(prefix));
  if (!found) {
    throw new Error(`fixture ${prefix} missing`);
  }
  return found;
}

function tokenEntries(entries: readonly FixtureTokenBalance[]): TokenBalanceEntry[] {
  return entries.map((entry) => ({
    accountIndex: entry.accountIndex,
    mint: entry.mint,
    owner: entry.owner ?? null,
    amount: BigInt(entry.uiTokenAmount.amount)
  }));
}

export function confirmedFromFixture(tx: FixtureTx, fee: bigint, err: unknown = null): ConfirmedTransaction {
  return {
    signature: tx.signature,
    slot: tx.slot,
    blockTimeMs: tx.blockTime * 1000,
    err,
    fee,
    logMessages: tx.logs,
    accountKeys: tx.accountKeys,
    preBalances: tx.preBalances.map(BigInt),
    postBalances: tx.postBalances.map(BigInt),
    preTokenBalances: tokenEntries(tx.preTokenBalances),
    postTokenBalances: tokenEntries(tx.postTokenBalances),
    computeUnitsConsumed: null
  };
}

const DATA_PREFIX = "Program data: ";

function replaceAll(buffer: Buffer, from: Buffer, to: Buffer): Buffer {
  const copy = Buffer.from(buffer);
  let index = copy.indexOf(from);
  while (index >= 0) {
    to.copy(copy, index);
    index = copy.indexOf(from, index + from.length);
  }
  return copy;
}

export function rewriteWallet(tx: ConfirmedTransaction, from: string, to: string, signature: string): ConfirmedTransaction {
  const fromBytes = Buffer.from(bs58.decode(from));
  const toBytes = Buffer.from(bs58.decode(to));
  const logMessages = tx.logMessages.map((line) => {
    if (!line.startsWith(DATA_PREFIX)) {
      return line;
    }
    const data = Buffer.from(line.slice(DATA_PREFIX.length), "base64");
    return `${DATA_PREFIX}${replaceAll(data, fromBytes, toBytes).toString("base64")}`;
  });
  const swapOwner = (entry: TokenBalanceEntry): TokenBalanceEntry => (entry.owner === from ? { ...entry, owner: to } : entry);
  return {
    ...tx,
    signature,
    logMessages,
    accountKeys: tx.accountKeys.map((key) => (key === from ? to : key)),
    preTokenBalances: tx.preTokenBalances.map(swapOwner),
    postTokenBalances: tx.postTokenBalances.map(swapOwner)
  };
}
