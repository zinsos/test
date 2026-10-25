import type { Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import { hashString } from "../core/rng.js";
import type { Db, DbClient } from "../db/pool.js";

const log = moduleLogger("app.trading-lock");
const LOG_EVERY_MS = 30_000;

export interface TradingLockOptions {
  db: Db;
  name: string;
  clock: Clock;
  retryMs?: number;
  onLost?: (error: unknown) => void;
}

export function advisoryLockKey(name: string): number {
  return hashString(name) | 0;
}

export class TradingLock {
  readonly key: number;
  private readonly options: TradingLockOptions;
  private client: DbClient | null = null;
  private released = false;
  private lost = false;

  constructor(options: TradingLockOptions) {
    this.options = options;
    this.key = advisoryLockKey(options.name);
  }

  held(): boolean {
    return this.client !== null && !this.lost;
  }

  async acquire(shouldStop: () => boolean = () => false): Promise<boolean> {
    const { clock } = this.options;
    const retryMs = this.options.retryMs ?? 2_000;
    let lastLogMs = Number.NEGATIVE_INFINITY;
    for (;;) {
      if (this.released || shouldStop()) {
        return false;
      }
      if (await this.tryOnce()) {
        log.info({ lock: this.options.name }, "trading lock acquired");
        return true;
      }
      if (clock.nowMs() - lastLogMs >= LOG_EVERY_MS) {
        lastLogMs = clock.nowMs();
        log.warn({ lock: this.options.name }, "another process holds the trading lock; waiting for it to stop");
      }
      await clock.sleepUntil(clock.nowMs() + retryMs);
    }
  }

  async release(): Promise<void> {
    this.released = true;
    const client = this.client;
    this.client = null;
    if (!client) {
      return;
    }
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [this.key]);
    } catch (error) {
      log.warn({ err: error }, "trading lock unlock failed; the lock ends with the connection");
    } finally {
      client.release(this.lost);
    }
  }

  private async tryOnce(): Promise<boolean> {
    let client: DbClient;
    try {
      client = await this.options.db.connect();
    } catch (error) {
      log.error({ err: error }, "trading lock connection failed");
      return false;
    }
    try {
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [this.key]);
      if (result.rows[0]?.locked === true) {
        client.on("error", (error: unknown) => this.onConnectionError(error));
        this.client = client;
        return true;
      }
    } catch (error) {
      log.error({ err: error }, "trading lock query failed");
    }
    client.release();
    return false;
  }

  private onConnectionError(error: unknown): void {
    if (this.lost || this.released) {
      return;
    }
    this.lost = true;
    log.fatal({ err: error, lock: this.options.name }, "trading lock connection lost; trading must stop");
    this.options.onLost?.(error);
  }
}
