import { executionImpactBps } from "../chain/curve.js";
import { SOL_QUOTE } from "../core/constants.js";
import type { OrderRequest, TradeVenue } from "../core/types.js";
import type { FillAmounts, FillQuality } from "./fill.js";
import type { ParsedFill } from "./fillParser.js";
import { fillPriceOf, slippageVersusReference } from "./model.js";

const CURVE_SLIPPAGE_CODES = new Set([6002, 6003, 6042]);
const CURVE_COMPLETE_CODES = new Set([6005]);
const POOL_SLIPPAGE_CODES = new Set([6004, 6040]);

export function customErrorCode(err: unknown): number | null {
  if (!err || typeof err !== "object" || !("InstructionError" in err)) {
    return null;
  }
  const detail = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(detail)) {
    return null;
  }
  const reason: unknown = detail[1];
  if (reason && typeof reason === "object" && "Custom" in reason) {
    const code = (reason as { Custom: unknown }).Custom;
    return typeof code === "number" ? code : null;
  }
  return null;
}

export function classifyOnChainError(venue: TradeVenue, err: unknown): string {
  const code = customErrorCode(err);
  if (code === null) {
    return "tx_failed";
  }
  if (venue === "pool") {
    return POOL_SLIPPAGE_CODES.has(code) ? "slippage_exceeded" : "tx_failed";
  }
  if (CURVE_COMPLETE_CODES.has(code)) {
    return "curve_complete";
  }
  return CURVE_SLIPPAGE_CODES.has(code) ? "slippage_exceeded" : "tx_failed";
}

export function amountsFromParsed(parsed: ParsedFill, tipLamports: bigint, side: OrderRequest["side"]): FillAmounts {
  if (parsed.tradeEvents > 0) {
    return {
      venue: parsed.venue ?? "curve",
      tokenAmount: parsed.tokenAmount,
      quoteAmount: parsed.quoteAmount,
      userQuote: parsed.userQuote,
      protocolFee: parsed.protocolFee,
      creatorFee: parsed.creatorFee,
      lpFee: parsed.lpFee,
      extraPlatformFee: 0n
    };
  }
  const tokens = parsed.tokenDelta < 0n ? -parsed.tokenDelta : parsed.tokenDelta;
  const nonTradeCosts = parsed.networkFee + parsed.rentPaid - parsed.rentRefunded + tipLamports;
  const valueDelta = parsed.solDelta + parsed.wrappedSolDelta;
  const userQuote = side === "buy" ? -valueDelta - nonTradeCosts : valueDelta + nonTradeCosts;
  return {
    venue: parsed.venue ?? "curve",
    tokenAmount: tokens,
    quoteAmount: userQuote > 0n ? userQuote : 0n,
    userQuote: userQuote > 0n ? userQuote : 0n,
    protocolFee: 0n,
    creatorFee: 0n,
    lpFee: 0n,
    extraPlatformFee: 0n
  };
}

export function outflowBeyondTrade(parsed: ParsedFill, tipLamports: bigint): bigint {
  if (parsed.tradeEvents === 0 || parsed.quoteMint !== SOL_QUOTE) {
    return tipLamports;
  }
  return parsed.unexplainedLamports > tipLamports ? parsed.unexplainedLamports : tipLamports;
}

export function qualityOf(order: OrderRequest, amounts: FillAmounts, spotPrice: number | null): FillQuality {
  const fillPrice = fillPriceOf(amounts);
  const executionPrice = amounts.tokenAmount > 0n ? Number(amounts.quoteAmount) / Number(amounts.tokenAmount) : 0;
  return {
    fillPrice,
    slippageBps: fillPrice === null ? null : slippageVersusReference(order.side, fillPrice, order.referencePrice),
    priceImpactBps: spotPrice === null || executionPrice <= 0 ? null : executionImpactBps(spotPrice, executionPrice)
  };
}
