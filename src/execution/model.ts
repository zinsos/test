import {
  quotePoolBuyExactBase,
  quotePoolBuyExactQuote,
  quotePoolSell,
  type PoolFeeRates,
  type PoolReserves
} from "../chain/amm.js";
import {
  curvePrice,
  executionImpactBps,
  quoteBuyExactQuoteIn,
  quoteBuyExactTokens,
  quoteSell,
  type CurveReserves,
  type FeeRates
} from "../chain/curve.js";
import type { ExecutionConfig } from "../config/strategy.js";
import { BPS } from "../core/constants.js";
import type { Rng } from "../core/rng.js";
import type { CurveView, OrderRequest, TradeVenue } from "../core/types.js";
import { platformFeeOn, resolveCurveFees, resolvePoolFees } from "./fees.js";

export type AttemptError =
  | "tx_failed"
  | "slippage_exceeded"
  | "curve_complete"
  | "pool_unavailable"
  | "no_liquidity"
  | "invalid_order";

export const RETRYABLE_ATTEMPT_ERRORS: ReadonlySet<string> = new Set<AttemptError>([
  "tx_failed",
  "slippage_exceeded",
  "curve_complete",
  "pool_unavailable"
]);

export interface TradeLeg {
  venue: TradeVenue;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  lpFee: bigint;
  extraPlatformFee: bigint;
  spotPrice: number;
  executionPrice: number;
}

export interface AttemptOutcome {
  success: boolean;
  error: AttemptError | null;
  sent: boolean;
  venue: TradeVenue;
  trade: TradeLeg | null;
  networkFee: bigint;
  tip: bigint;
  rentPaid: bigint;
  rentRefunded: bigint;
  fillPrice: number | null;
  priceImpactBps: number | null;
  slippageBps: number | null;
}

export interface SimulateAttemptInput {
  order: OrderRequest;
  view: CurveView;
  config: ExecutionConfig;
  rng: Rng;
  attempt: number;
  isFirstBuyOfPosition: boolean;
}

export type TradeLegResult = { leg: TradeLeg } | { error: AttemptError };

function curveReservesOf(view: CurveView): CurveReserves {
  return {
    virtualTokenReserves: view.virtualTokenReserves,
    virtualQuoteReserves: view.virtualQuoteReserves,
    realTokenReserves: view.realTokenReserves,
    realQuoteReserves: view.realQuoteReserves
  };
}

function poolReservesOf(view: CurveView): PoolReserves {
  return { baseReserves: view.virtualTokenReserves, quoteReserves: view.virtualQuoteReserves };
}

function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) {
    return 0;
  }
  return Number(numerator) / Number(denominator);
}

export function budgetNetOfPlatformFee(budget: bigint, platformFeeBps: number): bigint {
  if (budget <= 0n) {
    return 0n;
  }
  if (platformFeeBps <= 0) {
    return budget;
  }
  return (budget * BPS) / (BPS + BigInt(Math.floor(platformFeeBps)));
}

function finishBuyLeg(
  venue: TradeVenue,
  spotPrice: number,
  tokens: bigint,
  netQuote: bigint,
  fees: { protocolFee: bigint; creatorFee: bigint; lpFee: bigint },
  platformFeeBps: number
): TradeLegResult {
  if (tokens <= 0n || netQuote <= 0n) {
    return { error: "no_liquidity" };
  }
  const poolCost = netQuote + fees.protocolFee + fees.creatorFee + fees.lpFee;
  const extraPlatformFee = platformFeeOn(poolCost, platformFeeBps);
  return {
    leg: {
      venue,
      tokenAmount: tokens,
      quoteAmount: netQuote,
      userQuote: poolCost + extraPlatformFee,
      protocolFee: fees.protocolFee,
      creatorFee: fees.creatorFee,
      lpFee: fees.lpFee,
      extraPlatformFee,
      spotPrice,
      executionPrice: ratio(netQuote, tokens)
    }
  };
}

function finishSellLeg(
  venue: TradeVenue,
  spotPrice: number,
  tokens: bigint,
  grossQuote: bigint,
  netQuote: bigint,
  fees: { protocolFee: bigint; creatorFee: bigint; lpFee: bigint },
  platformFeeBps: number
): TradeLegResult {
  if (tokens <= 0n || grossQuote <= 0n || netQuote <= 0n) {
    return { error: "no_liquidity" };
  }
  const extraPlatformFee = platformFeeOn(netQuote, platformFeeBps);
  return {
    leg: {
      venue,
      tokenAmount: tokens,
      quoteAmount: grossQuote,
      userQuote: netQuote - extraPlatformFee,
      protocolFee: fees.protocolFee,
      creatorFee: fees.creatorFee,
      lpFee: fees.lpFee,
      extraPlatformFee,
      spotPrice,
      executionPrice: ratio(grossQuote, tokens)
    }
  };
}

