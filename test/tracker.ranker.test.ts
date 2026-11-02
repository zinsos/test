import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultStrategyConfig, type TrackerConfig } from "../src/config/strategy.js";
import { toNumber } from "../src/db/pool.js";
import { markHubs } from "../src/scorer/intelStore.js";
import { loadWalletFacts } from "../src/tracker/rankQueries.js";
import { chunkCandidates, rankWallets, type RankedWallet, type RankRunResult } from "../src/tracker/ranker.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import {
  insertDeadOutcome,
  insertHistory,
  insertIntel,
  insertKnownEntity,
  insertLaunches,
  insertLaunchScore,
  insertTrades,
  slotAt,
  SOL,
  type HistorySpec,
  type LaunchSpec,
  type TradeSpec
} from "./tracker.db.js";

const DAY = 86_400_000;
const MINUTE = 60_000;
const ASOF = Date.UTC(2026, 9, 20, 0, 0, 0);
const PUMP_COIN = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";

interface TripPlan {
  wallet: string;
  buyAtMs: number;
  costSol: number;
  pnlSol: number;
  entryDelaySec: number;
  holdSec: number | null;
  atCreationSlot?: boolean;
  dead?: "rugged" | "died";
  quoteMint?: string;
  historyOnly?: boolean;
  alsoHistory?: boolean;
}

interface PlannedTrip extends TripPlan {
  mint: string;
}

function lamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

class Scenario {
  readonly trips: PlannedTrip[] = [];
  readonly launches: LaunchSpec[] = [];
  private counter = 0;

  trip(plan: TripPlan): void {
    this.counter += 1;
    this.trips.push({ ...plan, mint: `${plan.wallet}_M${this.counter}` });
  }

  series(wallet: string, options: { count: number; startDaysAgo: number; spanDays: number; win: number; loss: number; lossEvery: number } & Partial<TripPlan>): void {
    for (let index = 0; index < options.count; index += 1) {
      const daysAgo = options.startDaysAgo + (index * options.spanDays) / options.count;
      const isLoss = index % options.lossEvery === options.lossEvery - 1;
      this.trip({
        wallet,
        buyAtMs: ASOF - daysAgo * DAY,
        costSol: 1,
        pnlSol: isLoss ? -options.loss : options.win,
        entryDelaySec: 30 + (index % 5) * 15,
        holdSec: 300 + (index % 4) * 60,
        ...stripSeries(options)
      });
    }
  }

  async write(db: TestDatabase["db"], historyFetchedAtMs: number): Promise<Map<string, number>> {
    const launchSpecs: LaunchSpec[] = [...this.launches];
    for (const trip of this.trips) {
      if (trip.historyOnly) {
        continue;
      }
      const createdAtMs = trip.buyAtMs - trip.entryDelaySec * 1000;
      launchSpecs.push({ mint: trip.mint, createdAtMs, createSlot: slotAt(createdAtMs), quoteMint: trip.quoteMint ?? "SOL" });
    }
    const ids = await insertLaunches(db, launchSpecs);
    const trades: TradeSpec[] = [];
    const history: HistorySpec[] = [];
    for (const trip of this.trips) {
      const createdAtMs = trip.buyAtMs - trip.entryDelaySec * 1000;
      const buySlot = trip.atCreationSlot ? slotAt(createdAtMs) : slotAt(trip.buyAtMs);
      const legs = [
        { isBuy: true, atMs: trip.buyAtMs, slot: buySlot, userQuote: lamports(trip.costSol), signature: `${trip.mint}-b` },
        ...(trip.holdSec === null
          ? []
          : [
              {
                isBuy: false,
                atMs: trip.buyAtMs + trip.holdSec * 1000,
                slot: slotAt(trip.buyAtMs + trip.holdSec * 1000),
                userQuote: lamports(trip.costSol + trip.pnlSol),
                signature: `${trip.mint}-s`
              }
            ])
      ];
      for (const leg of legs) {
        if (!trip.historyOnly) {
          trades.push({ launchId: ids.get(trip.mint) ?? 0, wallet: trip.wallet, tokenAmount: 1_000_000n, ...leg });
        }
        if (trip.historyOnly || trip.alsoHistory) {
          history.push({
            wallet: trip.wallet,
            mint: trip.mint,
            tokenAmount: 1_000_000n,
            quoteMint: trip.quoteMint ?? "SOL",
            fetchedAtMs: historyFetchedAtMs,
            ...leg
          });
        }
      }
      if (trip.dead && !trip.historyOnly) {
        await insertDeadOutcome(db, ids.get(trip.mint) ?? 0, trip.buyAtMs + 30 * MINUTE, trip.dead);
      }
    }
    await insertTrades(db, trades);
    await insertHistory(db, history);
    return ids;
  }
}

