import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { ScoreProvider } from "../src/core/contracts.js";
import type { LaunchCreatedEvent, LaunchScore, Signal, TradeEvent } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import { MarketState } from "../src/market/state.js";
import { createTrackerModule, walkForwardAsOfs, type TrackerModule } from "../src/tracker/index.js";
import { TrackedWalletRegistry } from "../src/tracker/registry.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T1 = Date.UTC(2026, 8, 1);
const T2 = T1 + 7 * DAY;

let counter = 0;

function create(mint: string, atMs: number): LaunchCreatedEvent {
  counter += 1;
  return {
    kind: "create",
    tx: { signature: `c${counter}`, slot: 10, seq: counter, eventIndex: 0, receivedAtMs: atMs },
    mint,
    bondingCurve: `${mint}Curve`,
    devWallet: "Dev",
    creator: "Dev",
    name: mint,
    symbol: mint,
    uri: "",
    timestampMs: atMs,
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualQuoteReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    tokenProgram: null,
    quoteMint: "SOL",
    isMayhemMode: false,
    isCashback: false,
    isHolderReward: false,
    creatorFeeBps: 30,
    depth: 0
  };
}

function buy(mint: string, wallet: string, atMs: number): TradeEvent {
  counter += 1;
  return {
    kind: "trade",
    tx: { signature: `t${counter}`, slot: 20 + counter, seq: counter, eventIndex: 0, receivedAtMs: atMs },
    venue: "curve",
    mint,
    pool: null,
    wallet,
    isBuy: true,
    tokenAmount: 1_000n,
    quoteAmount: 1_000n,
    userQuote: 1_010n,
    protocolFee: 9n,
    creatorFee: 1n,
    lpFee: 0n,
    protocolFeeBps: 95,
    creatorFeeBps: 5,
    lpFeeBps: 0,
    virtualTokenReserves: 1_070_000_000_000_000n,
    virtualQuoteReserves: 30_100_000_000n,
    realTokenReserves: null,
    realQuoteReserves: null,
    timestampMs: atMs,
    ixName: "buy"
  };
}

const scores: ScoreProvider = {
  latest: (mint) =>
    ({
      mint,
      launchId: null,
      checkpointSec: 10,
      computedAtMs: 0,
      slot: 0,
      score: 20,
      hardBlocked: false,
      flags: [],
      features: {},
      contributions: {},
      weightsVersion: "t"
    }) satisfies LaunchScore,
  scoreNow: async () => null
};

async function insertRun(db: Db, asOfMs: number, tracked: string[]): Promise<number> {
  const run = await db.query<{ id: bigint }>(
    `INSERT INTO wallet_rank_runs (as_of, params, candidates, tracked) VALUES ($1, '{}', $2, $2) RETURNING id`,
    [new Date(asOfMs), tracked.length]
  );
  const runId = Number(run.rows[0]?.id ?? 0);
  for (const [index, wallet] of tracked.entries()) {
    await db.query(`INSERT INTO wallet_ranks (run_id, wallet, rank, score, tracked) VALUES ($1, $2, $3, 1, true)`, [runId, wallet, index + 1]);
  }
  return runId;
}

interface Rig {
  clock: VirtualClock;
  bus: Bus;
  market: MarketState;
  signals: Signal[];
  module: TrackerModule;
  feed(event: LaunchCreatedEvent | TradeEvent): Promise<void>;
}

function rig(db: Db | null, mode: "live" | "backtest", startMs: number, extra: Partial<Parameters<typeof createTrackerModule>[0]> = {}): Rig {
  const clock = new VirtualClock(startMs);
  const bus = new Bus();
  const market = new MarketState({ maxTradesPerLaunch: 1_000, evictInactiveMs: DAY, evictMaxAgeMs: DAY, quoteMints: null });
  const config = defaultStrategyConfig();
  const module = createTrackerModule({
    db,
    rpc: null,
    bus,
    market,
    clock,
    config: { tracker: config.tracker, signals: config.signals, scorer: config.scorer },
    scores,
    mode,
    rerankStartDelayMs: 1_000,
    ...extra
  });
  const signals: Signal[] = [];
  bus.on("signal", (signal) => signals.push(signal));
  return {
    clock,
    bus,
    market,
    signals,
    module,
    async feed(event) {
      await clock.advanceTo(event.timestampMs);
      market.apply(event);
      bus.emit("chain", event);
      await clock.advanceTo(event.timestampMs);
      await module.signals.idle();
    }
  };
}

describe("walkForwardAsOfs", () => {
  it("steps from the start through the end inclusive", () => {
    expect(walkForwardAsOfs(0, 10, 5)).toEqual([0, 5, 10]);
    expect(walkForwardAsOfs(0, 9, 5)).toEqual([0, 5]);
    expect(walkForwardAsOfs(10, 0, 5)).toEqual([]);
    expect(walkForwardAsOfs(0, 10, 0)).toEqual([]);
  });
});