function curveBuyLeg(order: OrderRequest, view: CurveView, fees: FeeRates, platformFeeBps: number): TradeLegResult {
  const reserves = curveReservesOf(view);
  const spot = curvePrice(reserves);
  if (order.quoteBudget !== null && order.quoteBudget > 0n) {
    const quote = quoteBuyExactQuoteIn(reserves, budgetNetOfPlatformFee(order.quoteBudget, platformFeeBps), fees);
    return finishBuyLeg(view.venue, spot, quote.tokensOut, quote.netQuote, { ...quote, lpFee: 0n }, platformFeeBps);
  }
  const tokens = order.tokenAmount ?? 0n;
  if (tokens >= reserves.virtualTokenReserves) {
    return { error: "no_liquidity" };
  }
  const quote = quoteBuyExactTokens(reserves, tokens, fees);
  return finishBuyLeg(view.venue, spot, quote.tokensOut, quote.netQuote, { ...quote, lpFee: 0n }, platformFeeBps);
}

function curveSellLeg(order: OrderRequest, view: CurveView, fees: FeeRates, platformFeeBps: number): TradeLegResult {
  const reserves = curveReservesOf(view);
  const tokens = order.tokenAmount ?? 0n;
  const quote = quoteSell(reserves, tokens, fees);
  return finishSellLeg(
    view.venue,
    curvePrice(reserves),
    tokens,
    quote.grossQuote,
    quote.netQuote,
    { ...quote, lpFee: 0n },
    platformFeeBps
  );
}

function poolBuyLeg(order: OrderRequest, view: CurveView, fees: PoolFeeRates, platformFeeBps: number): TradeLegResult {
  const reserves = poolReservesOf(view);
  const spot = ratio(reserves.quoteReserves, reserves.baseReserves);
  if (order.quoteBudget !== null && order.quoteBudget > 0n) {
    const quote = quotePoolBuyExactQuote(reserves, budgetNetOfPlatformFee(order.quoteBudget, platformFeeBps), fees);
    return finishBuyLeg("pool", spot, quote.baseOut, quote.quoteIn, quote, platformFeeBps);
  }
  const tokens = order.tokenAmount ?? 0n;
  if (tokens <= 0n || tokens >= reserves.baseReserves) {
    return { error: "no_liquidity" };
  }
  const quote = quotePoolBuyExactBase(reserves, tokens, fees);
  return finishBuyLeg("pool", spot, quote.baseOut, quote.quoteIn, quote, platformFeeBps);
}

function poolSellLeg(order: OrderRequest, view: CurveView, fees: PoolFeeRates, platformFeeBps: number): TradeLegResult {
  const reserves = poolReservesOf(view);
  const tokens = order.tokenAmount ?? 0n;
  const quote = quotePoolSell(reserves, tokens, fees);
  return finishSellLeg(
    "pool",
    ratio(reserves.quoteReserves, reserves.baseReserves),
    tokens,
    quote.quoteOut,
    quote.netQuote,
    quote,
    platformFeeBps
  );
}

export function orderIsValid(order: OrderRequest): boolean {
  if (order.side === "buy") {
    const hasBudget = order.quoteBudget !== null && order.quoteBudget > 0n;
    const hasTokens = order.tokenAmount !== null && order.tokenAmount > 0n;
    return hasBudget || hasTokens;
  }
  return order.tokenAmount !== null && order.tokenAmount > 0n;
}

function hasUsableReserves(view: CurveView): boolean {
  return view.virtualTokenReserves > 0n && view.virtualQuoteReserves > 0n;
}

export function marketVenueError(view: CurveView): AttemptError | null {
  if (view.migrated) {
    const poolReservesKnown = view.venue === "pool" || view.venue === "curve_post_complete";
    return poolReservesKnown && hasUsableReserves(view) ? null : "pool_unavailable";
  }
  if (view.complete || view.venue === "curve_post_complete") {
    return "curve_complete";
  }
  return hasUsableReserves(view) ? null : "no_liquidity";
}

export function computeTradeLeg(order: OrderRequest, view: CurveView, config: ExecutionConfig): TradeLegResult {
  if (!orderIsValid(order)) {
    return { error: "invalid_order" };
  }
  const venueError = marketVenueError(view);
  if (venueError) {
    return { error: venueError };
  }
  const platformFeeBps = config.extraPlatformFeeBps;
  if (view.migrated) {
    const fees = resolvePoolFees(view, config);
    return order.side === "buy"
      ? poolBuyLeg(order, view, fees, platformFeeBps)
      : poolSellLeg(order, view, fees, platformFeeBps);
  }
  const fees = resolveCurveFees(view, config);
  return order.side === "buy"
    ? curveBuyLeg(order, view, fees, platformFeeBps)
    : curveSellLeg(order, view, fees, platformFeeBps);
}

