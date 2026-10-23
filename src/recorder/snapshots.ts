import type { ParsedAccountInfo, RpcClient } from "../chain/rpc.js";
import type { RecorderConfig } from "../config/strategy.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import type { BatchTableSpec } from "../db/batch.js";
import type { Db } from "../db/pool.js";
import type { LaunchState, MarketState } from "../market/state.js";
import {
  computeRpcSnapshot,
  computeTradeSnapshot,
  DEFAULT_TOP_HOLDERS,
  type HolderSnapshot,
  type RpcTokenAccount
} from "./snapshotMath.js";
import { SerialBatchWriter, type SerialBatchWriterOptions } from "./serialWriter.js";
import { jsonText } from "./sql.js";

export * from "./snapshotMath.js";

const log = moduleLogger("holder-snapshots");

export const HOLDER_SNAPSHOTS_TABLE_SPEC: BatchTableSpec = {
  table: "holder_snapshots",
  columns: [
    "launch_id",
    "checkpoint_sec",
    "source",
    "taken_at",
    "slot",
    "holder_count",
    "top10_share",
    "dev_share",
    "curve_share",
    "mcap_quote",
    "holders"
  ],
  conflict: "ON CONFLICT (launch_id, checkpoint_sec, source) DO NOTHING"
};

export type SnapshotRpc = Pick<RpcClient, "getTokenLargestAccounts" | "getMultipleParsedAccounts" | "stats">;

export interface SnapshotTarget {
  launchId: number;
  mint: Pubkey;
  createdAtMs: number;
}

export interface HolderSnapshotterOptions {
  db: Db;
  clock: Clock;
  market: MarketState;
  rpc: SnapshotRpc | null;
  config: RecorderConfig;
  writerOptions?: Partial<SerialBatchWriterOptions>;
  settleMs?: number;
  topN?: number;
  maxRpcQueue?: number;
  maxScheduled?: number;
}

interface ScheduledLaunch {
  target: SnapshotTarget;
  nextIndex: number;
  timer: TimerHandle | null;
}

export function snapshotRow(launchId: number, snapshot: HolderSnapshot): unknown[] {
  return [
    launchId,
    snapshot.checkpointSec,
    snapshot.source,
    new Date(snapshot.takenAtMs),
    snapshot.slot,
    snapshot.holderCount,
    snapshot.top10Share,
    snapshot.devShare,
    snapshot.curveShare,
    snapshot.mcapQuote,
    jsonText(snapshot.holders.map((holder) => ({ wallet: holder.wallet, amount: holder.amount, share: holder.share })))
  ];
}

export function tokenAccountOwner(info: ParsedAccountInfo | null | undefined): Pubkey | null {
  if (!info || !info.data || Array.isArray(info.data)) {
    return null;
  }
  const owner = info.data.parsed?.info?.owner;
  return typeof owner === "string" ? owner : null;
}

export function tradeSnapshotFromLaunch(launch: LaunchState, checkpointSec: number, topN: number): HolderSnapshot {
  const excluded = [launch.info.bondingCurve];
  if (launch.pool) {
    excluded.push(launch.pool);
  }
  return computeTradeSnapshot({
    checkpointSec,
    createdAtMs: launch.info.createdAtMs,
    createdSlot: launch.info.createdSlot,
    tokenTotalSupply: launch.info.tokenTotalSupply,
    initialMcapQuote: launch.initialMcapQuote(),
    devWallets: [launch.info.devWallet, launch.info.creator],
    excludedOwners: excluded,
    trades: launch.trades,
    completedAtMs: launch.completedAtMs ?? launch.migratedAtMs,
    topN
  });
}

export class HolderSnapshotter {
  private readonly clock: Clock;
  private readonly market: MarketState;
  private readonly rpc: SnapshotRpc | null;
  private readonly config: RecorderConfig;
  private readonly writer: SerialBatchWriter;
  private readonly checkpoints: readonly number[];
  private readonly settleMs: number;
  private readonly topN: number;
  private readonly maxRpcQueue: number;
  private readonly maxScheduled: number;
  private readonly scheduled = new Map<Pubkey, ScheduledLaunch>();
  private readonly inflight = new Set<Promise<void>>();
  private running = false;
  private readonly counters = {
    scheduledLaunches: 0,
    scheduleRejected: 0,
    tradeSnapshots: 0,
    skippedNotInMemory: 0,
    rpcSnapshots: 0,
    rpcSkippedFewTrades: 0,
    rpcSkippedBusy: 0,
    rpcErrors: 0
  };

