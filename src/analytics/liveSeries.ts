import type { ExecutionConfig, ExitConfig } from "../config/strategy.js";
import type { Position, Pubkey } from "../core/types.js";
import { isUsablePrice, multipleOf } from "../exits/math.js";
import { isSwitchedToPool, moonbagTokensOf, sortedTakeProfitLevels, trailFractionFor } from "../exits/rules.js";
import { readExitState } from "../exits/state.js";
import type { LaunchState, TradeRecord } from "../market/state.js";
import { effectiveFillPrice } from "../trader/accounting.js";
import { estimatedCloseProceeds, sellFeeBpsFor, sellFeeDefaultsOf, type LastTradeFees, type StoredFill } from "./positionQueries.js";
import { lamportsRatio, lamportsToSol } from "./units.js";

export const SERIES_LOOKBACK_MS = 60_000;
export const MAX_SERIES_POINTS = 400;
export const MAX_FILL_MARKERS = 40;
export const SPARKLINE_POINTS = 48;
const SECOND_MS = 1_000;
const MAX_SYMBOL_LENGTH = 16;
const LAMPORTS_PER_SOL_NUMBER = 1_000_000_000;
const PERCENT = 100;

export interface LiveMarket {
  get(mint: Pubkey): LaunchState | undefined;
}

export interface TakeProfitLevelView {
  multiple: number;
  price: number;
  sellPctOfInitial: number;
}

export interface ExitLevels {
  entryPrice: number;
  stopLossPrice: number | null;
  trailingStopPrice: number | null;
  moonbagStopPrice: number | null;
  trailFraction: number | null;
  nextTakeProfit: TakeProfitLevelView | null;
  takeProfits: TakeProfitLevelView[];
  timeStopAtMs: number | null;
  maxHoldAtMs: number;
}

export interface LivePositionView {
  id: string;
  mint: Pubkey;
  symbol: string | null;
  name: string | null;
  mode: string;
  signalType: string;
  riskScore: number | null;
  openedAtMs: number;
  ageSec: number;
  entryPrice: number;
  price: number | null;
  multiple: number | null;
  peakMultiple: number | null;
  costSol: number;
  proceedsSol: number;
  pnlEstimateSol: number | null;
  pnlEstimatePct: number | null;
  soldPct: number;
  takeProfitLevelsHit: number;
  migrated: boolean;
  exiting: string | null;
  lastTradeAtMs: number | null;
  marketCapSol: number | null;
  levels: ExitLevels;
}

export interface SeriesPoint {
  atMs: number;
  price: number;
}

export type FillSide = "buy" | "sell";

export interface FillMarker {
  side: FillSide;
  atMs: number;
  price: number;
  reason: string | null;
  pctOfEntry: number | null;
  sol: number;
  source: "fill" | "position";
}

export interface PositionSeries {
  position: LivePositionView;
  fromMs: number;
  totalTrades: number;
  points: SeriesPoint[];
  fills: FillMarker[];
  inMemory: boolean;
}

export interface LiveConfig {
  exits: ExitConfig;
  execution: ExecutionConfig;
}

export function cleanSymbol(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = [...value]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127 && !(code >= 0x200b && code <= 0x200f) && !(code >= 0x202a && code <= 0x202e);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return null;
  }
  const chars = [...cleaned];
  return chars.length > MAX_SYMBOL_LENGTH ? `${chars.slice(0, MAX_SYMBOL_LENGTH - 1).join("")}…` : cleaned;
}

function soldPctOf(position: Pick<Position, "entryTokens" | "tokensHeld">): number {
  if (position.entryTokens <= 0n) {
    return 0;
  }
  const sold = position.entryTokens - position.tokensHeld;
  const ratio = lamportsRatio(sold > 0n ? sold : 0n, position.entryTokens) ?? 0;
  return Math.max(0, Math.min(PERCENT, ratio * PERCENT));
}

