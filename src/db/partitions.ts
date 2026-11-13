import { moduleLogger } from "../core/logger.js";
import type { Db } from "./pool.js";

const log = moduleLogger("partitions");
const DAY_MS = 86_400_000;

export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function dayLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function tradePartitionName(dayStartMs: number): string {
  return `trades_${dayLabel(dayStartMs).replaceAll("-", "")}`;
}

export async function ensureTradePartitions(db: Db, nowMs: number, daysBack: number, daysAhead: number): Promise<void> {
  const today = utcDayStart(nowMs);
  for (let offset = -daysBack; offset <= daysAhead; offset += 1) {
    const start = today + offset * DAY_MS;
    const end = start + DAY_MS;
    const name = tradePartitionName(start);
    const exists = await db.query("SELECT 1 FROM pg_class WHERE relname = $1", [name]);
    if ((exists.rowCount ?? 0) > 0) {
      continue;
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE trades IN SHARE ROW EXCLUSIVE MODE");
      await client.query(`CREATE TABLE ${name} (LIKE trades INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
      const moved = await client.query(
        `WITH moved AS (DELETE FROM trades_default WHERE block_time >= $1 AND block_time < $2 RETURNING *)
         INSERT INTO ${name} SELECT * FROM moved`,
        [new Date(start), new Date(end)]
      );
      await client.query(
        `ALTER TABLE trades ATTACH PARTITION ${name} FOR VALUES FROM ('${new Date(start).toISOString()}') TO ('${new Date(end).toISOString()}')`
      );
      await client.query("COMMIT");
      log.info({ partition: name, movedRows: moved.rowCount ?? 0 }, "trade partition created");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      log.error({ err: error, partition: name }, "failed to create trade partition");
    } finally {
      client.release();
    }
  }
}
