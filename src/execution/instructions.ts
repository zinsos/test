import BN from "bn.js";
import { PublicKey, TransactionInstruction, type AccountInfo, type Connection } from "@solana/web3.js";
import type { BondingCurve, FeeConfig, Global } from "@pump-fun/pump-sdk";
import type { SwapSolanaState } from "@pump-fun/pump-swap-sdk";
import { normalizeQuoteMint } from "../chain/events.js";
import type { Clock } from "../core/clock.js";
import { SOL_QUOTE } from "../core/constants.js";
import type { OrderRequest, TradeVenue } from "../core/types.js";
import { loadPumpSdk, loadPumpSwapSdk } from "./sdk.js";

export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const CLOSE_ACCOUNT_INSTRUCTION = 9;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

export interface ComputeUnitLimits {
  curveBuy: number;
  curveSell: number;
  poolBuy: number;
  poolSell: number;
}

export const DEFAULT_COMPUTE_UNIT_LIMITS: ComputeUnitLimits = {
  curveBuy: 160_000,
  curveSell: 120_000,
  poolBuy: 260_000,
  poolSell: 220_000
};

export interface BuildHints {
  migrated: boolean;
  pool: string | null;
  tokenProgram: string | null;
}

export interface BuildRequest {
  order: OrderRequest;
  user: PublicKey;
  slippageBps: number;
  closeTokenAccount: boolean;
  hints: BuildHints;
}

export interface BuiltTrade {
  venue: TradeVenue;
  pool: string | null;
  instructions: TransactionInstruction[];
  computeUnitLimit: number;
  tokenAmount: bigint;
  expectedTokens: bigint;
  expectedQuote: bigint;
  closesTokenAccount: boolean;
  createsTokenAccount: boolean;
  tokenBalanceBefore: bigint;
  instructionSet: string;
}

export interface TradeInstructionBuilder {
  build(request: BuildRequest): Promise<BuiltTrade>;
}

export type RefusalCode = "non_sol_quote" | "curve_complete" | "pool_unavailable" | "no_balance" | "no_liquidity" | "invalid_order";

export class TradeRefusedError extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string
  ) {
    super(message);
    this.name = "TradeRefusedError";
  }
}

export function slippagePercent(slippageBps: number): number {
  return Math.max(0, slippageBps) / 100;
}

export function lessSlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.floor(slippageBps))));
  const reduced = (amount * (10_000n - bps)) / 10_000n;
  return reduced > 0n ? reduced : amount > 0n ? 1n : 0n;
}

export function budgetBeforeSdkSlippage(budget: bigint, slippageBps: number): bigint {
  const perMille = BigInt(Math.floor(slippagePercent(slippageBps) * 10));
  return (budget * 1_000n) / (1_000n + perMille);
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
  );
  return address;
}

export function closeTokenAccountInstruction(account: PublicKey, owner: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false }
    ],
    data: Buffer.from([CLOSE_ACCOUNT_INSTRUCTION])
  });
}

export function tokenAccountAmount(info: Pick<AccountInfo<Buffer>, "data"> | null): bigint {
  if (!info || info.data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) {
    return 0n;
  }
  return info.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

export function isSolQuoteMint(mint: PublicKey): boolean {
  return normalizeQuoteMint(mint.toBase58()) === SOL_QUOTE;
}

export function toBn(value: bigint): BN {
  return new BN(value.toString());
}

export function fromBn(value: BN): bigint {
  return BigInt(value.toString());
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error })
  );
}

export function sellAmount(requested: bigint, balance: bigint): bigint {
  return requested < balance ? requested : balance;
}

interface CurveConfig {
  global: Global;
  feeConfig: FeeConfig;
  fetchedAtMs: number;
}

export interface PumpInstructionBuilderOptions {
  connection: Connection;
  clock: Clock;
  computeUnitLimits?: Partial<ComputeUnitLimits>;
  configTtlMs?: number;
  maxCachedMints?: number;
}

type OnlinePump = InstanceType<ReturnType<typeof loadPumpSdk>["OnlinePumpSdk"]>;
type OnlineAmm = InstanceType<ReturnType<typeof loadPumpSwapSdk>["OnlinePumpAmmSdk"]>;

