import type { RecorderConfig } from "../config/strategy.js";
import type { Pubkey, TradeVenue } from "../core/types.js";

export type OutcomeConfig = RecorderConfig["outcome"];
export type OutcomeStatus = "migrated" | "rugged" | "died" | "alive";

export interface OutcomeTrade {
  atMs: number;
  slot: number;
  wallet: Pubkey;
  isBuy: boolean;
  venue: TradeVenue;
  tokenAmount: bigint;
  quoteAmount: bigint;
  mcapQuote: bigint;
}

export interface OutcomeLaunch {
  createdAtMs: number;
  createdSlot: number;
  initialMcapQuote: bigint;
  devWallets: readonly Pubkey[];
  completedAtMs: number | null;
  migratedAtMs: number | null;
  knownInsiders?: Iterable<Pubkey>;
}

export interface OutcomeParams {
  outcome: OutcomeConfig;
  postMigrationTrackHours: number;
  bundleSlotWindow: number;
}

export interface OutcomeInput {
  launch: OutcomeLaunch;
  trades: readonly OutcomeTrade[];
  nowMs: number;
  params: OutcomeParams;
}

export interface LaunchOutcome {
  status: OutcomeStatus;
  migrated: boolean;
  rugged: boolean;
  died: boolean;
  survived15m: boolean | null;
  initialMcapQuote: bigint;
  mcap30s: bigint | null;
  mcap1m: bigint | null;
  mcap5m: bigint | null;
  mcap15m: bigint | null;
  mcap1h: bigint | null;
  peakMcapQuote: bigint;
  peakAtMs: number;
  timeToPeakSec: number;
  finalMcapQuote: bigint;
  maxDrawdownFromPeak: number;
  peakMultipleFrom1m: number | null;
  return15mFrom1m: number | null;
  devSoldAtMs: number | null;
  devSoldFraction: number | null;
  rugAtMs: number | null;
  completedAtMs: number | null;
  lastTradeAtMs: number | null;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  uniqueTraders: number;
  totalVolumeQuote: bigint;
  outcomeKnownAtMs: number | null;
  finalized: boolean;
  nextCheckAtMs: number | null;
  details: OutcomeDetails;
}

export interface OutcomeDetails {
  insiderCount: number;
  insiderMaxHoldings: string;
  devBought: string;
  devSold: string;
  peakMultiple: number;
  finalMultiple: number;
  multiples: Record<string, number | null>;
  lastActivityAtMs: number;
}

export const MCAP_CHECKPOINTS_SEC = { mcap30s: 30, mcap1m: 60, mcap5m: 300, mcap15m: 900, mcap1h: 3600 } as const;

const SECOND_MS = 1_000;
const HOUR_MS = 3_600_000;

export function ratio(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) {
    return null;
  }
  return Number(numerator) / Number(denominator);
}

export function normalizedTimes(trades: readonly OutcomeTrade[], createdAtMs: number): number[] {
  const times: number[] = [];
  let floor = createdAtMs;
  for (const trade of trades) {
    floor = Math.max(floor, trade.atMs);
    times.push(floor);
  }
  return times;
}

export function mcapAt(
  trades: readonly OutcomeTrade[],
  times: readonly number[],
  createdAtMs: number,
  offsetSec: number,
  nowMs: number,
  initialMcap: bigint
): bigint | null {
  const cutoff = createdAtMs + offsetSec * SECOND_MS;
  if (nowMs < cutoff) {
    return null;
  }
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((times[mid] ?? Number.POSITIVE_INFINITY) <= cutoff) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low === 0 ? initialMcap : (trades[low - 1]?.mcapQuote ?? initialMcap);
}

interface PeakSummary {
  peak: bigint;
  peakAtMs: number;
  peakIndex: number;
  drawdown: number;
}

