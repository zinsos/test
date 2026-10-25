import { toNumber, type Db } from "../db/pool.js";
import type { TrendingTracker } from "./copycat.js";

const MINUTE_MS = 60_000;

export interface TrendingSeedOptions {
  nowMs: number;
  windowMinutes: number;
  maxLaunches?: number;
  maxVolumeRows?: number;
}

export interface TrendingSeedResult {
  launches: number;
  volumeRows: number;
}

interface LaunchRow {
  mint: string;
  name: string;
  symbol: string;
  created_at: Date;
  quote_mint: string;
}

interface VolumeRow extends LaunchRow {
  minute: unknown;
  volume: string;
}

function infoOf(row: LaunchRow): { mint: string; name: string; symbol: string; createdAtMs: number; quoteMint: string } {
  return { mint: row.mint, name: row.name, symbol: row.symbol, createdAtMs: row.created_at.getTime(), quoteMint: row.quote_mint };
}

export async function seedTrending(db: Db, tracker: TrendingTracker, options: TrendingSeedOptions): Promise<TrendingSeedResult> {
  const fromDate = new Date(options.nowMs - options.windowMinutes * MINUTE_MS);
  const toDate = new Date(options.nowMs);
  const launches = await db.query<LaunchRow>(
    `SELECT mint, name, symbol, created_at, quote_mint FROM launches
      WHERE created_at >= $1 AND created_at < $2
      ORDER BY created_at, id
      LIMIT $3`,
    [fromDate, toDate, options.maxLaunches ?? 50_000]
  );
  const volumes = await db.query<VolumeRow>(
    `WITH recent AS (
       SELECT t.launch_id, floor(extract(epoch FROM t.block_time) / 60)::bigint AS minute, sum(t.quote_amount)::text AS volume
         FROM trades t
        WHERE t.block_time >= $1 AND t.block_time < $2 AND t.quote_amount > 0
        GROUP BY t.launch_id, minute
     )
     SELECT l.mint, l.name, l.symbol, l.created_at, l.quote_mint, r.minute, r.volume
       FROM recent r
       JOIN launches l ON l.id = r.launch_id
      WHERE l.created_at < $2
      ORDER BY l.created_at, l.id, r.minute
      LIMIT $3`,
    [fromDate, toDate, options.maxVolumeRows ?? 200_000]
  );
  for (const row of launches.rows) {
    tracker.onCreate(infoOf(row));
  }
  for (const row of volumes.rows) {
    tracker.onCreate(infoOf(row));
  }
  for (const row of volumes.rows) {
    tracker.onTrade(row.mint, BigInt(row.volume), toNumber(row.minute) * MINUTE_MS);
  }
  tracker.invalidate();
  return { launches: launches.rows.length, volumeRows: volumes.rows.length };
}