export class PumpInstructionBuilder implements TradeInstructionBuilder {
  private readonly connection: Connection;
  private readonly clock: Clock;
  private readonly limits: ComputeUnitLimits;
  private readonly configTtlMs: number;
  private readonly maxCachedMints: number;
  private readonly tokenPrograms = new Map<string, PublicKey>();
  private curveConfig: CurveConfig | null = null;
  private onlinePump: OnlinePump | null = null;
  private onlineAmm: OnlineAmm | null = null;

  constructor(options: PumpInstructionBuilderOptions) {
    this.connection = options.connection;
    this.clock = options.clock;
    this.limits = { ...DEFAULT_COMPUTE_UNIT_LIMITS, ...options.computeUnitLimits };
    this.configTtlMs = options.configTtlMs ?? 60_000;
    this.maxCachedMints = options.maxCachedMints ?? 5_000;
  }

  async build(request: BuildRequest): Promise<BuiltTrade> {
    const mint = new PublicKey(request.order.mint);
    const tokenProgram = await this.tokenProgramOf(mint, request.hints.tokenProgram);
    if (request.hints.migrated) {
      return this.buildPool(request, mint, tokenProgram);
    }
    return request.order.side === "buy"
      ? this.buildCurveBuy(request, mint, tokenProgram)
      : this.buildCurveSell(request, mint, tokenProgram);
  }

  private pump(): OnlinePump {
    this.onlinePump ??= new (loadPumpSdk().OnlinePumpSdk)(this.connection);
    return this.onlinePump;
  }

  private amm(): OnlineAmm {
    this.onlineAmm ??= new (loadPumpSwapSdk().OnlinePumpAmmSdk)(this.connection);
    return this.onlineAmm;
  }

  private async tokenProgramOf(mint: PublicKey, hint: string | null): Promise<PublicKey> {
    if (hint === SPL_TOKEN_PROGRAM_ID || hint === TOKEN_2022_PROGRAM_ID) {
      return new PublicKey(hint);
    }
    const key = mint.toBase58();
    const cached = this.tokenPrograms.get(key);
    if (cached) {
      return cached;
    }
    const info = await this.connection.getAccountInfo(mint, "confirmed");
    if (!info) {
      throw new TradeRefusedError("invalid_order", `mint ${key} not found`);
    }
    this.tokenPrograms.set(key, info.owner);
    if (this.tokenPrograms.size > this.maxCachedMints) {
      const oldest = this.tokenPrograms.keys().next();
      if (!oldest.done) {
        this.tokenPrograms.delete(oldest.value);
      }
    }
    return info.owner;
  }

  private async loadCurveConfig(): Promise<CurveConfig> {
    const now = this.clock.nowMs();
    if (this.curveConfig && now - this.curveConfig.fetchedAtMs < this.configTtlMs) {
      return this.curveConfig;
    }
    const [global, feeConfig] = await Promise.all([this.pump().fetchGlobal(), this.pump().fetchFeeConfig()]);
    this.curveConfig = { global, feeConfig, fetchedAtMs: now };
    return this.curveConfig;
  }

  private assertSolCurve(quoteMint: PublicKey): void {
    if (!isSolQuoteMint(quoteMint)) {
      throw new TradeRefusedError("non_sol_quote", `curve is quoted in ${quoteMint.toBase58()}, only SOL is traded`);
    }
  }

  private async poolOrRefuse(request: BuildRequest, mint: PublicKey, tokenProgram: PublicKey): Promise<BuiltTrade> {
    try {
      return await this.buildPool(request, mint, tokenProgram);
    } catch (error) {
      if (error instanceof TradeRefusedError && error.code === "pool_unavailable") {
        throw new TradeRefusedError("curve_complete", "curve is complete and the pool is not live yet");
      }
      throw error;
    }
  }

