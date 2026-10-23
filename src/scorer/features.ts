import type { ScorerConfig } from "../config/strategy.js";
import { herfindahl } from "../core/stats.js";
import type { FeatureVector, Pubkey } from "../core/types.js";
import type { LaunchState, TradeRecord } from "../market/state.js";
import { buildFundingClusters, type FundingCluster } from "./clusters.js";
import type { CopycatResult, DevHistorySummary, IntelRequest, WalletIntel } from "./types.js";
import { heldBy, summarizeFlows, volumeOf, type FlowSummary, type WalletFlow } from "./walletFlows.js";

export const RATIO_CAP = 50;
const TOP_HOLDERS = 10;

export const FLAG_THRESHOLDS = {
  bundleBuyers: 2,
  bundleBoughtShare: 0.05,
  devSold: 0.1,
  devDumped: 0.9,
  devHoldsLarge: 0.1,
  clusterSize: 3,
  freshRatio: 0.6,
  serialRuggerRate: 0.5,
  serialRuggerMinOutcomes: 2,
  washRatio: 0.3,
  concentratedTop10: 0.5
} as const;

export interface FeatureContext {
  nowMs: number;
  config: ScorerConfig;
  intel?: ReadonlyMap<Pubkey, WalletIntel> | null;
  devHistory?: DevHistorySummary | null;
  copycat?: CopycatResult | null;
  isHub?: (address: Pubkey) => boolean;
}

export interface EarlyBuyer {
  wallet: Pubkey;
  firstBuySlot: number;
  firstBuyAtMs: number;
  firstBuySignature: string;
}

export interface ClusterSummary extends FundingCluster {
  heldShare: number;
  boughtShare: number;
}

export interface FeatureResult {
  features: FeatureVector;
  insiders: Set<Pubkey>;
  clusters: ClusterSummary[];
  flags: string[];
  earlyBuyers: EarlyBuyer[];
  bundleWallets: Pubkey[];
}

interface Basis {
  launch: LaunchState;
  ctx: FeatureContext;
  devs: Pubkey[];
  devSet: Set<Pubkey>;
  summary: FlowSummary;
  buyers: WalletFlow[];
  bundle: WalletFlow[];
  early: WalletFlow[];
  ageSec: number;
}

export function devWalletsOf(launch: LaunchState): Pubkey[] {
  return [...new Set([launch.info.devWallet, launch.info.creator])];
}

export function tradesAsOf(launch: LaunchState, nowMs: number): TradeRecord[] {
  return launch.trades.filter((trade) => trade.atMs <= nowMs);
}

export function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) {
    return 0;
  }
  return Number((numerator * 1_000_000n) / denominator) / 1_000_000;
}

