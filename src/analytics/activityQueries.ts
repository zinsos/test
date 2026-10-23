import { SOL_QUOTE } from "../core/constants.js";
import type { FeatureVector, LaunchScore, Pubkey } from "../core/types.js";
import { toBigInt, toNullableNumber, toNumber, type Db } from "../db/pool.js";
import { PUBLISHED_RUN_SQL } from "../tracker/registry.js";
import { LAB_RUN_IDS_SQL } from "./labQueries.js";
import { clampLimit } from "./tradeQueries.js";
import { lamportsRatio } from "./units.js";

export const DEFAULT_RECENT_LIMIT = 50;
export const MAX_RECENT_LIMIT = 500;
export const DEFAULT_WALLET_LIMIT = 100;
const MAX_SIGNAL_WALLETS = 10;

type DbRecord = Record<string, unknown>;

export interface SignalListItem {
  id: number;
  runId: number | null;
  type: string;
  mint: Pubkey;
  launchId: number | null;
  atMs: number;
  slot: number;
  riskScore: number | null;
  walletCount: number;
  wallets: Pubkey[];
  acted: boolean;
  skipReason: string | null;
  meta: Record<string, unknown>;
  symbol: string | null;
  name: string | null;
}

export interface LaunchScoreBrief {
  checkpointSec: number;
  score: number;
  hardBlocked: boolean;
  flags: string[];
  computedAtMs: number;
}

export interface LaunchOutcomeBrief {
  status: string;
  migrated: boolean;
  rugged: boolean;
  died: boolean;
  survived15m: boolean | null;
  finalized: boolean;
  peakMultiple: number | null;
}

export interface LaunchListItem {
  launchId: number;
  mint: Pubkey;
  name: string;
  symbol: string;
  quoteMint: string;
  isSolQuoted: boolean;
  createdAtMs: number;
  tradeCount: number;
  uniqueTraders: number;
  completedAtMs: number | null;
  migratedAtMs: number | null;
  score: LaunchScoreBrief | null;
  outcome: LaunchOutcomeBrief | null;
}

export interface RankRunSummary {
  runId: number;
  asOfMs: number;
  ranAtMs: number;
  candidates: number;
  tracked: number;
}

export interface TrackedWalletItem {
  wallet: Pubkey;
  rank: number | null;
  score: number;
  pnl30dSol: number | null;
  pnl90dSol: number | null;
  trades30d: number | null;
  trades90d: number | null;
  winRate30d: number | null;
  winRate90d: number | null;
  medianWinSol: number | null;
  medianLossSol: number | null;
  medianHoldSec: number | null;
  medianEntryDelaySec: number | null;
}

export interface TrackedWalletsResult {
  run: RankRunSummary | null;
  wallets: TrackedWalletItem[];
}

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

export async function latestSkipReason(db: Db, runId: number, mint: Pubkey, sinceMs: number): Promise<string | null> {
  const result = await db.query<DbRecord>(
    `SELECT skip_reason FROM signals
     WHERE run_id = $1 AND mint = $2 AND acted = FALSE AND at >= $3
     ORDER BY id DESC
     LIMIT 1`,
    [runId, mint, new Date(sinceMs)]
  );
  return textOrNull(result.rows[0]?.skip_reason);
}

