import { quoteBuyExactQuoteIn, quoteSell, type CurveReserves } from "../src/chain/curve.js";
import { defaultStrategyConfig, type ScorerConfig } from "../src/config/strategy.js";
import {
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
  ONE_BILLION_SUPPLY,
  SOL_QUOTE
} from "../src/core/constants.js";
import type { LaunchCreatedEvent, TradeEvent } from "../src/core/types.js";
import { MarketState, type LaunchState } from "../src/market/state.js";
import type { WalletIntel } from "../src/scorer/types.js";

export const PUMP_QUOTE_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
export const SOL = 1_000_000_000n;
export const T0 = 1_792_000_000_000;
export const SLOT0 = 400_000_000;

const FEES = { protocolFeeBps: 95, creatorFeeBps: 30 };

export function scorerConfig(overrides: Partial<ScorerConfig> = {}): ScorerConfig {
  return { ...defaultStrategyConfig().scorer, ...overrides };
}

export function newMarket(): MarketState {
  return new MarketState({ maxTradesPerLaunch: 25_000, evictInactiveMs: 3_600_000, evictMaxAgeMs: 86_400_000, quoteMints: null });
}

export interface LaunchSpec {
  mint?: string;
  dev?: string;
  creator?: string;
  quoteMint?: string;
  name?: string;
  symbol?: string;
  createdAtMs?: number;
  createdSlot?: number;
}

export interface TradeTiming {
  slot?: number;
  atMs?: number;
}

let signatureCounter = 0;

function nextSignature(prefix: string): string {
  signatureCounter += 1;
  return `${prefix}sig${signatureCounter}`;
}

export class LaunchBuilder {
  readonly market: MarketState;
  readonly launch: LaunchState;
  readonly createSignature: string;
  readonly createEvent: LaunchCreatedEvent;
  private reserves: CurveReserves;
  private seq = 0;

  constructor(spec: LaunchSpec = {}, market: MarketState = newMarket()) {
    this.market = market;
    const mint = spec.mint ?? `Mint${Math.floor(Math.random() * 1e9)}`;
    this.createSignature = nextSignature("create");
    const event: LaunchCreatedEvent = {
      kind: "create",
      tx: { signature: this.createSignature, slot: spec.createdSlot ?? SLOT0, seq: 0, eventIndex: 0, receivedAtMs: spec.createdAtMs ?? T0 },
      mint,
      bondingCurve: `${mint}Curve`,
      devWallet: spec.dev ?? "DevWallet",
      creator: spec.creator ?? spec.dev ?? "DevWallet",
      name: spec.name ?? "Test Coin",
      symbol: spec.symbol ?? "TEST",
      uri: "",
      timestampMs: spec.createdAtMs ?? T0,
      virtualTokenReserves: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
      virtualQuoteReserves: DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
      realTokenReserves: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
      tokenTotalSupply: ONE_BILLION_SUPPLY,
      tokenProgram: null,
      quoteMint: spec.quoteMint ?? SOL_QUOTE,
      isMayhemMode: false,
      isCashback: false,
      isHolderReward: false,
      creatorFeeBps: 30,
      depth: 0
    };
    this.createEvent = event;
    const outcome = market.apply(event);
    if (outcome.kind !== "created") {
      throw new Error("launch not created");
    }
    this.launch = outcome.launch;
    this.reserves = {
      virtualTokenReserves: event.virtualTokenReserves,
      virtualQuoteReserves: event.virtualQuoteReserves,
      realTokenReserves: event.realTokenReserves,
      realQuoteReserves: 0n
    };
  }

  get createdAtMs(): number {
    return this.launch.info.createdAtMs;
  }

  get createdSlot(): number {
    return this.launch.info.createdSlot;
  }

  buy(wallet: string, budget: bigint, timing: TradeTiming = {}): this {
    const quote = quoteBuyExactQuoteIn(this.reserves, budget, FEES);
    this.reserves = quote.after;
    return this.apply({
      wallet,
      isBuy: true,
      tokenAmount: quote.tokensOut,
      quoteAmount: quote.netQuote,
      userQuote: quote.totalCost,
      protocolFee: quote.protocolFee,
      creatorFee: quote.creatorFee,
      timing
    });
  }

  sellFraction(wallet: string, fraction: number, timing: TradeTiming = {}): this {
    const balance = this.launch.balanceOf(wallet);
    const tokens = (balance * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
    return this.sellTokens(wallet, tokens, timing);
  }

  sellTokens(wallet: string, tokens: bigint, timing: TradeTiming = {}): this {
    const quote = quoteSell(this.reserves, tokens, FEES);
    this.reserves = quote.after;
    return this.apply({
      wallet,
      isBuy: false,
      tokenAmount: tokens,
      quoteAmount: quote.grossQuote,
      userQuote: quote.netQuote,
      protocolFee: quote.protocolFee,
      creatorFee: quote.creatorFee,
      timing
    });
  }

  private apply(input: {
    wallet: string;
    isBuy: boolean;
    tokenAmount: bigint;
    quoteAmount: bigint;
    userQuote: bigint;
    protocolFee: bigint;
    creatorFee: bigint;
    timing: TradeTiming;
  }): this {
    this.seq += 1;
    const atMs = input.timing.atMs ?? this.createdAtMs;
    const slot = input.timing.slot ?? this.createdSlot + Math.floor((atMs - this.createdAtMs) / 400);
    const event: TradeEvent = {
      kind: "trade",
      tx: { signature: nextSignature(input.wallet), slot, seq: this.seq, eventIndex: 0, receivedAtMs: atMs },
      venue: "curve",
      mint: this.launch.mint,
      pool: null,
      wallet: input.wallet,
      isBuy: input.isBuy,
      tokenAmount: input.tokenAmount,
      quoteAmount: input.quoteAmount,
      userQuote: input.userQuote,
      protocolFee: input.protocolFee,
      creatorFee: input.creatorFee,
      lpFee: 0n,
      protocolFeeBps: FEES.protocolFeeBps,
      creatorFeeBps: FEES.creatorFeeBps,
      lpFeeBps: 0,
      virtualTokenReserves: this.reserves.virtualTokenReserves,
      virtualQuoteReserves: this.reserves.virtualQuoteReserves,
      realTokenReserves: this.reserves.realTokenReserves,
      realQuoteReserves: this.reserves.realQuoteReserves,
      timestampMs: atMs,
      ixName: null
    };
    this.market.apply(event);
    return this;
  }
}

export function intelEntry(wallet: string, overrides: Partial<WalletIntel> = {}): WalletIntel {
  return {
    wallet,
    funder: null,
    fundingSignature: null,
    fundingSlot: null,
    fundedAtMs: null,
    fundingAmount: null,
    priorTxCount: 50,
    priorTxCapped: true,
    oldestSeenAtMs: null,
    checkedBeforeSignature: "before",
    checkedAtMs: T0,
    funderIsHub: false,
    error: null,
    ...overrides
  };
}

export function organicLaunch(spec: LaunchSpec = {}, buyers = 30): LaunchBuilder {
  const builder = new LaunchBuilder(spec);
  builder.buy(builder.launch.info.devWallet, SOL / 2n, { slot: builder.createdSlot });
  for (let index = 0; index < buyers; index += 1) {
    const atMs = builder.createdAtMs + 3_000 + index * 1_800;
    builder.buy(`organic${index}`, SOL / 4n + BigInt(index) * 10_000_000n, { atMs });
    if (index % 4 === 3) {
      builder.sellFraction(`organic${index - 2}`, 0.5, { atMs: atMs + 200 });
    }
  }
  return builder;
}
