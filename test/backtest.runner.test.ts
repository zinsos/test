import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import type { ClosedTrade } from "../src/core/types.js";
import { runBacktest, type BacktestResult } from "../src/backtest/runner.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { CLEAN_DEEP_FEATURES, convergenceTrades, seedLaunch, seedRankRun, seedStoredScore } from "./backtest.seed.js";

const FROM = Date.UTC(2026, 9, 1, 0, 0, 0);
const TO = FROM + 3 * 3_600_000;
const MINUTE = 60_000;
const W = ["WalletW1", "WalletW2", "WalletW3"];
const X = ["WalletX1", "WalletX2", "WalletX3"];
const Y = ["WalletY1", "WalletY2", "WalletY3"];

const LAUNCHES = {
  traded: { mint: "MintL1Traded", atMs: FROM + 10 * MINUTE, wallets: W },
  futureRun: { mint: "MintL2FutureRun", atMs: FROM + 15 * MINUTE, wallets: X },
  beforeMidRun: { mint: "MintL3BeforeMid", atMs: FROM + 20 * MINUTE, wallets: Y },
  hardBlocked: { mint: "MintL5Blocked", atMs: FROM + 30 * MINUTE, wallets: W },
  incomplete: { mint: "MintL6Incomplete", atMs: FROM + 40 * MINUTE, wallets: W },
  afterMidRun: { mint: "MintL4AfterMid", atMs: FROM + 90 * MINUTE, wallets: Y },
  outside: { mint: "MintL7Outside", atMs: TO + 10 * MINUTE, wallets: W }
};

function config(): StrategyConfig {
  const strategy = defaultStrategyConfig();
  strategy.tracker.convergence.maxRiskScore = 100;
  return strategy;
}

function comparable(trades: readonly ClosedTrade[]): unknown[] {
  return trades.map(({ positionId: _positionId, runId: _runId, ...rest }) => rest);
}

