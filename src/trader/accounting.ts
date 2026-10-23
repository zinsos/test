import type { ExecutionConfig } from "../config/strategy.js";
import type {
  ClosedTrade,
  CurveView,
  FillAttempt,
  FillResult,
  OrderRequest,
  OrderUrgency,
  Position,
  Pubkey,
  Signal,
  TradingMode
} from "../core/types.js";
import { sentAtMsOf, successfulFill, UNCONFIRMED_ERROR, walletOutflow, type FillAmounts } from "../execution/fill.js";
import { attemptCosts, computeTradeLeg, fillPriceOf, slippageVersusReference } from "../execution/model.js";
import { isUsablePrice, valueAtPrice } from "../exits/math.js";
import { serializeExitState } from "../exits/state.js";
import { ORDER_KEY_META } from "./ids.js";

export const ENTRY_FAILED_REASON = "entry_failed";
export const EXTERNAL_EXIT_REASON = "external_or_unknown_exit";
export const SYNTHETIC_CLOSE_NOTE = "synthetic_close";
export const EXTERNAL_EXIT_NOTE = "external_exit_estimated";
export const WALLET_BALANCE_FILL_NOTE = "fill_from_wallet_balance";
const MAX_ERROR_TEXT = 300;
const FULL_SLIPPAGE_BPS = 10_000;

export interface PositionSeed {
  id: string;
  runId: number;
  mode: TradingMode;
  signal: Signal;
  signalId: number | null;
  launchId: number | null;
  shadowOf: string | null;
  orderKey: string;
  migrated: boolean;
  nowMs: number;
  slot: number;
}

export interface SellIntent {
  tokenAmount: bigint;
  reason: string;
  urgency: OrderUrgency;
  maxSlippageBps: number;
  closesPosition: boolean;
}

export function tradingFeesOf(fill: FillResult): bigint {
  return fill.protocolFee + fill.creatorFee + fill.lpFee + fill.extraPlatformFee;
}

export function costsOf(fill: FillResult): bigint {
  return tradingFeesOf(fill) + fill.networkFees + fill.tips;
}

export function entryCostOf(fill: FillResult): bigint {
  const outflow = walletOutflow(fill);
  return outflow > 0n ? outflow : 0n;
}

export function sellProceedsOf(fill: FillResult): bigint {
  return -walletOutflow(fill);
}

export function effectiveFillPrice(fill: Pick<FillResult, "fillPrice" | "userQuote" | "tokenAmount">): number {
  if (fill.fillPrice !== null && isUsablePrice(fill.fillPrice)) {
    return fill.fillPrice;
  }
  if (fill.tokenAmount > 0n && fill.userQuote > 0n) {
    return Number(fill.userQuote) / Number(fill.tokenAmount);
  }
  return 0;
}

function truncatedError(error: string | null): string | null {
  if (error === null) {
    return null;
  }
  return error.length > MAX_ERROR_TEXT ? `${error.slice(0, MAX_ERROR_TEXT)}...` : error;
}

function signalMeta(signal: Signal): Record<string, unknown> {
  return {
    type: signal.type,
    atMs: signal.atMs,
    slot: signal.slot,
    wallets: signal.wallets.length,
    riskScore: signal.riskScore
  };
}

function baseMeta(seed: PositionSeed, openedAtMs: number): Record<string, unknown> {
  const meta: Record<string, unknown> = { [ORDER_KEY_META]: seed.orderKey, signal: signalMeta(seed.signal) };
  if (seed.migrated) {
    meta.exit = serializeExitState({ liquidating: null, migratedSeenAtMs: openedAtMs });
  }
  return meta;
}

export function entrySkeleton(seed: PositionSeed, openedAtMs: number, openedSlot: number): Position {
  return {
    id: seed.id,
    runId: seed.runId,
    mode: seed.mode,
    mint: seed.signal.mint,
    launchId: seed.launchId,
    signalId: seed.signalId,
    signalType: seed.signal.type,
    riskScore: seed.signal.riskScore,
    openedAtMs,
    openedSlot,
    entryPrice: 0,
    entryTokens: 0n,
    entryCost: 0n,
    tokensHeld: 0n,
    proceeds: 0n,
    feesPaid: 0n,
    peakPrice: 0,
    lastPrice: 0,
    takeProfitLevelsHit: 0,
    migratedSeen: seed.migrated,
    status: "pending",
    closedAtMs: null,
    exitReason: null,
    shadowOf: seed.shadowOf,
    meta: baseMeta(seed, openedAtMs)
  };
}

export function withEntryFill(position: Position, fill: FillResult): Position {
  const entryPrice = effectiveFillPrice(fill);
  return {
    ...position,
    entryPrice,
    entryTokens: fill.tokenAmount,
    entryCost: entryCostOf(fill),
    tokensHeld: fill.tokenAmount,
    proceeds: 0n,
    feesPaid: costsOf(fill),
    peakPrice: entryPrice,
    lastPrice: entryPrice,
    status: "open"
  };
}

