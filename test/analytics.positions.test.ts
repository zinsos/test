import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  emptyPositionsSnapshot,
  entryRulesOf,
  estimatedCloseProceeds,
  netSellValue,
  pumpCoinUrl,
  selectPositionsRun,
  sellFeeBpsFor,
  sellFeeDefaultsOf
} from "../src/analytics/positionQueries.js";
import { startAnalyticsServer, type AnalyticsServer } from "../src/analytics/server.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import type { Position, Signal } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import { applySellFill, closePosition, realizedPnlOf, syntheticCloseFill } from "../src/trader/accounting.js";
import { mintAt, PUMP_QUOTE } from "./analytics.db.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const TOKEN = "positions-token";
const NOW_MS = Date.UTC(2026, 9, 23, 12, 0, 0);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SOL = 1_000_000_000n;
const ENTRY_PRICE = 2 ** -15;
const HALF_BAG = 1_638_400_000_000n;
const FULL_BAG = 3_276_800_000_000n;
type Json = Record<string, unknown>;

interface ApiResult {
  status: number;
  text: string;
  body: Json;
}

const CLOSE_TX = 305_000n;
const RENT_REFUND = 1_513_840n;
const SELL_FEES = { curveBps: 200, poolBps: 30, extraPlatformBps: 10, closeTxLamports: CLOSE_TX, rentRefundLamports: RENT_REFUND };
const MINT_A = mintAt(20);
const MINT_B = mintAt(21);
const MINT_C = mintAt(22);
const MINT_D = mintAt(23);
const MINT_PUMP_QUOTED = mintAt(24);

interface Runs {
  paper: number;
  live: number;
  backtest: number;
  oldPaper: number;
}

interface PositionRow {
  id: string;
  runId: number;
  mint: string;
  mode?: string;
  status: "open" | "pending" | "closed";
  openedAtMs: number;
  entryPrice?: number;
  entryTokens?: bigint;
  tokensHeld?: bigint;
  entryCost?: bigint;
  proceeds?: bigint;
  lastPrice?: number;
  peakPrice?: number;
  takeProfitLevelsHit?: number;
  migratedSeen?: boolean;
  closedAtMs?: number | null;
  realizedPnl?: bigint | null;
  exitReason?: string | null;
  peakMultiple?: number | null;
  shadowOf?: string | null;
  signalType?: string;
  meta?: Record<string, unknown>;
}

