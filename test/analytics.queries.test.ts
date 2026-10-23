import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  iterateClosedTrades,
  iterateScorerDataset,
  latestScore,
  loadClosedTrades,
  loadEquity,
  loadModes,
  loadPaperLivePairs,
  loadRuns,
  quoteMintLabel,
  recentLaunches,
  recentSignals,
  recorderHealth,
  scoreCheckpoints,
  scorerCalibration,
  scorerDatasetCsv,
  scorerDatasetFeatureKeys,
  trackedWallets
} from "../src/analytics/queries.js";
import { comparePaperLive, summarizeTrades } from "../src/analytics/metrics.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import {
  BACKTEST_TRADES,
  DAY_MS,
  LIVE_PAIRS,
  mintAt,
  NOW_MS,
  PAPER_TRADES,
  PUMP_QUOTE,
  seedAnalytics,
  walletAt,
  type SeededData
} from "./analytics.db.js";

async function collect<T>(pages: AsyncGenerator<T[]>): Promise<T[]> {
  const items: T[] = [];
  for await (const page of pages) {
    items.push(...page);
  }
  return items;
}

async function collectText(chunks: AsyncGenerator<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) {
    text += chunk;
  }
  return text;
}

describe.skipIf(!hasTestDatabase)("analytics queries", () => {
  let database: TestDatabase;
  let seeded: SeededData;

  beforeAll(async () => {
    database = await createTestDatabase("analytics_queries");
    seeded = await seedAnalytics(database.db);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("loads closed trades with filters, excluding shadows by default", async () => {
    const db = database.db;
    expect(await loadClosedTrades(db)).toHaveLength(PAPER_TRADES + BACKTEST_TRADES + LIVE_PAIRS);
    expect(await loadClosedTrades(db, { includeShadows: true })).toHaveLength(PAPER_TRADES + BACKTEST_TRADES + 2 * LIVE_PAIRS);
    const paper = await loadClosedTrades(db, { mode: "paper" });
    expect(paper).toHaveLength(PAPER_TRADES);
    expect(paper.every((trade) => trade.mode === "paper" && typeof trade.pnl === "bigint")).toBe(true);
    expect(paper.map((trade) => trade.closedAtMs)).toEqual([...paper.map((trade) => trade.closedAtMs)].sort((a, b) => a - b));
    expect(await loadClosedTrades(db, { runId: seeded.backtestRunId })).toHaveLength(BACKTEST_TRADES);
    const recent = await loadClosedTrades(db, { mode: "paper", fromMs: NOW_MS - 7 * DAY_MS });
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThan(PAPER_TRADES);
    expect(recent.every((trade) => trade.closedAtMs >= NOW_MS - 7 * DAY_MS)).toBe(true);
    const limited = await loadClosedTrades(db, { mode: "paper", limit: 5 });
    expect(limited).toHaveLength(5);
    expect(limited[4]?.positionId).toBe(paper[paper.length - 1]?.positionId);
    const first = paper[0];
    expect(first?.pnl).toBe(50_000_000n);
    expect(first?.cost).toBe(100_000_000n);
    expect(first?.riskScore).toBe(5);
    expect(paper[3]?.riskScore).toBeNull();
  });

  it("pages closed trades by keyset without gaps or duplicates", async () => {
    const all = await loadClosedTrades(database.db, { mode: "paper" });
    const paged = await collect(iterateClosedTrades(database.db, { mode: "paper" }, 7));
    expect(paged.map((trade) => trade.positionId)).toEqual(all.map((trade) => trade.positionId));
    const capped = await collect(iterateClosedTrades(database.db, { mode: "paper", limit: 10 }, 3));
    expect(capped).toHaveLength(10);
  });

  it("summarises the seeded paper run as an edge and builds equity", async () => {
    const summary = summarizeTrades(await loadClosedTrades(database.db, { mode: "paper" }));
    expect(summary.n).toBe(PAPER_TRADES);
    expect(summary.expectancySol).toBeCloseTo(0.02, 9);
    expect(summary.verdict).toBe("edge");
    const equity = await loadEquity(database.db, { mode: "paper" }, { maxPoints: 50 });
    expect(equity.length).toBeLessThanOrEqual(50);
    expect(equity[equity.length - 1]?.equitySol).toBeCloseTo(2.4, 9);
  });

  it("lists runs and modes with trade counts", async () => {
    const runs = await loadRuns(database.db);
    expect(runs.map((run) => run.mode).sort()).toEqual(["backtest", "live", "paper"]);
    const paper = runs.find((run) => run.id === seeded.paperRunId);
    expect(paper?.closedTrades).toBe(PAPER_TRADES);
    expect(paper?.openPositions).toBe(1);
    expect(paper?.realizedPnlSol).toBeCloseTo(2.4, 9);
    const live = runs.find((run) => run.id === seeded.liveRunId);
    expect(live?.shadowTrades).toBe(LIVE_PAIRS);
    expect(live?.closedTrades).toBe(LIVE_PAIRS);
    expect((await loadRuns(database.db, { mode: "live" })).map((run) => run.id)).toEqual([seeded.liveRunId]);
    const modes = await loadModes(database.db);
    expect(Object.fromEntries(modes.map((mode) => [mode.mode, mode.closedTrades]))).toEqual({
      paper: PAPER_TRADES,
      live: LIVE_PAIRS,
      backtest: BACKTEST_TRADES
    });
  });

  it("pairs live trades with their shadow paper trades and fills", async () => {
    const pairs = await loadPaperLivePairs(database.db);
    expect(pairs).toHaveLength(LIVE_PAIRS);
    const first = pairs[0];
    expect(first?.live.positionId).toBe("live-000");
    expect(first?.paper.positionId).toBe("shadow-000");
    expect(first?.liveFills).toHaveLength(3);
    expect(first?.paperFills).toHaveLength(2);
    const comparison = comparePaperLive(pairs);
    expect(comparison.verdict).toBe("paper_too_optimistic");
    expect(comparison.entryGap.meanBps).toBeCloseTo(100, 6);
    expect(comparison.exitGap.meanBps).toBeCloseTo(200, 6);
    expect(comparison.fillFailureRate.live).toBeCloseTo(1 / 51, 9);
    expect(await loadPaperLivePairs(database.db, { runId: seeded.paperRunId })).toHaveLength(0);
    expect(await loadPaperLivePairs(database.db, { limit: 3 })).toHaveLength(3);
  });

  it("reads recent signals, launches, scores and tracked wallets", async () => {
    const signals = await recentSignals(database.db, { limit: 10 });
    expect(signals.map((signal) => signal.symbol)).toEqual(["SYM2", "SYM1", "SYM0"]);
    expect(signals[0]?.acted).toBe(true);
    expect(signals[1]?.skipReason).toBe("risk_limit");
    expect(signals[0]?.walletCount).toBe(3);
    const launches = await recentLaunches(database.db, { limit: 20 });
    expect(launches).toHaveLength(8);
    expect(launches[0]?.mint).toBe(mintAt(7));
    expect(launches[0]?.outcome).toBeNull();
    expect(launches[0]?.score?.checkpointSec).toBe(60);
    const oldest = launches[launches.length - 1];
    expect(oldest?.outcome?.peakMultiple).toBeCloseTo(9, 9);
    expect(oldest?.outcome?.migrated).toBe(true);
    expect(oldest?.isSolQuoted).toBe(true);
    expect((await recentLaunches(database.db, { quoteMint: PUMP_QUOTE })).every((launch) => !launch.isSolQuoted)).toBe(true);
    const score = await latestScore(database.db, mintAt(1));
    expect(score?.checkpointSec).toBe(60);
    expect(score?.score).toBe(82);
    expect(score?.flags).toEqual(["dev_sold", "bundle"]);
    expect(score?.features.mcap_multiple).toBe(2);
    expect(await latestScore(database.db, mintAt(30))).toBeNull();
    const wallets = await trackedWallets(database.db);
    expect(wallets.run?.tracked).toBe(3);
    expect(wallets.wallets.map((wallet) => wallet.wallet)).toEqual([walletAt(1), walletAt(3), walletAt(2)]);
    expect(wallets.wallets[0]?.pnl30dSol).toBeCloseTo(1.5, 9);
  });

  it("calibrates the scorer by bucket and by pass or block", async () => {
    expect(await scoreCheckpoints(database.db)).toEqual([30, 60]);
    const calibration = await scorerCalibration(database.db, { checkpointSec: 60, maxRisk: 55 });
    expect(calibration.buckets.map((bucket) => bucket.label)).toEqual(["10-20", "20-30", "30-40", "60-70", "80-90", "90-100"]);
    expect(calibration.pass.n).toBe(3);
    expect(calibration.pass.survived15mRate).toBe(1);
    expect(calibration.pass.migratedRate).toBeCloseTo(2 / 3, 9);
    expect(calibration.pass.medianPeakMultiple).toBeCloseTo(6, 9);
    expect(calibration.pass.medianPeakFromScore).toBeCloseTo(3, 9);
    expect(calibration.block.n).toBe(3);
    expect(calibration.block.ruggedRate).toBeCloseTo(2 / 3, 9);
    expect(calibration.block.hardBlocked).toBe(1);
    expect(calibration.block.survived15mRate).toBe(0);
    expect(calibration.assessment.verdict).toBe("insufficient_data");
    const solOnly = await scorerCalibration(database.db, { checkpointSec: 60, quoteMint: "SOL" });
    expect(solOnly.pass.n + solOnly.block.n).toBe(4);
    const wide = await scorerCalibration(database.db, { checkpointSec: 60, bucketWidth: 50 });
    expect(wide.buckets.map((bucket) => [bucket.label, bucket.n])).toEqual([
      ["0-50", 3],
      ["50-100", 3]
    ]);
  });

  it("reports recorder health relative to the given time", async () => {
    const health = await recorderHealth(database.db, { nowMs: NOW_MS });
    expect(health.launchesPerHour).toHaveLength(24);
    expect(health.tradesPerMinute).toHaveLength(60);
    expect(health.launchesLast24h).toBe(4);
    expect(health.tradesLastHour).toBe(5);
    expect(health.lastTradeAgeSec).toBeCloseTo(30, 6);
    expect(health.recordingDays).toBeCloseTo(3, 9);
    expect(health.gaps24h.count).toBe(1);
    expect(health.gaps24h.totalSec).toBeCloseTo(60, 6);
    expect(health.gaps24h.recent[0]?.affectedLaunches).toBe(3);
    expect(Object.fromEntries(health.launchesByQuoteMint.map((item) => [item.label, item.count]))).toEqual({ SOL: 2, PUMP: 2 });
    const statuses = Object.fromEntries(health.outcomeStatus.counts.map((item) => [`${item.status}:${item.finalized}`, item.count]));
    expect(statuses).toEqual({ "migrated:true": 2, "rugged:true": 2, "died:true": 1, "alive:false": 1, "alive:true": 1, "pending:false": 1 });
    expect(health.activeTracking).toBe(3);
    expect(quoteMintLabel("SOL")).toBe("SOL");
    expect(quoteMintLabel(PUMP_QUOTE)).toBe("PUMP");
  });

  it("exports the scorer dataset with sorted feature columns from jsonb keys", async () => {
    expect(await scorerDatasetFeatureKeys(database.db)).toEqual(["age_sec", "dev_share", "mcap_multiple", "z_extra"]);
    const csv = await collectText(scorerDatasetCsv(database.db));
    const lines = csv.trim().split("\n");
    const header = lines[0]?.split(",") ?? [];
    expect(header.slice(11, 15)).toEqual(["f_age_sec", "f_dev_share", "f_mcap_multiple", "f_z_extra"]);
    expect(lines).toHaveLength(1 + 12);
    const everything = await collectText(scorerDatasetCsv(database.db, { includeUnknown: true }));
    expect(everything.trim().split("\n")).toHaveLength(1 + 14);
    const atSixty = await collect(iterateScorerDataset(database.db, { checkpointSec: 60 }, 2));
    expect(atSixty).toHaveLength(6);
    expect(new Set(atSixty.map((record) => record.launchId)).size).toBe(6);
  });

  it("exposes SQL views for ad-hoc analysis and SNYPRA", async () => {
    const closed = await database.db.query<{ n: number; wins: number }>(
      "SELECT count(*)::int AS n, count(*) FILTER (WHERE is_win)::int AS wins FROM analytics_closed_trades WHERE mode = 'paper'"
    );
    expect(closed.rows[0]).toEqual({ n: PAPER_TRADES, wins: PAPER_TRADES / 2 });
    const latest = await database.db.query<{ checkpoint_sec: number; score: number }>(
      "SELECT checkpoint_sec, score FROM analytics_latest_launch_scores WHERE mint = $1",
      [mintAt(0)]
    );
    expect(latest.rows).toEqual([{ checkpoint_sec: 60, score: 12 }]);
    const pairs = await database.db.query<{ n: number }>("SELECT count(*)::int AS n FROM analytics_paper_live_pairs WHERE gap_lamports < 0");
    expect(pairs.rows[0]?.n).toBe(LIVE_PAIRS);
  });
});
