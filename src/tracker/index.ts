import type { ScorerConfig, SignalsConfig, TrackerConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import type { ScoreProvider } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import { toNumber, type Db } from "../db/pool.js";
import { backfillWallets, type BackfillOptions, type BackfillRpc, type BackfillSummary } from "./backfill.js";
import { rankParamsFrom, rankWallets, type RankParams, type RankRunResult, type RankWalletsOptions } from "./ranker.js";
import { latestRun, LIVE_RANK_LABEL, TrackedWalletRegistry, WALK_FORWARD_RANK_LABEL } from "./registry.js";
import { SignalEngine, type LaunchLookup, type RejectionListener } from "./signals.js";

const log = moduleLogger("tracker");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_DATE_MS = 8.64e15;
const RERANK_LOCK_KEY = 7_272_030;

export type TrackerMode = "live" | "backtest" | "replay";

export interface TrackerModuleConfig {
  tracker: TrackerConfig;
  signals: SignalsConfig;
  scorer?: Pick<ScorerConfig, "bundleSlotWindow">;
}

export type TrackerRankOptions = Partial<Omit<RankWalletsOptions, "asOfMs" | "config" | "bundleSlotWindow">>;

export interface TrackerModuleOptions {
  db: Db | null;
  rpc: BackfillRpc | null;
  bus: Bus;
  market: LaunchLookup;
  clock: Clock;
  config: TrackerModuleConfig;
  scores: ScoreProvider;
  mode: TrackerMode;
  registry?: TrackedWalletRegistry | null;
  onRejected?: RejectionListener | null;
  rankOptions?: TrackerRankOptions;
  registryRefreshMs?: number;
  rerankStartDelayMs?: number;
  rerankRetryMs?: number;
  backtestRange?: { fromMs: number; toMs: number } | null;
}

export interface TrackerModule {
  registry: TrackedWalletRegistry;
  signals: SignalEngine;
  rerank(asOfMs: number): Promise<RankRunResult>;
  backfill(wallets: readonly Pubkey[], options?: Partial<BackfillOptions>): Promise<BackfillSummary>;
  backfillTargets(limit?: number): Promise<Pubkey[]>;
  prepareWalkForward(fromMs: number, toMs: number): Promise<number[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function backfillTargetsFromLatestRun(db: Db, limit: number): Promise<Pubkey[]> {
  const run = await latestRun(db);
  if (!run) {
    return [];
  }
  const result = await db.query<{ wallet: string }>(
    `SELECT wallet FROM wallet_ranks
     WHERE run_id = $1 AND (NOT excluded OR exclude_reason = 'min_trades')
     ORDER BY tracked DESC, excluded, score DESC, wallet
     LIMIT $2`,
    [run.runId, limit]
  );
  return result.rows.map((row) => row.wallet);
}

async function existingRunWith(db: Db, params: RankParams): Promise<number | null> {
  const result = await db.query<{ id: unknown }>(
    `SELECT id FROM wallet_rank_runs WHERE as_of = $1 AND params = $2::jsonb ORDER BY id DESC LIMIT 1`,
    [new Date(params.asOfMs), JSON.stringify(params)]
  );
  const row = result.rows[0];
  return row ? toNumber(row.id) : null;
}

async function withRerankLock<T>(db: Db, work: () => Promise<T>): Promise<T | null> {
  const client = await db.connect();
  try {
    const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [RERANK_LOCK_KEY]);
    if (locked.rows[0]?.locked !== true) {
      return null;
    }
    try {
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [RERANK_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

export function walkForwardAsOfs(fromMs: number, toMs: number, intervalMs: number): number[] {
  const asOfs: number[] = [];
  if (intervalMs <= 0) {
    return asOfs;
  }
  for (let asOfMs = fromMs; asOfMs <= toMs; asOfMs += intervalMs) {
    asOfs.push(asOfMs);
  }
  return asOfs;
}

export function createTrackerModule(options: TrackerModuleOptions): TrackerModule {
  const { config, clock, bus, db } = options;
  const live = options.mode === "live";
  const intervalMs = config.tracker.rerankIntervalHours * HOUR_MS;
  const bundleSlotWindow = config.scorer?.bundleSlotWindow ?? 1;
  const externalRegistry = options.registry ?? null;
  const registry =
    externalRegistry ?? new TrackedWalletRegistry({ db, clock, refreshIntervalMs: options.registryRefreshMs ?? 15 * 60_000 });
  const signals = new SignalEngine({
    clock,
    bus,
    market: options.market,
    scores: options.scores,
    tracked: registry,
    signals: config.signals,
    convergence: config.tracker.convergence,
    onRejected: options.onRejected ?? null
  });
  let stopped = false;
  let started = false;
  let rerankTimer: TimerHandle | null = null;
  let detachAsOf: (() => void) | null = null;
  let preparedRange: { fromMs: number; toMs: number } | null = null;
  let preparedRunIds: number[] | null = null;
  let rerankChain: Promise<unknown> = Promise.resolve();

  const requireDb = (): Db => {
    if (!db) {
      throw new Error("tracker needs a database for this operation");
    }
    return db;
  };

  const backfill = async (wallets: readonly Pubkey[], overrides: Partial<BackfillOptions> = {}): Promise<BackfillSummary> => {
    if (!options.rpc) {
      throw new Error("tracker backfill needs an rpc client");
    }
    const settings = config.tracker.backfill;
    return backfillWallets(requireDb(), options.rpc, wallets.slice(0, settings.maxWallets), {
      sinceMs: clock.nowMs() - config.tracker.longWindowDays * DAY_MS,
      maxSignatures: settings.maxSignaturesPerWallet,
      concurrency: settings.concurrency,
      shouldStop: () => stopped,
      ...overrides
    });
  };

  const rankOptionsFor = (asOfMs: number, historyKnownBeforeMs: number | null, label: string | null): RankWalletsOptions => ({
    ...options.rankOptions,
    asOfMs,
    config: config.tracker,
    bundleSlotWindow,
    historyKnownBeforeMs,
    label
  });

  const rank = (asOfMs: number, historyKnownBeforeMs: number | null, label: string | null): Promise<RankRunResult> =>
    rankWallets(requireDb(), rankOptionsFor(asOfMs, historyKnownBeforeMs, label));

  const backfillEnabled = (): boolean => live && options.rpc !== null && config.tracker.backfill.enabled;

  const rerankNow = async (asOfMs: number): Promise<RankRunResult> => {
    const historyCutoff = live ? null : asOfMs;
    const label = live ? LIVE_RANK_LABEL : (options.rankOptions?.label ?? null);
    let result = await rank(asOfMs, historyCutoff, label);
    if (backfillEnabled() && !stopped) {
      const targets = await backfillTargetsFromLatestRun(requireDb(), config.tracker.backfill.maxWallets);
      const summary = targets.length > 0 ? await backfill(targets, { sinceMs: asOfMs - config.tracker.longWindowDays * DAY_MS }) : null;
      if (summary && summary.tradesWritten > 0 && !stopped) {
        result = await rank(asOfMs, historyCutoff, label);
      }
    }
    if (live && !externalRegistry) {
      await registry.load(clock.nowMs());
    }
    return result;
  };

  const rerank = (asOfMs: number): Promise<RankRunResult> => {
    const next = rerankChain.then(() => rerankNow(asOfMs));
    rerankChain = next.catch(() => undefined);
    return next;
  };

  const backfillTargets = (limit = config.tracker.backfill.maxWallets): Promise<Pubkey[]> =>
    backfillTargetsFromLatestRun(requireDb(), limit);

  const scheduleRerank = (atMs: number): void => {
    if (stopped) {
      return;
    }
    if (rerankTimer) {
      clock.cancel(rerankTimer);
    }
    rerankTimer = clock.schedule(atMs, () => scheduledRerank());
  };

  const scheduledRerank = async (): Promise<void> => {
    rerankTimer = null;
    if (stopped) {
      return;
    }
    const database = requireDb();
    try {
      const latest = await latestRun(database);
      const nowMs = clock.nowMs();
      const dueAtMs = latest ? latest.asOfMs + intervalMs : nowMs;
      if (dueAtMs > nowMs + 60_000) {
        scheduleRerank(dueAtMs);
        return;
      }
      const result = await withRerankLock(database, () => rerank(nowMs));
      if (result === null) {
        log.info("another process holds the rerank lock, skipping");
      }
      scheduleRerank(clock.nowMs() + intervalMs);
    } catch (error) {
      log.error({ err: error }, "scheduled wallet rerank failed");
      scheduleRerank(clock.nowMs() + (options.rerankRetryMs ?? HOUR_MS));
    }
  };

  const prepareWalkForward = async (fromMs: number, toMs: number): Promise<number[]> => {
    const database = requireDb();
    const runIds: number[] = [];
    for (const asOfMs of walkForwardAsOfs(fromMs, toMs, intervalMs)) {
      const rankOptions = rankOptionsFor(asOfMs, asOfMs, WALK_FORWARD_RANK_LABEL);
      const existing = await existingRunWith(database, rankParamsFrom(rankOptions).params);
      if (existing !== null) {
        runIds.push(existing);
        continue;
      }
      const result = await rankWallets(database, rankOptions);
      if (result.runId !== null) {
        runIds.push(result.runId);
      }
    }
    preparedRange = { fromMs, toMs };
    preparedRunIds = runIds;
    return runIds;
  };

  const startLive = async (): Promise<void> => {
    if (db && !externalRegistry) {
      await registry.load(clock.nowMs());
      registry.startAutoRefresh();
    }
    signals.start();
    if (db) {
      const latest = await latestRun(db);
      const earliest = clock.nowMs() + (options.rerankStartDelayMs ?? 60_000);
      scheduleRerank(latest ? Math.max(earliest, latest.asOfMs + intervalMs) : earliest);
    }
  };

  const startBacktest = async (): Promise<void> => {
    if (db && !externalRegistry) {
      const range = options.backtestRange ?? preparedRange ?? { fromMs: clock.nowMs(), toMs: MAX_DATE_MS };
      await registry.preloadRuns(range, preparedRunIds);
      registry.setAsOf(clock.nowMs());
      detachAsOf = bus.on("chain", () => {
        registry.setAsOf(clock.nowMs());
      });
    }
    signals.start();
  };

  return {
    registry,
    signals,
    rerank,
    backfill,
    backfillTargets,
    prepareWalkForward,
    async start() {
      if (started) {
        return;
      }
      started = true;
      stopped = false;
      if (live) {
        await startLive();
      } else {
        await startBacktest();
      }
    },
    async stop() {
      stopped = true;
      started = false;
      if (rerankTimer) {
        clock.cancel(rerankTimer);
        rerankTimer = null;
      }
      detachAsOf?.();
      detachAsOf = null;
      registry.stop();
      await signals.stop();
    }
  };
}

export { backfillWallets, backfillWallet, loadBackfillState, writeHistoryTrades } from "./backfill.js";
export type { BackfillOptions, BackfillRpc, BackfillSummary, WalletBackfillResult } from "./backfill.js";
export { rankWallets, persistRankRun, assignRanks, evaluateWallet, rankParamsFrom } from "./ranker.js";
export type { RankedWallet, RankParams, RankRunResult, RankWalletsOptions } from "./ranker.js";
export {
  TrackedWalletRegistry,
  latestRun,
  latestRunAsOf,
  loadTrackedWallets,
  LIVE_RANK_LABEL,
  PUBLISHED_RUN_SQL,
  WALK_FORWARD_RANK_LABEL
} from "./registry.js";
export type { RankRunInfo, StaticTrackedWallet, TrackedWalletRegistryOptions } from "./registry.js";
export { SignalEngine, resolveLaunch, tradeTimeMs } from "./signals.js";
export type { LaunchLookup, RejectionListener, SignalEngineOptions, SignalRejectReason, TrackedBuy } from "./signals.js";
export { buildRoundTrips, groupTradesByWallet, DEFAULT_CLOSE_FRACTION } from "./roundtrips.js";
export type { RoundTripOptions } from "./roundtrips.js";
export { computeWindowStats, emptyWindowStats, statsToJson } from "./stats.js";
export {
  compositeWalletScore,
  confidenceAdjustedEdge,
  exclusionReasons,
  exclusionRulesFrom,
  DEFAULT_EXCLUDED_ENTITY_KINDS,
  DEFAULT_SCORE_WEIGHTS
} from "./scoring.js";
export type { ExclusionRules, WalletScoreWeights } from "./scoring.js";
export { extractWalletTrades, transactionInputFromParsed } from "./txParse.js";
export type { HistoryTrade, TransactionInput } from "./txParse.js";
export * from "./types.js";
