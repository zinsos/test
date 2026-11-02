import { moduleLogger } from "../core/logger.js";
import type { Db, DbClient } from "../db/pool.js";
import { advisoryLockKey } from "./tradingLock.js";

const log = moduleLogger("app.lane-locks");

export function laneLockName(label: string): string {
  return `snypra-edge:paper-lane:${label}`;
}

export interface LaneLocksOptions {
  db: Db;
  onLost?: (error: unknown) => void;
}

export class LaneLocks {
  private readonly options: LaneLocksOptions;
  private client: DbClient | null = null;
  private connecting: Promise<DbClient | null> | null = null;
  private readonly held = new Set<number>();
  private released = false;
  private lost = false;

  constructor(options: LaneLocksOptions) {
    this.options = options;
  }

  isHeld(name: string): boolean {
    return !this.lost && this.held.has(advisoryLockKey(name));
  }

  isLost(): boolean {
    return this.lost;
  }

  async tryAcquire(name: string): Promise<boolean> {
    const key = advisoryLockKey(name);
    if (this.held.has(key)) {
      return !this.lost;
    }
    const client = await this.connection();
    if (!client) {
      return false;
    }
    try {
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key]);
      if (result.rows[0]?.locked === true) {
        this.held.add(key);
        return true;
      }
    } catch (error) {
      log.error({ err: error, lock: name }, "paper lane lock query failed");
    }
    return false;
  }

  async release(): Promise<void> {
    this.released = true;
    await this.connecting?.catch(() => null);
    const client = this.client;
    this.client = null;
    if (!client) {
      return;
    }
    try {
      if (!this.lost) {
        await client.query("SELECT pg_advisory_unlock_all()");
      }
    } catch (error) {
      log.warn({ err: error }, "paper lane unlock failed; the locks end with the connection");
    } finally {
      this.held.clear();
      client.release(this.lost);
    }
  }

  private async connection(): Promise<DbClient | null> {
    if (this.client) {
      return this.lost ? null : this.client;
    }
    if (this.released) {
      return null;
    }
    this.connecting ??= this.options.db.connect().then(
      (client) => {
        client.on("error", (error: unknown) => this.onConnectionError(error));
        this.client = client;
        return client;
      },
      (error: unknown) => {
        log.error({ err: error }, "paper lane lock connection failed");
        return null;
      }
    );
    const client = await this.connecting;
    this.connecting = null;
    return client;
  }

  private onConnectionError(error: unknown): void {
    if (this.lost || this.released) {
      return;
    }
    this.lost = true;
    log.fatal({ err: error }, "paper lane lock connection lost; paper lanes stop trading");
    this.options.onLost?.(error);
  }
}