function stripSeries(options: Record<string, unknown>): Partial<TripPlan> {
  const { count: _count, startDaysAgo: _start, spanDays: _span, win: _win, loss: _loss, lossEvery: _every, ...rest } = options;
  return rest as Partial<TripPlan>;
}

function consistent(scenario: Scenario, wallet: string, win: number, extra: Partial<TripPlan> = {}): void {
  scenario.series(wallet, { count: 26, startDaysAgo: 1, spanDays: 27, win, loss: 0.3, lossEvery: 3, ...extra });
  scenario.series(wallet, { count: 16, startDaysAgo: 32, spanDays: 55, win, loss: 0.3, lossEvery: 3, ...extra });
}

const config: TrackerConfig = { ...defaultStrategyConfig().tracker, topN: 10 };

function byWallet(result: RankRunResult): Map<string, RankedWallet> {
  return new Map(result.wallets.map((wallet) => [wallet.wallet, wallet]));
}

function fingerprint(result: RankRunResult): unknown[] {
  return result.wallets.map((wallet) => [
    wallet.wallet,
    wallet.rank,
    Number(wallet.score.toFixed(9)),
    wallet.tracked,
    wallet.reasons.join(","),
    wallet.short.closed,
    wallet.long.closed,
    Number(wallet.long.realizedPnlSol.toFixed(9))
  ]);
}

describe("chunkCandidates", () => {
  it("splits by trade budget and wallet count", () => {
    const candidates = [
      { wallet: "a", mints: 10, trades: 60, netFlowSol: 0 },
      { wallet: "b", mints: 10, trades: 60, netFlowSol: 0 },
      { wallet: "c", mints: 10, trades: 200, netFlowSol: 0 },
      { wallet: "d", mints: 10, trades: 10, netFlowSol: 0 },
      { wallet: "e", mints: 10, trades: 10, netFlowSol: 0 }
    ];
    expect(chunkCandidates(candidates, 100, 10).map((chunk) => chunk.map((item) => item.wallet))).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["d", "e"]
    ]);
    expect(chunkCandidates(candidates, 1_000, 2).map((chunk) => chunk.length)).toEqual([2, 2, 1]);
    expect(chunkCandidates([], 100, 10)).toEqual([]);
  });
});

