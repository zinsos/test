import { median, wilsonLowerBound } from "../core/stats.js";
import { lamportsToSol } from "../market/state.js";
import type { RoundTrip, WindowStats } from "./types.js";

export interface StatsWindow {
  fromMs: number;
  toMs: number;
}

export function inWindow(trip: RoundTrip, window: StatsWindow): boolean {
  return trip.closedAtMs >= window.fromMs && trip.closedAtMs < window.toMs;
}

function profitFactorOf(grossProfit: bigint, grossLoss: bigint): number | null {
  if (grossLoss > 0n) {
    return Number(grossProfit) / Number(grossLoss);
  }
  if (grossProfit > 0n) {
    return Number.POSITIVE_INFINITY;
  }
  return null;
}

function creationSlotEntryRate(trips: readonly RoundTrip[]): number | null {
  let known = 0;
  let atCreation = 0;
  for (const trip of trips) {
    if (trip.creationSlotEntry === null) {
      continue;
    }
    known += 1;
    if (trip.creationSlotEntry) {
      atCreation += 1;
    }
  }
  return known === 0 ? null : atCreation / known;
}

function knownNumbers(values: ReadonlyArray<number | null>): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value));
}

export function computeWindowStats(trips: readonly RoundTrip[], window: StatsWindow): WindowStats {
  const selected = trips.filter((trip) => inWindow(trip, window));
  const wins = selected.filter((trip) => trip.pnl > 0n);
  const losses = selected.filter((trip) => trip.pnl < 0n);
  let realized = 0n;
  let grossProfit = 0n;
  let grossLoss = 0n;
  let totalCost = 0n;
  let best: bigint | null = null;
  for (const trip of selected) {
    realized += trip.pnl;
    totalCost += trip.cost;
    if (trip.pnl > 0n) {
      grossProfit += trip.pnl;
    } else if (trip.pnl < 0n) {
      grossLoss -= trip.pnl;
    }
    if (best === null || trip.pnl > best) {
      best = trip.pnl;
    }
  }
  const bestPositive = best !== null && best > 0n ? best : 0n;
  return {
    fromMs: window.fromMs,
    toMs: window.toMs,
    closed: selected.length,
    wins: wins.length,
    losses: losses.length,
    writeOffs: selected.filter((trip) => trip.closeKind === "written_off").length,
    distinctMints: new Set(selected.map((trip) => trip.mint)).size,
    winRate: selected.length === 0 ? null : wins.length / selected.length,
    winRateLower: wilsonLowerBound(wins.length, selected.length),
    realizedPnlSol: lamportsToSol(realized),
    grossProfitSol: lamportsToSol(grossProfit),
    grossLossSol: lamportsToSol(grossLoss),
    profitFactor: profitFactorOf(grossProfit, grossLoss),
    bestTradeSol: best === null ? null : lamportsToSol(best),
    pnlExBestSol: lamportsToSol(realized - bestPositive),
    totalCostSol: lamportsToSol(totalCost),
    roiPct: totalCost > 0n ? (Number(realized) / Number(totalCost)) * 100 : null,
    medianWinSol: median(wins.map((trip) => lamportsToSol(trip.pnl))),
    medianLossSol: median(losses.map((trip) => lamportsToSol(trip.pnl))),
    medianWinPct: median(wins.map((trip) => trip.returnPct)),
    medianLossPct: median(losses.map((trip) => trip.returnPct)),
    medianReturnPct: median(selected.map((trip) => trip.returnPct)),
    medianHoldSec: median(selected.map((trip) => trip.holdSec)),
    medianEntryDelaySec: median(knownNumbers(selected.map((trip) => trip.entryDelaySec))),
    creationSlotEntryRate: creationSlotEntryRate(selected)
  };
}

export function emptyWindowStats(window: StatsWindow): WindowStats {
  return computeWindowStats([], window);
}

export function finiteOrNull(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : value;
}

export function statsToJson(stats: WindowStats): Record<string, number | null> {
  const json: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(stats)) {
    json[key] = typeof value === "number" ? finiteOrNull(value) : null;
  }
  return json;
}
