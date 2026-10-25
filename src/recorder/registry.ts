import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import { toBigInt, toNullableNumber, toNumber, type Db } from "../db/pool.js";

const log = moduleLogger("launch-registry");

export interface TrackedLaunch {
  launchId: number;
  mint: Pubkey;
  createdAtMs: number;
  createdSlot: number;
  tokenTotalSupply: bigint;
  pool: Pubkey | null;
  resumeSlot: number | null;
}

export interface LaunchRegistryOptions {
  db: Db;
}

export type UntrackListener = (launch: TrackedLaunch) => void;

interface TrackedRow {
  id: unknown;
  mint: string;
  pool: string | null;
  created_at: Date;
  create_slot: unknown;
  last_trade_slot: unknown;
  token_total_supply: unknown;
}

export class LaunchRegistry {
  private readonly db: Db;
  private readonly byMint = new Map<Pubkey, TrackedLaunch>();
  private readonly pools = new Map<Pubkey, Pubkey>();
  private readonly untrackListeners = new Set<UntrackListener>();

  constructor(options: LaunchRegistryOptions) {
    this.db = options.db;
  }

  readonly poolLookup = (pool: Pubkey): Pubkey | undefined => this.pools.get(pool);

  get size(): number {
    return this.byMint.size;
  }

  async load(): Promise<number> {
    const result = await this.db.query<TrackedRow>(
      `SELECT id, mint, pool, created_at, create_slot, last_trade_slot, token_total_supply
         FROM launches
        WHERE tracking_ended_at IS NULL`
    );
    for (const row of result.rows) {
      this.track({
        launchId: toNumber(row.id),
        mint: row.mint,
        createdAtMs: row.created_at.getTime(),
        createdSlot: toNumber(row.create_slot),
        tokenTotalSupply: toBigInt(row.token_total_supply),
        pool: row.pool,
        resumeSlot: toNullableNumber(row.last_trade_slot)
      });
    }
    log.info({ tracked: this.byMint.size }, "launch registry loaded");
    return result.rows.length;
  }

  get(mint: Pubkey): TrackedLaunch | undefined {
    return this.byMint.get(mint);
  }

  launchId(mint: Pubkey): number | undefined {
    return this.byMint.get(mint)?.launchId;
  }

  isTracked(mint: Pubkey): boolean {
    return this.byMint.has(mint);
  }

  mintForPool(pool: Pubkey): Pubkey | undefined {
    return this.pools.get(pool);
  }

  entries(): IterableIterator<TrackedLaunch> {
    return this.byMint.values();
  }

  track(launch: TrackedLaunch): void {
    this.byMint.set(launch.mint, launch);
    if (launch.pool) {
      this.pools.set(launch.pool, launch.mint);
    }
  }

  registerPool(mint: Pubkey, pool: Pubkey): void {
    this.pools.set(pool, mint);
    const launch = this.byMint.get(mint);
    if (launch) {
      launch.pool = pool;
    }
  }

  forgetPool(pool: Pubkey): void {
    this.pools.delete(pool);
  }

  untrack(mint: Pubkey): TrackedLaunch | undefined {
    const launch = this.byMint.get(mint);
    if (!launch) {
      return undefined;
    }
    this.byMint.delete(mint);
    if (launch.pool && this.pools.get(launch.pool) === mint) {
      this.pools.delete(launch.pool);
    }
    for (const listener of this.untrackListeners) {
      try {
        listener(launch);
      } catch (error) {
        log.error({ err: error, mint }, "untrack listener failed");
      }
    }
    return launch;
  }

  onUntrack(listener: UntrackListener): () => void {
    this.untrackListeners.add(listener);
    return () => {
      this.untrackListeners.delete(listener);
    };
  }
}
