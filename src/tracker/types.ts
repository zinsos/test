import type { Pubkey, TradeVenue } from "../core/types.js";

export interface WalletTrade {
  wallet: Pubkey;
  mint: Pubkey;
  signature: string;
  eventIndex: number;
  slot: number;
  seq: number;
  atMs: number;
  venue: TradeVenue;
  isBuy: boolean;
  tokenAmount: bigint;
  userQuote: bigint;
  quoteMint: string;
}

export interface MintContext {
  createdAtMs: number | null;
  createdSlot: number | null;
  deadAtMs: number | null;
}

export type MintContextLookup = (mint: Pubkey) => MintContext | undefined;

export type RoundTripCloseKind = "sold" | "written_off";

export interface PositionLedger {
  wallet: Pubkey;
  mint: Pubkey;
  openedAtMs: number;
  openedSlot: number;
  lastTradeAtMs: number;
  cost: bigint;
  proceeds: bigint;
  tokensBought: bigint;
  tokensSold: bigint;
  buys: number;
  sells: number;
  entryDelaySec: number | null;
  creationSlotEntry: boolean | null;
}

export interface RoundTrip extends PositionLedger {
  closedAtMs: number;
  closeKind: RoundTripCloseKind;
  pnl: bigint;
  returnPct: number;
  holdSec: number;
}

export interface RoundTripResult {
  closed: RoundTrip[];
  open: PositionLedger[];
  ignoredNonSol: number;
  ignoredAfterAsOf: number;
  orphanSells: number;
}

export interface WindowStats {
  fromMs: number;
  toMs: number;
  closed: number;
  wins: number;
  losses: number;
  writeOffs: number;
  distinctMints: number;
  winRate: number | null;
  winRateLower: number;
  realizedPnlSol: number;
  grossProfitSol: number;
  grossLossSol: number;
  profitFactor: number | null;
  bestTradeSol: number | null;
  pnlExBestSol: number;
  totalCostSol: number;
  roiPct: number | null;
  medianWinSol: number | null;
  medianLossSol: number | null;
  medianWinPct: number | null;
  medianLossPct: number | null;
  medianReturnPct: number | null;
  medianHoldSec: number | null;
  medianEntryDelaySec: number | null;
  creationSlotEntryRate: number | null;
}

export const EXCLUDE_REASONS = [
  "known_entity",
  "dev_linked",
  "dev_funded",
  "dev_funder",
  "bundle_insider",
  "bundle_entries",
  "sniper",
  "too_active",
  "too_fast",
  "late_entries",
  "min_trades",
  "non_positive_pnl",
  "one_hit"
] as const;

export type ExcludeReason = (typeof EXCLUDE_REASONS)[number];

export interface WalletFacts {
  knownEntityKind: string | null;
  devLinked: boolean;
  devFunded: boolean;
  devFunder: boolean;
  insiderLaunches: number;
  tooActive: boolean;
}

export const EMPTY_WALLET_FACTS: WalletFacts = {
  knownEntityKind: null,
  devLinked: false,
  devFunded: false,
  devFunder: false,
  insiderLaunches: 0,
  tooActive: false
};
