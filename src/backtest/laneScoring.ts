import type { ScorerConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock } from "../core/clock.js";
import type { ScoreProvider } from "../core/contracts.js";
import type { LaunchScore, Pubkey } from "../core/types.js";
import type { Db } from "../db/pool.js";
import type { LaunchState, MarketState } from "../market/state.js";
import type { TrendingEntry, TrendingTracker } from "../scorer/copycat.js";
import { DevHistoryService, EMPTY_DEV_HISTORY } from "../scorer/devHistory.js";
import { COPYCAT_FEATURES, DEV_HISTORY_FEATURES } from "../scorer/featureNames.js";
import { devWalletsOf } from "../scorer/features.js";
import { LruCache } from "../scorer/lru.js";
import type { ScoringModel } from "../scorer/model.js";
import { ScorerService } from "../scorer/service.js";
import type {
  CopycatDetector,
  CopycatResult,
  CopycatSubject,
  DevHistoryProvider,
  DevHistorySummary,
  StoredFeatures
} from "../scorer/types.js";
import type { LaneMarket } from "./laneMarket.js";

const MINUTE_MS = 60_000;

export const DEV_HISTORY_CACHE_TTL_MS = 60_000;
export const DEV_HISTORY_CACHE_ENTRIES = 20_000;
export const LATEST_SCORE_ENTRIES = 50_000;

const NO_COPYCAT: CopycatResult = { copycat: false, similarity: 0, original: null, sameTickerRecent: 0 };
const NO_INSIDERS: readonly Pubkey[] = [];

export type StoredLookup = (mint: Pubkey, checkpointSec: number) => StoredFeatures | null;

interface TrendingIdentity {
  minute: number;
  version: number;
  list: readonly TrendingEntry[];
  checkpoint: boolean;
}

interface CheckpointDevLookup {
  key: string;
  wallets: Pubkey[];
  mint: Pubkey;
  atMs: number;
  sharedAsOfMs: number;
}

export interface DevCacheEntry {
  asOfMs: number;
  summary: DevHistorySummary | null;
}

function minuteOf(atMs: number): number {
  return Math.floor(atMs / MINUTE_MS);
}

function hasAllKeys(stored: StoredFeatures | null, keys: readonly string[]): boolean {
  return stored !== null && keys.every((key) => key in stored.features);
}

function sameEntries(a: readonly TrendingEntry[], b: readonly TrendingEntry[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.mint === other.mint &&
      entry.volume === other.volume &&
      entry.ticker === other.ticker &&
      entry.normalizedName === other.normalizedName &&
      entry.createdAtMs === other.createdAtMs &&
      entry.quoteMint === other.quoteMint
    );
  });
}

function sameSummary(a: DevHistorySummary, b: DevHistorySummary): boolean {
  return (
    a.launchCount === b.launchCount &&
    a.outcomeCount === b.outcomeCount &&
    a.ruggedCount === b.ruggedCount &&
    a.migratedCount === b.migratedCount &&
    a.rugRate === b.rugRate &&
    a.migrationRate === b.migrationRate &&
    a.medianPeakMultiple === b.medianPeakMultiple
  );
}

export function devHistoryWallets(devWallets: readonly Pubkey[]): Pubkey[] {
  return [...new Set(devWallets.filter((wallet) => wallet.length > 0))];
}

export function devHistoryKey(wallets: readonly Pubkey[], excludeMint: Pubkey): string {
  return `${[...new Set(wallets)].sort().join(",")}|${excludeMint}`;
}

export class DevCacheEmulator {
  private readonly cache: LruCache<string, DevCacheEntry>;

  constructor(
    private readonly ttlMs: number = DEV_HISTORY_CACHE_TTL_MS,
    maxEntries: number = DEV_HISTORY_CACHE_ENTRIES
  ) {
    this.cache = new LruCache<string, DevCacheEntry>(maxEntries);
  }

  hit(key: string, asOfMs: number): DevCacheEntry | null {
    const cached = this.cache.get(key);
    return cached && cached.asOfMs <= asOfMs && asOfMs - cached.asOfMs <= this.ttlMs ? cached : null;
  }

  store(key: string, entry: DevCacheEntry): void {
    this.cache.set(key, entry);
  }

  touch(key: string, asOfMs: number): DevCacheEntry {
    const cached = this.hit(key, asOfMs);
    if (cached) {
      return cached;
    }
    const entry: DevCacheEntry = { asOfMs, summary: null };
    this.cache.set(key, entry);
    return entry;
  }
}

export interface CohortScoringOptions {
  db: Db | null;
  market: MarketState;
  shared: TrendingTracker;
  scratch: TrendingTracker;
  stored: StoredLookup;
}

export class CohortScoring {
  private version = 0;
  private sharedTrending: TrendingIdentity | null = null;
  private scratchTrending: TrendingIdentity | null = null;
  private readonly sharedDev = new DevCacheEmulator();
  private readonly values: DevHistoryService | null;
  private readonly lanes: LaneScoring[] = [];

