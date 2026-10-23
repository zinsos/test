import type { Clock, TimerHandle } from "../core/clock.js";
import type { TrackedWallet, TrackedWalletProvider } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import { toNumber, type Db } from "../db/pool.js";

const log = moduleLogger("tracker-registry");

export interface RankRunInfo {
  runId: number;
  asOfMs: number;
}

export const LIVE_RANK_LABEL = "live";
export const WALK_FORWARD_RANK_LABEL = "walk-forward";

export const PUBLISHED_RUN_SQL = `COALESCE(params->>'label', '') <> '${WALK_FORWARD_RANK_LABEL}'`;

const AVAILABLE_AT_SQL = `CASE WHEN jsonb_typeof(params->'historyKnownBeforeMs') = 'null' THEN GREATEST(as_of, ran_at) ELSE as_of END`;

export interface TrackedWalletRegistryOptions {
  db: Db | null;
  clock?: Clock | null;
  refreshIntervalMs?: number;
}

export interface StaticTrackedWallet {
  wallet: Pubkey;
  score?: number;
  rank?: number;
}

interface PreloadedRun extends RankRunInfo {
  availableAtMs: number;
  wallets: TrackedWallet[];
}

interface RunRow {
  id: unknown;
  as_of: Date;
}

interface AvailableRunRow extends RunRow {
  available_at: Date;
}

interface RankRow {
  run_id: unknown;
  wallet: string;
  rank: unknown;
  score: unknown;
}

export async function latestRunAsOf(db: Db, asOfMs: number): Promise<RankRunInfo | null> {
  const result = await db.query<RunRow>(
    `SELECT id, as_of FROM wallet_rank_runs WHERE as_of <= $1 AND ${PUBLISHED_RUN_SQL} ORDER BY as_of DESC, id DESC LIMIT 1`,
    [new Date(asOfMs)]
  );
  const row = result.rows[0];
  return row ? { runId: toNumber(row.id), asOfMs: row.as_of.getTime() } : null;
}

export async function latestRun(db: Db): Promise<RankRunInfo | null> {
  const result = await db.query<RunRow>(
    `SELECT id, as_of FROM wallet_rank_runs WHERE ${PUBLISHED_RUN_SQL} ORDER BY as_of DESC, id DESC LIMIT 1`
  );
  const row = result.rows[0];
  return row ? { runId: toNumber(row.id), asOfMs: row.as_of.getTime() } : null;
}

function trackedFromRow(row: RankRow): TrackedWallet {
  return {
    wallet: row.wallet,
    rank: toNumber(row.rank),
    score: toNumber(row.score),
    runId: toNumber(row.run_id)
  };
}

export async function loadTrackedWallets(db: Db, runIds: readonly number[]): Promise<Map<number, TrackedWallet[]>> {
  const byRun = new Map<number, TrackedWallet[]>();
  if (runIds.length === 0) {
    return byRun;
  }
  const result = await db.query<RankRow>(
    `SELECT run_id, wallet, rank, score FROM wallet_ranks
     WHERE run_id = ANY($1::bigint[]) AND tracked
     ORDER BY run_id, rank`,
    [runIds.map((id) => id.toString())]
  );
  for (const row of result.rows) {
    const wallet = trackedFromRow(row);
    const list = byRun.get(wallet.runId) ?? [];
    list.push(wallet);
    byRun.set(wallet.runId, list);
  }
  return byRun;
}

function newestAsOfSoFar(runs: readonly PreloadedRun[]): number[] {
  const best: number[] = [];
  runs.forEach((run, index) => {
    const previous = best[index - 1] ?? -1;
    const current = runs[previous];
    const newer = !current || run.asOfMs > current.asOfMs || (run.asOfMs === current.asOfMs && run.runId > current.runId);
    best.push(newer ? index : previous);
  });
  return best;
}

export class TrackedWalletRegistry implements TrackedWalletProvider {
  private readonly db: Db | null;
  private readonly clock: Clock | null;
  private readonly refreshIntervalMs: number;
  private wallets = new Map<Pubkey, TrackedWallet>();
  private run: RankRunInfo | null = null;
  private versionTag = "none";
  private preloaded: PreloadedRun[] = [];
  private inForce: number[] = [];
  private preloadedIndex = -1;
  private refreshTimer: TimerHandle | null = null;
  private refreshing: Promise<RankRunInfo | null> | null = null;

  constructor(options: TrackedWalletRegistryOptions) {
    this.db = options.db;
    this.clock = options.clock ?? null;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 15 * 60_000;
  }

  static fromWallets(wallets: ReadonlyArray<Pubkey | StaticTrackedWallet>, runId = 0): TrackedWalletRegistry {
    const registry = new TrackedWalletRegistry({ db: null });
    const tracked = wallets.map((entry, index): TrackedWallet => {
      const spec = typeof entry === "string" ? { wallet: entry } : entry;
      return { wallet: spec.wallet, rank: spec.rank ?? index + 1, score: spec.score ?? 1, runId };
    });
    registry.replace(tracked, runId === 0 ? null : { runId, asOfMs: 0 }, `static:${tracked.length}`);
    return registry;
  }

