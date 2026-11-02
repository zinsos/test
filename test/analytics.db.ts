import bs58 from "bs58";
import type { Db } from "../src/db/pool.js";

export const NOW_MS = Date.UTC(2026, 9, 20, 12, 0, 0);
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const SOL = 1_000_000_000n;
export const PUMP_QUOTE = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
export const PAPER_TRADES = 120;
export const BACKTEST_TRADES = 10;
export const LIVE_PAIRS = 25;

export function mintAt(index: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = 7;
  bytes[31] = index + 1;
  bytes[15] = 200 - index;
  return bs58.encode(bytes);
}

export function walletAt(index: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = 9;
  bytes[31] = index + 1;
  return bs58.encode(bytes);
}

export interface SeededData {
  paperRunId: number;
  liveRunId: number;
  backtestRunId: number;
  launchIds: number[];
  mints: string[];
}

interface PositionSpec {
  id: string;
  runId: number;
  mode: string;
  mint: string;
  signalType: string;
  riskScore: number | null;
  openedAtMs: number;
  holdSec: number;
  cost: bigint;
  pnl: bigint;
  exitReason: string;
  status?: "open" | "closed";
  shadowOf?: string | null;
}

interface FillSpec {
  positionId: string;
  runId: number;
  side: "buy" | "sell";
  atMs: number;
  tokens: bigint;
  userQuote: bigint;
  success?: boolean;
}

function lamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

async function insertRun(db: Db, mode: string, label: string, startedAtMs: number): Promise<number> {
  const result = await db.query<{ id: bigint }>(
    `INSERT INTO strategy_runs (mode, label, started_at, config) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`,
    [mode, label, new Date(startedAtMs)]
  );
  return Number(result.rows[0]?.id ?? 0);
}

async function insertPosition(db: Db, spec: PositionSpec): Promise<void> {
  const closed = (spec.status ?? "closed") === "closed";
  const closedAt = closed ? new Date(spec.openedAtMs + spec.holdSec * 1_000) : null;
  await db.query(
    `INSERT INTO positions (id, run_id, mode, mint, signal_type, risk_score, opened_at, opened_slot, entry_price, entry_tokens,
       entry_cost, tokens_held, proceeds, fees_paid, peak_price, last_price, status, closed_at, exit_reason, realized_pnl,
       hold_sec, peak_multiple, shadow_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 0.0000001, 1000000000, $8, 0, $9, 1000000, 0.0000002, 0.0000001, $10, $11, $12,
       $13, $14, $15, $16)`,
    [
      spec.id,
      spec.runId,
      spec.mode,
      spec.mint,
      spec.signalType,
      spec.riskScore,
      new Date(spec.openedAtMs),
      spec.cost.toString(),
      closed ? (spec.cost + spec.pnl).toString() : "0",
      closed ? "closed" : "open",
      closedAt,
      closed ? spec.exitReason : null,
      closed ? spec.pnl.toString() : null,
      closed ? spec.holdSec : null,
      closed ? 1.8 : null,
      spec.shadowOf ?? null
    ]
  );
}

async function insertFill(db: Db, spec: FillSpec): Promise<void> {
  await db.query(
    `INSERT INTO fills (position_id, run_id, side, reason, urgency, success, venue, requested_at, requested_slot, filled_at,
       filled_slot, token_amount, quote_amount, user_quote, protocol_fee, creator_fee, lp_fee, extra_platform_fee, network_fees,
       tips, rent_paid, rent_refunded, reference_price, fill_price, slippage_bps, price_impact_bps, attempts)
     VALUES ($1, $2, $3, 'test', 'normal', $4, 'curve', $5, 1, $6, 2, $7, $8, $8, 0, 0, 0, 0, 5000, 0, 0, 0, 0.0000001, NULL,
       NULL, NULL, '[{"atMs":0}]'::jsonb)`,
    [
      spec.positionId,
      spec.runId,
      spec.side,
      spec.success ?? true,
      new Date(spec.atMs),
      spec.success === false ? null : new Date(spec.atMs + 900),
      spec.tokens.toString(),
      spec.userQuote.toString()
    ]
  );
}