  constructor(private readonly options: CohortScoringOptions) {
    this.values = options.db ? new DevHistoryService({ db: options.db, cacheTtlMs: 0, maxEntries: DEV_HISTORY_CACHE_ENTRIES }) : null;
  }

  attach(lane: LaneScoring): void {
    this.lanes.push(lane);
  }

  eventApplied(): void {
    this.version += 1;
  }

  devHistoryAt(wallets: readonly Pubkey[], asOfMs: number, mint: Pubkey): Promise<DevHistorySummary> {
    if (!this.values) {
      return Promise.resolve({ ...EMPTY_DEV_HISTORY });
    }
    return this.values.lookup(wallets, asOfMs, mint);
  }

  onCheckpoint(score: LaunchScore): void {
    const nowMs = score.computedAtMs;
    const minute = minuteOf(nowMs);
    if (this.sharedTrending === null || this.sharedTrending.minute !== minute) {
      this.sharedTrending = { minute, version: this.version, list: this.options.shared.trending(nowMs), checkpoint: true };
    }
    const stored = this.options.stored(score.mint, score.checkpointSec);
    const consumesCopycat = !hasAllKeys(stored, COPYCAT_FEATURES);
    const dev = hasAllKeys(stored, DEV_HISTORY_FEATURES) ? null : this.checkpointDevLookup(score.mint, nowMs);
    for (const lane of this.lanes) {
      if (lane.active() && lane.sees(score.mint)) {
        lane.observeCheckpoint(this.sharedTrending, consumesCopycat, dev);
      }
    }
  }

  copycatFor(lane: LaneScoring, target: CopycatSubject | { info: CopycatSubject }, nowMs: number): CopycatResult {
    const minute = minuteOf(nowMs);
    const shared = this.sharedTrending?.minute === minute ? this.sharedTrending : null;
    const scratch = this.scratchTrending?.minute === minute ? this.scratchTrending : null;
    const record = lane.trendingRecord(minute);
    if (record === null) {
      if (shared && shared.version === this.version) {
        lane.rememberTrending(shared);
        return this.options.shared.isCopycat(target, nowMs);
      }
      if (scratch && scratch.version === this.version) {
        lane.rememberTrending(scratch);
        return this.options.scratch.isCopycat(target, nowMs);
      }
      const result = this.recompute(target, nowMs, minute);
      lane.rememberTrending(this.scratchTrending);
      return result;
    }
    if (shared && (record === shared || sameEntries(record.list, shared.list))) {
      return this.options.shared.isCopycat(target, nowMs);
    }
    if (scratch && (record === scratch || sameEntries(record.list, scratch.list))) {
      return this.options.scratch.isCopycat(target, nowMs);
    }
    if (record.version === this.version) {
      return this.recompute(target, nowMs, minute);
    }
    lane.diverge("its copycat trending list for the minute was replaced before it was used again");
    return NO_COPYCAT;
  }

  private recompute(target: CopycatSubject | { info: CopycatSubject }, nowMs: number, minute: number): CopycatResult {
    const scratch = this.options.scratch;
    scratch.invalidate();
    const result = scratch.isCopycat(target, nowMs);
    this.scratchTrending = { minute, version: this.version, list: scratch.trending(nowMs), checkpoint: false };
    return result;
  }

  private checkpointDevLookup(mint: Pubkey, atMs: number): CheckpointDevLookup | null {
    const launch = this.options.market.get(mint);
    if (!launch || !this.values) {
      return null;
    }
    const wallets = devHistoryWallets(devWalletsOf(launch));
    if (wallets.length === 0) {
      return null;
    }
    const key = devHistoryKey(wallets, mint);
    return { key, wallets, mint, atMs, sharedAsOfMs: this.sharedDev.touch(key, atMs).asOfMs };
  }
}

class LaneCopycat implements CopycatDetector {
  constructor(
    private readonly cohort: CohortScoring,
    private readonly lane: LaneScoring
  ) {}

  isCopycat(target: CopycatSubject | { info: CopycatSubject }, nowMs: number): CopycatResult {
    return this.cohort.copycatFor(this.lane, target, nowMs);
  }
}

class LaneDevHistory implements DevHistoryProvider {
  constructor(
    private readonly cohort: CohortScoring,
    private readonly cache: DevCacheEmulator
  ) {}

  async lookup(devWallets: readonly Pubkey[], asOfMs: number, excludeMint: Pubkey): Promise<DevHistorySummary> {
    const wallets = devHistoryWallets(devWallets);
    if (wallets.length === 0) {
      return { ...EMPTY_DEV_HISTORY };
    }
    const key = devHistoryKey(wallets, excludeMint);
    const cached = this.cache.hit(key, asOfMs);
    if (cached) {
      if (cached.summary === null) {
        cached.summary = await this.cohort.devHistoryAt(wallets, cached.asOfMs, excludeMint);
      }
      return cached.summary;
    }
    const summary = await this.cohort.devHistoryAt(wallets, asOfMs, excludeMint);
    this.cache.store(key, { asOfMs, summary });
    return summary;
  }
}

