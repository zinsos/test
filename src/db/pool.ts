import pg from "pg";
import { moduleLogger } from "../core/logger.js";

const log = moduleLogger("db");

pg.types.setTypeParser(20, (value: string) => BigInt(value));
pg.types.setTypeParser(1700, (value: string) => Number(value));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export interface DbOptions {
  connectionString: string;
  maxConnections: number;
  ssl: boolean;
  applicationName: string;
}

export function createDb(options: DbOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: options.applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000
  });
  pool.on("error", (error) => {
    log.error({ err: error }, "idle database client error");
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && value.length > 0) {
    return BigInt(value);
  }
  return 0n;
}

export function toNullableBigInt(value: unknown): bigint | null {
  return value === null || value === undefined ? null : toBigInt(value);
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return Number(value);
  }
  return 0;
}

export function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

export function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) => (typeof inner === "bigint" ? inner.toString() : inner))
  );
}
