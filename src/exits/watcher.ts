import type { MarketDataSource, TrackedWalletProvider } from "../core/contracts.js";
import type { Pubkey } from "../core/types.js";
import type { LaunchState, TradeRecord, WalletActivity } from "../market/state.js";
import { NO_EXIT_EVENTS, type ExitEvents } from "./types.js";

export type SmartExitCounter = (mint: Pubkey, sinceMs: number) => number;

export interface ExitEventWatcherOptions {
  market: Pick<MarketDataSource, "launch">;
  creationWindowSlots: number;
  smartExitCount?: SmartExitCounter;
  extraInsiders?: (mint: Pubkey) => Iterable<Pubkey>;
  excludeWallets?: Iterable<Pubkey>;
}

export interface PositionAnchor {
  mint: Pubkey;
  openedAtMs: number;
  openedSlot: number;
}

interface FlowTotals {
  bought: bigint;
  sold: bigint;
}

export interface GroupFlow {
  heldAtOpen: bigint;
  boughtSince: bigint;
  soldSince: bigint;
}

export function devWalletsOf(launch: LaunchState): Set<Pubkey> {
  return new Set([launch.info.devWallet, launch.info.creator]);
}

export function creationWindowBuyers(launch: LaunchState, creationWindowSlots: number): Set<Pubkey> {
  const windowEnd = launch.info.createdSlot + Math.max(0, creationWindowSlots);
  const buyers = new Set<Pubkey>();
  for (const activity of launch.wallets.values()) {
    if (activity.firstBuySlot !== null && activity.firstBuySlot <= windowEnd) {
      buyers.add(activity.wallet);
    }
  }
  return buyers;
}

export function insiderWalletsOf(
  launch: LaunchState,
  creationWindowSlots: number,
  extra: Iterable<Pubkey> = [],
  exclude: ReadonlySet<Pubkey> = new Set()
): Set<Pubkey> {
  const devs = devWalletsOf(launch);
  const insiders = new Set<Pubkey>();
  const candidates = [launch.insiders, creationWindowBuyers(launch, creationWindowSlots), extra];
  for (const source of candidates) {
    for (const wallet of source) {
      if (!devs.has(wallet) && !exclude.has(wallet)) {
        insiders.add(wallet);
      }
    }
  }
  return insiders;
}

function flowsBeforeSlot(trades: readonly TradeRecord[], wallets: ReadonlySet<Pubkey>, slot: number): Map<Pubkey, FlowTotals> {
  const totals = new Map<Pubkey, FlowTotals>();
  for (const trade of trades) {
    if (trade.slot >= slot || !wallets.has(trade.wallet)) {
      continue;
    }
    let entry = totals.get(trade.wallet);
    if (!entry) {
      entry = { bought: 0n, sold: 0n };
      totals.set(trade.wallet, entry);
    }
    if (trade.isBuy) {
      entry.bought += trade.tokenAmount;
    } else {
      entry.sold += trade.tokenAmount;
    }
  }
  return totals;
}

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

export function historyCoversSlot(launch: LaunchState, slot: number): boolean {
  if (launch.droppedTrades === 0) {
    return true;
  }
  const last = launch.trades[launch.trades.length - 1];
  return last !== undefined && last.slot >= slot;
}

export function groupFlowSince(launch: LaunchState, wallets: ReadonlySet<Pubkey>, sinceSlot: number): GroupFlow {
  const flow: GroupFlow = { heldAtOpen: 0n, boughtSince: 0n, soldSince: 0n };
  if (!historyCoversSlot(launch, sinceSlot)) {
    return flow;
  }
  const before = flowsBeforeSlot(launch.trades, wallets, sinceSlot);
  for (const wallet of wallets) {
    const activity: WalletActivity | undefined = launch.wallets.get(wallet);
    if (!activity) {
      continue;
    }
    const prior = before.get(wallet) ?? { bought: 0n, sold: 0n };
    flow.heldAtOpen += nonNegative(prior.bought - prior.sold);
    flow.boughtSince += nonNegative(activity.bought - prior.bought);
    flow.soldSince += nonNegative(activity.sold - prior.sold);
  }
  return flow;
}

export function soldFraction(flow: GroupFlow): number {
  const basis = flow.heldAtOpen + flow.boughtSince;
  if (basis <= 0n || flow.soldSince <= 0n) {
    return 0;
  }
  return Math.min(1, Number(flow.soldSince) / Number(basis));
}

export class ExitEventWatcher {
  private readonly options: ExitEventWatcherOptions;
  private readonly excluded: ReadonlySet<Pubkey>;

  constructor(options: ExitEventWatcherOptions) {
    this.options = options;
    this.excluded = new Set(options.excludeWallets ?? []);
  }

  eventsFor(position: PositionAnchor): ExitEvents {
    const launch = this.options.market.launch(position.mint);
    const smartWalletsExited = this.smartExits(position.mint, position.openedAtMs);
    if (!launch) {
      return { ...NO_EXIT_EVENTS, smartWalletsExited };
    }
    const devs = devWalletsOf(launch);
    for (const wallet of this.excluded) {
      devs.delete(wallet);
    }
    const extra = this.options.extraInsiders?.(position.mint) ?? [];
    const insiders = insiderWalletsOf(launch, this.options.creationWindowSlots, extra, this.excluded);
    return {
      devSoldFraction: soldFraction(groupFlowSince(launch, devs, position.openedSlot)),
      insiderSoldFraction: soldFraction(groupFlowSince(launch, insiders, position.openedSlot)),
      smartWalletsExited
    };
  }

  private smartExits(mint: Pubkey, sinceMs: number): number {
    const counter = this.options.smartExitCount;
    if (!counter) {
      return 0;
    }
    const count = counter(mint, sinceMs);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }
}

export interface TrackedExitCounterOptions {
  market: Pick<MarketDataSource, "launch">;
  tracked: Pick<TrackedWalletProvider, "isTracked">;
  minSoldFraction: number;
}

function trackedFlowsSince(
  launch: LaunchState,
  tracked: Pick<TrackedWalletProvider, "isTracked">,
  sinceMs: number
): Map<Pubkey, GroupFlow> {
  const flows = new Map<Pubkey, GroupFlow>();
  for (const trade of launch.trades) {
    let flow = flows.get(trade.wallet);
    if (!flow) {
      if (!tracked.isTracked(trade.wallet)) {
        continue;
      }
      flow = { heldAtOpen: 0n, boughtSince: 0n, soldSince: 0n };
      flows.set(trade.wallet, flow);
    }
    if (trade.atMs < sinceMs) {
      flow.heldAtOpen += trade.isBuy ? trade.tokenAmount : -trade.tokenAmount;
    } else if (trade.isBuy) {
      flow.boughtSince += trade.tokenAmount;
    } else {
      flow.soldSince += trade.tokenAmount;
    }
  }
  for (const flow of flows.values()) {
    flow.heldAtOpen = nonNegative(flow.heldAtOpen);
  }
  return flows;
}

export function createTrackedExitCounter(options: TrackedExitCounterOptions): SmartExitCounter {
  return (mint, sinceMs) => {
    const launch = options.market.launch(mint);
    if (!launch) {
      return 0;
    }
    let exited = 0;
    for (const flow of trackedFlowsSince(launch, options.tracked, sinceMs).values()) {
      const fraction = soldFraction(flow);
      if (fraction > 0 && fraction >= options.minSoldFraction) {
        exited += 1;
      }
    }
    return exited;
  };
}