export function exitLevels(position: Position, config: ExitConfig): ExitLevels {
  const entry = position.entryPrice;
  const state = readExitState(position);
  const switched = isSwitchedToPool({ migratedSeen: position.migratedSeen, config });
  const holdSince = switched ? state.migratedSeenAtMs ?? position.openedAtMs : position.openedAtMs;
  const maxHoldAtMs = holdSince + (switched ? config.migration.timeStopSec : config.maxHoldSec) * SECOND_MS;
  if (!isUsablePrice(entry)) {
    return {
      entryPrice: entry,
      stopLossPrice: null,
      trailingStopPrice: null,
      moonbagStopPrice: null,
      trailFraction: null,
      nextTakeProfit: null,
      takeProfits: [],
      timeStopAtMs: null,
      maxHoldAtMs
    };
  }
  const peak = isUsablePrice(position.peakPrice) ? Math.max(position.peakPrice, entry) : entry;
  const fraction = trailFractionFor(multipleOf(peak, entry), { migratedSeen: position.migratedSeen, config });
  const moonbag = moonbagTokensOf(position, config);
  const hit = Math.max(0, Math.floor(position.takeProfitLevelsHit));
  const takeProfits = sortedTakeProfitLevels(config)
    .slice(hit)
    .map((level) => ({
      multiple: level.atMultiple,
      price: entry * level.atMultiple,
      sellPctOfInitial: level.sellFractionOfInitial * PERCENT
    }));
  const flatStopApplies = hit === 0 && position.tokensHeld > moonbag;
  return {
    entryPrice: entry,
    stopLossPrice: entry * config.stopLossMultiple,
    trailingStopPrice: fraction !== null && position.tokensHeld > moonbag ? peak * (1 - fraction) : null,
    moonbagStopPrice: fraction !== null ? peak * (1 - config.moonbagTrailFraction) : null,
    trailFraction: fraction,
    nextTakeProfit: takeProfits[0] ?? null,
    takeProfits,
    timeStopAtMs: flatStopApplies ? position.openedAtMs + config.timeStop.afterSec * SECOND_MS : null,
    maxHoldAtMs
  };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function lastTradeFeesOf(launch: LaunchState | undefined): LastTradeFees | null {
  if (!launch || launch.protocolFeeBps === null) {
    return null;
  }
  return {
    protocolBps: launch.protocolFeeBps,
    creatorBps: launch.creatorFeeBps ?? 0,
    lpBps: launch.venue === "pool" ? (launch.lpFeeBps ?? 0) : 0
  };
}

export function estimatedOpenPnl(position: Position, launch: LaunchState | undefined, price: number | null, execution: ExecutionConfig): bigint | null {
  if (price === null || position.status !== "open" || position.entryTokens <= 0n) {
    return null;
  }
  const defaults = sellFeeDefaultsOf(execution);
  const fee = sellFeeBpsFor(lastTradeFeesOf(launch), position.migratedSeen || (launch?.migrated ?? false), defaults);
  return position.proceeds + estimatedCloseProceeds(position.tokensHeld, price, fee, defaults) - position.entryCost;
}

export function marketCapSolAt(launch: LaunchState | undefined, price: number | null): number | null {
  if (!launch || price === null || !launch.isSolQuoted || launch.info.tokenTotalSupply <= 0n) {
    return null;
  }
  return finiteOrNull((price * Number(launch.info.tokenTotalSupply)) / LAMPORTS_PER_SOL_NUMBER);
}

export function livePositionView(position: Position, launch: LaunchState | undefined, config: LiveConfig, nowMs: number): LivePositionView {
  const spot = launch ? launch.price() : 0;
  const price = isUsablePrice(spot) ? spot : isUsablePrice(position.lastPrice) ? position.lastPrice : null;
  const peakPrice = Math.max(isUsablePrice(position.peakPrice) ? position.peakPrice : 0, price ?? 0);
  const pnl = estimatedOpenPnl(position, launch, price, config.execution);
  const costSol = lamportsToSol(position.entryCost);
  const pnlSol = pnl === null ? null : lamportsToSol(pnl);
  return {
    id: position.id,
    mint: position.mint,
    symbol: cleanSymbol(launch?.info.symbol),
    name: cleanSymbol(launch?.info.name),
    mode: position.mode,
    signalType: position.signalType,
    riskScore: position.riskScore,
    openedAtMs: position.openedAtMs,
    ageSec: Math.max(0, (nowMs - position.openedAtMs) / SECOND_MS),
    entryPrice: position.entryPrice,
    price,
    multiple: price === null ? null : finiteOrNull(multipleOf(price, position.entryPrice)),
    peakMultiple: peakPrice > 0 ? finiteOrNull(multipleOf(peakPrice, position.entryPrice)) : null,
    costSol,
    proceedsSol: lamportsToSol(position.proceeds),
    pnlEstimateSol: pnlSol,
    pnlEstimatePct: pnlSol !== null && costSol > 0 ? (pnlSol / costSol) * PERCENT : null,
    soldPct: soldPctOf(position),
    takeProfitLevelsHit: position.takeProfitLevelsHit,
    migrated: position.migratedSeen || (launch?.migrated ?? false),
    exiting: readExitState(position).liquidating?.reason ?? null,
    lastTradeAtMs: launch?.lastTradeAtMs ?? null,
    marketCapSol: marketCapSolAt(launch, price),
    levels: exitLevels({ ...position, peakPrice: peakPrice > 0 ? peakPrice : position.peakPrice }, config.exits)
  };
}

function firstTradeAtOrAfter(trades: readonly TradeRecord[], atMs: number): number {
  let low = 0;
  let high = trades.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const trade = trades[mid];
    if (trade && trade.atMs < atMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function storedFillPrice(fill: StoredFill): number | null {
  const price = effectiveFillPrice({ fillPrice: fill.price, userQuote: fill.userQuote, tokenAmount: fill.tokenAmount });
  return isUsablePrice(price) ? price : null;
}

function fillSideOf(side: string): FillSide | null {
  return side === "buy" || side === "sell" ? side : null;
}

export function fillMarkers(position: Pick<Position, "openedAtMs" | "entryPrice" | "entryTokens" | "entryCost">, fills: readonly StoredFill[]): FillMarker[] {
  const markers: FillMarker[] = [];
  for (const fill of fills) {
    const side = fillSideOf(fill.side);
    const price = storedFillPrice(fill);
    if (side === null || price === null || !Number.isFinite(fill.atMs) || fill.atMs <= 0) {
      continue;
    }
    const share = position.entryTokens > 0n ? lamportsRatio(fill.tokenAmount, position.entryTokens) : null;
    markers.push({
      side,
      atMs: fill.atMs,
      price,
      reason: fill.reason,
      pctOfEntry: share === null ? null : Math.max(0, share * PERCENT),
      sol: lamportsToSol(fill.userQuote),
      source: "fill"
    });
  }
  if (!markers.some((marker) => marker.side === "buy") && isUsablePrice(position.entryPrice)) {
    markers.push({
      side: "buy",
      atMs: position.openedAtMs,
      price: position.entryPrice,
      reason: null,
      pctOfEntry: PERCENT,
      sol: lamportsToSol(position.entryCost),
      source: "position"
    });
  }
  markers.sort((a, b) => a.atMs - b.atMs);
  return markers.slice(-MAX_FILL_MARKERS);
}

export function downsamplePoints(points: readonly SeriesPoint[], maxPoints: number = MAX_SERIES_POINTS): SeriesPoint[] {
  if (points.length <= maxPoints) {
    return [...points];
  }
  const buckets = Math.max(1, Math.floor((maxPoints - 1) / 2));
  const size = points.length / buckets;
  const result: SeriesPoint[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor(bucket * size);
    const end = Math.min(points.length, Math.floor((bucket + 1) * size));
    let low: SeriesPoint | null = null;
    let lowIndex = -1;
    let high: SeriesPoint | null = null;
    let highIndex = -1;
    for (let index = start; index < end; index += 1) {
      const point = points[index];
      if (!point) {
        continue;
      }
      if (!low || point.price < low.price) {
        low = point;
        lowIndex = index;
      }
      if (!high || point.price > high.price) {
        high = point;
        highIndex = index;
      }
    }
    if (low && high) {
      if (lowIndex === highIndex) {
        result.push(low);
      } else if (lowIndex < highIndex) {
        result.push(low, high);
      } else {
        result.push(high, low);
      }
    }
  }
  const last = points[points.length - 1];
  if (last && result[result.length - 1] !== last) {
    result.push(last);
  }
  return result;
}

function pricePointsSince(launch: LaunchState | undefined, fromMs: number): SeriesPoint[] {
  const trades = launch?.trades ?? [];
  const points: SeriesPoint[] = [];
  for (let index = firstTradeAtOrAfter(trades, fromMs); index < trades.length; index += 1) {
    const trade = trades[index];
    if (trade && isUsablePrice(trade.price)) {
      points.push({ atMs: trade.atMs, price: trade.price });
    }
  }
  return points;
}

export function sparklinePoints(position: Pick<Position, "openedAtMs">, launch: LaunchState | undefined, maxPoints: number = SPARKLINE_POINTS): SeriesPoint[] {
  return downsamplePoints(pricePointsSince(launch, position.openedAtMs), maxPoints);
}

export function positionSeries(
  position: Position,
  launch: LaunchState | undefined,
  config: LiveConfig,
  nowMs: number,
  maxPoints: number = MAX_SERIES_POINTS,
  fills: readonly StoredFill[] = []
): PositionSeries {
  const fromMs = position.openedAtMs - SERIES_LOOKBACK_MS;
  const points = pricePointsSince(launch, fromMs);
  return {
    position: livePositionView(position, launch, config, nowMs),
    fromMs,
    totalTrades: points.length,
    points: downsamplePoints(points, maxPoints),
    fills: fillMarkers(position, fills),
    inMemory: launch !== undefined
  };
}