describe("tracker module without a database", () => {
  it("runs signals from an injected registry and refuses database work", async () => {
    const r = rig(null, "backtest", T1, { registry: TrackedWalletRegistry.fromWallets(["A", "B", "C"]) });
    await r.module.start();
    await r.feed(create("M", T1));
    for (const [index, wallet] of ["A", "B", "C"].entries()) {
      await r.feed(buy("M", wallet, T1 + (index + 1) * 1_000));
    }
    expect(r.signals).toHaveLength(1);
    await expect(r.module.rerank(T1)).rejects.toThrow("database");
    await expect(r.module.backfill(["A"])).rejects.toThrow("rpc");
    await r.module.stop();
  });
});

describe.skipIf(!hasTestDatabase)("tracker module", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("tracker_module");
  });

  beforeEach(async () => {
    await database.db.query("TRUNCATE wallet_rank_runs CASCADE");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("switches tracked wallets walk-forward during a backtest", async () => {
    await insertRun(database.db, T1, ["A", "B", "C"]);
    await insertRun(database.db, T2, ["D", "E", "F"]);
    const r = rig(database.db, "backtest", T1 - HOUR, { backtestRange: { fromMs: T1 - DAY, toMs: T2 + DAY } });
    await r.module.start();
    await r.feed(create("EARLY", T1 - 30 * 60_000));
    for (const [index, wallet] of ["A", "B", "C"].entries()) {
      await r.feed(buy("EARLY", wallet, T1 - 20 * 60_000 + index * 1_000));
    }
    expect(r.signals).toHaveLength(0);
    await r.feed(create("FIRST", T1 + HOUR));
    for (const [index, wallet] of ["A", "B", "C"].entries()) {
      await r.feed(buy("FIRST", wallet, T1 + HOUR + (index + 1) * 1_000));
    }
    expect(r.signals.map((signal) => signal.mint)).toEqual(["FIRST"]);
    await r.feed(create("SECOND", T2 + HOUR));
    for (const [index, wallet] of ["A", "B", "C", "D", "E", "F"].entries()) {
      await r.feed(buy("SECOND", wallet, T2 + HOUR + (index + 1) * 1_000));
    }
    expect(r.signals.map((signal) => signal.mint)).toEqual(["FIRST", "SECOND"]);
    expect(r.signals[1]?.wallets).toEqual(["D", "E", "F"]);
    await r.module.stop();
  });

  it("prepares walk-forward runs once per interval and reuses existing ones", async () => {
    const r = rig(database.db, "backtest", T1);
    const first = await r.module.prepareWalkForward(T1, T1 + 14 * DAY);
    expect(first).toHaveLength(3);
    const again = await r.module.prepareWalkForward(T1, T1 + 14 * DAY);
    expect(again).toEqual(first);
    const runs = await database.db.query<{ as_of: Date }>(`SELECT as_of FROM wallet_rank_runs ORDER BY as_of`);
    expect(runs.rows.map((row) => row.as_of.getTime())).toEqual([T1, T1 + 7 * DAY, T1 + 14 * DAY]);
    await r.module.start();
    expect(r.module.registry.version()).toBe(`run:${first[0]}`);
    await r.module.stop();
  });

  it("loads the latest run live and reranks on schedule", async () => {
    const previous = await insertRun(database.db, T2 - 7 * DAY + HOUR, ["A", "B", "C"]);
    const r = rig(database.db, "live", T2);
    await r.module.start();
    expect(r.module.registry.version()).toBe(`run:${previous}`);
    expect(r.module.registry.isTracked("A")).toBe(true);
    await r.clock.advanceTo(T2 + 30 * 60_000);
    expect(r.module.registry.version()).toBe(`run:${previous}`);
    await r.clock.advanceTo(T2 + 2 * HOUR);
    const runs = await database.db.query<{ id: bigint; as_of: Date }>(`SELECT id, as_of FROM wallet_rank_runs ORDER BY id`);
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows[1]?.as_of.getTime()).toBe(T2 + HOUR);
    expect(r.module.registry.version()).toBe(`run:${Number(runs.rows[1]?.id)}`);
    expect(r.module.registry.count()).toBe(0);
    await r.module.stop();
    expect(r.clock.pendingCount()).toBe(0);
  });

  it("returns backfill targets from the latest run", async () => {
    const runId = await insertRun(database.db, T1, ["A", "B"]);
    await database.db.query(
      `INSERT INTO wallet_ranks (run_id, wallet, score, excluded, exclude_reason) VALUES ($1, 'C', 9, true, 'min_trades'), ($1, 'D', 9, true, 'dev_linked')`,
      [runId]
    );
    const r = rig(database.db, "live", T1);
    expect(await r.module.backfillTargets(10)).toEqual(["A", "B", "C"]);
    expect(await r.module.backfillTargets(1)).toEqual(["A"]);
  });
});