async function insertRun(db: Db, mode: string, label: string | null, startedAtMs: number, endedAtMs: number | null = null): Promise<number> {
  const result = await db.query<{ id: bigint }>(
    `INSERT INTO strategy_runs (mode, label, started_at, ended_at, config) VALUES ($1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
    [mode, label, new Date(startedAtMs), endedAtMs === null ? null : new Date(endedAtMs)]
  );
  return Number(result.rows[0]?.id ?? 0);
}

async function insertLaunch(
  db: Db,
  mint: string,
  name: string,
  symbol: string,
  createdAtMs: number,
  migratedAtMs: number | null,
  quoteMint = "SOL"
): Promise<number> {
  const result = await db.query<{ id: bigint }>(
    `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, name, symbol, create_signature, create_slot, created_at,
       token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token, migrated_at, last_trade_at, quote_mint)
     VALUES ($1, $1 || 'c', $1 || 'd', $1 || 'd', $2, $3, $1 || 's', 1, $4, 1000000000000000, 1073000000000000, 30000000000,
       793100000000000, $5, $6, $7)
     RETURNING id`,
    [mint, name, symbol, new Date(createdAtMs), migratedAtMs === null ? null : new Date(migratedAtMs), new Date(NOW_MS - 3 * MINUTE_MS), quoteMint]
  );
  return Number(result.rows[0]?.id ?? 0);
}

async function insertTrade(
  db: Db,
  launchId: number,
  atMs: number,
  slot: number,
  venue: number,
  bps: { protocol: number; creator: number; lp: number }
): Promise<void> {
  await db.query(
    `INSERT INTO trades (launch_id, block_time, slot, seq, signature, event_index, venue, wallet, is_buy, token_amount, quote_amount,
       user_quote, protocol_fee_bps, creator_fee_bps, lp_fee_bps, virtual_token, virtual_quote)
     VALUES ($1, $2, $3, $3, $4, 0, $5, 'Wallet1', TRUE, 1000, 1000, 1000, $6, $7, $8, 1073000000000000, 30000000000)`,
    [launchId, new Date(atMs), slot, `sig-${launchId}-${slot}`, venue, bps.protocol, bps.creator, bps.lp]
  );
}

async function insertPosition(db: Db, row: PositionRow): Promise<void> {
  const closed = row.status === "closed";
  await db.query(
    `INSERT INTO positions (id, run_id, mode, mint, signal_type, risk_score, opened_at, opened_slot, entry_price, entry_tokens, entry_cost,
       tokens_held, proceeds, fees_paid, peak_price, last_price, take_profit_levels_hit, migrated_seen, status, closed_at, exit_reason,
       realized_pnl, hold_sec, peak_multiple, shadow_of, meta)
     VALUES ($1, $2, $3, $4, $5, 18, $6, 1, $7, $8, $9, $10, $11, 2000000, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb)`,
    [
      row.id,
      row.runId,
      row.mode ?? "paper",
      row.mint,
      row.signalType ?? "score_momentum",
      new Date(row.openedAtMs),
      row.entryPrice ?? ENTRY_PRICE,
      (row.entryTokens ?? FULL_BAG).toString(),
      (row.entryCost ?? SOL / 10n).toString(),
      (row.tokensHeld ?? FULL_BAG).toString(),
      (row.proceeds ?? 0n).toString(),
      row.peakPrice ?? ENTRY_PRICE,
      row.lastPrice ?? ENTRY_PRICE,
      row.takeProfitLevelsHit ?? 0,
      row.migratedSeen ?? false,
      row.status,
      closed && row.closedAtMs ? new Date(row.closedAtMs) : null,
      closed ? row.exitReason ?? "take_profit" : null,
      closed && row.realizedPnl !== null && row.realizedPnl !== undefined ? row.realizedPnl.toString() : null,
      closed && row.closedAtMs ? (row.closedAtMs - row.openedAtMs) / 1000 : null,
      closed ? row.peakMultiple ?? null : null,
      row.shadowOf ?? null,
      JSON.stringify(row.meta ?? {})
    ]
  );
}

async function insertSignal(db: Db, runId: number, type: string, mint: string, atMs: number, acted: boolean, skipReason: string | null): Promise<void> {
  await db.query(
    `INSERT INTO signals (run_id, type, mint, at, slot, risk_score, acted, skip_reason) VALUES ($1, $2, $3, $4, 1, 20, $5, $6)`,
    [runId, type, mint, new Date(atMs), acted, skipReason]
  );
}

async function seed(db: Db): Promise<Runs> {
  const oldPaper = await insertRun(db, "paper", "old", NOW_MS - 5 * 24 * HOUR_MS, NOW_MS - 4 * 24 * HOUR_MS);
  const live = await insertRun(db, "live", "live-small", NOW_MS - 3 * HOUR_MS);
  const paper = await insertRun(db, "paper", null, NOW_MS - 2 * HOUR_MS);
  const backtest = await insertRun(db, "backtest", "bt", NOW_MS - 10 * MINUTE_MS, NOW_MS - 5 * MINUTE_MS);

  const launchA = await insertLaunch(db, MINT_A, "Alpha Coin", "ALPHA", NOW_MS - 30 * MINUTE_MS, null);
  await insertLaunch(db, MINT_B, "Beta Coin", "BETA", NOW_MS - 30 * MINUTE_MS, null);
  const launchC = await insertLaunch(db, MINT_C, "Gamma Coin", "GAMMA", NOW_MS - 3 * HOUR_MS, NOW_MS - HOUR_MS);
  await insertLaunch(db, MINT_PUMP_QUOTED, "Pump Quoted", "PQ", NOW_MS - 30 * MINUTE_MS, null, PUMP_QUOTE);
  await insertTrade(db, launchA, NOW_MS - 20 * MINUTE_MS, 10, 0, { protocol: 100, creator: 50, lp: 0 });
  await insertTrade(db, launchA, NOW_MS - 2 * MINUTE_MS, 20, 0, { protocol: 95, creator: 30, lp: 0 });
  await insertTrade(db, launchC, NOW_MS - 90 * MINUTE_MS, 5, 0, { protocol: 95, creator: 30, lp: 0 });
  await insertTrade(db, launchC, NOW_MS - MINUTE_MS, 30, 1, { protocol: 5, creator: 5, lp: 20 });

  await insertPosition(db, {
    id: "pos-a",
    runId: paper,
    mint: MINT_A,
    status: "open",
    openedAtMs: NOW_MS - 10 * MINUTE_MS,
    entryTokens: FULL_BAG,
    tokensHeld: HALF_BAG,
    proceeds: SOL / 20n,
    lastPrice: 2 ** -13,
    peakPrice: 2 ** -12,
    takeProfitLevelsHit: 1,
    meta: { exit: { liquidating: null } }
  });
  await insertPosition(db, {
    id: "pos-b",
    runId: paper,
    mint: MINT_B,
    status: "open",
    openedAtMs: NOW_MS - 5 * MINUTE_MS,
    lastPrice: 2 ** -16,
    signalType: "smart_convergence",
    meta: { exit: { liquidating: { reason: "stop_loss", urgency: "emergency", targetTokens: "0" } } }
  });
  await insertPosition(db, {
    id: "pos-c",
    runId: paper,
    mint: MINT_C,
    status: "open",
    openedAtMs: NOW_MS - 20 * MINUTE_MS,
    tokensHeld: HALF_BAG,
    entryTokens: HALF_BAG,
    lastPrice: 2 ** -13,
    peakPrice: 2 ** -13
  });
  await insertPosition(db, {
    id: "pos-d",
    runId: paper,
    mint: MINT_D,
    status: "pending",
    openedAtMs: NOW_MS - MINUTE_MS,
    entryPrice: 0,
    entryTokens: 0n,
    tokensHeld: 0n,
    entryCost: 0n,
    lastPrice: 0,
    peakPrice: 0,
    meta: { pendingEntry: { quoteBudget: "150000000", maxSlippageBps: 1500, referencePrice: 1e-5 } }
  });
  await insertPosition(db, { id: "pos-a-shadow", runId: paper, mint: MINT_A, mode: "shadow", status: "open", openedAtMs: NOW_MS - 10 * MINUTE_MS, shadowOf: "pos-a" });
  await insertPosition(db, { id: "pos-pump-quoted", runId: paper, mint: MINT_PUMP_QUOTED, status: "open", openedAtMs: NOW_MS - 2 * MINUTE_MS });
  await insertPosition(db, {
    id: "closed-pump-quoted",
    runId: paper,
    mint: MINT_PUMP_QUOTED,
    status: "closed",
    openedAtMs: NOW_MS - 30 * MINUTE_MS,
    closedAtMs: NOW_MS - 2 * MINUTE_MS,
    tokensHeld: 0n,
    realizedPnl: 9n * SOL
  });
  await insertPosition(db, {
    id: "closed-1",
    runId: paper,
    mint: MINT_A,
    status: "closed",
    openedAtMs: NOW_MS - 90 * MINUTE_MS,
    closedAtMs: NOW_MS - 50 * MINUTE_MS,
    tokensHeld: 0n,
    proceeds: 130_000_000n,
    realizedPnl: null,
    exitReason: "take_profit",
    peakMultiple: 2.4
  });
  await insertPosition(db, {
    id: "closed-2",
    runId: paper,
    mint: MINT_B,
    status: "closed",
    openedAtMs: NOW_MS - 60 * MINUTE_MS,
    closedAtMs: NOW_MS - 30 * MINUTE_MS,
    tokensHeld: 0n,
    proceeds: 160_000_000n,
    realizedPnl: 60_000_000n,
    exitReason: "trailing_stop",
    peakMultiple: 2.1
  });
  await insertPosition(db, {
    id: "closed-3",
    runId: paper,
    mint: MINT_D,
    status: "closed",
    openedAtMs: NOW_MS - 70 * MINUTE_MS,
    closedAtMs: NOW_MS - 40 * MINUTE_MS,
    tokensHeld: 0n,
    proceeds: 60_000_000n,
    realizedPnl: -40_000_000n,
    exitReason: "stop_loss",
    peakMultiple: 1.1
  });
  await insertPosition(db, {
    id: "closed-2-shadow",
    runId: paper,
    mint: MINT_B,
    mode: "shadow",
    status: "closed",
    openedAtMs: NOW_MS - 60 * MINUTE_MS,
    closedAtMs: NOW_MS - 20 * MINUTE_MS,
    tokensHeld: 0n,
    realizedPnl: 1n,
    shadowOf: "closed-2"
  });
  await insertPosition(db, {
    id: "old-closed",
    runId: oldPaper,
    mint: MINT_A,
    status: "closed",
    openedAtMs: NOW_MS - 5 * 24 * HOUR_MS,
    closedAtMs: NOW_MS - 10 * MINUTE_MS,
    tokensHeld: 0n,
    realizedPnl: 5n
  });
  await insertPosition(db, {
    id: "bt-closed",
    runId: backtest,
    mint: MINT_C,
    mode: "backtest",
    status: "closed",
    openedAtMs: NOW_MS - 9 * MINUTE_MS,
    closedAtMs: NOW_MS - 8 * MINUTE_MS,
    tokensHeld: 0n,
    realizedPnl: -1n
  });

  await db.query(
    `INSERT INTO risk_state (run_id, starting_bankroll, realized_pnl, peak_equity, day_key, day_start_equity, halted_until, killed, state)
     VALUES ($1, 10000000000, 500000000, 10700000000, '2026-10-23', 10200000000, $2, FALSE, $3::jsonb)`,
    [paper, new Date(NOW_MS + HOUR_MS), JSON.stringify({ unrealizedPnlLamports: "100000000", devEntries: { Dev1: 1 } })]
  );
  await db.query(
    `INSERT INTO risk_state (run_id, starting_bankroll, realized_pnl, peak_equity, day_key, day_start_equity, halted_until, killed, kill_reason)
     VALUES ($1, 5000000000, -1000000000, 5000000000, '2026-10-22', 5000000000, $2, TRUE, 'drawdown 0.2500 >= 0.25')`,
    [live, new Date(NOW_MS - HOUR_MS)]
  );

  await insertSignal(db, paper, "score_momentum", MINT_A, NOW_MS - 10 * MINUTE_MS, true, null);
  await insertSignal(db, paper, "score_momentum", MINT_B, NOW_MS - 5 * MINUTE_MS, true, null);
  await insertSignal(db, paper, "score_momentum", MINT_A, NOW_MS - 4 * MINUTE_MS, false, "cooldown");
  for (let index = 0; index < 3; index += 1) {
    await insertSignal(db, paper, "smart_convergence", MINT_C, NOW_MS - (index + 1) * MINUTE_MS, false, "max_open_positions");
  }
  await insertSignal(db, paper, "smart_convergence", MINT_C, NOW_MS - 30 * HOUR_MS, false, "old_reason");
  return { paper, live, backtest, oldPaper };
}

function heldPosition(tokensHeld: bigint, proceeds: bigint, entryCost: bigint, lastPrice: number): Position {
  const signal: Signal = { id: null, type: "score_momentum", mint: MINT_A, atMs: NOW_MS, slot: 1, riskScore: 18, wallets: [], meta: {} };
  return {
    id: "estimate-check",
    runId: 1,
    mode: "paper",
    mint: signal.mint,
    launchId: null,
    signalId: null,
    signalType: signal.type,
    riskScore: signal.riskScore,
    openedAtMs: NOW_MS - 10 * MINUTE_MS,
    openedSlot: 1,
    entryPrice: ENTRY_PRICE,
    entryTokens: FULL_BAG,
    entryCost,
    tokensHeld,
    proceeds,
    feesPaid: 0n,
    peakPrice: lastPrice,
    lastPrice,
    takeProfitLevelsHit: 0,
    migratedSeen: false,
    status: "open",
    closedAtMs: null,
    exitReason: null,
    shadowOf: null,
    meta: {}
  };
}

describe("position estimates", () => {
  it("uses the latest trade's fee bps, falls back to venue defaults, and adds the platform fee", () => {
    const defaults = { curveBps: 125, poolBps: 30, extraPlatformBps: 5, closeTxLamports: 0n, rentRefundLamports: 0n };
    expect(sellFeeBpsFor({ protocolBps: 95, creatorBps: 30, lpBps: 0 }, false, defaults)).toEqual({ venueBps: 125, platformBps: 5, bps: 130, source: "last_trade" });
    expect(sellFeeBpsFor({ protocolBps: 5, creatorBps: 5, lpBps: 20 }, true, defaults)).toEqual({ venueBps: 30, platformBps: 5, bps: 35, source: "last_trade" });
    expect(sellFeeBpsFor(null, false, defaults)).toEqual({ venueBps: 125, platformBps: 5, bps: 130, source: "default" });
    expect(sellFeeBpsFor(null, true, defaults)).toEqual({ venueBps: 30, platformBps: 5, bps: 35, source: "default" });
    expect(sellFeeBpsFor({ protocolBps: 0, creatorBps: 0, lpBps: 0 }, false, defaults)).toEqual({ venueBps: 125, platformBps: 5, bps: 130, source: "default" });
  });

  it("nets the venue fee, then the platform fee on what is left, from the value at the last price in lamports", () => {
    expect(netSellValue(HALF_BAG, 2 ** -13, { venueBps: 125, platformBps: 0 })).toBe(197_500_000n);
    expect(netSellValue(HALF_BAG, 2 ** -13, { venueBps: 125, platformBps: 10 })).toBe(197_302_500n);
    expect(netSellValue(HALF_BAG, 2 ** -13, { venueBps: 0, platformBps: 0 })).toBe(200_000_000n);
    expect(netSellValue(0n, 2 ** -13, { venueBps: 125, platformBps: 0 })).toBe(0n);
    expect(netSellValue(HALF_BAG, Number.NaN, { venueBps: 125, platformBps: 0 })).toBe(0n);
    expect(netSellValue(HALF_BAG, 2 ** -13, { venueBps: 20_000, platformBps: 0 })).toBe(0n);
    expect(netSellValue(HALF_BAG, 2 ** -13, { venueBps: Number.NaN, platformBps: Number.POSITIVE_INFINITY })).toBe(200_000_000n);
  });

  it("books the closing sell's network fee and ATA rent refund like the trader does, and nothing once no tokens are held", () => {
    const fee = { venueBps: 125, platformBps: 0 };
    const costs = { closeTxLamports: CLOSE_TX, rentRefundLamports: RENT_REFUND };
    expect(estimatedCloseProceeds(HALF_BAG, 2 ** -13, fee, costs)).toBe(197_500_000n - CLOSE_TX + RENT_REFUND);
    expect(estimatedCloseProceeds(0n, 2 ** -13, fee, costs)).toBe(0n);
  });

  it("estimates the same pnl the trader books when it closes the position at the last price", () => {
    const execution = defaultStrategyConfig().execution;
    const defaults = sellFeeDefaultsOf(execution);
    const price = 2 ** -13;
    for (const [tokens, proceeds] of [
      [HALF_BAG, SOL / 20n],
      [FULL_BAG, 0n]
    ] as const) {
      const open = heldPosition(tokens, proceeds, 76_819_145n, price);
      const close = syntheticCloseFill(open, null, price, execution, NOW_MS, "take_profit", "estimate-check");
      const booked = realizedPnlOf(closePosition(applySellFill(open, close.order, close.fill), NOW_MS, "take_profit"));
      const estimate = proceeds + estimatedCloseProceeds(tokens, price, sellFeeBpsFor(null, false, defaults), defaults) - open.entryCost;
      expect(estimate).toBe(booked);
    }
  });

  it("derives fee and close cost defaults and entry rules from the strategy config", () => {
    const config = defaultStrategyConfig();
    config.signals.enabled = ["smart_convergence", "score_momentum"];
    expect(sellFeeDefaultsOf(config.execution)).toEqual({
      curveBps: 125,
      poolBps: 30,
      extraPlatformBps: 0,
      closeTxLamports: 305_000n,
      rentRefundLamports: 1_513_840n
    });
    expect(sellFeeDefaultsOf({ ...config.execution, useJito: true, refundAtaOnClose: false })).toMatchObject({
      closeTxLamports: 1_305_000n,
      rentRefundLamports: 0n
    });
    const rules = entryRulesOf(config);
    expect(rules.enabled).toEqual(["smart_convergence", "score_momentum"]);
    expect(rules.scoreMomentum).toMatchObject({ checkpointSec: 60, maxRiskScore: 35, minMcapSol: 35, maxMcapSol: 150 });
    expect(rules.convergence).toEqual({ windowSec: 120, minWallets: 3, maxRiskScore: 55 });
    expect(rules.maxOpenPositions).toBe(config.risk.maxConcurrent);
    expect(emptyPositionsSnapshot(5, 0)).toMatchObject({ run: null, todayKey: "1970-01-01", todayPnlEstimateSol: null });
  });

  it("links only valid base58 mints to pump.fun", () => {
    expect(pumpCoinUrl(MINT_A)).toBe(`https://pump.fun/coin/${MINT_A}`);
    for (const bad of ["", "javascript:alert(1)", "../../evil", `${MINT_A}/../x`, "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", "a".repeat(45)]) {
      expect(pumpCoinUrl(bad)).toBeNull();
    }
  });
});

