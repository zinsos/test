import type { TrackerConfig } from "../config/strategy.js";
import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import { withTransaction, type Db, type DbClient } from "../db/pool.js";
import {
  loadHistoryTrades,
  loadMintContexts,
  loadRecordedTrades,
  loadWalletFacts,
  mergeTradeSources,
  selectCandidates,
  type CandidateRow
} from "./rankQueries.js";
import { buildRoundTrips, groupTradesByWallet } from "./roundtrips.js";
import {
  compositeWalletScore,
  DEFAULT_SCORE_WEIGHTS,
  exclusionReasons,
  exclusionRulesFrom,
  type ExclusionRules,
  type WalletScoreWeights
} from "./scoring.js";
import { computeWindowStats, emptyWindowStats, finiteOrNull, statsToJson, type StatsWindow } from "./stats.js";
import { EMPTY_WALLET_FACTS, type ExcludeReason, type WalletFacts, type WalletTrade, type WindowStats } from "./types.js";

const log = moduleLogger("tracker-ranker");
const DAY_MS = 86_400_000;

export interface RankWalletsOptions {
  asOfMs: number;
  config: TrackerConfig;
  bundleSlotWindow: number;
  maxCandidates?: number;
  minDistinctMints?: number;
  maxTradesPerWallet?: number;
  chunkMaxTrades?: number;
  chunkMaxWallets?: number;
  openLookbackDays?: number;
  maxInsiderRate?: number;
  minInsiderLaunches?: number;
  excludedEntityKinds?: readonly string[];
  weights?: Partial<WalletScoreWeights>;
  persist?: boolean;
  label?: string | null;
  historyKnownBeforeMs?: number | null;
}

export interface RankedWallet {
  wallet: Pubkey;
  rank: number | null;
  score: number;
  tracked: boolean;
  excluded: boolean;
  reasons: ExcludeReason[];
  short: WindowStats;
  long: WindowStats;
  facts: WalletFacts;
  openPositions: number;
  orphanSells: number;
  distinctMintsTraded: number;
}

export interface RankRunResult {
  runId: number | null;
  asOfMs: number;
  candidates: number;
  tracked: number;
  excluded: number;
  wallets: RankedWallet[];
  params: RankParams;
}

export interface RankParams {
  asOfMs: number;
  shortWindowDays: number;
  longWindowDays: number;
  topN: number;
  bundleSlotWindow: number;
  maxCandidates: number;
  minDistinctMints: number;
  maxTradesPerWallet: number;
  openLookbackDays: number;
  weights: WalletScoreWeights;
  rules: Omit<ExclusionRules, "excludedEntityKinds"> & { excludedEntityKinds: string[] };
  label: string | null;
  historyKnownBeforeMs: number | null;
}

interface RankContext {
  db: Db;
  params: RankParams;
  rules: ExclusionRules;
  short: StatsWindow;
  long: StatsWindow;
  loadFromMs: number;
}

export function rankParamsFrom(options: RankWalletsOptions): { params: RankParams; rules: ExclusionRules } {
  const config = options.config;
  const rules = exclusionRulesFrom(config, {
    ...(options.maxInsiderRate === undefined ? {} : { maxInsiderRate: options.maxInsiderRate }),
    ...(options.minInsiderLaunches === undefined ? {} : { minInsiderLaunches: options.minInsiderLaunches }),
    ...(options.excludedEntityKinds === undefined ? {} : { excludedEntityKinds: options.excludedEntityKinds })
  });
  const params: RankParams = {
    asOfMs: options.asOfMs,
    shortWindowDays: config.shortWindowDays,
    longWindowDays: config.longWindowDays,
    topN: config.topN,
    bundleSlotWindow: options.bundleSlotWindow,
    maxCandidates: options.maxCandidates ?? 25_000,
    minDistinctMints: options.minDistinctMints ?? Math.max(1, Math.min(config.minTradesShort, config.minTradesLong)),
    maxTradesPerWallet: options.maxTradesPerWallet ?? 20_000,
    openLookbackDays: options.openLookbackDays ?? 2,
    weights: { ...DEFAULT_SCORE_WEIGHTS, ...options.weights },
    rules: { ...rules, excludedEntityKinds: [...rules.excludedEntityKinds] },
    label: options.label ?? null,
    historyKnownBeforeMs: options.historyKnownBeforeMs === undefined ? options.asOfMs : options.historyKnownBeforeMs
  };
  return { params, rules };
}

