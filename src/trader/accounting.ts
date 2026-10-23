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
import { successfulFill, walletOutflow, type FillAmounts } from "../execution/fill.js";
import { computeTradeLeg, fillPriceOf } from "../execution/model.js";
import { isUsablePrice, valueAtPrice } from "../exits/math.js";
import { serializeExitState } from "../exits/state.js";
import { ORDER_KEY_META } from "./ids.js";

export const ENTRY_FAILED_REASON = "entry_failed";
export const SYNTHETIC_CLOSE_NOTE = "synthetic_close";
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

export function openPositionFromFill(seed: PositionSeed, fill: FillResult): Position {
  const entryPrice = effectiveFillPrice(fill);
  const openedAtMs = fill.filledAtMs ?? seed.nowMs;
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
    openedSlot: fill.filledSlot ?? seed.slot,
    entryPrice,
    entryTokens: fill.tokenAmount,
    entryCost: entryCostOf(fill),
    tokensHeld: fill.tokenAmount,
    proceeds: 0n,
    feesPaid: costsOf(fill),
    peakPrice: entryPrice,
    lastPrice: entryPrice,
    takeProfitLevelsHit: 0,
    migratedSeen: seed.migrated,
    status: "open",
    closedAtMs: null,
    exitReason: null,
    shadowOf: seed.shadowOf,
    meta: baseMeta(seed, openedAtMs)
  };
}

export function failedEntryPosition(seed: PositionSeed, fill: FillResult): Position {
  return {
    id: seed.id,
    runId: seed.runId,
    mode: seed.mode,
    mint: seed.signal.mint,
    launchId: seed.launchId,
    signalId: seed.signalId,
    signalType: seed.signal.type,
    riskScore: seed.signal.riskScore,
    openedAtMs: seed.nowMs,
    openedSlot: seed.slot,
    entryPrice: 0,
    entryTokens: 0n,
    entryCost: entryCostOf(fill),
    tokensHeld: 0n,
    proceeds: 0n,
    feesPaid: costsOf(fill),
    peakPrice: 0,
    lastPrice: 0,
    takeProfitLevelsHit: 0,
    migratedSeen: seed.migrated,
    status: "closed",
    closedAtMs: seed.nowMs,
    exitReason: ENTRY_FAILED_REASON,
    shadowOf: seed.shadowOf,
    meta: { ...baseMeta(seed, seed.nowMs), entryError: truncatedError(fill.error) }
  };
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
  const computed = view && position.tokensHeld > 0n ? computeTradeLeg(order, view, execution) : null;
  const amounts = computed && "leg" in computed ? computed.leg : fallbackSellAmounts(position.tokensHeld, price, execution, view);
  const slot = view?.slot ?? 0;
  const attempt: FillAttempt = {
    atMs: nowMs,
    slot,
    success: true,
    error: null,
    networkFee: BigInt(execution.baseFeeLamports) + BigInt(execution.priorityFeeLamports),
    tip: 0n
  };
  const fill = successfulFill({
    order,
    amounts,
    quality: { fillPrice: fillPriceOf(amounts), slippageBps: null, priceImpactBps: null },
    attempts: [attempt],
    filledAtMs: nowMs,
    filledSlot: slot,
    rentPaid: 0n,
    rentRefunded: execution.refundAtaOnClose ? BigInt(execution.ataRentLamports) : 0n,
    signature: null,
    note: SYNTHETIC_CLOSE_NOTE
  });
  return { order, fill };
}
