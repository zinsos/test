import type { FillAttempt, FillResult, OrderRequest, TradeVenue } from "../core/types.js";

export const UNCONFIRMED_ERROR = "unconfirmed";
export const HALTED_ERROR = "halted";

export interface FillAmounts {
  venue: TradeVenue;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  lpFee: bigint;
  extraPlatformFee: bigint;
}

export interface FillQuality {
  fillPrice: number | null;
  slippageBps: number | null;
  priceImpactBps: number | null;
}

export function sumAttemptCosts(attempts: readonly FillAttempt[]): { networkFees: bigint; tips: bigint } {
  let networkFees = 0n;
  let tips = 0n;
  for (const attempt of attempts) {
    networkFees += attempt.networkFee;
    tips += attempt.tip;
  }
  return { networkFees, tips };
}

export function failedFill(
  order: OrderRequest,
  error: string,
  attempts: readonly FillAttempt[],
  venue: TradeVenue,
  quality: Partial<FillQuality> = {}
): FillResult {
  const costs = sumAttemptCosts(attempts);
  return {
    side: order.side,
    mint: order.mint,
    success: false,
    venue,
    requestedAtMs: order.signalAtMs,
    requestedSlot: order.signalSlot,
    filledAtMs: null,
    filledSlot: null,
    tokenAmount: 0n,
    quoteAmount: 0n,
    userQuote: 0n,
    protocolFee: 0n,
    creatorFee: 0n,
    lpFee: 0n,
    extraPlatformFee: 0n,
    networkFees: costs.networkFees,
    tips: costs.tips,
    rentPaid: 0n,
    rentRefunded: 0n,
    referencePrice: order.referencePrice,
    fillPrice: null,
    slippageBps: quality.slippageBps ?? null,
    priceImpactBps: quality.priceImpactBps ?? null,
    attempts: [...attempts],
    signature: null,
    error
  };
}

export interface SuccessfulFillInput {
  order: OrderRequest;
  amounts: FillAmounts;
  quality: FillQuality;
  attempts: readonly FillAttempt[];
  filledAtMs: number;
  filledSlot: number;
  rentPaid: bigint;
  rentRefunded: bigint;
  signature: string | null;
  note?: string | null;
}

export function successfulFill(input: SuccessfulFillInput): FillResult {
  const costs = sumAttemptCosts(input.attempts);
  return {
    side: input.order.side,
    mint: input.order.mint,
    success: true,
    venue: input.amounts.venue,
    requestedAtMs: input.order.signalAtMs,
    requestedSlot: input.order.signalSlot,
    filledAtMs: input.filledAtMs,
    filledSlot: input.filledSlot,
    tokenAmount: input.amounts.tokenAmount,
    quoteAmount: input.amounts.quoteAmount,
    userQuote: input.amounts.userQuote,
    protocolFee: input.amounts.protocolFee,
    creatorFee: input.amounts.creatorFee,
    lpFee: input.amounts.lpFee,
    extraPlatformFee: input.amounts.extraPlatformFee,
    networkFees: costs.networkFees,
    tips: costs.tips,
    rentPaid: input.rentPaid,
    rentRefunded: input.rentRefunded,
    referencePrice: input.order.referencePrice,
    fillPrice: input.quality.fillPrice,
    slippageBps: input.quality.slippageBps,
    priceImpactBps: input.quality.priceImpactBps,
    attempts: [...input.attempts],
    signature: input.signature,
    error: input.note ?? null
  };
}

export function walletOutflow(fill: FillResult): bigint {
  const tradeFlow = fill.side === "buy" ? fill.userQuote : -fill.userQuote;
  return tradeFlow + fill.networkFees + fill.tips + fill.rentPaid - fill.rentRefunded;
}

export function withEarlierAttempts(fill: FillResult, earlier: readonly FillAttempt[]): FillResult {
  const prior = earlier.filter((attempt) => attempt.error !== UNCONFIRMED_ERROR);
  if (prior.length === 0) {
    return fill;
  }
  const attempts = [...prior, ...fill.attempts];
  return { ...fill, attempts, ...sumAttemptCosts(attempts) };
}

export function sentAtMsOf(fill: Pick<FillResult, "attempts" | "requestedAtMs">): number {
  return fill.attempts.at(-1)?.atMs ?? fill.requestedAtMs;
}