describe.skipIf(!hasTestDatabase)("backtest runner", () => {
  let database: TestDatabase;
  const launchIds = new Map<string, number>();

  beforeAll(async () => {
    database = await createTestDatabase("backtest_runner");
    const db = database.db;
    await seedRankRun(db, FROM - 86_400_000, W);
    await seedRankRun(db, FROM + 60 * MINUTE, Y);
    await seedRankRun(db, TO + 86_400_000, X);
    let slot = 300_000_000;
    for (const [key, spec] of Object.entries(LAUNCHES)) {
      slot += 50_000;
      const id = await seedLaunch(db, {
        mint: spec.mint,
        dev: `Dev${spec.mint}`,
        createdAtMs: spec.atMs,
        slot,
        trades: convergenceTrades(spec.wallets, { pump: key !== "hardBlocked" }),
        dataComplete: key !== "incomplete"
      });
      launchIds.set(spec.mint, id);
    }
    for (const spec of [LAUNCHES.traded, LAUNCHES.afterMidRun, LAUNCHES.incomplete]) {
      await seedStoredScore(db, launchIds.get(spec.mint) ?? 0, spec.mint, 30, spec.atMs + 30_200, CLEAN_DEEP_FEATURES);
    }
    await seedStoredScore(db, launchIds.get(LAUNCHES.hardBlocked.mint) ?? 0, LAUNCHES.hardBlocked.mint, 30, LAUNCHES.hardBlocked.atMs + 30_200, {
      ...CLEAN_DEEP_FEATURES,
      largest_cluster_share: 0.9,
      largest_cluster_size: 3,
      cluster_count: 1
    });
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function signalsFor(runId: number): Promise<Map<string, Array<{ acted: boolean; skip: string | null }>>> {
    const result = await database.db.query<{ mint: string; acted: boolean; skip_reason: string | null }>(
      "SELECT mint, acted, skip_reason FROM signals WHERE run_id = $1 ORDER BY at, id",
      [runId]
    );
    const byMint = new Map<string, Array<{ acted: boolean; skip: string | null }>>();
    for (const row of result.rows) {
      const list = byMint.get(row.mint) ?? [];
      list.push({ acted: row.acted, skip: row.skip_reason });
      byMint.set(row.mint, list);
    }
    return byMint;
  }

  let first: BacktestResult;

  it("replays recorded launches through scorer, signals, trader, exits and risk without lookahead", async () => {
    first = await runBacktest({ db: database.db, fromMs: FROM, toMs: TO, config: config(), label: "first" });
    const signals = await signalsFor(first.runId);
    expect(signals.get(LAUNCHES.traded.mint)).toEqual([{ acted: true, skip: null }]);
    expect(signals.get(LAUNCHES.afterMidRun.mint)).toEqual([{ acted: true, skip: null }]);
    expect(signals.get(LAUNCHES.hardBlocked.mint)).toEqual([{ acted: false, skip: "hard_blocked" }]);
    expect(signals.has(LAUNCHES.futureRun.mint)).toBe(false);
    expect(signals.has(LAUNCHES.beforeMidRun.mint)).toBe(false);
    expect(signals.has(LAUNCHES.incomplete.mint)).toBe(false);
    expect(signals.has(LAUNCHES.outside.mint)).toBe(false);

    const tradedMints = first.closedTrades.map((trade) => trade.mint).sort();
    expect(tradedMints).toEqual([LAUNCHES.afterMidRun.mint, LAUNCHES.traded.mint].sort());
    for (const trade of first.closedTrades) {
      expect(trade.mode).toBe("backtest");
      expect(trade.cost).toBeGreaterThan(0n);
      expect(trade.pnl).toBe(trade.proceeds - trade.cost);
    }
    const summary = first.summary;
    expect(summary.counts.launches).toBe(5);
    expect(summary.counts.entriesFilled).toBe(2);
    expect(summary.trades.n).toBe(2);
    expect(summary.counts.storedScoreLaunches).toBe(4);
    expect(summary.trackedVersionAtEnd).toMatch(/^run:/);

    const positions = await database.db.query<{ status: string; mode: string; realized_pnl: bigint | null }>(
      "SELECT status, mode, realized_pnl FROM positions WHERE run_id = $1",
      [first.runId]
    );
    expect(positions.rows).toHaveLength(2);
    expect(positions.rows.every((row) => row.status === "closed" && row.mode === "backtest" && row.realized_pnl !== null)).toBe(true);
    const run = await database.db.query<{ ended_at: Date | null; summary: { fingerprint: string }; data_from: Date; mode: string }>(
      "SELECT ended_at, summary, data_from, mode FROM strategy_runs WHERE id = $1",
      [first.runId]
    );
    expect(run.rows[0]?.mode).toBe("backtest");
    expect(run.rows[0]?.ended_at).not.toBeNull();
    expect(run.rows[0]?.data_from.getTime()).toBe(FROM);
    expect(run.rows[0]?.summary.fingerprint).toBe(summary.fingerprint);
    const fills = await database.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM fills WHERE run_id = $1",
      [first.runId]
    );
    expect(fills.rows[0]?.count).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it("gives identical results for identical data and config", async () => {
    const second = await runBacktest({ db: database.db, fromMs: FROM, toMs: TO, config: config(), label: "second" });
    expect(second.runId).not.toBe(first.runId);
    expect(second.summary.fingerprint).toBe(first.summary.fingerprint);
    expect(comparable(second.closedTrades)).toEqual(comparable(first.closedTrades));
    expect(second.summary.trades).toEqual(first.summary.trades);
    expect(second.summary.exitReasons).toEqual(first.summary.exitReasons);
  }, 120_000);

  it("replays launches with ingest gaps only when asked", async () => {
    const result = await runBacktest({ db: database.db, fromMs: FROM, toMs: TO, config: config(), includeIncomplete: true });
    const signals = await signalsFor(result.runId);
    expect(signals.get(LAUNCHES.incomplete.mint)).toEqual([{ acted: true, skip: null }]);
    expect(result.summary.counts.launches).toBe(6);
  }, 120_000);

  it("never sees wallets ranked after the replay window even when the window covers launches they bought", async () => {
    const result = await runBacktest({ db: database.db, fromMs: FROM, toMs: TO + 2 * 86_400_000, config: config() });
    const signals = await signalsFor(result.runId);
    expect(signals.has(LAUNCHES.futureRun.mint)).toBe(false);
    expect(signals.get(LAUNCHES.traded.mint)?.[0]?.acted).toBe(true);
  }, 120_000);
});