export function chunkCandidates(candidates: readonly CandidateRow[], maxTrades: number, maxWallets: number): CandidateRow[][] {
  const chunks: CandidateRow[][] = [];
  let current: CandidateRow[] = [];
  let budget = 0;
  for (const candidate of candidates) {
    if (current.length > 0 && (budget + candidate.trades > maxTrades || current.length >= maxWallets)) {
      chunks.push(current);
      current = [];
      budget = 0;
    }
    current.push(candidate);
    budget += candidate.trades;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function evaluateWallet(
  wallet: Pubkey,
  trades: readonly WalletTrade[],
  facts: WalletFacts,
  context: Pick<RankContext, "params" | "rules" | "short" | "long">,
  mints: Parameters<typeof buildRoundTrips>[1]["mints"]
): RankedWallet {
  const roundTrips = buildRoundTrips(trades, {
    asOfMs: context.params.asOfMs,
    mints,
    bundleSlotWindow: context.params.bundleSlotWindow
  });
  const short = computeWindowStats(roundTrips.closed, context.short);
  const long = computeWindowStats(roundTrips.closed, context.long);
  const reasons = exclusionReasons(short, long, facts, context.rules);
  return {
    wallet,
    rank: null,
    score: compositeWalletScore(short, long, context.params.weights),
    tracked: false,
    excluded: reasons.length > 0,
    reasons,
    short,
    long,
    facts,
    openPositions: roundTrips.open.length,
    orphanSells: roundTrips.orphanSells,
    distinctMintsTraded: new Set(trades.map((trade) => trade.mint)).size
  };
}

function tooActiveWallet(candidate: CandidateRow, facts: WalletFacts, context: RankContext): RankedWallet {
  const reasons = exclusionReasons(emptyWindowStats(context.short), emptyWindowStats(context.long), facts, context.rules);
  return {
    wallet: candidate.wallet,
    rank: null,
    score: 0,
    tracked: false,
    excluded: true,
    reasons,
    short: emptyWindowStats(context.short),
    long: emptyWindowStats(context.long),
    facts,
    openPositions: 0,
    orphanSells: 0,
    distinctMintsTraded: candidate.mints
  };
}

async function evaluateChunk(context: RankContext, chunk: readonly CandidateRow[]): Promise<RankedWallet[]> {
  const wallets = chunk.map((candidate) => candidate.wallet);
  const [recorded, history] = await Promise.all([
    loadRecordedTrades(context.db, wallets, context.loadFromMs, context.params.asOfMs),
    loadHistoryTrades(context.db, wallets, context.loadFromMs, context.params.asOfMs, context.params.historyKnownBeforeMs)
  ]);
  const trades = mergeTradeSources(recorded, history);
  const mints = [...new Set(trades.map((trade) => trade.mint))];
  const [contexts, facts] = await Promise.all([
    loadMintContexts(context.db, mints, context.params.asOfMs),
    loadWalletFacts(context.db, wallets, { fromMs: context.long.fromMs, asOfMs: context.params.asOfMs }, new Set())
  ]);
  const byWallet = groupTradesByWallet(trades);
  return wallets.map((wallet) =>
    evaluateWallet(wallet, byWallet.get(wallet) ?? [], facts.get(wallet) ?? EMPTY_WALLET_FACTS, context, contexts)
  );
}

async function evaluateTooActive(context: RankContext, candidates: readonly CandidateRow[], chunkSize: number): Promise<RankedWallet[]> {
  const ranked: RankedWallet[] = [];
  for (let start = 0; start < candidates.length; start += chunkSize) {
    const chunk = candidates.slice(start, start + chunkSize);
    const wallets = chunk.map((candidate) => candidate.wallet);
    const window = { fromMs: context.long.fromMs, asOfMs: context.params.asOfMs };
    const facts = await loadWalletFacts(context.db, wallets, window, new Set(wallets));
    for (const candidate of chunk) {
      ranked.push(tooActiveWallet(candidate, facts.get(candidate.wallet) ?? { ...EMPTY_WALLET_FACTS, tooActive: true }, context));
    }
  }
  return ranked;
}

export function compareRanked(a: RankedWallet, b: RankedWallet): number {
  if (a.excluded !== b.excluded) {
    return a.excluded ? 1 : -1;
  }
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  if (b.short.realizedPnlSol !== a.short.realizedPnlSol) {
    return b.short.realizedPnlSol - a.short.realizedPnlSol;
  }
  return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
}

export function assignRanks(wallets: RankedWallet[], topN: number): RankedWallet[] {
  wallets.sort(compareRanked);
  let rank = 0;
  for (const wallet of wallets) {
    if (wallet.excluded) {
      wallet.rank = null;
      wallet.tracked = false;
      continue;
    }
    rank += 1;
    wallet.rank = rank;
    wallet.tracked = rank <= topN && wallet.score > 0;
  }
  return wallets;
}

function rankRowValues(runId: number, wallet: RankedWallet): unknown[] {
  return [
    runId,
    wallet.wallet,
    wallet.rank,
    finiteOrNull(wallet.score) ?? 0,
    wallet.tracked,
    wallet.excluded,
    wallet.reasons[0] ?? null,
    wallet.short.realizedPnlSol,
    wallet.long.realizedPnlSol,
    wallet.short.closed,
    wallet.long.closed,
    wallet.short.winRate,
    wallet.long.winRate,
    wallet.long.medianWinSol,
    wallet.long.medianLossSol,
    wallet.long.medianHoldSec,
    wallet.long.medianEntryDelaySec,
    JSON.stringify({
      reasons: wallet.reasons,
      short: statsToJson(wallet.short),
      long: statsToJson(wallet.long),
      facts: wallet.facts,
      openPositions: wallet.openPositions,
      orphanSells: wallet.orphanSells,
      distinctMintsTraded: wallet.distinctMintsTraded
    })
  ];
}

const RANK_COLUMNS = [
  "run_id",
  "wallet",
  "rank",
  "score",
  "tracked",
  "excluded",
  "exclude_reason",
  "pnl_30d",
  "pnl_90d",
  "trades_30d",
  "trades_90d",
  "win_rate_30d",
  "win_rate_90d",
  "median_win",
  "median_loss",
  "median_hold_sec",
  "median_entry_delay_sec",
  "stats"
] as const;

async function insertRankRows(client: DbClient, runId: number, wallets: readonly RankedWallet[]): Promise<void> {
  const chunkSize = 500;
  for (let start = 0; start < wallets.length; start += chunkSize) {
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const wallet of wallets.slice(start, start + chunkSize)) {
      const placeholders = rankRowValues(runId, wallet).map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      tuples.push(`(${placeholders.join(",")})`);
    }
    await client.query(
      `INSERT INTO wallet_ranks (${RANK_COLUMNS.join(",")}) VALUES ${tuples.join(",")}
       ON CONFLICT (run_id, wallet) DO UPDATE SET
         rank = EXCLUDED.rank, score = EXCLUDED.score, tracked = EXCLUDED.tracked, excluded = EXCLUDED.excluded,
         exclude_reason = EXCLUDED.exclude_reason, pnl_30d = EXCLUDED.pnl_30d, pnl_90d = EXCLUDED.pnl_90d,
         trades_30d = EXCLUDED.trades_30d, trades_90d = EXCLUDED.trades_90d, win_rate_30d = EXCLUDED.win_rate_30d,
         win_rate_90d = EXCLUDED.win_rate_90d, median_win = EXCLUDED.median_win, median_loss = EXCLUDED.median_loss,
         median_hold_sec = EXCLUDED.median_hold_sec, median_entry_delay_sec = EXCLUDED.median_entry_delay_sec,
         stats = EXCLUDED.stats`,
      params
    );
  }
}

export async function persistRankRun(db: Db, params: RankParams, wallets: readonly RankedWallet[]): Promise<number> {
  const tracked = wallets.filter((wallet) => wallet.tracked).length;
  return withTransaction(db, async (client) => {
    const run = await client.query<{ id: bigint }>(
      `INSERT INTO wallet_rank_runs (as_of, params, candidates, tracked) VALUES ($1, $2, $3, $4) RETURNING id`,
      [new Date(params.asOfMs), JSON.stringify(params), wallets.length, tracked]
    );
    const runId = Number(run.rows[0]?.id ?? 0);
    await insertRankRows(client, runId, wallets);
    return runId;
  });
}

function windowsFor(params: RankParams): { short: StatsWindow; long: StatsWindow; loadFromMs: number } {
  const longFrom = params.asOfMs - params.longWindowDays * DAY_MS;
  return {
    short: { fromMs: params.asOfMs - params.shortWindowDays * DAY_MS, toMs: params.asOfMs },
    long: { fromMs: longFrom, toMs: params.asOfMs },
    loadFromMs: longFrom - params.openLookbackDays * DAY_MS
  };
}

export async function rankWallets(db: Db, options: RankWalletsOptions): Promise<RankRunResult> {
  const { params, rules } = rankParamsFrom(options);
  const context: RankContext = { db, params, rules, ...windowsFor(params) };
  const candidates = await selectCandidates(db, {
    fromMs: context.long.fromMs,
    asOfMs: params.asOfMs,
    minDistinctMints: params.minDistinctMints,
    limit: params.maxCandidates,
    historyKnownBeforeMs: params.historyKnownBeforeMs
  });
  const tooActive = candidates.filter((candidate) => candidate.trades > params.maxTradesPerWallet);
  const regular = candidates.filter((candidate) => candidate.trades <= params.maxTradesPerWallet);
  const chunkMaxWallets = Math.max(1, options.chunkMaxWallets ?? 1_000);
  const ranked: RankedWallet[] = await evaluateTooActive(context, tooActive, chunkMaxWallets);
  for (const chunk of chunkCandidates(regular, options.chunkMaxTrades ?? 250_000, chunkMaxWallets)) {
    ranked.push(...(await evaluateChunk(context, chunk)));
  }
  assignRanks(ranked, params.topN);
  const runId = options.persist === false ? null : await persistRankRun(db, params, ranked);
  const tracked = ranked.filter((wallet) => wallet.tracked).length;
  log.info({ runId, asOf: new Date(params.asOfMs).toISOString(), candidates: ranked.length, tracked }, "wallet ranking finished");
  return {
    runId,
    asOfMs: params.asOfMs,
    candidates: ranked.length,
    tracked,
    excluded: ranked.filter((wallet) => wallet.excluded).length,
    wallets: ranked,
    params
  };
}