describe.skipIf(!hasTestDatabase)("positions api", () => {
  let database: TestDatabase;
  let runs: Runs;
  let server: AnalyticsServer;
  let base = "";

  async function call(path: string, token: string | null = TOKEN): Promise<ApiResult> {
    const response = await fetch(`${base}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Json };
  }

  function list(body: Json, key: string): Json[] {
    return body[key] as Json[];
  }

  function ids(body: Json, key: string): unknown[] {
    return list(body, key).map((item) => item.id);
  }

  beforeAll(async () => {
    database = await createTestDatabase("analytics_positions");
    runs = await seed(database.db);
    const rules = entryRulesOf(defaultStrategyConfig());
    server = await startAnalyticsServer({
      db: database.db,
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      clock: new VirtualClock(NOW_MS),
      settings: { sellFees: SELL_FEES, entryRules: rules }
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  it("requires the token", async () => {
    expect((await call("/api/positions", null)).status).toBe(401);
    expect((await call("/api/positions", "wrong")).status).toBe(401);
    expect((await call(`/api/positions?token=${TOKEN}`, null)).status).toBe(200);
  });

  it("picks the latest paper or live run that has positions, ahead of newer backtests and empty runs", async () => {
    const { body, status } = await call("/api/positions");
    expect(status).toBe(200);
    expect(body.run).toMatchObject({ id: runs.paper, mode: "paper", label: null, active: true, startedAtMs: NOW_MS - 2 * HOUR_MS });
    expect(body.readAtMs).toBe(NOW_MS);
    expect(body.filter).toEqual({ runId: null, mode: null });
    expect(await selectPositionsRun(database.db, { mode: "backtest" })).toMatchObject({ id: runs.backtest });
    expect(await selectPositionsRun(database.db, { mode: "shadow" })).toBeNull();
  });

  it("lists open and pending positions newest first with fee-netted estimates and no shadows", async () => {
    const { body, text } = await call("/api/positions");
    expect(ids(body, "open")).toEqual(["pos-d", "pos-b", "pos-a", "pos-c"]);
    const [pending, beta, alpha, gamma] = list(body, "open");

    expect(alpha).toMatchObject({
      status: "open",
      mint: MINT_A,
      name: "Alpha Coin",
      symbol: "ALPHA",
      signalType: "score_momentum",
      riskScore: 18,
      openedAtMs: NOW_MS - 10 * MINUTE_MS,
      ageSec: 600,
      entryCostSol: 0.1,
      multiple: 4,
      peakMultiple: 8,
      tokensHeld: HALF_BAG.toString(),
      entryTokens: FULL_BAG.toString(),
      soldPct: 50,
      proceedsSol: 0.05,
      sellFeeBps: 135,
      sellFeeSource: "last_trade",
      estimatedValueSol: 0.19851134,
      takeProfitLevelsHit: 1,
      migrated: false,
      exiting: null,
      lastTradeAtMs: NOW_MS - 2 * MINUTE_MS,
      pumpUrl: `https://pump.fun/coin/${MINT_A}`
    });
    expect(alpha?.estimatedPnlSol).toBeCloseTo(0.14851134, 12);
    expect(alpha?.estimatedPnlPct).toBeCloseTo(148.51134, 9);

    expect(beta).toMatchObject({ sellFeeBps: 210, sellFeeSource: "default", estimatedValueSol: 0.05015984, multiple: 0.5, exiting: "stop_loss", soldPct: 0 });
    expect(beta?.estimatedPnlSol).toBeCloseTo(-0.04984016, 12);
    expect(beta?.lastTradeAtMs).toBe(NOW_MS - 3 * MINUTE_MS);

    expect(gamma).toMatchObject({ migrated: true, sellFeeBps: 40, sellFeeSource: "last_trade", estimatedValueSol: 0.20040944 });
    expect(gamma?.estimatedPnlSol).toBeCloseTo(0.10040944, 12);

    expect(pending).toMatchObject({
      status: "pending",
      mint: MINT_D,
      name: null,
      symbol: null,
      budgetSol: 0.15,
      entryPrice: null,
      multiple: null,
      estimatedValueSol: null,
      estimatedPnlSol: null,
      estimatedPnlPct: null,
      soldPct: null
    });

    expect(body.openPnlEstimateSol).toBeCloseTo(0.19908062, 12);
    expect(body.equityEstimateSol).toBeCloseTo(10.69908062, 9);
    expect(body.todayKey).toBe("2026-10-23");
    expect(body.todayPnlEstimateSol).toBeCloseTo(10.69908062 - 10.2, 9);
    expect(text).not.toContain("pos-a-shadow");
  });

  it("returns the bankroll from the run's risk state", async () => {
    const { body } = await call("/api/positions");
    expect(body.bankroll).toEqual({
      startingSol: 10,
      realizedPnlSol: 0.5,
      unrealizedPnlSol: 0.1,
      equitySol: 10.6,
      peakEquitySol: 10.7,
      dayKey: "2026-10-23",
      dayStartEquitySol: 10.2,
      dayPnlSol: 0.4,
      haltedForDay: true,
      haltedUntilMs: NOW_MS + HOUR_MS,
      killed: false,
      killReason: null,
      updatedAtMs: expect.any(Number)
    });
    const live = await call("/api/positions?mode=live");
    expect(live.body.run).toMatchObject({ id: runs.live, mode: "live" });
    expect(live.body.bankroll).toMatchObject({ killed: true, killReason: "drawdown 0.2500 >= 0.25", haltedForDay: false, equitySol: null, dayPnlSol: null });
    expect(live.body.open).toEqual([]);
    expect(live.body.equityEstimateSol).toBe(4);
    expect(live.body.bankroll).toMatchObject({ dayKey: "2026-10-22" });
    expect(live.body.todayKey).toBe("2026-10-23");
    expect(live.body.todayPnlEstimateSol).toBeNull();
  });

  it("lists recent closed trades of the run newest first with realized pnl", async () => {
    const { body } = await call("/api/positions");
    const closed = list(body, "recentClosed");
    expect(ids(body, "recentClosed")).toEqual(["closed-2", "closed-3", "closed-1"]);
    expect(closed[0]).toEqual({
      id: "closed-2",
      mint: MINT_B,
      name: "Beta Coin",
      symbol: "BETA",
      signalType: "score_momentum",
      riskScore: 18,
      openedAtMs: NOW_MS - 60 * MINUTE_MS,
      closedAtMs: NOW_MS - 30 * MINUTE_MS,
      holdSec: 1_800,
      costSol: 0.1,
      proceedsSol: 0.16,
      feesPaidSol: 0.002,
      pnlSol: 0.06,
      pnlPct: 60,
      peakMultiple: 2.1,
      exitReason: "trailing_stop",
      pumpUrl: `https://pump.fun/coin/${MINT_B}`
    });
    expect(closed[1]).toMatchObject({ pnlSol: -0.04, pnlPct: -40, exitReason: "stop_loss", name: null });
    expect(closed[2]).toMatchObject({ pnlSol: 0.03, exitReason: "take_profit" });
    expect((await call("/api/positions?closedLimit=1")).body.recentClosed).toHaveLength(1);
  });

  it("counts positions and summarises the run's signals over the last day", async () => {
    const { body } = await call("/api/positions");
    expect(body.counts).toEqual({
      open: 3,
      pending: 1,
      closed: 3,
      openedLast24h: 7,
      closedLast24h: 3,
      winsLast24h: 2,
      realizedLast24hSol: 0.05,
      lastOpenedAtMs: NOW_MS - MINUTE_MS,
      lastClosedAtMs: NOW_MS - 30 * MINUTE_MS
    });
    expect(body.activity).toEqual({
      windowHours: 24,
      byType: [
        { type: "score_momentum", total: 3, acted: 2, lastAtMs: NOW_MS - 4 * MINUTE_MS },
        { type: "smart_convergence", total: 3, acted: 0, lastAtMs: NOW_MS - MINUTE_MS }
      ],
      skipReasons: [
        { reason: "max_open_positions", count: 3 },
        { reason: "cooldown", count: 1 }
      ]
    });
    expect(body.entryRules).toMatchObject({ enabled: ["smart_convergence"], scorerMaxRisk: 55 });
  });

  it("filters by run id and mode and rejects unknown runs", async () => {
    const backtest = await call(`/api/positions?runId=${runs.backtest}`);
    expect(backtest.body.run).toMatchObject({ id: runs.backtest, mode: "backtest", active: false });
    expect(ids(backtest.body, "recentClosed")).toEqual(["bt-closed"]);
    expect(backtest.body.bankroll).toBeNull();
    const old = await call(`/api/positions?runId=${runs.oldPaper}&mode=paper`);
    expect(ids(old.body, "recentClosed")).toEqual(["old-closed"]);
    expect(old.body.open).toEqual([]);
    const missing = await call("/api/positions?runId=99999");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("run_not_found");
    expect((await call(`/api/positions?runId=${runs.paper}&mode=live`)).status).toBe(404);
    expect((await call("/api/positions?mode=moon")).status).toBe(400);
    const none = await call("/api/positions?mode=shadow");
    expect(none.status).toBe(200);
    expect(none.body.run).toBeNull();
    expect(none.body.open).toEqual([]);
  });

  it("is never served from the response cache", async () => {
    const before = await call("/api/positions");
    expect(list(before.body, "open")[1]).toMatchObject({ id: "pos-b", multiple: 0.5 });
    await database.db.query("UPDATE positions SET last_price = $1, peak_price = $1 WHERE id = 'pos-b'", [2 ** -14]);
    const after = await call("/api/positions");
    expect(list(after.body, "open")[1]).toMatchObject({ id: "pos-b", multiple: 2, peakMultiple: 2 });
  });

  it("never shows positions on launches quoted in another coin, in lists, counts or the equity estimate", async () => {
    const { text, body } = await call("/api/positions");
    expect(text).not.toContain(MINT_PUMP_QUOTED);
    expect(text).not.toContain("pos-pump-quoted");
    expect(body.counts).toMatchObject({ open: 3, closed: 3, realizedLast24hSol: 0.05 });
  });

  it("prefers the active paper or live run over an ended one that has more history", async () => {
    const db = database.db;
    await db.query("UPDATE strategy_runs SET ended_at = $2 WHERE id = $1", [runs.paper, new Date(NOW_MS - MINUTE_MS)]);
    await db.query("UPDATE strategy_runs SET ended_at = $2 WHERE id = $1", [runs.live, new Date(NOW_MS - MINUTE_MS)]);
    const fresh = await insertRun(db, "paper", "fresh", NOW_MS - 30 * MINUTE_MS);
    try {
      const { body } = await call("/api/positions");
      expect(body.run).toMatchObject({ id: fresh, active: true });
      expect(body.open).toEqual([]);
      expect(await selectPositionsRun(db, { mode: "paper" })).toMatchObject({ id: fresh });
    } finally {
      await db.query("DELETE FROM strategy_runs WHERE id = $1", [fresh]);
      await db.query("UPDATE strategy_runs SET ended_at = NULL WHERE id = ANY($1::bigint[])", [[runs.paper, runs.live]]);
    }
    expect((await call("/api/positions")).body.run).toMatchObject({ id: runs.paper });
  });
});
