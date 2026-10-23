import { moduleLogger } from "../core/logger.js";
import { utcDayStart } from "./partitions.js";
import { toNumber, type Db } from "./pool.js";

const log = moduleLogger("retention");
const DAY_MS = 86_400_000;
const PARTITION_PATTERN = /^trades_(\d{4})(\d{2})(\d{2})$/;

export interface PruneOptions {
  beforeMs: number;
  dryRun?: boolean;
  batchSize?: number;
}

export interface PruneResult {
  cutoffMs: number;
  droppedPartitions: string[];
  defaultTradesDeleted: number;
  launchesPruned: number;
  scoresDeleted: number;
  snapshotsDeleted: number;
}

export function partitionDayStart(name: string): number | null {
  const match = PARTITION_PATTERN.exec(name);
  if (!match) {
    return null;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

async function tradePartitions(db: Db): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'trades'
      ORDER BY c.relname`
  );
  return result.rows.map((row) => row.name);
}

async function deleteInBatches(db: Db, sql: string, params: unknown[]): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.query(sql, params);
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted === 0) {
      return total;
    }
  }
}

export async function pruneRecordedData(db: Db, options: PruneOptions): Promise<PruneResult> {
  const cutoffMs = utcDayStart(options.beforeMs);
  const batchSize = options.batchSize ?? 5_000;
  const cutoff = new Date(cutoffMs);
  const expired = (await tradePartitions(db)).filter((name) => {
    const dayStart = partitionDayStart(name);
    return dayStart !== null && dayStart + DAY_MS <= cutoffMs;
  });
  const launches = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM launches WHERE created_at < $1", [cutoff]);
  const result: PruneResult = {
    cutoffMs,
    droppedPartitions: expired,
    defaultTradesDeleted: 0,
    launchesPruned: toNumber(launches.rows[0]?.n),
    scoresDeleted: 0,
    snapshotsDeleted: 0
  };
  if (options.dryRun) {
    return result;
  }
  for (const name of expired) {
    await db.query(`ALTER TABLE trades DETACH PARTITION ${name}`);
    await db.query(`DROP TABLE ${name}`);
    log.info({ partition: name }, "trade partition dropped");
  }
  result.defaultTradesDeleted = await deleteInBatches(
    db,
    "DELETE FROM trades_default WHERE ctid IN (SELECT ctid FROM trades_default WHERE block_time < $1 LIMIT $2)",
    [cutoff, batchSize]
  );
  const ownedBy = "launch_id IN (SELECT id FROM launches WHERE created_at < $1)";
  result.scoresDeleted = await deleteInBatches(
    db,
    `DELETE FROM launch_scores WHERE ctid IN (SELECT ctid FROM launch_scores WHERE ${ownedBy} LIMIT $2)`,
    [cutoff, batchSize]
  );
  result.snapshotsDeleted = await deleteInBatches(
    db,
    `DELETE FROM holder_snapshots WHERE ctid IN (SELECT ctid FROM holder_snapshots WHERE ${ownedBy} LIMIT $2)`,
    [cutoff, batchSize]
  );
  return result;
}
