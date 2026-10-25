import type { Pubkey, TradeVenue } from "../core/types.js";

export type SnapshotSource = "trades" | "rpc";

export interface SnapshotTrade {
  atMs: number;
  slot: number;
  wallet: Pubkey;
  isBuy: boolean;
  venue: TradeVenue;
  tokenAmount: bigint;
  mcapQuote: bigint;
}

export interface HolderEntry {
  wallet: Pubkey;
  amount: bigint;
  share: number;
}

export interface HolderSnapshot {
  checkpointSec: number;
  source: SnapshotSource;
  takenAtMs: number;
  slot: number | null;
  holderCount: number;
  top10Share: number | null;
  devShare: number | null;
  curveShare: number | null;
  mcapQuote: bigint | null;
  holders: HolderEntry[];
}

export interface TradeSnapshotInput {
  checkpointSec: number;
  createdAtMs: number;
  createdSlot: number;
  tokenTotalSupply: bigint;
  initialMcapQuote: bigint;
  devWallets: readonly Pubkey[];
  excludedOwners: readonly Pubkey[];
  trades: readonly SnapshotTrade[];
  completedAtMs?: number | null;
  topN?: number;
}

export interface RpcTokenAccount {
  address: string;
  amount: bigint;
  owner: Pubkey | null;
}

export interface RpcSnapshotInput {
  checkpointSec: number;
  takenAtMs: number;
  slot: number | null;
  tokenTotalSupply: bigint;
  bondingCurve: Pubkey;
  pool: Pubkey | null;
  devWallets: readonly Pubkey[];
  accounts: readonly RpcTokenAccount[];
  mcapQuote: bigint | null;
  topN?: number;
}

export const DEFAULT_TOP_HOLDERS = 50;
const SHARE_SCALE = 1_000_000n;

export function supplyShare(amount: bigint, supply: bigint): number {
  if (supply <= 0n || amount <= 0n) {
    return 0;
  }
  return Number((amount * SHARE_SCALE) / supply) / Number(SHARE_SCALE);
}

function byAmountDesc(a: { wallet: string; amount: bigint }, b: { wallet: string; amount: bigint }): number {
  if (a.amount !== b.amount) {
    return a.amount > b.amount ? -1 : 1;
  }
  return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
}

function sumAmounts(entries: readonly { amount: bigint }[]): bigint {
  let total = 0n;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

function rankHolders(balances: Map<Pubkey, bigint>, excluded: ReadonlySet<Pubkey>): Array<{ wallet: Pubkey; amount: bigint }> {
  const ranked: Array<{ wallet: Pubkey; amount: bigint }> = [];
  for (const [wallet, amount] of balances) {
    if (amount > 0n && !excluded.has(wallet)) {
      ranked.push({ wallet, amount });
    }
  }
  ranked.sort(byAmountDesc);
  return ranked;
}

function devHoldings(balances: Map<Pubkey, bigint>, devWallets: readonly Pubkey[]): bigint {
  let total = 0n;
  for (const wallet of new Set(devWallets)) {
    const amount = balances.get(wallet) ?? 0n;
    if (amount > 0n) {
      total += amount;
    }
  }
  return total;
}

function withShares(ranked: readonly { wallet: Pubkey; amount: bigint }[], supply: bigint, topN: number): HolderEntry[] {
  return ranked.slice(0, topN).map((entry) => ({
    wallet: entry.wallet,
    amount: entry.amount,
    share: supplyShare(entry.amount, supply)
  }));
}

export function computeTradeSnapshot(input: TradeSnapshotInput): HolderSnapshot {
  const cutoff = input.createdAtMs + input.checkpointSec * 1000;
  const balances = new Map<Pubkey, bigint>();
  let mcap = input.initialMcapQuote;
  let slot = input.createdSlot;
  let leftCurve = input.completedAtMs !== undefined && input.completedAtMs !== null && input.completedAtMs <= cutoff;
  for (const trade of input.trades) {
    if (trade.atMs > cutoff) {
      continue;
    }
    const delta = trade.isBuy ? trade.tokenAmount : -trade.tokenAmount;
    balances.set(trade.wallet, (balances.get(trade.wallet) ?? 0n) + delta);
    mcap = trade.mcapQuote;
    slot = Math.max(slot, trade.slot);
    if (trade.venue !== "curve") {
      leftCurve = true;
    }
  }
  const excluded = new Set(input.excludedOwners);
  const ranked = rankHolders(balances, excluded);
  const supply = input.tokenTotalSupply;
  const circulating = sumAmounts(ranked);
  const curveHeld = supply - circulating;
  return {
    checkpointSec: input.checkpointSec,
    source: "trades",
    takenAtMs: cutoff,
    slot,
    holderCount: ranked.length,
    top10Share: supplyShare(sumAmounts(ranked.slice(0, 10)), supply),
    devShare: supplyShare(devHoldings(balances, input.devWallets), supply),
    curveShare: leftCurve ? null : supplyShare(curveHeld > 0n ? curveHeld : 0n, supply),
    mcapQuote: mcap,
    holders: withShares(ranked, supply, input.topN ?? DEFAULT_TOP_HOLDERS)
  };
}

export function computeRpcSnapshot(input: RpcSnapshotInput): HolderSnapshot {
  const byOwner = new Map<Pubkey, bigint>();
  let curveAmount = 0n;
  for (const account of input.accounts) {
    if (account.amount <= 0n) {
      continue;
    }
    const owner = account.owner ?? account.address;
    if (owner === input.bondingCurve) {
      curveAmount += account.amount;
      continue;
    }
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + account.amount);
  }
  const excluded = new Set<Pubkey>([input.bondingCurve]);
  if (input.pool) {
    excluded.add(input.pool);
  }
  const ranked = rankHolders(byOwner, excluded);
  const supply = input.tokenTotalSupply;
  return {
    checkpointSec: input.checkpointSec,
    source: "rpc",
    takenAtMs: input.takenAtMs,
    slot: input.slot,
    holderCount: ranked.length,
    top10Share: supplyShare(sumAmounts(ranked.slice(0, 10)), supply),
    devShare: supplyShare(devHoldings(byOwner, input.devWallets), supply),
    curveShare: supplyShare(curveAmount, supply),
    mcapQuote: input.mcapQuote,
    holders: withShares(ranked, supply, input.topN ?? DEFAULT_TOP_HOLDERS)
  };
}
