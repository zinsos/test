import { SOL_QUOTE } from "../core/constants.js";
import type { Pubkey } from "../core/types.js";
import type {
  MintContext,
  MintContextLookup,
  PositionLedger,
  RoundTrip,
  RoundTripCloseKind,
  RoundTripResult,
  WalletTrade
} from "./types.js";

export const DEFAULT_CLOSE_FRACTION = 0.99;
const BPS_SCALE = 10_000n;

export interface RoundTripOptions {
  asOfMs: number;
  mints: MintContextLookup | ReadonlyMap<Pubkey, MintContext>;
  bundleSlotWindow: number;
  closeFraction?: number;
}

export function compareTrades(a: WalletTrade, b: WalletTrade): number {
  if (a.slot !== b.slot) {
    return a.slot - b.slot;
  }
  if (a.atMs !== b.atMs) {
    return a.atMs - b.atMs;
  }
  if (a.seq !== b.seq) {
    return a.seq - b.seq;
  }
  if (a.signature !== b.signature) {
    return a.signature < b.signature ? -1 : 1;
  }
  return a.eventIndex - b.eventIndex;
}

function lookupFor(mints: RoundTripOptions["mints"]): MintContextLookup {
  return typeof mints === "function" ? mints : (mint: Pubkey) => mints.get(mint);
}

function closeThresholdBps(fraction: number): bigint {
  const clamped = Math.min(1, Math.max(0, fraction));
  return BigInt(Math.round(clamped * Number(BPS_SCALE)));
}

export function entryDelaySec(openedAtMs: number, context: MintContext | undefined): number | null {
  if (!context || context.createdAtMs === null) {
    return null;
  }
  return Math.max(0, (openedAtMs - context.createdAtMs) / 1000);
}

export function isCreationSlotEntry(
  openedSlot: number,
  context: MintContext | undefined,
  bundleSlotWindow: number
): boolean | null {
  if (!context || context.createdSlot === null) {
    return null;
  }
  return openedSlot - context.createdSlot <= bundleSlotWindow;
}

function openLedger(trade: WalletTrade, context: MintContext | undefined, bundleSlotWindow: number): PositionLedger {
  return {
    wallet: trade.wallet,
    mint: trade.mint,
    openedAtMs: trade.atMs,
    openedSlot: trade.slot,
    lastTradeAtMs: trade.atMs,
    cost: 0n,
    proceeds: 0n,
    tokensBought: 0n,
    tokensSold: 0n,
    buys: 0,
    sells: 0,
    entryDelaySec: entryDelaySec(trade.atMs, context),
    creationSlotEntry: isCreationSlotEntry(trade.slot, context, bundleSlotWindow)
  };
}

function applyBuy(ledger: PositionLedger, trade: WalletTrade): void {
  ledger.cost += trade.userQuote;
  ledger.tokensBought += trade.tokenAmount;
  ledger.buys += 1;
  ledger.lastTradeAtMs = trade.atMs;
}

function applySell(ledger: PositionLedger, trade: WalletTrade): void {
  const remaining = ledger.tokensBought - ledger.tokensSold;
  const counted = trade.tokenAmount > remaining ? remaining : trade.tokenAmount;
  const proceeds =
    trade.tokenAmount > remaining && trade.tokenAmount > 0n
      ? (trade.userQuote * (remaining > 0n ? remaining : 0n)) / trade.tokenAmount
      : trade.userQuote;
  ledger.proceeds += proceeds;
  ledger.tokensSold += counted > 0n ? counted : 0n;
  ledger.sells += 1;
  ledger.lastTradeAtMs = trade.atMs;
}

function soldEnough(ledger: PositionLedger, thresholdBps: bigint): boolean {
  return ledger.tokensBought > 0n && ledger.tokensSold * BPS_SCALE >= ledger.tokensBought * thresholdBps;
}

export function closeLedger(ledger: PositionLedger, closedAtMs: number, closeKind: RoundTripCloseKind): RoundTrip {
  const pnl = ledger.proceeds - ledger.cost;
  return {
    ...ledger,
    closedAtMs,
    closeKind,
    pnl,
    returnPct: ledger.cost > 0n ? (Number(pnl) / Number(ledger.cost)) * 100 : 0,
    holdSec: Math.max(0, (closedAtMs - ledger.openedAtMs) / 1000)
  };
}

function writeOffAtMs(ledger: PositionLedger, context: MintContext | undefined, asOfMs: number): number | null {
  if (!context || context.deadAtMs === null || context.deadAtMs >= asOfMs) {
    return null;
  }
  return Math.max(context.deadAtMs, ledger.lastTradeAtMs);
}

export function buildRoundTrips(trades: readonly WalletTrade[], options: RoundTripOptions): RoundTripResult {
  const lookup = lookupFor(options.mints);
  const thresholdBps = closeThresholdBps(options.closeFraction ?? DEFAULT_CLOSE_FRACTION);
  const result: RoundTripResult = { closed: [], open: [], ignoredNonSol: 0, ignoredAfterAsOf: 0, orphanSells: 0 };
  const eligible: WalletTrade[] = [];
  for (const trade of trades) {
    if (trade.atMs >= options.asOfMs) {
      result.ignoredAfterAsOf += 1;
    } else if (trade.quoteMint !== SOL_QUOTE) {
      result.ignoredNonSol += 1;
    } else {
      eligible.push(trade);
    }
  }
  eligible.sort(compareTrades);
  const openByMint = new Map<string, PositionLedger>();
  for (const trade of eligible) {
    const key = `${trade.wallet}|${trade.mint}`;
    let ledger = openByMint.get(key);
    if (trade.isBuy) {
      if (!ledger) {
        ledger = openLedger(trade, lookup(trade.mint), options.bundleSlotWindow);
        openByMint.set(key, ledger);
      }
      applyBuy(ledger, trade);
      continue;
    }
    if (!ledger) {
      result.orphanSells += 1;
      continue;
    }
    applySell(ledger, trade);
    if (soldEnough(ledger, thresholdBps)) {
      result.closed.push(closeLedger(ledger, trade.atMs, "sold"));
      openByMint.delete(key);
    }
  }
  for (const ledger of openByMint.values()) {
    const writeOffAt = writeOffAtMs(ledger, lookup(ledger.mint), options.asOfMs);
    if (writeOffAt === null) {
      result.open.push(ledger);
    } else {
      result.closed.push(closeLedger(ledger, writeOffAt, "written_off"));
    }
  }
  result.closed.sort((a, b) => a.closedAtMs - b.closedAtMs || a.openedAtMs - b.openedAtMs);
  return result;
}

export function groupTradesByWallet(trades: Iterable<WalletTrade>): Map<Pubkey, WalletTrade[]> {
  const grouped = new Map<Pubkey, WalletTrade[]>();
  for (const trade of trades) {
    let list = grouped.get(trade.wallet);
    if (!list) {
      list = [];
      grouped.set(trade.wallet, list);
    }
    list.push(trade);
  }
  return grouped;
}