async function seedTrading(db: Db, mints: readonly string[]): Promise<{ paperRunId: number; liveRunId: number; backtestRunId: number }> {
  const paperRunId = await insertRun(db, "paper", "paper-oct", NOW_MS - 12 * DAY_MS);
  const liveRunId = await insertRun(db, "live", "live-small", NOW_MS - 5 * DAY_MS);
  const backtestRunId = await insertRun(db, "backtest", "bt-1", NOW_MS - 20 * DAY_MS);
  const riskScores = [5, 15, 25, null];
  for (let index = 0; index < PAPER_TRADES; index += 1) {
    await insertPosition(db, {
      id: `paper-${String(index).padStart(4, "0")}`,
      runId: paperRunId,
      mode: "paper",
      mint: mints[index % mints.length] ?? "",
      signalType: index % 3 === 0 ? "score_momentum" : "smart_convergence",
      riskScore: riskScores[index % riskScores.length] ?? null,
      openedAtMs: NOW_MS - 10 * DAY_MS + index * HOUR_MS,
      holdSec: 30 + (index % 5) * 200,
      cost: SOL / 10n,
      pnl: index % 2 === 0 ? lamports(0.05) : lamports(-0.01),
      exitReason: index % 2 === 0 ? "take_profit" : "stop_loss"
    });
  }
  await insertPosition(db, {
    id: "paper-open",
    runId: paperRunId,
    mode: "paper",
    mint: mints[0] ?? "",
    signalType: "smart_convergence",
    riskScore: 10,
    openedAtMs: NOW_MS - HOUR_MS,
    holdSec: 0,
    cost: SOL / 10n,
    pnl: 0n,
    exitReason: "",
    status: "open"
  });
  for (let index = 0; index < BACKTEST_TRADES; index += 1) {
    await insertPosition(db, {
      id: `bt-${index}`,
      runId: backtestRunId,
      mode: "backtest",
      mint: mints[1] ?? "",
      signalType: "smart_convergence",
      riskScore: 40,
      openedAtMs: NOW_MS - 30 * DAY_MS + index * HOUR_MS,
      holdSec: 100,
      cost: SOL / 10n,
      pnl: lamports(-0.02),
      exitReason: "time_stop"
    });
  }
  for (let index = 0; index < LIVE_PAIRS; index += 1) {
    const openedAtMs = NOW_MS - 4 * DAY_MS + index * HOUR_MS;
    const paperPnl = index % 2 === 0 ? 0.03 : -0.01;
    const liveId = `live-${String(index).padStart(3, "0")}`;
    const shadowId = `shadow-${String(index).padStart(3, "0")}`;
    const mint = mints[index % mints.length] ?? "";
    await insertPosition(db, {
      id: liveId,
      runId: liveRunId,
      mode: "live",
      mint,
      signalType: "smart_convergence",
      riskScore: 20,
      openedAtMs,
      holdSec: 120,
      cost: SOL / 10n,
      pnl: lamports(paperPnl - 0.02 - (index % 3) * 0.001),
      exitReason: "take_profit"
    });
    await insertPosition(db, {
      id: shadowId,
      runId: liveRunId,
      mode: "shadow",
      mint,
      signalType: "smart_convergence",
      riskScore: 20,
      openedAtMs,
      holdSec: 120,
      cost: SOL / 10n,
      pnl: lamports(paperPnl),
      exitReason: "take_profit",
      shadowOf: liveId
    });
    await insertFill(db, { positionId: liveId, runId: liveRunId, side: "buy", atMs: openedAtMs, tokens: 1_000_000n, userQuote: 101_000_000n });
    await insertFill(db, { positionId: liveId, runId: liveRunId, side: "sell", atMs: openedAtMs + 120_000, tokens: 1_000_000n, userQuote: 98_000_000n });
    await insertFill(db, { positionId: shadowId, runId: liveRunId, side: "buy", atMs: openedAtMs, tokens: 1_000_000n, userQuote: 100_000_000n });
    await insertFill(db, { positionId: shadowId, runId: liveRunId, side: "sell", atMs: openedAtMs + 120_000, tokens: 1_000_000n, userQuote: 100_000_000n });
  }
  await insertFill(db, { positionId: "live-000", runId: liveRunId, side: "buy", atMs: NOW_MS - 4 * DAY_MS - 5_000, tokens: 0n, userQuote: 0n, success: false });
  return { paperRunId, liveRunId, backtestRunId };
}