function cappedRatio(numerator: number, denominator: number): number | null {
  if (numerator <= 0 && denominator <= 0) {
    return null;
  }
  if (denominator <= 0) {
    return RATIO_CAP;
  }
  return Math.min(RATIO_CAP, numerator / denominator);
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function present(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sumBig(flows: readonly WalletFlow[], pick: (flow: WalletFlow) => bigint): bigint {
  let total = 0n;
  for (const flow of flows) {
    total += pick(flow);
  }
  return total;
}

function buildBasis(launch: LaunchState, ctx: FeatureContext): Basis {
  const devs = devWalletsOf(launch);
  const devSet = new Set(devs);
  const creationWindowEnd = launch.info.createdSlot + ctx.config.bundleSlotWindow;
  const summary = summarizeFlows(tradesAsOf(launch, ctx.nowMs), creationWindowEnd);
  const buyers = [...summary.flows.values()]
    .filter((flow) => flow.firstBuyOrder !== null && !devSet.has(flow.wallet))
    .sort((a, b) => (a.firstBuyOrder ?? 0) - (b.firstBuyOrder ?? 0));
  const bundle = buyers.filter((flow) => (flow.firstBuySlot ?? Number.MAX_SAFE_INTEGER) <= creationWindowEnd);
  const earlyCutoffMs = launch.info.createdAtMs + ctx.config.earlyWindowSec * 1000;
  const early = buyers
    .filter((flow) => (flow.firstBuyAtMs ?? Number.POSITIVE_INFINITY) <= earlyCutoffMs)
    .slice(0, ctx.config.earlyBuyerCount);
  const ageSec = Math.max(0, (ctx.nowMs - launch.info.createdAtMs) / 1000);
  return { launch, ctx, devs, devSet, summary, buyers, bundle, early, ageSec };
}

function devFeatures(basis: Basis): FeatureVector {
  const devFlows = basis.devs.flatMap((dev) => {
    const flow = basis.summary.flows.get(dev);
    return flow ? [flow] : [];
  });
  const bought = sumBig(devFlows, (flow) => flow.bought);
  const sold = sumBig(devFlows, (flow) => flow.sold);
  const initial = sumBig(devFlows, (flow) => flow.boughtByCreationWindow);
  const held = sumBig(devFlows, heldBy);
  const soldFraction = bought > 0n ? Math.min(1, ratio(sold, bought)) : sold > 0n ? 1 : 0;
  return {
    dev_initial_share: basis.launch.supplyShare(initial),
    dev_share: basis.launch.supplyShare(held),
    dev_sold_fraction: soldFraction
  };
}

function bundleFeatures(basis: Basis): FeatureVector {
  return {
    creation_slot_buyers: basis.bundle.length,
    bundle_bought_share: basis.launch.supplyShare(sumBig(basis.bundle, (flow) => flow.boughtByCreationWindow)),
    bundle_share: basis.launch.supplyShare(sumBig(basis.bundle, heldBy))
  };
}

function holderFeatures(basis: Basis): FeatureVector {
  const excluded = new Set<Pubkey>([basis.launch.info.bondingCurve]);
  if (basis.launch.pool) {
    excluded.add(basis.launch.pool);
  }
  const balances = [...basis.summary.flows.values()]
    .filter((flow) => !excluded.has(flow.wallet))
    .map(heldBy)
    .filter((balance) => balance > 0n)
    .sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
  let top = 0n;
  for (const balance of balances.slice(0, TOP_HOLDERS)) {
    top += balance;
  }
  return {
    early_buyers: basis.early.length,
    top10_share: basis.launch.supplyShare(top)
  };
}

function hasIntelData(entry: WalletIntel | undefined): boolean {
  return entry !== undefined && (entry.priorTxCount !== null || entry.funder !== null);
}

function clusterSummaries(basis: Basis, clusters: readonly FundingCluster[]): ClusterSummary[] {
  return clusters.map((cluster) => {
    const flows = cluster.members.flatMap((member) => {
      const flow = basis.summary.flows.get(member);
      return flow ? [flow] : [];
    });
    return {
      ...cluster,
      heldShare: basis.launch.supplyShare(sumBig(flows, heldBy)),
      boughtShare: basis.launch.supplyShare(sumBig(flows, (flow) => flow.bought))
    };
  });
}

const NULL_DEEP: FeatureVector = {
  intel_coverage: null,
  fresh_wallet_ratio: null,
  largest_cluster_size: null,
  largest_cluster_share: null,
  cluster_count: null,
  dev_funded_buyers: null
};

interface DeepOutcome {
  features: FeatureVector;
  clusters: ClusterSummary[];
  devFundedBuyers: Pubkey[];
}

function deepFeatures(basis: Basis): DeepOutcome {
  const intel = basis.ctx.intel;
  if (!intel) {
    return { features: { ...NULL_DEEP }, clusters: [], devFundedBuyers: [] };
  }
  const wallets = basis.early.map((flow) => flow.wallet);
  const covered = wallets.filter((wallet) => hasIntelData(intel.get(wallet)));
  const known = wallets.flatMap((wallet) => {
    const entry = intel.get(wallet);
    return entry && entry.priorTxCount !== null ? [entry] : [];
  });
  const freshLimit = basis.ctx.config.deepIntel.freshMaxPriorTxs;
  const fresh = known.filter((entry) => !entry.priorTxCapped && (entry.priorTxCount ?? Infinity) <= freshLimit);
  const anyDevIntel = basis.devs.some((dev) => hasIntelData(intel.get(dev)));
  const features: FeatureVector = {
    ...NULL_DEEP,
    intel_coverage: wallets.length > 0 ? covered.length / wallets.length : null,
    fresh_wallet_ratio: known.length > 0 ? fresh.length / known.length : null
  };
  if (covered.length === 0 && !anyDevIntel) {
    return { features, clusters: [], devFundedBuyers: [] };
  }
  const result = buildFundingClusters({
    buyers: wallets,
    devWallets: basis.devs,
    intel,
    ...(basis.ctx.isHub ? { isHub: basis.ctx.isHub } : {})
  });
  const clusters = clusterSummaries(basis, result.clusters);
  features.largest_cluster_size = clusters.reduce((max, cluster) => Math.max(max, cluster.buyers.length), 0);
  features.largest_cluster_share = clusters.reduce((max, cluster) => Math.max(max, cluster.heldShare), 0);
  features.cluster_count = clusters.length;
  features.dev_funded_buyers = result.devFundedBuyers.length;
  return { features, clusters, devFundedBuyers: result.devFundedBuyers };
}

function devHistoryFeatures(history: DevHistorySummary | null | undefined): FeatureVector {
  if (!history) {
    return {
      dev_launch_count: null,
      dev_outcome_count: null,
      dev_rug_rate: null,
      dev_migration_rate: null,
      dev_median_peak_multiple: null
    };
  }
  return {
    dev_launch_count: history.launchCount,
    dev_outcome_count: history.outcomeCount,
    dev_rug_rate: history.rugRate,
    dev_migration_rate: history.migrationRate,
    dev_median_peak_multiple: history.medianPeakMultiple
  };
}

function flowFeatures(basis: Basis): FeatureVector {
  const minutes = Math.max(basis.ageSec, 1) / 60;
  const bundleSet = new Set(basis.bundle.map((flow) => flow.wallet));
  const organicBuyers = basis.buyers.filter((flow) => !bundleSet.has(flow.wallet)).length;
  const nonDev = [...basis.summary.flows.values()].filter((flow) => !basis.devSet.has(flow.wallet));
  const buys = nonDev.reduce((total, flow) => total + flow.buys, 0);
  const sells = nonDev.reduce((total, flow) => total + flow.sells, 0);
  const buyVolume = Number(sumBig(nonDev, (flow) => flow.quoteIn));
  const sellVolume = Number(sumBig(nonDev, (flow) => flow.quoteOut));
  const all = [...basis.summary.flows.values()];
  const volumes = all.map((flow) => Number(volumeOf(flow)));
  const totalVolume = volumes.reduce((total, value) => total + value, 0);
  const washVolume = all
    .filter((flow) => flow.roundTrips >= 2)
    .reduce((total, flow) => total + Number(volumeOf(flow)), 0);
  return {
    unique_buyers_per_min: organicBuyers / minutes,
    trades_per_min: basis.summary.trades.length / minutes,
    buy_sell_count_ratio: buys + sells > 0 ? (buys + 1) / (sells + 1) : null,
    buy_sell_volume_ratio: cappedRatio(buyVolume, sellVolume),
    volume_hhi: totalVolume > 0 ? herfindahl(volumes) : null,
    wash_ratio: totalVolume > 0 ? washVolume / totalVolume : null
  };
}

function metadataFeatures(launch: LaunchState): FeatureVector {
  const metadata = launch.metadata;
  if (!metadata) {
    return { has_twitter: null, has_telegram: null, has_website: null, socials_count: null };
  }
  const twitter = present(metadata.twitter);
  const telegram = present(metadata.telegram);
  const website = present(metadata.website);
  return {
    has_twitter: bool(twitter),
    has_telegram: bool(telegram),
    has_website: bool(website),
    socials_count: bool(twitter) + bool(telegram) + bool(website)
  };
}

function copycatFeatures(copycat: CopycatResult | null | undefined): FeatureVector {
  if (!copycat) {
    return { copycat: null, copycat_similarity: null, same_ticker_recent: null };
  }
  return {
    copycat: bool(copycat.copycat),
    copycat_similarity: copycat.similarity,
    same_ticker_recent: copycat.sameTickerRecent
  };
}

function contextFeatures(basis: Basis): FeatureVector {
  const last = basis.summary.lastTrade;
  return {
    age_sec: basis.ageSec,
    mcap_multiple: last ? last.mcapMultiple : 1,
    is_sol_quoted: bool(basis.launch.isSolQuoted)
  };
}

function at(features: FeatureVector, name: string): number | null {
  return features[name] ?? null;
}

function atLeast(features: FeatureVector, name: string, threshold: number): boolean {
  const value = at(features, name);
  return value !== null && value >= threshold;
}

export function softFlags(features: FeatureVector): string[] {
  const flags: string[] = [];
  const t = FLAG_THRESHOLDS;
  if (atLeast(features, "creation_slot_buyers", t.bundleBuyers) || atLeast(features, "bundle_bought_share", t.bundleBoughtShare)) {
    flags.push("bundled");
  }
  if (atLeast(features, "dev_sold_fraction", t.devDumped)) {
    flags.push("dev_dumped");
  } else if (atLeast(features, "dev_sold_fraction", t.devSold)) {
    flags.push("dev_selling");
  }
  if (atLeast(features, "dev_share", t.devHoldsLarge)) {
    flags.push("dev_holds_large");
  }
  if (atLeast(features, "largest_cluster_size", t.clusterSize)) {
    flags.push("funding_cluster");
  }
  if (atLeast(features, "dev_funded_buyers", 1)) {
    flags.push("dev_funded_buyers");
  }
  if (atLeast(features, "fresh_wallet_ratio", t.freshRatio)) {
    flags.push("fresh_wallets");
  }
  if (atLeast(features, "dev_rug_rate", t.serialRuggerRate) && atLeast(features, "dev_outcome_count", t.serialRuggerMinOutcomes)) {
    flags.push("serial_rugger");
  }
  if (atLeast(features, "wash_ratio", t.washRatio)) {
    flags.push("wash_trading");
  }
  if (atLeast(features, "top10_share", t.concentratedTop10)) {
    flags.push("concentrated");
  }
  if (at(features, "socials_count") === 0) {
    flags.push("no_socials");
  }
  if (at(features, "copycat") === 1) {
    flags.push("copycat");
  }
  return flags;
}

function collectInsiders(basis: Basis, deep: DeepOutcome): Set<Pubkey> {
  const insiders = new Set<Pubkey>(basis.devs);
  for (const flow of basis.bundle) {
    insiders.add(flow.wallet);
  }
  for (const cluster of deep.clusters) {
    for (const member of cluster.members) {
      insiders.add(member);
    }
  }
  for (const wallet of deep.devFundedBuyers) {
    insiders.add(wallet);
  }
  return insiders;
}

export function computeFeatures(launch: LaunchState, ctx: FeatureContext): FeatureResult {
  const basis = buildBasis(launch, ctx);
  const deep = deepFeatures(basis);
  const features: FeatureVector = {
    ...contextFeatures(basis),
    ...devFeatures(basis),
    ...bundleFeatures(basis),
    ...holderFeatures(basis),
    ...deep.features,
    ...devHistoryFeatures(ctx.devHistory),
    ...flowFeatures(basis),
    ...metadataFeatures(launch),
    ...copycatFeatures(ctx.copycat)
  };
  return {
    features,
    insiders: collectInsiders(basis, deep),
    clusters: deep.clusters,
    flags: softFlags(features),
    earlyBuyers: basis.early.map((flow) => ({
      wallet: flow.wallet,
      firstBuySlot: flow.firstBuySlot ?? launch.info.createdSlot,
      firstBuyAtMs: flow.firstBuyAtMs ?? launch.info.createdAtMs,
      firstBuySignature: flow.firstBuySignature ?? launch.info.createSignature
    })),
    bundleWallets: basis.bundle.map((flow) => flow.wallet)
  };
}

export function intelRequestsFor(launch: LaunchState, nowMs: number, config: ScorerConfig): IntelRequest[] {
  const basis = buildBasis(launch, { nowMs, config });
  const requests: IntelRequest[] = basis.devs.map((wallet) => ({
    wallet,
    buySignature: launch.info.createSignature,
    buySlot: launch.info.createdSlot
  }));
  for (const flow of basis.early) {
    if (flow.firstBuySignature && flow.firstBuySlot !== null) {
      requests.push({ wallet: flow.wallet, buySignature: flow.firstBuySignature, buySlot: flow.firstBuySlot });
    }
  }
  return requests.slice(0, Math.max(basis.devs.length, config.deepIntel.maxWalletsPerLaunch));
}

export function uniqueBuyersAsOf(launch: LaunchState, nowMs: number): number {
  const devs = new Set(devWalletsOf(launch));
  const seen = new Set<Pubkey>();
  for (const trade of launch.trades) {
    if (trade.isBuy && trade.atMs <= nowMs && !devs.has(trade.wallet)) {
      seen.add(trade.wallet);
    }
  }
  return seen.size;
}

export function lastSlotAsOf(launch: LaunchState, nowMs: number): number {
  let slot = launch.info.createdSlot;
  for (const trade of launch.trades) {
    if (trade.atMs <= nowMs && trade.slot > slot) {
      slot = trade.slot;
    }
  }
  return slot;
}