class LaneLaunches {
  private readonly insiders = new Map<Pubkey, Set<Pubkey>>();

  constructor(private readonly market: LaneMarket) {}

  get(mint: Pubkey): LaunchState | undefined {
    const launch = this.market.get(mint);
    if (!launch) {
      return undefined;
    }
    return Object.create(launch, { insiders: { value: this.insidersOf(mint) } }) as LaunchState;
  }

  extra(mint: Pubkey): Iterable<Pubkey> {
    return this.insiders.get(mint) ?? NO_INSIDERS;
  }

  forget(mint: Pubkey): void {
    this.insiders.delete(mint);
  }

  private insidersOf(mint: Pubkey): Set<Pubkey> {
    let set = this.insiders.get(mint);
    if (!set) {
      set = new Set();
      this.insiders.set(mint, set);
    }
    return set;
  }
}

export interface LaneScoringOptions {
  cohort: CohortScoring;
  market: LaneMarket;
  clock: Clock;
  bus: Bus;
  config: ScorerConfig;
  model: ScoringModel;
  stored: StoredLookup;
}

export class LaneScoring implements ScoreProvider {
  private readonly cohort: CohortScoring;
  private readonly market: LaneMarket;
  private readonly launches: LaneLaunches;
  private readonly service: ScorerService;
  private readonly devCache = new DevCacheEmulator();
  private readonly latestScores = new LruCache<Pubkey, LaunchScore>(LATEST_SCORE_ENTRIES);
  private readonly checks: Array<Promise<string | null>> = [];
  private trending: TrendingIdentity | null = null;
  private divergence: string | null = null;
  private running = true;

  constructor(options: LaneScoringOptions) {
    this.cohort = options.cohort;
    this.market = options.market;
    this.launches = new LaneLaunches(options.market);
    this.service = new ScorerService({
      clock: options.clock,
      bus: options.bus,
      market: this.launches,
      config: options.config,
      model: options.model,
      intel: null,
      devHistory: new LaneDevHistory(options.cohort, this.devCache),
      trending: new LaneCopycat(options.cohort, this),
      store: null,
      mode: "replay",
      storedFeatures: options.stored
    });
    options.cohort.attach(this);
  }

  latest(mint: Pubkey): LaunchScore | null {
    return this.latestScores.get(mint) ?? null;
  }

  scoreNow(mint: Pubkey, reason: string): Promise<LaunchScore | null> {
    const pending = this.service.scoreNow(mint, reason);
    void pending.then((score) => {
      if (score) {
        this.remember(score);
      }
    });
    return pending;
  }

  remember(score: LaunchScore): void {
    const previous = this.latestScores.peek(score.mint);
    if (!previous || previous.computedAtMs <= score.computedAtMs) {
      this.latestScores.set(score.mint, score);
    }
  }

  extraInsiders(mint: Pubkey): Iterable<Pubkey> {
    return this.launches.extra(mint);
  }

  forget(mint: Pubkey): void {
    this.launches.forget(mint);
  }

  sees(mint: Pubkey): boolean {
    return this.market.sees(mint);
  }

  active(): boolean {
    return this.running && this.divergence === null;
  }

  stop(): void {
    this.running = false;
  }

  diverge(reason: string): void {
    this.divergence ??= reason;
  }

  trendingRecord(minute: number): TrendingIdentity | null {
    return this.trending?.minute === minute ? this.trending : null;
  }

  rememberTrending(identity: TrendingIdentity | null): void {
    this.trending = identity;
  }

  observeCheckpoint(shared: TrendingIdentity, consumesCopycat: boolean, dev: CheckpointDevLookup | null): void {
    const record = this.trendingRecord(shared.minute);
    if (record === null) {
      this.trending = shared;
    } else if (consumesCopycat && record !== shared && !sameEntries(record.list, shared.list)) {
      this.diverge("a checkpoint score used a copycat trending list this lane would have cached differently");
    }
    if (dev) {
      const mine = this.devCache.touch(dev.key, dev.atMs);
      if (mine.asOfMs !== dev.sharedAsOfMs) {
        this.checks.push(this.compareDevHistory(mine, dev));
      }
    }
  }

  async divergenceReason(): Promise<string | null> {
    if (this.divergence !== null) {
      return this.divergence;
    }
    for (const reason of await Promise.all(this.checks)) {
      if (reason !== null) {
        return reason;
      }
    }
    return null;
  }

  private async compareDevHistory(mine: DevCacheEntry, dev: CheckpointDevLookup): Promise<string | null> {
    try {
      const own = mine.summary ?? (await this.cohort.devHistoryAt(dev.wallets, mine.asOfMs, dev.mint));
      const shared = await this.cohort.devHistoryAt(dev.wallets, dev.sharedAsOfMs, dev.mint);
      return sameSummary(own, shared) ? null : `dev history of ${dev.mint} cached at a different time changed a checkpoint score`;
    } catch (error) {
      return `dev history check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