export function peakSummary(trades: readonly OutcomeTrade[], times: readonly number[], createdAtMs: number, initialMcap: bigint): PeakSummary {
  let peak = initialMcap;
  let peakAtMs = createdAtMs;
  let peakIndex = -1;
  trades.forEach((trade, index) => {
    if (trade.mcapQuote > peak) {
      peak = trade.mcapQuote;
      peakAtMs = times[index] ?? trade.atMs;
      peakIndex = index;
    }
  });
  let lowest: bigint | null = null;
  for (let index = peakIndex + 1; index < trades.length; index += 1) {
    const mcap = trades[index]?.mcapQuote;
    if (mcap !== undefined && (lowest === null || mcap < lowest)) {
      lowest = mcap;
    }
  }
  const drawdown = lowest === null || peak <= 0n ? 0 : Math.min(1, Math.max(0, 1 - Number(lowest) / Number(peak)));
  return { peak, peakAtMs, peakIndex, drawdown };
}

export function completionTime(launch: OutcomeLaunch, trades: readonly OutcomeTrade[], times: readonly number[]): number | null {
  const candidates: number[] = [];
  if (launch.completedAtMs !== null) {
    candidates.push(launch.completedAtMs);
  }
  if (launch.migratedAtMs !== null) {
    candidates.push(launch.migratedAtMs);
  }
  const firstOffCurve = trades.findIndex((trade) => trade.venue !== "curve");
  if (firstOffCurve >= 0) {
    candidates.push(times[firstOffCurve] ?? trades[firstOffCurve]?.atMs ?? launch.createdAtMs);
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function findInsiders(launch: OutcomeLaunch, trades: readonly OutcomeTrade[], bundleSlotWindow: number): Set<Pubkey> {
  const insiders = new Set<Pubkey>(launch.devWallets);
  for (const wallet of launch.knownInsiders ?? []) {
    insiders.add(wallet);
  }
  const seenBuyers = new Set<Pubkey>();
  for (const trade of trades) {
    if (!trade.isBuy || seenBuyers.has(trade.wallet)) {
      continue;
    }
    seenBuyers.add(trade.wallet);
    if (trade.slot - launch.createdSlot <= bundleSlotWindow) {
      insiders.add(trade.wallet);
    }
  }
  return insiders;
}

interface DevActivity {
  bought: bigint;
  sold: bigint;
  firstSellAtMs: number | null;
}

export function devActivity(trades: readonly OutcomeTrade[], times: readonly number[], devWallets: readonly Pubkey[]): DevActivity {
  const devs = new Set(devWallets);
  const activity: DevActivity = { bought: 0n, sold: 0n, firstSellAtMs: null };
  trades.forEach((trade, index) => {
    if (!devs.has(trade.wallet)) {
      return;
    }
    if (trade.isBuy) {
      activity.bought += trade.tokenAmount;
      return;
    }
    activity.sold += trade.tokenAmount;
    if (activity.firstSellAtMs === null && trade.tokenAmount > 0n) {
      activity.firstSellAtMs = times[index] ?? trade.atMs;
    }
  });
  return activity;
}

export function devSoldFractionOf(activity: DevActivity): number | null {
  if (activity.bought <= 0n) {
    return activity.sold > 0n ? 1 : null;
  }
  return Math.min(1, Number(activity.sold) / Number(activity.bought));
}

class SlidingMin {
  private readonly deque: number[] = [];
  private head = 0;
  private nextIndex = 0;

  constructor(
    private readonly values: readonly bigint[],
    private readonly times: readonly number[]
  ) {}

  minBetween(fromIndex: number, untilMs: number): bigint | null {
    while (this.nextIndex < this.values.length && (this.times[this.nextIndex] ?? Number.POSITIVE_INFINITY) <= untilMs) {
      const value = this.values[this.nextIndex] ?? 0n;
      while (this.deque.length > this.head && (this.values[this.deque[this.deque.length - 1] ?? 0] ?? 0n) >= value) {
        this.deque.pop();
      }
      this.deque.push(this.nextIndex);
      this.nextIndex += 1;
    }
    while (this.head < this.deque.length && (this.deque[this.head] ?? 0) < fromIndex) {
      this.head += 1;
    }
    const index = this.deque[this.head];
    return index === undefined ? null : (this.values[index] ?? null);
  }
}

class WindowPeak {
  private readonly deque: number[] = [];
  private head = 0;
  private pushed = 0;
  private openingIndex = 0;

  constructor(
    private readonly values: readonly bigint[],
    private readonly times: readonly number[],
    private readonly initial: bigint
  ) {}

  levelBefore(endIndex: number, fromMs: number): bigint {
    while (this.pushed < endIndex) {
      const value = this.values[this.pushed] ?? 0n;
      while (this.deque.length > this.head && (this.values[this.deque[this.deque.length - 1] ?? 0] ?? 0n) <= value) {
        this.deque.pop();
      }
      this.deque.push(this.pushed);
      this.pushed += 1;
    }
    while (this.openingIndex < endIndex && (this.times[this.openingIndex] ?? Number.POSITIVE_INFINITY) < fromMs) {
      this.openingIndex += 1;
    }
    while (this.head < this.deque.length && (this.deque[this.head] ?? 0) < this.openingIndex) {
      this.head += 1;
    }
    const opening = this.openingIndex > 0 ? (this.values[this.openingIndex - 1] ?? this.initial) : this.initial;
    const index = this.deque[this.head];
    const inside = index === undefined ? null : (this.values[index] ?? null);
    return inside !== null && inside > opening ? inside : opening;
  }
}

interface RugParams {
  windowMs: number;
  lookaheadMs: number;
  sellFraction: number;
  dropFraction: number;
}

export function findRug(
  trades: readonly OutcomeTrade[],
  times: readonly number[],
  insiders: ReadonlySet<Pubkey>,
  initialMcap: bigint,
  params: RugParams
): { rugAtMs: number | null; insiderMaxHoldings: bigint } {
  const balances = new Map<Pubkey, bigint>();
  const sells: Array<{ atMs: number; amount: bigint }> = [];
  const mcaps = trades.map((trade) => trade.mcapQuote);
  const sliding = new SlidingMin(mcaps, times);
  const peaks = new WindowPeak(mcaps, times, initialMcap);
  let sellHead = 0;
  let windowSold = 0n;
  let holdings = 0n;
  let maxHoldings = 0n;
  let levelBeforeTau = initialMcap;
  let firstIndexAtTau = 0;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    const tau = times[index];
    if (!trade || tau === undefined) {
      continue;
    }
    if (tau > previousTime) {
      firstIndexAtTau = index;
      levelBeforeTau = peaks.levelBefore(index, tau - params.windowMs);
      previousTime = tau;
    }
    if (insiders.has(trade.wallet)) {
      const before = balances.get(trade.wallet) ?? 0n;
      const after = before + (trade.isBuy ? trade.tokenAmount : -trade.tokenAmount);
      balances.set(trade.wallet, after);
      holdings += (after > 0n ? after : 0n) - (before > 0n ? before : 0n);
      if (holdings > maxHoldings) {
        maxHoldings = holdings;
      }
      if (!trade.isBuy && trade.tokenAmount > 0n) {
        sells.push({ atMs: tau, amount: trade.tokenAmount });
        windowSold += trade.tokenAmount;
      }
    }
    while (sellHead < sells.length && (sells[sellHead]?.atMs ?? tau) < tau - params.windowMs) {
      windowSold -= sells[sellHead]?.amount ?? 0n;
      sellHead += 1;
    }
    const lowAhead = sliding.minBetween(firstIndexAtTau, tau + params.lookaheadMs);
    const insidersDumped = maxHoldings > 0n && Number(windowSold) >= params.sellFraction * Number(maxHoldings);
    const priceCollapsed = lowAhead !== null && Number(lowAhead) <= (1 - params.dropFraction) * Number(levelBeforeTau);
    if (insidersDumped && priceCollapsed) {
      return { rugAtMs: tau, insiderMaxHoldings: maxHoldings };
    }
  }
  return { rugAtMs: null, insiderMaxHoldings: maxHoldings };
}

export function survivedCheck(
  launch: OutcomeLaunch,
  trades: readonly OutcomeTrade[],
  times: readonly number[],
  completedAtMs: number | null,
  nowMs: number,
  config: OutcomeConfig
): boolean | null {
  const checkAt = launch.createdAtMs + config.surviveCheckSec * SECOND_MS;
  if (nowMs < checkAt) {
    return null;
  }
  if (completedAtMs !== null && completedAtMs <= checkAt) {
    return true;
  }
  const recentFrom = checkAt - config.surviveRecentTradeSec * SECOND_MS;
  const recentTrade = times.some((time) => time >= recentFrom && time <= checkAt);
  if (!recentTrade) {
    return false;
  }
  const mcap = mcapAt(trades, times, launch.createdAtMs, config.surviveCheckSec, nowMs, launch.initialMcapQuote);
  const multiple = mcap === null ? null : ratio(mcap, launch.initialMcapQuote);
  return multiple !== null && multiple >= config.surviveMinMultipleOfInitial;
}

function earliestFuture(nowMs: number, candidates: ReadonlyArray<number | null>): number | null {
  let earliest: number | null = null;
  for (const candidate of candidates) {
    if (candidate !== null && candidate > nowMs && (earliest === null || candidate < earliest)) {
      earliest = candidate;
    }
  }
  return earliest;
}

function countTrades(trades: readonly OutcomeTrade[]): { buys: number; sells: number; traders: number; volume: bigint } {
  const wallets = new Set<Pubkey>();
  let buys = 0;
  let volume = 0n;
  for (const trade of trades) {
    wallets.add(trade.wallet);
    if (trade.isBuy) {
      buys += 1;
    }
    volume += trade.quoteAmount;
  }
  return { buys, sells: trades.length - buys, traders: wallets.size, volume };
}

export function computeOutcome(input: OutcomeInput): LaunchOutcome {
  const { launch, trades, nowMs } = input;
  const config = input.params.outcome;
  const created = launch.createdAtMs;
  const initial = launch.initialMcapQuote;
  const times = normalizedTimes(trades, created);
  const at = (offsetSec: number): bigint | null => mcapAt(trades, times, created, offsetSec, nowMs, initial);
  const mcap30s = at(MCAP_CHECKPOINTS_SEC.mcap30s);
  const mcap1m = at(MCAP_CHECKPOINTS_SEC.mcap1m);
  const mcap5m = at(MCAP_CHECKPOINTS_SEC.mcap5m);
  const mcap15m = at(MCAP_CHECKPOINTS_SEC.mcap15m);
  const mcap1h = at(MCAP_CHECKPOINTS_SEC.mcap1h);
  const peak = peakSummary(trades, times, created, initial);
  const lastIndex = trades.length - 1;
  const finalMcap = trades[lastIndex]?.mcapQuote ?? initial;
  const lastTradeAtMs = lastIndex >= 0 ? (times[lastIndex] ?? null) : null;
  const lastActivityAtMs = lastTradeAtMs ?? created;

  let peakAfter1m: bigint | null = mcap1m;
  if (peakAfter1m !== null) {
    const oneMinute = created + MCAP_CHECKPOINTS_SEC.mcap1m * SECOND_MS;
    trades.forEach((trade, index) => {
      if ((times[index] ?? 0) > oneMinute && peakAfter1m !== null && trade.mcapQuote > peakAfter1m) {
        peakAfter1m = trade.mcapQuote;
      }
    });
  }
  const peakMultipleFrom1m = peakAfter1m !== null && mcap1m !== null ? ratio(peakAfter1m, mcap1m) : null;
  const multiple15From1 = mcap15m !== null && mcap1m !== null ? ratio(mcap15m, mcap1m) : null;

  const dev = devActivity(trades, times, launch.devWallets);
  const completedAtMs = completionTime(launch, trades, times);
  const migrated = completedAtMs !== null;
  const insiders = findInsiders(launch, trades, input.params.bundleSlotWindow);
  const rug = findRug(trades, times, insiders, initial, {
    windowMs: config.rugWindowSec * SECOND_MS,
    lookaheadMs: config.rugLookaheadSec * SECOND_MS,
    sellFraction: config.rugInsiderSellFraction,
    dropFraction: config.rugDropFraction
  });
  const rugged = !migrated && rug.rugAtMs !== null;
  const inactivityMs = config.deadInactivityMinutes * 60_000;
  const finalMultiple = ratio(finalMcap, initial) ?? 0;
  const died = !migrated && !rugged && nowMs - lastActivityAtMs >= inactivityMs && finalMultiple <= config.deadMaxMcapMultiple;
  const status: OutcomeStatus = migrated ? "migrated" : rugged ? "rugged" : died ? "died" : "alive";

  let outcomeKnownAtMs: number | null = null;
  if (status === "migrated") {
    outcomeKnownAtMs = completedAtMs;
  } else if (status === "rugged" && rug.rugAtMs !== null) {
    outcomeKnownAtMs = rug.rugAtMs + config.rugLookaheadSec * SECOND_MS;
  } else if (status === "died") {
    outcomeKnownAtMs = lastActivityAtMs + inactivityMs;
  }

  const postMigrationMs = input.params.postMigrationTrackHours * HOUR_MS;
  const hardStopAtMs = created + config.finalizeAfterHours * HOUR_MS;
  const migrationTrackingDone = status !== "migrated" || (completedAtMs !== null && nowMs >= completedAtMs + postMigrationMs);
  const surviveCheckedAtMs = created + config.surviveCheckSec * SECOND_MS;
  const statusFinal = outcomeKnownAtMs !== null && nowMs >= outcomeKnownAtMs && migrationTrackingDone && nowMs >= surviveCheckedAtMs;
  const finalized = statusFinal || nowMs >= hardStopAtMs;

  const nextCheckAtMs = finalized
    ? null
    : earliestFuture(nowMs, [
        ...Object.values(MCAP_CHECKPOINTS_SEC).map((sec) => created + sec * SECOND_MS),
        created + config.surviveCheckSec * SECOND_MS,
        migrated || rugged ? null : lastActivityAtMs + inactivityMs,
        outcomeKnownAtMs,
        migrated && completedAtMs !== null ? completedAtMs + postMigrationMs : null,
        hardStopAtMs
      ]);

  const counts = countTrades(trades);
  return {
    status,
    migrated,
    rugged,
    died,
    survived15m: survivedCheck(launch, trades, times, completedAtMs, nowMs, config),
    initialMcapQuote: initial,
    mcap30s,
    mcap1m,
    mcap5m,
    mcap15m,
    mcap1h,
    peakMcapQuote: peak.peak,
    peakAtMs: peak.peakAtMs,
    timeToPeakSec: Math.max(0, (peak.peakAtMs - created) / SECOND_MS),
    finalMcapQuote: finalMcap,
    maxDrawdownFromPeak: peak.drawdown,
    peakMultipleFrom1m,
    return15mFrom1m: multiple15From1 === null ? null : multiple15From1 - 1,
    devSoldAtMs: dev.firstSellAtMs,
    devSoldFraction: devSoldFractionOf(dev),
    rugAtMs: rug.rugAtMs,
    completedAtMs,
    lastTradeAtMs,
    tradeCount: trades.length,
    buyCount: counts.buys,
    sellCount: counts.sells,
    uniqueTraders: counts.traders,
    totalVolumeQuote: counts.volume,
    outcomeKnownAtMs,
    finalized,
    nextCheckAtMs,
    details: {
      insiderCount: insiders.size,
      insiderMaxHoldings: rug.insiderMaxHoldings.toString(),
      devBought: dev.bought.toString(),
      devSold: dev.sold.toString(),
      peakMultiple: ratio(peak.peak, initial) ?? 0,
      finalMultiple,
      multiples: {
        mcap30s: mcap30s === null ? null : ratio(mcap30s, initial),
        mcap1m: mcap1m === null ? null : ratio(mcap1m, initial),
        mcap5m: mcap5m === null ? null : ratio(mcap5m, initial),
        mcap15m: mcap15m === null ? null : ratio(mcap15m, initial),
        mcap1h: mcap1h === null ? null : ratio(mcap1h, initial)
      },
      lastActivityAtMs
    }
  };
}
