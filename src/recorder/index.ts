import type { Env } from "../config/env.js";
import type { StrategyConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import type { Db } from "../db/pool.js";
import type { LaunchState, MarketState } from "../market/state.js";
import { MetadataFetcher, type FetchLike } from "./metadata.js";
import { OutcomeFinalizer } from "./outcomes.js";
import { RecorderService, tradeBlockTimeMs, type RecorderServiceOptions } from "./recorder.js";
import { LaunchRegistry } from "./registry.js";
import { HolderSnapshotter, type SnapshotRpc } from "./snapshots.js";

export {
  AGGREGATE_CHUNK_SIZE,
  LaunchAggregate,
  writeAggregateDeltas,
  type AggregateDelta,
  type AggregateWriteResult
} from "./aggregates.js";
export {
  MetadataFetchError,
  MetadataFetcher,
  blockedHostReason,
  isPrivateAddress,
  launchMetadataOf,
  normalizeGateway,
  parseMetadata,
  rewriteIpfsUrl,
  type FetchLike,
  type HostResolver,
  type MetadataConfig,
  type MetadataFetcherOptions,
  type MetadataJob,
  type ParsedMetadata
} from "./metadata.js";
export {
  OutcomeFinalizer,
  endTracking,
  loadOutcomeSubjects,
  outcomeParamsFrom,
  outcomeRow,
  recomputeOutcomes,
  subjectFromLaunchState,
  upsertOutcomes,
  type FinalizerTickResult,
  type LoadedSubject,
  type OutcomeFinalizerOptions,
  type OutcomeSubject,
  type OutcomeWrite,
  type RecomputeOutcomesOptions,
  type RecomputeOutcomesResult
} from "./outcomes.js";
export * from "./outcomeLabels.js";
export {
  RecorderService,
  TRADES_TABLE_SPEC,
  VENUE_CODES,
  tradeBlockTimeMs,
  tradeRow,
  type RecorderServiceOptions,
  type RegisteredLaunch,
  type RegisteredListener
} from "./recorder.js";
export { LaunchRegistry, type LaunchRegistryOptions, type TrackedLaunch, type UntrackListener } from "./registry.js";
export { SerialBatchWriter, type SerialBatchWriterOptions } from "./serialWriter.js";
export {
  HOLDER_SNAPSHOTS_TABLE_SPEC,
  HolderSnapshotter,
  snapshotRow,
  tokenAccountOwner,
  tradeSnapshotFromLaunch,
  type HolderSnapshotterOptions,
  type SnapshotRpc,
  type SnapshotTarget
} from "./snapshots.js";
export * from "./snapshotMath.js";

const log = moduleLogger("recorder-module");

export interface MarketEvictionOptions {
  intervalSec?: number;
  keep?: (launch: LaunchState) => boolean;
}

export interface RecorderModuleOptions {
  db: Db;
  rpc: SnapshotRpc | null;
  bus: Bus;
  market: MarketState;
  clock: Clock;
  config: StrategyConfig;
  env: Pick<Env, "METADATA_GATEWAY">;
  fetchImpl?: FetchLike;
  metadataSweepMs?: number | null;
  service?: Partial<Omit<RecorderServiceOptions, "db" | "bus" | "market" | "clock" | "config" | "registry">>;
  marketEviction?: MarketEvictionOptions;
}

export interface RecorderModule {
  readonly registry: LaunchRegistry;
  readonly service: RecorderService;
  readonly snapshotter: HolderSnapshotter;
  readonly metadata: MetadataFetcher;
  readonly finalizer: OutcomeFinalizer;
  readonly poolLookup: (pool: Pubkey) => Pubkey | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  stats(): Record<string, Record<string, number>>;
}

export function createRecorderModule(options: RecorderModuleOptions): RecorderModule {
  const recorderConfig = options.config.recorder;
  const registry = new LaunchRegistry({ db: options.db });
  const service = new RecorderService({
    ...options.service,
    db: options.db,
    bus: options.bus,
    market: options.market,
    clock: options.clock,
    config: recorderConfig,
    registry
  });
  const snapshotter = new HolderSnapshotter({
    db: options.db,
    clock: options.clock,
    market: options.market,
    rpc: options.rpc,
    config: recorderConfig
  });
  const metadata = new MetadataFetcher({
    db: options.db,
    clock: options.clock,
    market: options.market,
    config: recorderConfig.metadata,
    gatewayOverride: options.env.METADATA_GATEWAY,
    fetchImpl: options.fetchImpl,
    sweepIntervalMs: options.metadataSweepMs ?? 5 * 60_000
  });
  const finalizer = new OutcomeFinalizer({
    db: options.db,
    clock: options.clock,
    market: options.market,
    registry,
    bus: options.bus,
    config: recorderConfig,
    bundleSlotWindow: options.config.scorer.bundleSlotWindow,
    beforeLoad: () => service.flush()
  });
  let detachRegistered: (() => void) | null = null;
  let evictionTimer: TimerHandle | null = null;
  let running = false;

  const scheduleEviction = (eviction: MarketEvictionOptions): void => {
    const intervalMs = (eviction.intervalSec ?? 60) * 1_000;
    evictionTimer = options.clock.schedule(options.clock.nowMs() + intervalMs, () => {
      evictionTimer = null;
      if (!running) {
        return;
      }
      const evicted = options.market.evict(options.clock.nowMs(), eviction.keep);
      if (evicted.length > 0) {
        log.debug({ evicted: evicted.length, remaining: options.market.size }, "market launches evicted");
      }
      scheduleEviction(eviction);
    });
  };

  return {
    registry,
    service,
    snapshotter,
    metadata,
    finalizer,
    poolLookup: registry.poolLookup,
    async start() {
      if (running) {
        return;
      }
      running = true;
      snapshotter.start();
      metadata.start();
      detachRegistered = service.onLaunchRegistered((launch) => {
        snapshotter.schedule({ launchId: launch.launchId, mint: launch.mint, createdAtMs: tradeBlockTimeMs(launch.event) });
        if (launch.inserted) {
          metadata.enqueue({ launchId: launch.launchId, mint: launch.mint, uri: launch.event.uri });
        }
      });
      await service.start();
      finalizer.start();
      if (options.marketEviction) {
        scheduleEviction(options.marketEviction);
      }
    },
    async stop() {
      if (!running) {
        return;
      }
      running = false;
      if (evictionTimer) {
        options.clock.cancel(evictionTimer);
        evictionTimer = null;
      }
      detachRegistered?.();
      detachRegistered = null;
      await finalizer.stop();
      await metadata.stop();
      await snapshotter.stop();
      await service.stop();
    },
    stats() {
      return {
        recorder: service.stats(),
        snapshots: snapshotter.stats(),
        metadata: metadata.stats(),
        outcomes: finalizer.stats()
      };
    }
  };
}
