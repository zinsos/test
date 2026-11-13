import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import { toNullableNumber, toNumber, type Db } from "../db/pool.js";
import { LruCache } from "./lru.js";
import type { DevHistoryProvider, DevHistorySummary } from "./types.js";

const log = moduleLogger("dev-history");

export interface DevHistoryServiceOptions {
  db: Db;
  cacheTtlMs?: number;
  maxEntries?: number;
}

interface CachedSummary {
  asOfMs: number;
  summary: DevHistorySummary;
}

interface SummaryRow {
  launch_count: unknown;
  outcome_count: unknown;
  rugged_count: unknown;
  migrated_count: unknown;
  median_peak_multiple: unknown;
}

export const EMPTY_DEV_HISTORY: DevHistorySummary = {
  launchCount: 0,
  outcomeCount: 0,
  ruggedCount: 0,
  migratedCount: 0,
  rugRate: null,
  migrationRate: null,
  medianPeakMultiple: null
};

const DEV_HISTORY_SQL = `
WITH dev_launches AS (
  SELECT id, initial_virtual_quote, initial_virtual_token, token_total_supply, migrated_at
    FROM launches
   WHERE dev_wallet = ANY($1::text[]) AND created_at < $2 AND mint <> $3
  UNION
  SELECT id, initial_virtual_quote, initial_virtual_token, token_total_supply, migrated_at
    FROM launches
   WHERE creator = ANY($1::text[]) AND created_at < $2 AND mint <> $3
),
known AS (
  SELECT d.id,
         o.rugged AND (o.rug_at IS NULL OR o.rug_at < $2) AS rugged,
         o.migrated AND COALESCE(d.migrated_at, o.outcome_known_at) < $2 AS migrated,
         CASE
           WHEN o.peak_at IS NOT NULL AND o.peak_at <= $2 AND o.peak_mcap_quote IS NOT NULL
           THEN o.peak_mcap_quote::float8 / NULLIF(
             COALESCE(
               o.initial_mcap_quote::float8,
               d.initial_virtual_quote::float8 * d.token_total_supply::float8 / NULLIF(d.initial_virtual_token, 0)::float8
             ), 0)
         END AS peak_multiple
    FROM dev_launches d
    JOIN launch_outcomes o ON o.launch_id = d.id
   WHERE o.outcome_known_at IS NOT NULL AND o.outcome_known_at < $2
)
SELECT (SELECT count(*)::int FROM dev_launches) AS launch_count,
       count(*)::int AS outcome_count,
       count(*) FILTER (WHERE rugged)::int AS rugged_count,
       count(*) FILTER (WHERE migrated)::int AS migrated_count,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY peak_multiple) FILTER (WHERE peak_multiple IS NOT NULL) AS median_peak_multiple
  FROM known`;

function cacheKey(devWallets: readonly Pubkey[], excludeMint: Pubkey): string {
  return `${[...new Set(devWallets)].sort().join(",")}|${excludeMint}`;
}

export function summarize(row: SummaryRow | undefined): DevHistorySummary {
  if (!row) {
    return { ...EMPTY_DEV_HISTORY };
  }
  const outcomeCount = toNumber(row.outcome_count);
  const ruggedCount = toNumber(row.rugged_count);
  const migratedCount = toNumber(row.migrated_count);
  return {
    launchCount: toNumber(row.launch_count),
    outcomeCount,
    ruggedCount,
    migratedCount,
    rugRate: outcomeCount > 0 ? ruggedCount / outcomeCount : null,
    migrationRate: outcomeCount > 0 ? migratedCount / outcomeCount : null,
    medianPeakMultiple: toNullableNumber(row.median_peak_multiple)
  };
}

export class DevHistoryService implements DevHistoryProvider {
  private readonly cache: LruCache<string, CachedSummary>;
  private readonly cacheTtlMs: number;

  constructor(private readonly options: DevHistoryServiceOptions) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.cache = new LruCache<string, CachedSummary>(options.maxEntries ?? 20_000);
  }

  async lookup(devWallets: readonly Pubkey[], asOfMs: number, excludeMint: Pubkey): Promise<DevHistorySummary> {
    const wallets = [...new Set(devWallets.filter((wallet) => wallet.length > 0))];
    if (wallets.length === 0) {
      return { ...EMPTY_DEV_HISTORY };
    }
    const key = cacheKey(wallets, excludeMint);
    const cached = this.cache.get(key);
    if (cached && cached.asOfMs <= asOfMs && asOfMs - cached.asOfMs <= this.cacheTtlMs) {
      return cached.summary;
    }
    const summary = await this.query(wallets, asOfMs, excludeMint);
    this.cache.set(key, { asOfMs, summary });
    return summary;
  }

  private async query(wallets: readonly Pubkey[], asOfMs: number, excludeMint: Pubkey): Promise<DevHistorySummary> {
    try {
      const result = await this.options.db.query<SummaryRow>(DEV_HISTORY_SQL, [wallets, new Date(asOfMs), excludeMint]);
      return summarize(result.rows[0]);
    } catch (error) {
      log.warn({ err: error }, "dev history lookup failed");
      throw error;
    }
  }
}
