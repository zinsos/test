import type { Pubkey } from "../core/types.js";
import type { WalletIntel } from "./types.js";

export interface ClusterInput {
  buyers: readonly Pubkey[];
  devWallets: readonly Pubkey[];
  intel: ReadonlyMap<Pubkey, WalletIntel>;
  isHub?: (address: Pubkey) => boolean;
}

export interface FundingCluster {
  members: Pubkey[];
  buyers: Pubkey[];
  containsDev: boolean;
  funders: Pubkey[];
}

export interface ClusterResult {
  clusters: FundingCluster[];
  devFundedBuyers: Pubkey[];
  linkedWallets: Set<Pubkey>;
}

export class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly rank = new Map<string, number>();

  add(node: string): void {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
      this.rank.set(node, 0);
    }
  }

  has(node: string): boolean {
    return this.parent.has(node);
  }

  find(node: string): string {
    this.add(node);
    let root = node;
    for (;;) {
      const next = this.parent.get(root) ?? root;
      if (next === root) {
        break;
      }
      root = next;
    }
    let current = node;
    while (current !== root) {
      const next = this.parent.get(current) ?? root;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) {
      return;
    }
    const rankA = this.rank.get(rootA) ?? 0;
    const rankB = this.rank.get(rootB) ?? 0;
    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }
}

const FUNDER_PREFIX = "funder:";

function funderNode(address: Pubkey): string {
  return `${FUNDER_PREFIX}${address}`;
}

function linkableFunder(
  wallet: Pubkey,
  intel: ReadonlyMap<Pubkey, WalletIntel>,
  devSet: ReadonlySet<Pubkey>,
  isHub: (address: Pubkey) => boolean
): Pubkey | null {
  const entry = intel.get(wallet);
  const funder = entry?.funder ?? null;
  if (!entry || !funder || funder === wallet) {
    return null;
  }
  if (devSet.has(funder)) {
    return funder;
  }
  if (entry.funderIsHub || isHub(funder)) {
    return null;
  }
  return funder;
}

function collectDevFunded(
  buyers: readonly Pubkey[],
  devSet: ReadonlySet<Pubkey>,
  intel: ReadonlyMap<Pubkey, WalletIntel>
): Pubkey[] {
  const devFunders = new Set<Pubkey>();
  for (const dev of devSet) {
    const funder = intel.get(dev)?.funder;
    if (funder) {
      devFunders.add(funder);
    }
  }
  return buyers.filter((buyer) => {
    const funder = intel.get(buyer)?.funder ?? null;
    return (funder !== null && devSet.has(funder)) || devFunders.has(buyer);
  });
}

export function buildFundingClusters(input: ClusterInput): ClusterResult {
  const devSet = new Set(input.devWallets);
  const buyers = [...new Set(input.buyers.filter((buyer) => !devSet.has(buyer)))];
  const isHub = input.isHub ?? (() => false);
  const nodes = [...devSet, ...buyers];
  const uf = new UnionFind();
  for (const node of nodes) {
    uf.add(node);
  }
  const [firstDev, ...otherDevs] = [...devSet];
  if (firstDev) {
    for (const dev of otherDevs) {
      uf.union(firstDev, dev);
    }
  }
  const fundersByRoot = new Map<string, Set<Pubkey>>();
  const nodeSet = new Set(nodes);
  for (const node of nodes) {
    const funder = linkableFunder(node, input.intel, devSet, isHub);
    if (!funder) {
      continue;
    }
    uf.union(node, nodeSet.has(funder) ? funder : funderNode(funder));
  }
  for (const node of nodes) {
    const funder = input.intel.get(node)?.funder;
    if (!funder) {
      continue;
    }
    const root = uf.find(node);
    const set = fundersByRoot.get(root) ?? new Set<Pubkey>();
    set.add(funder);
    fundersByRoot.set(root, set);
  }
  const groups = new Map<string, FundingCluster>();
  for (const node of nodes) {
    const root = uf.find(node);
    let group = groups.get(root);
    if (!group) {
      group = { members: [], buyers: [], containsDev: false, funders: [] };
      groups.set(root, group);
    }
    group.members.push(node);
    if (devSet.has(node)) {
      group.containsDev = true;
    } else {
      group.buyers.push(node);
    }
  }
  const clusters: FundingCluster[] = [];
  const linkedWallets = new Set<Pubkey>();
  for (const [root, group] of groups) {
    const isCluster = group.buyers.length >= 2 || (group.buyers.length >= 1 && group.containsDev);
    if (!isCluster) {
      continue;
    }
    const sharedFunders = [...(fundersByRoot.get(root) ?? [])].filter((funder) => !group.members.includes(funder));
    clusters.push({ ...group, funders: sharedFunders });
    for (const member of group.members) {
      linkedWallets.add(member);
    }
  }
  clusters.sort((a, b) => b.buyers.length - a.buyers.length || b.members.length - a.members.length);
  return { clusters, devFundedBuyers: collectDevFunded(buyers, devSet, input.intel), linkedWallets };
}