export function openPositionFromFill(seed: PositionSeed, fill: FillResult): Position {
  return withEntryFill(entrySkeleton(seed, fill.filledAtMs ?? seed.nowMs, fill.filledSlot ?? seed.slot), fill);
}

export function failedEntryPosition(seed: PositionSeed, fill: FillResult): Position {
  const skeleton = entrySkeleton(seed, seed.nowMs, seed.slot);
  return {
    ...skeleton,
    entryCost: entryCostOf(fill),
    feesPaid: costsOf(fill),
    status: "closed",
    closedAtMs: seed.nowMs,
    exitReason: ENTRY_FAILED_REASON,
    meta: { ...skeleton.meta, entryError: truncatedError(fill.error) }
  };
}

export function walletBalanceEntryFill(order: OrderRequest, unresolved: FillResult, tokens: bigint, execution: ExecutionConfig): FillResult {
  const spent = order.quoteBudget ?? 0n;
  const atMs = sentAtMsOf(unresolved);
  const slot = unresolved.attempts.at(-1)?.slot ?? order.signalSlot;
  const costs = attemptCosts(execution, true, true);
  const landed: FillAttempt = { atMs, slot, success: true, error: null, networkFee: costs.networkFee, tip: costs.tip };
  const amounts: FillAmounts = {
    venue: unresolved.venue,
    tokenAmount: tokens,
    quoteAmount: spent,
    userQuote: spent,
    protocolFee: 0n,
    creatorFee: 0n,
    lpFee: 0n,
    extraPlatformFee: 0n
  };
  const fillPrice = fillPriceOf(amounts);
  return successfulFill({
    order,
    amounts,
    quality: {
      fillPrice,
      slippageBps: fillPrice === null ? null : slippageVersusReference("buy", fillPrice, order.referencePrice),
      priceImpactBps: null
    },
    attempts: [...unresolved.attempts.filter((attempt) => attempt.error !== UNCONFIRMED_ERROR), landed],
    filledAtMs: atMs,
    filledSlot: slot,
    rentPaid: BigInt(execution.ataRentLamports),
    rentRefunded: 0n,
    signature: unresolved.signature,
    note: WALLET_BALANCE_FILL_NOTE
  });
}

export function applySellFill(position: Position, order: Pick<OrderRequest, "closesPosition">, fill: FillResult): Position {
  const sold = fill.success ? (fill.tokenAmount < position.tokensHeld ? fill.tokenAmount : position.tokensHeld) : 0n;
  const remaining = fill.success && order.closesPosition ? 0n : position.tokensHeld - sold;
  return {
    ...position,
    tokensHeld: remaining > 0n ? remaining : 0n,
    proceeds: position.proceeds + sellProceedsOf(fill),
    feesPaid: position.feesPaid + costsOf(fill)
  };
}

export function closePosition(position: Position, nowMs: number, reason: string): Position {
  return { ...position, status: "closed", closedAtMs: nowMs, exitReason: reason };
}

export function holdSecondsOf(position: Pick<Position, "openedAtMs" | "closedAtMs">, nowMs?: number): number {
  const end = position.closedAtMs ?? nowMs ?? position.openedAtMs;
  return Math.max(0, (end - position.openedAtMs) / 1000);
}

export function peakMultipleOf(position: Pick<Position, "peakPrice" | "entryPrice">): number {
  if (!isUsablePrice(position.entryPrice) || !isUsablePrice(position.peakPrice)) {
    return 0;
  }
  return position.peakPrice / position.entryPrice;
}

export function realizedPnlOf(position: Pick<Position, "proceeds" | "entryCost">): bigint {
  return position.proceeds - position.entryCost;
}

export function closedTradeOf(position: Position): ClosedTrade {
  const closedAtMs = position.closedAtMs ?? position.openedAtMs;
  return {
    positionId: position.id,
    runId: position.runId,
    mode: position.mode,
    mint: position.mint,
    signalType: position.signalType,
    riskScore: position.riskScore,
    openedAtMs: position.openedAtMs,
    closedAtMs,
    holdSec: holdSecondsOf({ openedAtMs: position.openedAtMs, closedAtMs }),
    cost: position.entryCost,
    proceeds: position.proceeds,
    pnl: realizedPnlOf(position),
    fees: position.feesPaid,
    exitReason: position.exitReason ?? "unknown",
    peakMultiple: peakMultipleOf(position)
  };
}

export function sellOrderFor(
  position: Pick<Position, "mint">,
  intent: SellIntent,
  view: Pick<CurveView, "slot"> | null,
  price: number,
  nowMs: number,
  orderKey: string
): OrderRequest {
  return {
    side: "sell",
    mint: position.mint,
    quoteBudget: null,
    tokenAmount: intent.tokenAmount,
    maxSlippageBps: intent.maxSlippageBps,
    reason: intent.reason,
    urgency: intent.urgency,
    signalSlot: view?.slot ?? 0,
    signalAtMs: nowMs,
    referencePrice: price,
    positionId: orderKey,
    closesPosition: intent.closesPosition
  };
}