async function insertLaunch(db: Db, mint: string, createdAtMs: number, quoteMint: string, symbol: string): Promise<number> {
  const result = await db.query<{ id: bigint }>(
    `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, name, symbol, quote_mint, create_signature, create_slot,
       created_at, token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token, trade_count, unique_traders)
     VALUES ($1, $1 || 'c', $1 || 'd', $1 || 'd', $2, $3, $4, $1 || 's', 1, $5, 1000000000000000, 1073000000000000, 30000000000,
       793100000000000, 42, 17)
     RETURNING id`,
    [mint, `${symbol} coin`, symbol, quoteMint, new Date(createdAtMs)]
  );
  return Number(result.rows[0]?.id ?? 0);
}

async function insertScore(db: Db, launchId: number, mint: string, checkpointSec: number, createdAtMs: number, score: number, features: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO launch_scores (launch_id, checkpoint_sec, mint, computed_at, slot, score, hard_blocked, flags, features, contributions, weights_version)
     VALUES ($1, $2, $3, $4, 100, $5, $6, $7, $8::jsonb, $9::jsonb, 'w-test')`,
    [
      launchId,
      checkpointSec,
      mint,
      new Date(createdAtMs + checkpointSec * 1_000),
      score,
      score > 90,
      score > 50 ? ["dev_sold", "bundle"] : [],
      JSON.stringify(features),
      JSON.stringify({ dev_share: score / 100, bundle_share: -0.5 })
    ]
  );
}

async function insertOutcome(db: Db, launchId: number, status: string, createdAtMs: number, peak: bigint, known: boolean): Promise<void> {
  await db.query(
    `INSERT INTO launch_outcomes (launch_id, status, migrated, rugged, died, survived_15m, initial_mcap_quote, peak_mcap_quote,
       final_mcap_quote, mcap_1m, outcome_known_at, finalized, time_to_peak_sec, peak_multiple_from_1m)
     VALUES ($1, $2, $2 = 'migrated', $2 = 'rugged', $2 = 'died', $3, 1000, $4, 900, 1100, $5, $6, 300, 2.5)`,
    [launchId, status, status === "migrated" || status === "alive", peak.toString(), known ? new Date(createdAtMs + HOUR_MS) : null, known]
  );
}

const LAUNCH_PLAN: ReadonlyArray<{ ageHours: number; quote: string; status: string; score: number; peak: bigint; known: boolean }> = [
  { ageHours: 72, quote: "SOL", status: "migrated", score: 12, peak: 9000n, known: true },
  { ageHours: 60, quote: "SOL", status: "rugged", score: 82, peak: 1500n, known: true },
  { ageHours: 48, quote: "SOL", status: "died", score: 65, peak: 1200n, known: true },
  { ageHours: 30, quote: "SOL", status: "migrated", score: 25, peak: 6000n, known: true },
  { ageHours: 20, quote: PUMP_QUOTE, status: "rugged", score: 95, peak: 1100n, known: true },
  { ageHours: 5, quote: "SOL", status: "alive", score: 40, peak: 2000n, known: false },
  { ageHours: 2, quote: PUMP_QUOTE, status: "alive", score: 33, peak: 1300n, known: true },
  { ageHours: 0.5, quote: "SOL", status: "none", score: 50, peak: 0n, known: false }
];

async function seedLaunches(db: Db): Promise<{ launchIds: number[]; mints: string[] }> {
  const launchIds: number[] = [];
  const mints: string[] = [];
  for (const [index, plan] of LAUNCH_PLAN.entries()) {
    const mint = mintAt(index);
    const createdAtMs = NOW_MS - plan.ageHours * HOUR_MS;
    const launchId = await insertLaunch(db, mint, createdAtMs, plan.quote, `SYM${index}`);
    launchIds.push(launchId);
    mints.push(mint);
    const features: Record<string, unknown> = { mcap_multiple: 2, dev_share: 0.1, age_sec: 30 };
    if (index === 3) {
      features.z_extra = 1;
    }
    await insertScore(db, launchId, mint, 30, createdAtMs, plan.score - 5, features);
    await insertScore(db, launchId, mint, 60, createdAtMs, plan.score, { ...features, age_sec: 60 });
    if (plan.status !== "none") {
      await insertOutcome(db, launchId, plan.status, createdAtMs, plan.peak, plan.known);
    }
  }
  await db.query(`UPDATE launches SET tracking_ended_at = $1 WHERE id = ANY($2::bigint[])`, [new Date(NOW_MS), launchIds.slice(0, 5)]);
  return { launchIds, mints };
}

async function seedActivity(db: Db, runId: number, launchIds: readonly number[], mints: readonly string[]): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await db.query(
      `INSERT INTO signals (run_id, type, mint, launch_id, at, slot, risk_score, wallets, meta, acted, skip_reason)
       VALUES ($1, 'smart_convergence', $2, $3, $4, 10, $5, $6, '{"windowSec":120}'::jsonb, $7, $8)`,
      [
        runId,
        mints[index],
        launchIds[index],
        new Date(NOW_MS - (3 - index) * HOUR_MS),
        20 + index,
        [walletAt(1), walletAt(2), walletAt(3)],
        index === 2,
        index === 2 ? null : "risk_limit"
      ]
    );
  }
  const older = await db.query<{ id: bigint }>(
    `INSERT INTO wallet_rank_runs (as_of, params, candidates, tracked) VALUES ($1, '{}'::jsonb, 10, 1) RETURNING id`,
    [new Date(NOW_MS - 14 * DAY_MS)]
  );
  const latest = await db.query<{ id: bigint }>(
    `INSERT INTO wallet_rank_runs (as_of, params, candidates, tracked) VALUES ($1, '{}'::jsonb, 50, 3) RETURNING id`,
    [new Date(NOW_MS - DAY_MS)]
  );
  await db.query(`INSERT INTO wallet_ranks (run_id, wallet, rank, score, tracked) VALUES ($1, $2, 1, 0.9, TRUE)`, [
    older.rows[0]?.id.toString(),
    walletAt(9)
  ]);
  const ranks: Array<[number, number | null, number, boolean]> = [
    [3, 2, 0.7, true],
    [1, 1, 0.95, true],
    [4, null, 0.2, false],
    [2, 3, 0.5, true]
  ];
  for (const [wallet, rank, score, tracked] of ranks) {
    await db.query(
      `INSERT INTO wallet_ranks (run_id, wallet, rank, score, tracked, pnl_30d, pnl_90d, trades_30d, trades_90d, win_rate_30d,
         win_rate_90d, median_hold_sec)
       VALUES ($1, $2, $3, $4, $5, 1.5, 4.2, 30, 80, 0.55, 0.52, 240)`,
      [latest.rows[0]?.id.toString(), walletAt(wallet), rank, score, tracked]
    );
  }
  await db.query(
    `INSERT INTO ingest_gaps (source, from_slot, to_slot, started_at, ended_at, reason, affected_launches)
     VALUES ('ws', 10, 20, $1, $2, 'reconnect', 3), ('ws', 1, 2, $3, $4, 'reconnect', NULL)`,
    [new Date(NOW_MS - 2 * HOUR_MS), new Date(NOW_MS - 2 * HOUR_MS + 60_000), new Date(NOW_MS - 3 * DAY_MS), new Date(NOW_MS - 3 * DAY_MS + 5_000)]
  );
  for (let index = 0; index < 5; index += 1) {
    await db.query(
      `INSERT INTO trades (launch_id, block_time, slot, seq, signature, event_index, venue, wallet, is_buy, token_amount,
         quote_amount, user_quote, virtual_token, virtual_quote)
       VALUES ($1, $2, 1, 0, $3, 0, 0, $4, TRUE, 1000, 1000, 1000, 1073000000000000, 30000000000)`,
      [launchIds[7], new Date(NOW_MS - 30_000 - index * 600_000), `sig-${index}`, walletAt(index)]
    );
  }
}

export async function seedAnalytics(db: Db): Promise<SeededData> {
  const { launchIds, mints } = await seedLaunches(db);
  const runs = await seedTrading(db, mints);
  await seedActivity(db, runs.liveRunId, launchIds, mints);
  return { ...runs, launchIds, mints };
}