export async function recentSignals(
  db: Db,
  options: { limit?: number; runId?: number | null; type?: string | null } = {}
): Promise<SignalListItem[]> {
  const limit = clampLimit(options.limit, DEFAULT_RECENT_LIMIT, MAX_RECENT_LIMIT);
  const result = await db.query<DbRecord>(
    `SELECT s.id, s.run_id, s.type, s.mint, s.launch_id, s.at, s.slot, s.risk_score,
            cardinality(s.wallets) AS wallet_count, s.wallets[1:${MAX_SIGNAL_WALLETS}] AS wallets,
            s.acted, s.skip_reason, s.meta, l.symbol, l.name
     FROM signals s
     LEFT JOIN launches l ON l.mint = s.mint
     WHERE ($2::bigint IS NULL OR s.run_id = $2)
       AND ($2::bigint IS NOT NULL OR s.run_id IS NULL OR s.run_id NOT IN (${LAB_RUN_IDS_SQL}))
       AND ($3::text IS NULL OR s.type = $3)
     ORDER BY s.at DESC, s.id DESC
     LIMIT $1`,
    [limit, options.runId ?? null, options.type ?? null]
  );
  return result.rows.map((row) => ({
    id: toNumber(row.id),
    runId: nullableInt(row.run_id),
    type: String(row.type ?? ""),
    mint: String(row.mint ?? ""),
    launchId: nullableInt(row.launch_id),
    atMs: msOf(row.at) ?? 0,
    slot: toNumber(row.slot),
    riskScore: toNullableNumber(row.risk_score),
    walletCount: toNumber(row.wallet_count),
    wallets: stringArray(row.wallets),
    acted: row.acted === true,
    skipReason: textOrNull(row.skip_reason),
    meta: objectOrEmpty(row.meta),
    symbol: textOrNull(row.symbol),
    name: textOrNull(row.name)
  }));
}

function scoreBrief(row: DbRecord): LaunchScoreBrief | null {
  if (row.score === null || row.score === undefined) {
    return null;
  }
  return {
    checkpointSec: toNumber(row.checkpoint_sec),
    score: toNumber(row.score),
    hardBlocked: row.hard_blocked === true,
    flags: stringArray(row.flags),
    computedAtMs: msOf(row.computed_at) ?? 0
  };
}

function outcomeBrief(row: DbRecord): LaunchOutcomeBrief | null {
  if (typeof row.status !== "string") {
    return null;
  }
  const initial = row.initial_mcap_quote === null ? null : toBigInt(row.initial_mcap_quote);
  const peak = row.peak_mcap_quote === null ? null : toBigInt(row.peak_mcap_quote);
  return {
    status: row.status,
    migrated: row.migrated === true,
    rugged: row.rugged === true,
    died: row.died === true,
    survived15m: typeof row.survived_15m === "boolean" ? row.survived_15m : null,
    finalized: row.finalized === true,
    peakMultiple: initial === null || peak === null || initial <= 0n ? null : lamportsRatio(peak, initial)
  };
}

export async function recentLaunches(
  db: Db,
  options: { limit?: number; quoteMint?: string | null } = {}
): Promise<LaunchListItem[]> {
  const limit = clampLimit(options.limit, DEFAULT_RECENT_LIMIT, MAX_RECENT_LIMIT);
  const result = await db.query<DbRecord>(
    `SELECT l.id, l.mint, l.name, l.symbol, l.quote_mint, l.created_at, l.trade_count, l.unique_traders,
            l.completed_at, l.migrated_at,
            sc.checkpoint_sec, sc.score, sc.hard_blocked, sc.flags, sc.computed_at,
            o.status, o.migrated, o.rugged, o.died, o.survived_15m, o.finalized, o.initial_mcap_quote, o.peak_mcap_quote
     FROM launches l
     LEFT JOIN LATERAL (
       SELECT checkpoint_sec, score, hard_blocked, flags, computed_at
       FROM launch_scores
       WHERE launch_id = l.id
       ORDER BY checkpoint_sec DESC
       LIMIT 1
     ) sc ON TRUE
     LEFT JOIN launch_outcomes o ON o.launch_id = l.id
     WHERE ($2::text IS NULL OR l.quote_mint = $2)
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $1`,
    [limit, options.quoteMint ?? null]
  );
  return result.rows.map((row) => {
    const quoteMint = String(row.quote_mint ?? SOL_QUOTE);
    return {
      launchId: toNumber(row.id),
      mint: String(row.mint ?? ""),
      name: String(row.name ?? ""),
      symbol: String(row.symbol ?? ""),
      quoteMint,
      isSolQuoted: quoteMint === SOL_QUOTE,
      createdAtMs: msOf(row.created_at) ?? 0,
      tradeCount: toNumber(row.trade_count),
      uniqueTraders: toNumber(row.unique_traders),
      completedAtMs: msOf(row.completed_at),
      migratedAtMs: msOf(row.migrated_at),
      score: scoreBrief(row),
      outcome: outcomeBrief(row)
    };
  });
}