function markOrder(mint: Pubkey, tokens: bigint, view: CurveView): OrderRequest {
  return sellOrderFor(
    { mint },
    { tokenAmount: tokens, reason: "mark", urgency: "normal", maxSlippageBps: FULL_SLIPPAGE_BPS, closesPosition: true },
    view,
    0,
    view.atMs,
    "mark"
  );
}

export function liquidationValue(
  position: Pick<Position, "mint" | "tokensHeld" | "lastPrice">,
  view: CurveView | null,
  execution: ExecutionConfig
): bigint {
  if (position.tokensHeld <= 0n) {
    return 0n;
  }
  if (view) {
    const leg = computeTradeLeg(markOrder(position.mint, position.tokensHeld, view), view, execution);
    if ("leg" in leg) {
      return leg.leg.userQuote;
    }
  }
  return valueAtPrice(position.tokensHeld, position.lastPrice);
}

export function unrealizedPnlOf(position: Position, view: CurveView | null, execution: ExecutionConfig): bigint {
  return position.proceeds + liquidationValue(position, view, execution) - position.entryCost;
}

export function isDust(tokens: bigint, price: number, dustLamports: bigint): boolean {
  if (tokens <= 0n) {
    return true;
  }
  return isUsablePrice(price) && valueAtPrice(tokens, price) < dustLamports;
}

function fallbackSellAmounts(tokens: bigint, price: number, execution: ExecutionConfig, view: CurveView | null): FillAmounts {
  const gross = valueAtPrice(tokens, price);
  const feeBps = BigInt(execution.defaultProtocolFeeBps + execution.defaultCreatorFeeBps);
  const fee = (gross * feeBps) / 10_000n;
  return {
    venue: view?.venue ?? "curve",
    tokenAmount: tokens,
    quoteAmount: gross,
    userQuote: gross - fee,
    protocolFee: fee,
    creatorFee: 0n,
    lpFee: 0n,
    extraPlatformFee: 0n
  };
}

export interface SyntheticClose {
  order: OrderRequest;
  fill: FillResult;
}

function estimatedSellAmounts(order: OrderRequest, view: CurveView | null, price: number, execution: ExecutionConfig): FillAmounts {
  const tokens = order.tokenAmount ?? 0n;
  const computed = view && tokens > 0n ? computeTradeLeg(order, view, execution) : null;
  return computed && "leg" in computed ? computed.leg : fallbackSellAmounts(tokens, price, execution, view);
}

function estimatedSellFill(
  order: OrderRequest,
  view: CurveView | null,
  price: number,
  execution: ExecutionConfig,
  attempts: FillAttempt[],
  rentRefunded: bigint,
  note: string
): FillResult {
  const amounts = estimatedSellAmounts(order, view, price, execution);
  const slot = view?.slot ?? 0;
  return successfulFill({
    order,
    amounts,
    quality: { fillPrice: fillPriceOf(amounts), slippageBps: null, priceImpactBps: null },
    attempts,
    filledAtMs: order.signalAtMs,
    filledSlot: slot,
    rentPaid: 0n,
    rentRefunded,
    signature: null,
    note
  });
}

export function syntheticCloseFill(
  position: Pick<Position, "mint" | "tokensHeld">,
  view: CurveView | null,
  price: number,
  execution: ExecutionConfig,
  nowMs: number,
  reason: string,
  orderKey: string
): SyntheticClose {
  const intent: SellIntent = {
    tokenAmount: position.tokensHeld,
    reason,
    urgency: "emergency",
    maxSlippageBps: FULL_SLIPPAGE_BPS,
    closesPosition: true
  };
  const order = sellOrderFor(position, intent, view, price, nowMs, orderKey);
  const attempt: FillAttempt = {
    atMs: nowMs,
    slot: view?.slot ?? 0,
    success: true,
    error: null,
    networkFee: BigInt(execution.baseFeeLamports) + BigInt(execution.priorityFeeLamports),
    tip: 0n
  };
  const rentRefunded = execution.refundAtaOnClose ? BigInt(execution.ataRentLamports) : 0n;
  return { order, fill: estimatedSellFill(order, view, price, execution, [attempt], rentRefunded, SYNTHETIC_CLOSE_NOTE) };
}

export function externalExitFill(
  position: Pick<Position, "mint" | "tokensHeld">,
  tokens: bigint,
  view: CurveView | null,
  price: number,
  execution: ExecutionConfig,
  nowMs: number,
  orderKey: string
): SyntheticClose {
  const intent: SellIntent = {
    tokenAmount: tokens,
    reason: EXTERNAL_EXIT_REASON,
    urgency: "normal",
    maxSlippageBps: FULL_SLIPPAGE_BPS,
    closesPosition: tokens >= position.tokensHeld
  };
  const order = sellOrderFor(position, intent, view, price, nowMs, orderKey);
  return { order, fill: estimatedSellFill(order, view, price, execution, [], 0n, EXTERNAL_EXIT_NOTE) };
}