describe.skipIf(!hasTestDatabase)("rankWallets", () => {
  let database: TestDatabase;
  let first: RankRunResult;

  beforeAll(async () => {
    database = await createTestDatabase("tracker_ranker");
    const db = database.db;
    const scenario = new Scenario();
    consistent(scenario, "GOOD1", 0.8);
    consistent(scenario, "GOOD2", 0.5, { alsoHistory: true });
    consistent(scenario, "GOOD3", 0.4);
    consistent(scenario, "HISTORY", 0.3, { historyOnly: true });
    consistent(scenario, "DEVLINK", 0.8);
    consistent(scenario, "CREATOR", 0.8);
    consistent(scenario, "FUNDED", 0.8);
    consistent(scenario, "BUNDLE", 0.8);
    consistent(scenario, "BOT", 0.8);
    consistent(scenario, "LATEHIST", 0.8, { historyOnly: true });
    scenario.series("LUCKY", { count: 1, startDaysAgo: 2, spanDays: 1, win: 30, loss: 0, lossEvery: 1_000 });
    scenario.series("LUCKY", { count: 9, startDaysAgo: 3, spanDays: 20, win: 0, loss: 0.5, lossEvery: 1 });
    scenario.series("LUCKY", { count: 6, startDaysAgo: 35, spanDays: 40, win: 0, loss: 0.5, lossEvery: 1 });
    scenario.series("SNIPER", { count: 30, startDaysAgo: 1, spanDays: 60, win: 0.4, loss: 0.2, lossEvery: 4, entryDelaySec: 0, atCreationSlot: true, holdSec: 8 });
    scenario.series("FEW", { count: 9, startDaysAgo: 1, spanDays: 20, win: 0.8, loss: 0.3, lossEvery: 3 });
    scenario.series("LOSER", { count: 30, startDaysAgo: 1, spanDays: 60, win: 0.2, loss: 0.5, lossEvery: 2 });
    scenario.series("BAGHOLDER", { count: 20, startDaysAgo: 1, spanDays: 60, win: 0.2, loss: 0, lossEvery: 1_000 });
    scenario.series("BAGHOLDER", { count: 10, startDaysAgo: 2, spanDays: 50, win: 0, loss: 0, lossEvery: 1_000, holdSec: null, dead: "rugged" });
    scenario.series("PUMPQ", { count: 30, startDaysAgo: 1, spanDays: 60, win: 0.8, loss: 0.3, lossEvery: 3, quoteMint: PUMP_COIN });
    scenario.series("TOOACTIVE", { count: 60, startDaysAgo: 1, spanDays: 60, win: 0.8, loss: 0.3, lossEvery: 3 });
    scenario.series("FUTURE", { count: 30, startDaysAgo: -20, spanDays: 15, win: 0.8, loss: 0.3, lossEvery: 3 });
    scenario.series("STALE", { count: 30, startDaysAgo: 100, spanDays: 60, win: 0.8, loss: 0.3, lossEvery: 3 });
    scenario.launches.push(
      { mint: "DevLaunch", createdAtMs: ASOF - 50 * DAY, dev: "DEVLINK" },
      { mint: "CreatorLaunch", createdAtMs: ASOF - 40 * DAY, dev: "SomeSigner", creator: "CREATOR" },
      { mint: "FunderLaunch", createdAtMs: ASOF - 45 * DAY, dev: "DEVX" },
      { mint: "LaterLaunch", createdAtMs: ASOF + 2 * DAY, dev: "GOOD3" }
    );
    const ids = await scenario.write(db, ASOF - 3 * DAY);
    await insertTrades(db, [
      {
        launchId: ids.get("CreatorLaunch") ?? 0,
        wallet: "CREATOR",
        atMs: ASOF - 40 * DAY,
        slot: slotAt(ASOF - 40 * DAY),
        isBuy: true,
        tokenAmount: 1_000_000n,
        userQuote: 1_000_000_000n,
        signature: "creator-self-buy"
      }
    ]);
    await insertHistory(
      db,
      scenario.trips
        .filter((trip) => trip.wallet === "LATEHIST")
        .map((trip, index) => ({
          wallet: "LATEHIST",
          mint: `${trip.mint}_late`,
          atMs: trip.buyAtMs + 1_000,
          isBuy: true,
          tokenAmount: 1_000_000n,
          userQuote: 1_000_000_000n,
          signature: `late-${index}`,
          fetchedAtMs: ASOF - DAY
        }))
    );
    await db.query(`UPDATE wallet_history_trades SET fetched_at = $1 WHERE wallet = 'LATEHIST' AND signature NOT LIKE 'late-%'`, [
      new Date(ASOF + DAY)
    ]);
    await insertIntel(db, "FUNDED", "DEVX", ASOF - 10 * DAY, ASOF - 60 * DAY);
    await insertIntel(db, "GOOD1", "DEVX", ASOF + DAY, ASOF - 60 * DAY);
    await insertKnownEntity(db, "BOT", "bot", ASOF - 30 * DAY);
    await insertKnownEntity(db, "GOOD2", "bot", ASOF + DAY);
    const bundleTrips = scenario.trips.filter((trip) => trip.wallet === "BUNDLE").slice(0, 20);
    for (const trip of bundleTrips) {
      await insertLaunchScore(db, ids.get(trip.mint) ?? 0, trip.mint, trip.buyAtMs + 10_000, ["BUNDLE", "SomeDev"]);
    }
    const goodTrips = scenario.trips.filter((trip) => trip.wallet === "GOOD1").slice(0, 20);
    for (const trip of goodTrips) {
      await insertLaunchScore(db, ids.get(trip.mint) ?? 0, trip.mint, ASOF + DAY, ["GOOD1"]);
    }
    first = await rankWallets(db, {
      asOfMs: ASOF,
      config,
      bundleSlotWindow: 1,
      maxTradesPerWallet: 100,
      chunkMaxWallets: 3
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  it("ranks the planted good wallets on top and tracks only them", () => {
    const tracked = first.wallets.filter((wallet) => wallet.tracked).map((wallet) => wallet.wallet);
    expect(tracked).toEqual(["GOOD1", "GOOD2", "GOOD3", "HISTORY"]);
    expect(first.wallets.slice(0, 4).map((wallet) => wallet.rank)).toEqual([1, 2, 3, 4]);
    expect(first.tracked).toBe(4);
    const good1 = byWallet(first).get("GOOD1");
    expect(good1?.short.closed).toBe(26);
    expect(good1?.long.closed).toBe(42);
    expect(good1?.short.winRate).toBeCloseTo(18 / 26, 10);
    expect(good1?.excluded).toBe(false);
  });

  it("deduplicates trades present in both recorded and history tables", () => {
    const good2 = byWallet(first).get("GOOD2");
    expect(good2?.long.closed).toBe(42);
    expect(good2?.long.realizedPnlSol).toBeCloseTo(29 * 0.5 - 13 * 0.3, 6);
  });

  it("excludes wallets with the right reasons", () => {
    const wallets = byWallet(first);
    const primary = (wallet: string): string | undefined => wallets.get(wallet)?.reasons[0];
    expect(primary("LUCKY")).toBe("one_hit");
    expect(primary("DEVLINK")).toBe("dev_linked");
    expect(primary("CREATOR")).toBe("dev_linked");
    expect(primary("FUNDED")).toBe("dev_funded");
    expect(primary("BUNDLE")).toBe("bundle_insider");
    expect(primary("BOT")).toBe("known_entity");
    expect(primary("FEW")).toBe("min_trades");
    expect(primary("LOSER")).toBe("non_positive_pnl");
    expect(primary("BAGHOLDER")).toBe("non_positive_pnl");
    expect(primary("TOOACTIVE")).toBe("too_active");
    expect(wallets.get("SNIPER")?.reasons).toEqual(expect.arrayContaining(["bundle_entries", "sniper", "too_fast"]));
    expect(primary("SNIPER")).toBe("bundle_entries");
    for (const wallet of ["LUCKY", "DEVLINK", "SNIPER", "BAGHOLDER"]) {
      expect(wallets.get(wallet)?.excluded).toBe(true);
      expect(wallets.get(wallet)?.rank).toBeNull();
      expect(wallets.get(wallet)?.tracked).toBe(false);
    }
  });

  it("writes off bags held in rugged launches", () => {
    const bagholder = byWallet(first).get("BAGHOLDER");
    expect(bagholder?.long.writeOffs).toBe(10);
    expect(bagholder?.long.realizedPnlSol).toBeCloseTo(20 * 0.2 - 10, 6);
    expect(bagholder?.openPositions).toBe(0);
  });

  it("ignores non-SOL launches, stale wallets and wallets active only after as-of", () => {
    const wallets = byWallet(first);
    expect(wallets.has("PUMPQ")).toBe(false);
    expect(wallets.has("FUTURE")).toBe(false);
    expect(wallets.has("STALE")).toBe(false);
  });

  it("does not use history fetched after as-of", () => {
    const latehist = byWallet(first).get("LATEHIST");
    expect(latehist?.long.closed ?? 0).toBe(0);
    expect(latehist?.excluded ?? true).toBe(true);
  });

  it("ignores dev launches, intel, entity labels and insider flags dated after as-of", () => {
    const wallets = byWallet(first);
    expect(wallets.get("GOOD3")?.facts.devLinked).toBe(false);
    expect(wallets.get("GOOD1")?.facts.devFunded).toBe(false);
    expect(wallets.get("GOOD2")?.facts.knownEntityKind).toBeNull();
    expect(wallets.get("GOOD1")?.facts.insiderLaunches).toBe(0);
  });

  it("persists the run and every candidate", async () => {
    const db = database.db;
    const run = await db.query<{ as_of: Date; candidates: number; tracked: number; params: { topN: number } }>(
      `SELECT as_of, candidates, tracked, params FROM wallet_rank_runs WHERE id = $1`,
      [first.runId]
    );
    expect(run.rows[0]?.as_of.getTime()).toBe(ASOF);
    expect(run.rows[0]?.candidates).toBe(first.candidates);
    expect(run.rows[0]?.tracked).toBe(4);
    expect(run.rows[0]?.params.topN).toBe(10);
    const ranks = await db.query<{ wallet: string; tracked: boolean; exclude_reason: string | null; rank: number | null; trades_30d: number; stats: { reasons: string[] } }>(
      `SELECT wallet, tracked, exclude_reason, rank, trades_30d, stats FROM wallet_ranks WHERE run_id = $1 ORDER BY wallet`,
      [first.runId]
    );
    expect(ranks.rows.length).toBe(first.candidates);
    const lucky = ranks.rows.find((row) => row.wallet === "LUCKY");
    expect(lucky?.exclude_reason).toBe("one_hit");
    expect(lucky?.stats.reasons).toContain("one_hit");
    const good1 = ranks.rows.find((row) => row.wallet === "GOOD1");
    expect(good1?.tracked).toBe(true);
    expect(toNumber(good1?.rank)).toBe(1);
    expect(good1?.trades_30d).toBe(26);
  });

  it("keeps the wallets with the best net SOL flow when the candidate cap binds", async () => {
    const capped = await rankWallets(database.db, { asOfMs: ASOF, config, bundleSlotWindow: 1, maxCandidates: 8, maxTradesPerWallet: 100, persist: false });
    const wallets = capped.wallets.map((wallet) => wallet.wallet);
    expect([...wallets].sort()).toEqual(["BOT", "BUNDLE", "CREATOR", "DEVLINK", "FUNDED", "GOOD1", "LUCKY", "TOOACTIVE"]);
    expect(capped.wallets[0]?.wallet).toBe("GOOD1");
    for (const loser of ["LOSER", "BAGHOLDER", "FEW", "GOOD3", "HISTORY"]) {
      expect(wallets).not.toContain(loser);
    }
  });

  it("is unaffected by trades and data after as-of", async () => {
    const db = database.db;
    const ids = await insertLaunches(db, [
      { mint: "PostA", createdAtMs: ASOF + 1_000, dev: "GOOD1" },
      { mint: "PostB", createdAtMs: ASOF + 2_000 }
    ]);
    const trades: TradeSpec[] = [];
    for (let index = 0; index < 40; index += 1) {
      const atMs = ASOF + index * 1_000;
      trades.push(
        { launchId: ids.get("PostB") ?? 0, wallet: "GOOD2", atMs, isBuy: true, tokenAmount: 10n, userQuote: 50_000_000_000n, signature: `post-b-${index}` },
        { launchId: ids.get("PostB") ?? 0, wallet: "GOOD2", atMs: atMs + 500, isBuy: false, tokenAmount: 10n, userQuote: 1n, signature: `post-s-${index}` },
        { launchId: ids.get("PostA") ?? 0, wallet: "FEW", atMs, isBuy: true, tokenAmount: 10n, userQuote: 1n, signature: `post-f-${index}` }
      );
    }
    await insertTrades(db, trades);
    await insertKnownEntity(db, "GOOD3", "exclude", ASOF);
    const second = await rankWallets(db, { asOfMs: ASOF, config, bundleSlotWindow: 1, maxTradesPerWallet: 100, persist: false });
    expect(second.runId).toBeNull();
    expect(fingerprint(second)).toEqual(fingerprint(first));
  });
});

describe.skipIf(!hasTestDatabase)("ranking exclusions resist a spoofed creator", () => {
  let database: TestDatabase;
  const AT = ASOF - 10 * DAY;
  const window = { fromMs: ASOF - 90 * DAY, asOfMs: ASOF, creationSlotWindow: 1 };

  beforeAll(async () => {
    database = await createTestDatabase("tracker_creator_spoof");
    const ids = await insertLaunches(database.db, [
      { mint: "GriefMint", createdAtMs: AT, dev: "GrieferSigner", creator: "SmartWallet" },
      { mint: "ServiceMint", createdAtMs: AT, dev: "LaunchService", creator: "RealDev" },
      { mint: "TributeMint", createdAtMs: AT, dev: "PranksterSigner", creator: "ExchangeHot" },
      { mint: "SignerMint", createdAtMs: AT, dev: "DevSigner" }
    ]);
    await insertTrades(database.db, [
      { launchId: ids.get("GriefMint") ?? 0, wallet: "SmartWallet", atMs: AT + 30_000, isBuy: true, tokenAmount: 1_000n, userQuote: SOL, signature: "smart-buy" },
      { launchId: ids.get("ServiceMint") ?? 0, wallet: "RealDev", atMs: AT, slot: slotAt(AT), isBuy: true, tokenAmount: 1_000n, userQuote: SOL, signature: "dev-buy" }
    ]);
    await markHubs(database.db, ["ExchangeHot"]);
    await insertKnownEntity(database.db, "ExchangeLabeled", "exchange", AT - DAY);
    await insertLaunches(database.db, [{ mint: "LabeledTribute", createdAtMs: AT, dev: "ExchangeLabeled" }]);
    await insertIntel(database.db, "FundedByHub", "ExchangeHot", AT + 1_000, AT - DAY);
    await insertIntel(database.db, "FundedByLabeled", "ExchangeLabeled", AT + 1_000, AT - DAY);
    await insertIntel(database.db, "FundedBySigner", "DevSigner", AT + 1_000, AT - DAY);
    await insertIntel(database.db, "FundedByCreatorOnly", "SmartWallet", AT + 1_000, AT - DAY);
  });

  afterAll(async () => {
    await database.drop();
  });

  it("links a wallet to a launch only when it signed the create or bought it in the creation window", async () => {
    const facts = await loadWalletFacts(database.db, ["SmartWallet", "RealDev", "DevSigner", "ExchangeHot"], window, new Set());
    expect(facts.get("SmartWallet")?.devLinked).toBe(false);
    expect(facts.get("RealDev")?.devLinked).toBe(true);
    expect(facts.get("DevSigner")?.devLinked).toBe(true);
    expect(facts.get("ExchangeHot")?.devLinked).toBe(false);
  });

  it("does not mark wallets dev funded through a hub or labelled exchange or a spoofed creator", async () => {
    const wallets = ["FundedByHub", "FundedByLabeled", "FundedBySigner", "FundedByCreatorOnly"];
    const facts = await loadWalletFacts(database.db, wallets, window, new Set());
    expect(wallets.map((wallet) => facts.get(wallet)?.devFunded)).toEqual([false, false, true, false]);
  });
});