  private async buildCurveBuy(request: BuildRequest, mint: PublicKey, tokenProgram: PublicKey): Promise<BuiltTrade> {
    const budget = request.order.quoteBudget ?? 0n;
    if (budget <= 0n) {
      throw new TradeRefusedError("invalid_order", "curve buys need a quote budget");
    }
    const state = await this.pump().fetchBuyState(mint, request.user, tokenProgram);
    this.assertSolCurve(state.quoteMint);
    if (state.bondingCurve.complete) {
      return this.poolOrRefuse(request, mint, tokenProgram);
    }
    const { global, feeConfig } = await this.loadCurveConfig();
    const sdk = loadPumpSdk();
    const common = {
      mint,
      user: request.user,
      slippage: slippagePercent(request.slippageBps),
      tokenProgram,
      quoteTokenProgram: state.quoteTokenProgram
    };
    if (!state.bondingCurve.isCashbackCoin) {
      const tokens = sdk.getBuyV3TokenAmountFromQuoteAmount({
        global,
        feeConfig,
        mintSupply: state.bondingCurve.tokenTotalSupply,
        bondingCurve: state.bondingCurve,
        amount: toBn(budget),
        curveBaseTokenBalance: state.curveBaseTokenBalance,
        quoteTransferFee: state.quoteTransferFee
      });
      try {
        const instructions = await sdk.PUMP_SDK.buyExactQuoteInV3Instructions({
          ...common,
          bondingCurve: state.bondingCurve,
          associatedUserAccountInfo: state.associatedUserAccountInfo,
          amount: tokens,
          quoteAmount: toBn(budget)
        });
        return this.curveTrade("buy", instructions, budget, fromBn(tokens), budget, false, "buy_exact_quote_in_v3", state.associatedUserAccountInfo);
      } catch (error) {
        if (!(error instanceof sdk.CashbackCoinNotSupportedError)) {
          throw error;
        }
      }
    }
    return this.buildCurveBuyV2(request, state, global, feeConfig, common);
  }

