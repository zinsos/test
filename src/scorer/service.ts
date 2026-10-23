import type { ScorerConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import type { ScoreProvider } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { ChainEvent, FeatureVector, LaunchScore, Pubkey } from "../core/types.js";
import type { LaunchState } from "../market/state.js";
import { DEV_HISTORY_FEATURES, REPLAY_STORED_FEATURES } from "./featureNames.js";
import {
  computeFeatures,
  devWalletsOf,
  intelRequestsFor,
  lastSlotAsOf,
  softFlags,
  uniqueBuyersAsOf
} from "./features.js";
import { LruCache } from "./lru.js";
import type { ScoringModel } from "./model.js";
import type {
  CopycatDetector,
  DevHistoryProvider,
  DevHistorySummary,
  IntelRequest,
  ScoreSink,
  StoredFeatures,
  StoredFeaturesLookup,
  WalletIntel,
  WalletIntelProvider
} from "./types.js";

const log = moduleLogger("scorer");

export type ScorerMode = "live" | "replay";

export type LaunchSource =
  | { get(mint: Pubkey): LaunchState | undefined }
  | { launch(mint: Pubkey): LaunchState | undefined };

export interface ScorerServiceOptions {
  clock: Clock;
  bus: Bus;
  market: LaunchSource;
  config: ScorerConfig;
  model: ScoringModel;
  intel?: WalletIntelProvider | null;
  devHistory?: DevHistoryProvider | null;
  trending: CopycatDetector;
  store?: ScoreSink | null;
  mode: ScorerMode;
  storedFeatures?: StoredFeaturesLookup | null;
  maxLatest?: number;
  devHistoryTimeoutMs?: number;
  maxCheckpointLagMs?: number;
}

interface ScoringInputs {
  intel: ReadonlyMap<Pubkey, WalletIntel> | null;
  devHistory: DevHistorySummary | null;
  stored: StoredFeatures | null;
}

interface FinishOptions {
  checkpointSec: number;
  reason: string;
  publish: boolean;
}

export function resolveLaunch(market: LaunchSource, mint: Pubkey): LaunchState | undefined {
  return "launch" in market ? market.launch(mint) : market.get(mint);
}

export function overlayStored(features: FeatureVector, stored: StoredFeatures | null, keys: readonly string[]): FeatureVector {
  if (!stored) {
    return features;
  }
  const merged: FeatureVector = { ...features };
  for (const key of keys) {
    if (key in stored.features) {
      merged[key] = stored.features[key] ?? null;
    }
  }
  return merged;
}

function hasAllKeys(stored: StoredFeatures | null, keys: readonly string[]): boolean {
  return stored !== null && keys.every((key) => key in stored.features);
}

export class ScorerService implements ScoreProvider {
  private readonly clock: Clock;
  private readonly bus: Bus;
  private readonly market: LaunchSource;
  private readonly config: ScorerConfig;
  private readonly intel: WalletIntelProvider | null;
  private readonly devHistory: DevHistoryProvider | null;
  private readonly trending: CopycatDetector;
  private readonly store: ScoreSink | null;
  private readonly storedFeatures: StoredFeaturesLookup | null;
  private readonly devHistoryTimeoutMs: number;
  private readonly maxCheckpointLagMs: number;
  private readonly latestScores: LruCache<Pubkey, LaunchScore>;
  private readonly timers = new Map<Pubkey, Set<TimerHandle>>();
  private readonly scheduledMints = new LruCache<Pubkey, true>(100_000);
  private readonly running = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;
  private model: ScoringModel;
  readonly mode: ScorerMode;

  constructor(options: ScorerServiceOptions) {
    this.clock = options.clock;
    this.bus = options.bus;
    this.market = options.market;
    this.config = options.config;
    this.model = options.model;
    this.intel = options.mode === "live" ? (options.intel ?? null) : null;
    this.devHistory = options.devHistory ?? null;
    this.trending = options.trending;
    this.store = options.store ?? null;
    this.mode = options.mode;
    this.storedFeatures = options.storedFeatures ?? null;
    this.devHistoryTimeoutMs = options.devHistoryTimeoutMs ?? 2_000;
    this.maxCheckpointLagMs = options.maxCheckpointLagMs ?? 60_000;
    this.latestScores = new LruCache<Pubkey, LaunchScore>(options.maxLatest ?? 50_000);
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.bus.on("chain", (event) => this.onChainEvent(event));
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const handles of this.timers.values()) {
      for (const handle of handles) {
        this.clock.cancel(handle);
      }
    }
    this.timers.clear();
    this.scheduledMints.clear();
    await Promise.allSettled([...this.running]);
  }

  setModel(model: ScoringModel): void {
    this.model = model;
  }

  currentModel(): ScoringModel {
    return this.model;
  }

  pendingCheckpoints(): number {
    let count = 0;
    for (const handles of this.timers.values()) {
      count += handles.size;
    }
    return count;
  }

  latest(mint: Pubkey): LaunchScore | null {
    return this.latestScores.get(mint) ?? null;
  }

  scheduleLaunch(mint: Pubkey, createdAtMs: number): void {
    if (this.scheduledMints.has(mint)) {
      return;
    }
    this.scheduledMints.set(mint, true);
    const now = this.clock.nowMs();
    for (const checkpointSec of this.config.checkpointsSec) {
      const atMs = createdAtMs + checkpointSec * 1000;
      if (now - atMs > this.maxCheckpointLagMs) {
        continue;
      }
      this.scheduleFor(mint, atMs, () => this.runCheckpoint(mint, checkpointSec));
    }
  }

  async runCheckpoint(mint: Pubkey, checkpointSec: number): Promise<LaunchScore | null> {
    return this.track(
      this.mode === "live" ? this.runLiveCheckpoint(mint, checkpointSec) : this.runReplayCheckpoint(mint, checkpointSec)
    );
  }

  async scoreNow(mint: Pubkey, reason: string): Promise<LaunchScore | null> {
    const launch = resolveLaunch(this.market, mint);
    if (!launch) {
      return null;
    }
    const nowMs = this.clock.nowMs();
    const checkpointSec = Math.max(0, Math.floor(launch.ageMs(nowMs) / 1000));
    try {
      if (this.mode === "replay") {
        const stored = await this.latestStoredAsOf(mint, nowMs);
        const devHistory = hasAllKeys(stored, DEV_HISTORY_FEATURES) ? null : await this.lookupDevHistory(launch, nowMs);
        return this.finish(launch, { intel: null, devHistory, stored }, { checkpointSec, reason, publish: false });
      }
      const intel = this.intel ? await this.knownIntel(intelRequestsFor(launch, nowMs, this.config), nowMs) : null;
      const devHistory = await this.lookupDevHistory(launch, nowMs);
      return this.finish(launch, { intel, devHistory, stored: null }, { checkpointSec, reason, publish: false });
    } catch (error) {
      log.error({ err: error, mint, reason }, "ad-hoc scoring failed");
      return null;
    }
  }

  private onChainEvent(event: ChainEvent): void {
    if (event.kind === "create") {
      this.scheduleLaunch(event.mint, event.timestampMs > 0 ? event.timestampMs : event.tx.receivedAtMs);
    }
  }

  private scheduleFor(mint: Pubkey, atMs: number, fn: () => Promise<unknown>): void {
    let handles = this.timers.get(mint);
    if (!handles) {
      handles = new Set();
      this.timers.set(mint, handles);
    }
    const owned = handles;
    const handle = this.clock.schedule(atMs, async () => {
      owned.delete(handle);
      if (owned.size === 0 && this.timers.get(mint) === owned) {
        this.timers.delete(mint);
      }
      await fn();
    });
    owned.add(handle);
  }

  private async track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    try {
      return await work;
    } finally {
      this.running.delete(work);
    }
  }

  private async runLiveCheckpoint(mint: Pubkey, checkpointSec: number): Promise<LaunchScore | null> {
    const launch = resolveLaunch(this.market, mint);
    if (!launch) {
      return null;
    }
    try {
      const startMs = this.clock.nowMs();
      const [intel, devHistory] = await Promise.all([
        this.gatherIntel(launch, startMs),
        this.lookupDevHistory(launch, startMs)
      ]);
      return this.finish(launch, { intel, devHistory, stored: null }, { checkpointSec, reason: "checkpoint", publish: true });
    } catch (error) {
      log.error({ err: error, mint, checkpointSec }, "checkpoint scoring failed");
      return null;
    }
  }

  private async runReplayCheckpoint(mint: Pubkey, checkpointSec: number): Promise<LaunchScore | null> {
    if (!resolveLaunch(this.market, mint)) {
      return null;
    }
    try {
      const stored = this.storedFeatures ? await this.storedFeatures(mint, checkpointSec) : null;
      if (stored && stored.computedAtMs > this.clock.nowMs()) {
        this.scheduleFor(mint, stored.computedAtMs, () => this.track(this.completeReplay(mint, checkpointSec, stored)));
        return null;
      }
      return await this.completeReplay(mint, checkpointSec, stored);
    } catch (error) {
      log.error({ err: error, mint, checkpointSec }, "replay scoring failed");
      return null;
    }
  }

  private async completeReplay(mint: Pubkey, checkpointSec: number, stored: StoredFeatures | null): Promise<LaunchScore | null> {
    const launch = resolveLaunch(this.market, mint);
    if (!launch) {
      return null;
    }
    const nowMs = this.clock.nowMs();
    const devHistory = hasAllKeys(stored, DEV_HISTORY_FEATURES) ? null : await this.lookupDevHistory(launch, nowMs);
    return this.finish(launch, { intel: null, devHistory, stored }, { checkpointSec, reason: "checkpoint", publish: true });
  }

  private async latestStoredAsOf(mint: Pubkey, nowMs: number): Promise<StoredFeatures | null> {
    if (!this.storedFeatures) {
      return null;
    }
    const checkpoints = [...this.config.checkpointsSec].sort((a, b) => b - a);
    for (const checkpointSec of checkpoints) {
      const stored = await this.storedFeatures(mint, checkpointSec);
      if (stored && stored.computedAtMs <= nowMs) {
        return stored;
      }
    }
    return null;
  }

  private async gatherIntel(launch: LaunchState, nowMs: number): Promise<ReadonlyMap<Pubkey, WalletIntel> | null> {
    if (!this.intel) {
      return null;
    }
    const deep = this.config.deepIntel;
    const requests = intelRequestsFor(launch, nowMs, this.config);
    if (deep.enabled && uniqueBuyersAsOf(launch, nowMs) >= deep.minBuyersForDeep) {
      try {
        return await this.intel.ensure(requests, nowMs + deep.timeoutMs);
      } catch (error) {
        log.warn({ err: error, mint: launch.mint }, "wallet intel failed, using cache");
        return this.intel.cached(requests.map((request) => request.wallet));
      }
    }
    return this.knownIntel(requests, nowMs);
  }

  private async knownIntel(requests: readonly IntelRequest[], nowMs: number): Promise<ReadonlyMap<Pubkey, WalletIntel>> {
    const intel = this.intel;
    if (!intel) {
      return new Map();
    }
    try {
      return await intel.ensure(requests, nowMs + this.config.deepIntel.timeoutMs, { fetch: false });
    } catch (error) {
      log.warn({ err: error }, "stored wallet intel unavailable, using memory cache");
      return intel.cached(requests.map((request) => request.wallet));
    }
  }

  private async lookupDevHistory(launch: LaunchState, asOfMs: number): Promise<DevHistorySummary | null> {
    if (!this.devHistory) {
      return null;
    }
    let handle: TimerHandle | null = null;
    const timeout = new Promise<null>((resolve) => {
      handle = this.clock.schedule(asOfMs + this.devHistoryTimeoutMs, () => resolve(null));
    });
    try {
      const lookup = this.devHistory.lookup(devWalletsOf(launch), asOfMs, launch.mint).catch((error: unknown) => {
        log.warn({ err: error, mint: launch.mint }, "dev history unavailable");
        return null;
      });
      return await Promise.race([lookup, timeout]);
    } finally {
      if (handle) {
        this.clock.cancel(handle);
      }
    }
  }

  private finish(launch: LaunchState, inputs: ScoringInputs, options: FinishOptions): LaunchScore {
    const nowMs = this.clock.nowMs();
    const result = computeFeatures(launch, {
      nowMs,
      config: this.config,
      intel: inputs.intel,
      devHistory: inputs.devHistory,
      copycat: this.trending.isCopycat(launch, nowMs)
    });
    const features = overlayStored(result.features, inputs.stored, REPLAY_STORED_FEATURES);
    const modelScore = this.model.score(features, this.config.hardBlocks);
    const insiders = new Set(result.insiders);
    for (const wallet of inputs.stored?.insiders ?? []) {
      insiders.add(wallet);
    }
    for (const wallet of insiders) {
      launch.insiders.add(wallet);
    }
    const score: LaunchScore = {
      mint: launch.mint,
      launchId: launch.launchId,
      checkpointSec: options.checkpointSec,
      computedAtMs: nowMs,
      slot: lastSlotAsOf(launch, nowMs),
      score: modelScore.score,
      hardBlocked: modelScore.hardBlocked,
      flags: [...new Set([...modelScore.flags, ...softFlags(features)])],
      features,
      contributions: modelScore.contributions,
      weightsVersion: modelScore.weightsVersion
    };
    const previous = this.latestScores.peek(launch.mint);
    if (!previous || previous.computedAtMs <= score.computedAtMs) {
      this.latestScores.set(launch.mint, score);
    }
    if (options.publish) {
      this.publish(score, [...insiders], options.reason);
    }
    return score;
  }

  private publish(score: LaunchScore, insiders: Pubkey[], reason: string): void {
    if (this.store) {
      try {
        this.store(score, { insiders, reason });
      } catch (error) {
        log.error({ err: error, mint: score.mint }, "score store failed");
      }
    }
    this.bus.emit("score", score);
  }
}