  constructor(options: HolderSnapshotterOptions) {
    this.clock = options.clock;
    this.market = options.market;
    this.rpc = options.rpc;
    this.config = options.config;
    this.checkpoints = [...new Set(options.config.holderCheckpointsSec)].sort((a, b) => a - b);
    this.settleMs = options.settleMs ?? 2_000;
    this.topN = options.topN ?? DEFAULT_TOP_HOLDERS;
    this.maxRpcQueue = options.maxRpcQueue ?? 200;
    this.maxScheduled = options.maxScheduled ?? 50_000;
    this.writer = new SerialBatchWriter(options.db, [HOLDER_SNAPSHOTS_TABLE_SPEC], {
      flushIntervalMs: 2_000,
      flushAtRows: 500,
      maxRetries: 4,
      ...options.writerOptions
    });
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.writer.start();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const entry of this.scheduled.values()) {
      if (entry.timer) {
        this.clock.cancel(entry.timer);
      }
    }
    this.scheduled.clear();
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
    await this.writer.stop();
  }

  schedule(target: SnapshotTarget): boolean {
    if (!this.running || this.scheduled.has(target.mint) || this.checkpoints.length === 0) {
      return false;
    }
    if (this.scheduled.size >= this.maxScheduled) {
      this.counters.scheduleRejected += 1;
      return false;
    }
    const entry: ScheduledLaunch = { target, nextIndex: 0, timer: null };
    this.scheduled.set(target.mint, entry);
    this.counters.scheduledLaunches += 1;
    this.armNext(entry);
    return true;
  }

  cancel(mint: Pubkey): void {
    const entry = this.scheduled.get(mint);
    if (entry?.timer) {
      this.clock.cancel(entry.timer);
    }
    this.scheduled.delete(mint);
  }

  async flush(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
    await this.writer.flush();
  }

  stats(): Record<string, number> {
    const writer = this.writer.stats();
    return {
      ...this.counters,
      pendingLaunches: this.scheduled.size,
      inflightRpc: this.inflight.size,
      rowsBuffered: writer.buffered,
      rowsWritten: writer.written,
      rowsDropped: writer.dropped
    };
  }

  takeCheckpoint(target: SnapshotTarget, checkpointSec: number): void {
    const launch = this.market.get(target.mint);
    if (!launch) {
      this.counters.skippedNotInMemory += 1;
      return;
    }
    const snapshot = tradeSnapshotFromLaunch(launch, checkpointSec, this.topN);
    this.writer.push(HOLDER_SNAPSHOTS_TABLE_SPEC.table, snapshotRow(target.launchId, snapshot));
    this.counters.tradeSnapshots += 1;
    this.maybeRpcSnapshot(target, launch, checkpointSec);
  }

  private armNext(entry: ScheduledLaunch): void {
    const checkpointSec = this.checkpoints[entry.nextIndex];
    if (checkpointSec === undefined) {
      this.scheduled.delete(entry.target.mint);
      return;
    }
    const dueMs = entry.target.createdAtMs + checkpointSec * 1000 + this.settleMs;
    entry.timer = this.clock.schedule(dueMs, () => {
      entry.timer = null;
      if (!this.running || this.scheduled.get(entry.target.mint) !== entry) {
        return;
      }
      try {
        this.takeCheckpoint(entry.target, checkpointSec);
      } catch (error) {
        log.error({ err: error, mint: entry.target.mint, checkpointSec }, "holder snapshot failed");
      }
      entry.nextIndex += 1;
      this.armNext(entry);
    });
  }

  private maybeRpcSnapshot(target: SnapshotTarget, launch: LaunchState, checkpointSec: number): void {
    if (!this.config.rpcSnapshotsEnabled || !this.rpc) {
      return;
    }
    if (launch.buyCount + launch.sellCount < this.config.rpcSnapshotMinTrades) {
      this.counters.rpcSkippedFewTrades += 1;
      return;
    }
    if (this.rpc.stats().queued > this.maxRpcQueue) {
      this.counters.rpcSkippedBusy += 1;
      return;
    }
    const task = this.rpcSnapshot(this.rpc, target, launch, checkpointSec);
    this.inflight.add(task);
    void task.finally(() => {
      this.inflight.delete(task);
    });
  }

  private async rpcSnapshot(rpc: SnapshotRpc, target: SnapshotTarget, launch: LaunchState, checkpointSec: number): Promise<void> {
    try {
      const largest = await rpc.getTokenLargestAccounts(target.mint, "low");
      const infos = largest.length > 0 ? await rpc.getMultipleParsedAccounts(largest.map((account) => account.address), "low") : [];
      const accounts: RpcTokenAccount[] = largest.map((account, index) => ({
        address: account.address,
        amount: BigInt(account.amount),
        owner: tokenAccountOwner(infos[index])
      }));
      const snapshot = computeRpcSnapshot({
        checkpointSec,
        takenAtMs: this.clock.nowMs(),
        slot: launch.lastSlot,
        tokenTotalSupply: launch.info.tokenTotalSupply,
        bondingCurve: launch.info.bondingCurve,
        pool: launch.pool,
        devWallets: [launch.info.devWallet, launch.info.creator],
        accounts,
        mcapQuote: launch.mcapQuote(),
        topN: this.topN
      });
      this.writer.push(HOLDER_SNAPSHOTS_TABLE_SPEC.table, snapshotRow(target.launchId, snapshot));
      this.counters.rpcSnapshots += 1;
    } catch (error) {
      this.counters.rpcErrors += 1;
      log.debug({ err: error, mint: target.mint, checkpointSec }, "rpc holder snapshot failed");
    }
  }
}