  private async buildCurveBuyV2(
    request: BuildRequest,
    state: Awaited<ReturnType<OnlinePump["fetchBuyState"]>>,
    global: Global,
    feeConfig: FeeConfig,
    common: { mint: PublicKey; user: PublicKey; slippage: number; tokenProgram: PublicKey; quoteTokenProgram: PublicKey }
  ): Promise<BuiltTrade> {
    const sdk = loadPumpSdk();
    const quoteAmount = budgetBeforeSdkSlippage(request.order.quoteBudget ?? 0n, request.slippageBps);
    const tokens = sdk.getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: toBn(quoteAmount),
      quoteMint: state.quoteMint,
      quoteTransferFee: state.quoteTransferFee
    });
    const instructions = await sdk.PUMP_SDK.buyV2Instructions({
      ...common,
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      amount: tokens,
      quoteAmount: toBn(quoteAmount)
    });
    return this.curveTrade("buy", instructions, fromBn(tokens), fromBn(tokens), quoteAmount, false, "buy_v2", state.associatedUserAccountInfo);
  }

  private async userTokenBalance(
    owner: PublicKey,
    mint: PublicKey,
    tokenProgram: PublicKey
  ): Promise<{ account: PublicKey; info: AccountInfo<Buffer> | null; balance: bigint }> {
    const account = associatedTokenAddress(owner, mint, tokenProgram);
    const info = await this.connection.getAccountInfo(account, "confirmed");
    return { account, info, balance: tokenAccountAmount(info) };
  }

  private async buildCurveSell(request: BuildRequest, mint: PublicKey, tokenProgram: PublicKey): Promise<BuiltTrade> {
    const [stateResult, holding] = await Promise.all([
      settle(this.pump().fetchSellState(mint, request.user, tokenProgram)),
      this.userTokenBalance(request.user, mint, tokenProgram)
    ]);
    if (holding.balance <= 0n) {
      throw new TradeRefusedError("no_balance", "wallet holds none of this token");
    }
    if (!stateResult.ok) {
      throw stateResult.error;
    }
    const state = stateResult.value;
    this.assertSolCurve(state.quoteMint);
    if (state.bondingCurve.complete) {
      return this.poolOrRefuse(request, mint, tokenProgram);
    }
    const tokens = sellAmount(request.order.tokenAmount ?? 0n, holding.balance);
    if (tokens <= 0n) {
      throw new TradeRefusedError("no_balance", "wallet holds none of this token");
    }
    const { global, feeConfig } = await this.loadCurveConfig();
    const sdk = loadPumpSdk();
    const expectedQuote = sdk.getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: toBn(tokens),
      quoteTransferFee: state.quoteTransferFee
    });
    const params = {
      bondingCurve: state.bondingCurve,
      mint,
      user: request.user,
      amount: toBn(tokens),
      quoteAmount: expectedQuote,
      slippage: slippagePercent(request.slippageBps),
      tokenProgram,
      quoteTokenProgram: state.quoteTokenProgram
    };
    const { instructions, instructionSet } = await this.curveSellInstructions(params, state.bondingCurve, global, state.bondingCurveAccountInfo);
    const closes = request.closeTokenAccount && tokens === holding.balance;
    if (closes) {
      instructions.push(closeTokenAccountInstruction(holding.account, request.user, tokenProgram));
    }
    return this.curveTrade("sell", instructions, tokens, tokens, fromBn(expectedQuote), closes, instructionSet, holding.info);
  }

  private async curveSellInstructions(
    params: Parameters<OnlinePumpSdkSell>[0],
    bondingCurve: BondingCurve,
    global: Global,
    bondingCurveAccountInfo: AccountInfo<Buffer>
  ): Promise<{ instructions: TransactionInstruction[]; instructionSet: string }> {
    const sdk = loadPumpSdk();
    if (!bondingCurve.isCashbackCoin) {
      try {
        return { instructions: await sdk.PUMP_SDK.sellV3Instructions(params), instructionSet: "sell_v3" };
      } catch (error) {
        if (!(error instanceof sdk.CashbackCoinNotSupportedError)) {
          throw error;
        }
      }
    }
    const instructions = await sdk.PUMP_SDK.sellV2Instructions({ ...params, global, bondingCurveAccountInfo });
    return { instructions, instructionSet: "sell_v2" };
  }

  private curveTrade(
    side: "buy" | "sell",
    instructions: TransactionInstruction[],
    tokenAmount: bigint,
    expectedTokens: bigint,
    expectedQuote: bigint,
    closesTokenAccount: boolean,
    instructionSet: string,
    userTokenAccount: Pick<AccountInfo<Buffer>, "data"> | null
  ): BuiltTrade {
    return {
      venue: "curve",
      pool: null,
      instructions,
      computeUnitLimit: side === "buy" ? this.limits.curveBuy : this.limits.curveSell,
      tokenAmount,
      expectedTokens,
      expectedQuote,
      closesTokenAccount,
      createsTokenAccount: side === "buy" && userTokenAccount === null,
      tokenBalanceBefore: tokenAccountAmount(userTokenAccount),
      instructionSet
    };
  }

  private async swapState(request: BuildRequest, mint: PublicKey): Promise<SwapSolanaState> {
    const swapSdk = loadPumpSwapSdk();
    const poolKey = swapSdk.canonicalPumpPoolPda(mint);
    if (request.hints.pool !== null && request.hints.pool !== poolKey.toBase58()) {
      throw new TradeRefusedError("invalid_order", `pool ${request.hints.pool} is not the canonical SOL pool ${poolKey.toBase58()} of ${mint.toBase58()}`);
    }
    let state: SwapSolanaState;
    try {
      state = await this.amm().swapSolanaState(poolKey, request.user);
    } catch (error) {
      throw new TradeRefusedError("pool_unavailable", `pool ${poolKey.toBase58()} unavailable: ${(error as Error).message}`);
    }
    if (!state.pool.baseMint.equals(mint) || !state.pool.creator.equals(swapSdk.pumpPoolAuthorityPda(mint))) {
      throw new TradeRefusedError("invalid_order", `pool ${poolKey.toBase58()} does not belong to ${mint.toBase58()}`);
    }
    return state;
  }

  private async buildPool(request: BuildRequest, mint: PublicKey, tokenProgram: PublicKey): Promise<BuiltTrade> {
    const state = await this.swapState(request, mint);
    if (!isSolQuoteMint(state.pool.quoteMint)) {
      throw new TradeRefusedError("non_sol_quote", `pool is quoted in ${state.pool.quoteMint.toBase58()}, only SOL is traded`);
    }
    return request.order.side === "buy" ? this.buildPoolBuy(request, state) : this.buildPoolSell(request, state, tokenProgram);
  }

  private poolPricing(state: SwapSolanaState): PoolPricingInputs {
    return {
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
      quoteMint: state.pool.quoteMint,
      isMayhemMode: state.pool.isMayhemMode,
      creatorFeeBps: state.pool.creatorFeeBps,
      quoteTransferFee: state.quoteTransferFee ?? null
    };
  }

  private async buildPoolBuy(request: BuildRequest, state: SwapSolanaState): Promise<BuiltTrade> {
    const budget = request.order.quoteBudget ?? 0n;
    if (budget <= 0n) {
      throw new TradeRefusedError("invalid_order", "pool buys need a quote budget");
    }
    const swapSdk = loadPumpSwapSdk();
    const tradeV2 = swapSdk.supportsTradeV2(state.pool);
    const spend = tradeV2 ? budget : budgetBeforeSdkSlippage(budget, request.slippageBps);
    const quote = swapSdk.buyQuoteInput({
      ...this.poolPricing(state),
      quote: toBn(spend),
      slippage: slippagePercent(request.slippageBps),
      tradeV2
    });
    const expectedTokens = fromBn(quote.base);
    if (expectedTokens <= 0n) {
      throw new TradeRefusedError("no_liquidity", "pool quote returns no tokens");
    }
    const instructions = tradeV2
      ? await swapSdk.PUMP_AMM_SDK.buyExactQuoteInV2Instructions(state, toBn(budget), toBn(lessSlippage(expectedTokens, request.slippageBps)))
      : await swapSdk.PUMP_AMM_SDK.buyQuoteInput(state, toBn(spend), slippagePercent(request.slippageBps));
    return {
      venue: "pool",
      pool: state.poolKey.toBase58(),
      instructions,
      computeUnitLimit: this.limits.poolBuy,
      tokenAmount: expectedTokens,
      expectedTokens,
      expectedQuote: spend,
      closesTokenAccount: false,
      createsTokenAccount: !state.userBaseAccountInfo,
      tokenBalanceBefore: tokenAccountAmount(state.userBaseAccountInfo ?? null),
      instructionSet: tradeV2 ? "buy_exact_quote_in_v2" : "buy"
    };
  }

  private async buildPoolSell(request: BuildRequest, state: SwapSolanaState, tokenProgram: PublicKey): Promise<BuiltTrade> {
    const balance = tokenAccountAmount(state.userBaseAccountInfo);
    const tokens = sellAmount(request.order.tokenAmount ?? 0n, balance);
    if (tokens <= 0n) {
      throw new TradeRefusedError("no_balance", "wallet holds none of this token");
    }
    const swapSdk = loadPumpSwapSdk();
    const quote = swapSdk.sellBaseInput({
      ...this.poolPricing(state),
      base: toBn(tokens),
      slippage: slippagePercent(request.slippageBps),
      feeBucketsTotal: state.pool.protocolFees.add(state.pool.creatorFees)
    });
    const instructions = await swapSdk.PUMP_AMM_SDK.sellBaseInput(state, toBn(tokens), slippagePercent(request.slippageBps), { v2: true });
    const closes = request.closeTokenAccount && tokens === balance;
    if (closes) {
      instructions.push(closeTokenAccountInstruction(state.userBaseTokenAccount, request.user, state.baseTokenProgram ?? tokenProgram));
    }
    return {
      venue: "pool",
      pool: state.poolKey.toBase58(),
      instructions,
      computeUnitLimit: this.limits.poolSell,
      tokenAmount: tokens,
      expectedTokens: tokens,
      expectedQuote: fromBn(quote.uiQuote),
      closesTokenAccount: closes,
      createsTokenAccount: false,
      tokenBalanceBefore: balance,
      instructionSet: swapSdk.supportsTradeV2(state.pool) ? "sell_v2" : "sell"
    };
  }
}

type OnlinePumpSdkSell = ReturnType<typeof loadPumpSdk>["PUMP_SDK"]["sellV3Instructions"];

interface PoolPricingInputs {
  baseReserve: BN;
  quoteReserve: BN;
  virtualQuoteReserves: BN;
  globalConfig: SwapSolanaState["globalConfig"];
  baseMintAccount: SwapSolanaState["baseMintAccount"];
  baseMint: PublicKey;
  coinCreator: PublicKey;
  creator: PublicKey;
  feeConfig: SwapSolanaState["feeConfig"];
  quoteMint: PublicKey;
  isMayhemMode: boolean;
  creatorFeeBps: BN;
  quoteTransferFee: SwapSolanaState["quoteTransferFee"];
}
