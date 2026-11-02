import type { FeatureVector, LaunchScore, Pubkey } from "../core/types.js";

export interface WalletIntel {
  wallet: Pubkey;
  funder: Pubkey | null;
  fundingSignature: string | null;
  fundingSlot: number | null;
  fundedAtMs: number | null;
  fundingAmount: bigint | null;
  priorTxCount: number | null;
  priorTxCapped: boolean;
  oldestSeenAtMs: number | null;
  checkedBeforeSignature: string | null;
  checkedAtMs: number;
  funderIsHub: boolean;
  error: string | null;
}

export interface IntelRequest {
  wallet: Pubkey;
  buySignature: string;
  buySlot: number;
}

export interface IntelEnsureOptions {
  fetch?: boolean;
}

export interface WalletIntelProvider {
  ensure(entries: readonly IntelRequest[], deadlineMs: number, options?: IntelEnsureOptions): Promise<Map<Pubkey, WalletIntel>>;
  cached(wallets: Iterable<Pubkey>): Map<Pubkey, WalletIntel>;
}

export interface DevHistorySummary {
  launchCount: number;
  outcomeCount: number;
  ruggedCount: number;
  migratedCount: number;
  rugRate: number | null;
  migrationRate: number | null;
  medianPeakMultiple: number | null;
}

export interface DevHistoryProvider {
  lookup(devWallets: readonly Pubkey[], asOfMs: number, excludeMint: Pubkey): Promise<DevHistorySummary>;
}

export interface CopycatSubject {
  mint: Pubkey;
  name: string;
  symbol: string;
  createdAtMs: number;
}

export interface CopycatResult {
  copycat: boolean;
  similarity: number;
  original: Pubkey | null;
  sameTickerRecent: number;
}

export interface CopycatDetector {
  isCopycat(target: CopycatSubject | { info: CopycatSubject }, nowMs: number): CopycatResult;
  touch?(target: CopycatSubject | { info: CopycatSubject }, nowMs: number): void;
}

export interface StoredFeatures {
  features: FeatureVector;
  computedAtMs: number;
  insiders?: readonly Pubkey[];
}

export type StoredFeaturesLookup = (
  mint: Pubkey,
  checkpointSec: number
) => StoredFeatures | null | Promise<StoredFeatures | null>;

export interface ScoreExtras {
  insiders: readonly Pubkey[];
  reason: string;
}

export type ScoreSink = (score: LaunchScore, extras: ScoreExtras) => void;