export function slippageVersusReference(side: OrderRequest["side"], fillPrice: number, referencePrice: number): number | null {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) {
    return null;
  }
  const adverse = side === "buy" ? fillPrice / referencePrice - 1 : 1 - fillPrice / referencePrice;
  return Math.round(adverse * 10_000);
}

const FULL_RANGE_BPS = 10_000;

export function remainingSlippageBps(
  side: OrderRequest["side"],
  maxSlippageBps: number,
  expectedSlippageBps: number
): number | null {
  if (expectedSlippageBps > maxSlippageBps) {
    return null;
  }
  const max = maxSlippageBps / FULL_RANGE_BPS;
  const expected = expectedSlippageBps / FULL_RANGE_BPS;
  if (side === "sell" && expected >= 1) {
    return maxSlippageBps >= FULL_RANGE_BPS ? FULL_RANGE_BPS : null;
  }
  const remaining = side === "buy" ? (max - expected) / (1 + max) : (max - expected) / (1 - expected);
  return Math.min(FULL_RANGE_BPS, Math.max(0, Math.floor(remaining * FULL_RANGE_BPS)));
}

export function fillPriceOf(leg: Pick<TradeLeg, "userQuote" | "tokenAmount">): number | null {
  if (leg.tokenAmount <= 0n || leg.userQuote <= 0n) {
    return null;
  }
  return ratio(leg.userQuote, leg.tokenAmount);
}

const SENT_ON_CHAIN: ReadonlySet<AttemptError> = new Set<AttemptError>(["tx_failed", "slippage_exceeded", "curve_complete"]);

export function attemptCosts(
  config: ExecutionConfig,
  sent: boolean,
  success: boolean
): { networkFee: bigint; tip: bigint } {
  if (!sent) {
    return { networkFee: 0n, tip: 0n };
  }
  const networkFee = BigInt(config.baseFeeLamports) + BigInt(config.priorityFeeLamports);
  if (config.useJito) {
    return success ? { networkFee, tip: BigInt(config.jitoTipLamports) } : { networkFee: 0n, tip: 0n };
  }
  return { networkFee, tip: 0n };
}

function failedOutcome(
  config: ExecutionConfig,
  view: CurveView,
  error: AttemptError,
  leg: TradeLeg | null,
  order: OrderRequest
): AttemptOutcome {
  const sent = SENT_ON_CHAIN.has(error);
  const costs = attemptCosts(config, sent, false);
  const fillPrice = leg ? fillPriceOf(leg) : null;
  return {
    success: false,
    error,
    sent,
    venue: leg?.venue ?? view.venue,
    trade: leg,
    networkFee: costs.networkFee,
    tip: costs.tip,
    rentPaid: 0n,
    rentRefunded: 0n,
    fillPrice: null,
    priceImpactBps: leg ? executionImpactBps(leg.spotPrice, leg.executionPrice) : null,
    slippageBps: fillPrice === null ? null : slippageVersusReference(order.side, fillPrice, order.referencePrice)
  };
}

function rentFor(input: SimulateAttemptInput): { rentPaid: bigint; rentRefunded: bigint } {
  const rent = BigInt(input.config.ataRentLamports);
  if (input.order.side === "buy") {
    return { rentPaid: input.isFirstBuyOfPosition ? rent : 0n, rentRefunded: 0n };
  }
  const refunds = input.order.closesPosition && input.config.refundAtaOnClose;
  return { rentPaid: 0n, rentRefunded: refunds ? rent : 0n };
}

export function simulateAttempt(input: SimulateAttemptInput): AttemptOutcome {
  const { order, view, config } = input;
  const failureDraw = input.rng();
  const computed = computeTradeLeg(order, view, config);
  if ("error" in computed) {
    return failedOutcome(config, view, computed.error, null, order);
  }
  const leg = computed.leg;
  if (failureDraw < config.failureRate) {
    return failedOutcome(config, view, "tx_failed", leg, order);
  }
  const fillPrice = fillPriceOf(leg);
  const slippageBps = fillPrice === null ? null : slippageVersusReference(order.side, fillPrice, order.referencePrice);
  if (slippageBps !== null && slippageBps > order.maxSlippageBps) {
    return failedOutcome(config, view, "slippage_exceeded", leg, order);
  }
  const costs = attemptCosts(config, true, true);
  return {
    success: true,
    error: null,
    sent: true,
    venue: leg.venue,
    trade: leg,
    networkFee: costs.networkFee,
    tip: costs.tip,
    ...rentFor(input),
    fillPrice,
    priceImpactBps: executionImpactBps(leg.spotPrice, leg.executionPrice),
    slippageBps
  };
}