function featureVector(raw: unknown): FeatureVector {
  const features: FeatureVector = {};
  for (const [name, value] of Object.entries(objectOrEmpty(raw))) {
    features[name] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return features;
}

function contributionMap(raw: unknown): Record<string, number> {
  const contributions: Record<string, number> = {};
  for (const [name, value] of Object.entries(objectOrEmpty(raw))) {
    if (typeof value === "number" && Number.isFinite(value)) {
      contributions[name] = value;
    }
  }
  return contributions;
}

export async function latestScore(db: Db, mint: Pubkey): Promise<LaunchScore | null> {
  const result = await db.query<DbRecord>(
    `SELECT launch_id, checkpoint_sec, mint, computed_at, slot, score, hard_blocked, flags, features, contributions, weights_version
     FROM launch_scores
     WHERE mint = $1
     ORDER BY checkpoint_sec DESC, computed_at DESC
     LIMIT 1`,
    [mint]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    mint: String(row.mint ?? mint),
    launchId: nullableInt(row.launch_id),
    checkpointSec: toNumber(row.checkpoint_sec),
    computedAtMs: msOf(row.computed_at) ?? 0,
    slot: toNumber(row.slot),
    score: toNumber(row.score),
    hardBlocked: row.hard_blocked === true,
    flags: stringArray(row.flags),
    features: featureVector(row.features),
    contributions: contributionMap(row.contributions),
    weightsVersion: String(row.weights_version ?? "")
  };
}

export async function latestRankRun(db: Db): Promise<RankRunSummary | null> {
  const result = await db.query<DbRecord>(
    `SELECT id, as_of, ran_at, candidates, tracked FROM wallet_rank_runs WHERE ${PUBLISHED_RUN_SQL} ORDER BY as_of DESC, id DESC LIMIT 1`
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    runId: toNumber(row.id),
    asOfMs: msOf(row.as_of) ?? 0,
    ranAtMs: msOf(row.ran_at) ?? 0,
    candidates: toNumber(row.candidates),
    tracked: toNumber(row.tracked)
  };
}

export async function trackedWallets(db: Db, options: { limit?: number } = {}): Promise<TrackedWalletsResult> {
  const run = await latestRankRun(db);
  if (!run) {
    return { run: null, wallets: [] };
  }
  const limit = clampLimit(options.limit, DEFAULT_WALLET_LIMIT, 1_000);
  const result = await db.query<DbRecord>(
    `SELECT wallet, rank, score, pnl_30d, pnl_90d, trades_30d, trades_90d, win_rate_30d, win_rate_90d,
            median_win, median_loss, median_hold_sec, median_entry_delay_sec
     FROM wallet_ranks
     WHERE run_id = $1 AND tracked
     ORDER BY rank NULLS LAST, score DESC, wallet
     LIMIT $2`,
    [run.runId, limit]
  );
  return {
    run,
    wallets: result.rows.map((row) => ({
      wallet: String(row.wallet ?? ""),
      rank: nullableInt(row.rank),
      score: toNumber(row.score),
      pnl30dSol: toNullableNumber(row.pnl_30d),
      pnl90dSol: toNullableNumber(row.pnl_90d),
      trades30d: nullableInt(row.trades_30d),
      trades90d: nullableInt(row.trades_90d),
      winRate30d: toNullableNumber(row.win_rate_30d),
      winRate90d: toNullableNumber(row.win_rate_90d),
      medianWinSol: toNullableNumber(row.median_win),
      medianLossSol: toNullableNumber(row.median_loss),
      medianHoldSec: toNullableNumber(row.median_hold_sec),
      medianEntryDelaySec: toNullableNumber(row.median_entry_delay_sec)
    }))
  };
}