  static async loadAsOf(db: Db, asOfMs: number): Promise<TrackedWalletRegistry> {
    const registry = new TrackedWalletRegistry({ db });
    await registry.load(asOfMs);
    return registry;
  }

  isTracked(wallet: Pubkey): boolean {
    return this.wallets.has(wallet);
  }

  get(wallet: Pubkey): TrackedWallet | null {
    return this.wallets.get(wallet) ?? null;
  }

  count(): number {
    return this.wallets.size;
  }

  version(): string {
    return this.versionTag;
  }

  currentRun(): RankRunInfo | null {
    return this.run;
  }

  list(): TrackedWallet[] {
    return [...this.wallets.values()].sort((a, b) => a.rank - b.rank);
  }

  setWallets(wallets: ReadonlyArray<Pubkey | StaticTrackedWallet>): void {
    const next = TrackedWalletRegistry.fromWallets(wallets);
    this.replace(next.list(), null, next.version());
  }

  async load(asOfMs: number): Promise<RankRunInfo | null> {
    const db = this.requireDb();
    const run = await latestRunAsOf(db, asOfMs);
    if (!run) {
      this.replace([], null, "none");
      return null;
    }
    if (this.run?.runId === run.runId) {
      return run;
    }
    const wallets = (await loadTrackedWallets(db, [run.runId])).get(run.runId) ?? [];
    this.replace(wallets, run, `run:${run.runId}`);
    log.info({ runId: run.runId, asOf: new Date(run.asOfMs).toISOString(), tracked: wallets.length }, "tracked wallets loaded");
    return run;
  }

  async preloadRuns(range: { fromMs: number; toMs: number }, onlyRunIds: readonly number[] | null = null): Promise<number> {
    const db = this.requireDb();
    const scope = onlyRunIds === null ? PUBLISHED_RUN_SQL : "id = ANY($3::bigint[])";
    const result = await db.query<AvailableRunRow>(
      `WITH runs AS (
         SELECT id, as_of, ${AVAILABLE_AT_SQL} AS available_at FROM wallet_rank_runs WHERE ${scope}
       )
       SELECT id, as_of, available_at FROM runs
       WHERE available_at <= $2 AND (available_at >= $1 OR id = (
         SELECT id FROM runs WHERE available_at < $1 ORDER BY as_of DESC, id DESC LIMIT 1))
       ORDER BY available_at, as_of, id`,
      [new Date(range.fromMs), new Date(range.toMs), ...(onlyRunIds === null ? [] : [onlyRunIds.map(String)])]
    );
    const runs = result.rows.map((row) => ({
      runId: toNumber(row.id),
      asOfMs: row.as_of.getTime(),
      availableAtMs: row.available_at.getTime()
    }));
    const wallets = await loadTrackedWallets(db, runs.map((run) => run.runId));
    this.preloaded = runs.map((run) => ({ ...run, wallets: wallets.get(run.runId) ?? [] }));
    this.inForce = newestAsOfSoFar(this.preloaded);
    this.preloadedIndex = -1;
    this.replace([], null, "none");
    return this.preloaded.length;
  }

  setAsOf(asOfMs: number): boolean {
    const available = this.preloadedIndexAt(asOfMs);
    const index = available >= 0 ? (this.inForce[available] ?? -1) : -1;
    if (index === this.preloadedIndex) {
      return false;
    }
    this.preloadedIndex = index;
    const run = index >= 0 ? this.preloaded[index] : undefined;
    if (!run) {
      this.replace([], null, "none");
    } else {
      this.replace(run.wallets, { runId: run.runId, asOfMs: run.asOfMs }, `run:${run.runId}`);
    }
    return true;
  }

  async refresh(): Promise<RankRunInfo | null> {
    if (!this.clock) {
      throw new Error("registry refresh needs a clock");
    }
    if (this.refreshing) {
      return this.refreshing;
    }
    this.refreshing = this.load(this.clock.nowMs()).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  startAutoRefresh(): void {
    if (!this.clock || this.refreshTimer) {
      return;
    }
    this.scheduleRefresh(this.clock);
  }

  stop(): void {
    if (this.refreshTimer && this.clock) {
      this.clock.cancel(this.refreshTimer);
    }
    this.refreshTimer = null;
  }

  private scheduleRefresh(clock: Clock): void {
    this.refreshTimer = clock.schedule(clock.nowMs() + this.refreshIntervalMs, async () => {
      try {
        await this.refresh();
      } catch (error) {
        log.warn({ err: error }, "tracked wallet refresh failed");
      }
      if (this.refreshTimer) {
        this.scheduleRefresh(clock);
      }
    });
  }

  private preloadedIndexAt(asOfMs: number): number {
    let low = 0;
    let high = this.preloaded.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const run = this.preloaded[mid];
      if (run && run.availableAtMs <= asOfMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low - 1;
  }

  private replace(wallets: readonly TrackedWallet[], run: RankRunInfo | null, version: string): void {
    this.wallets = new Map(wallets.map((wallet) => [wallet.wallet, wallet]));
    this.run = run;
    this.versionTag = version;
  }

  private requireDb(): Db {
    if (!this.db) {
      throw new Error("tracked wallet registry has no database");
    }
    return this.db;
  }
}
