import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyReplayEvent, LAUNCH_SELECT, launchEventFromRow, replayEventOf, TRADE_SELECT, tradeEventFromRow } from "../../src/backtest/loader.js";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { MarketState } from "../../src/market/state.js";
import { computeOutcome, loadOutcomeSubjects, outcomeParamsFrom, subjectFromLaunchState } from "../../src/recorder/outcomes.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";
import { BASE_MS, insertLaunches } from "../tracker.db.js";

const T = BASE_MS;
const S = 300_000_000;
const VT0 = 1_073_000_000_000_000;
const VQ0 = 30_000_000_000;
const DEV = "OutcomeDevWallet";
const CLUSTER_A = "FundingClusterA";
const CLUSTER_B = "FundingClusterB";
const config = defaultStrategyConfig();
const params = outcomeParamsFrom(config.recorder, config.scorer.bundleSlotWindow);

function reservesAt(multiple: number): [bigint, bigint] {
  const root = Math.sqrt(multiple);
  return [BigInt(Math.round(VT0 / root)), BigInt(Math.round(VQ0 * root))];
}

interface Step {
  sec: number;
  slot: number;
  wallet: string;
  isBuy: boolean;
  tokens: bigint;
  multiple: number;
}

const steps: Step[] = [
  { sec: 0, slot: S, wallet: DEV, isBuy: true, tokens: 50_000_000n, multiple: 1.1 },
  { sec: 20, slot: S + 50, wallet: CLUSTER_A, isBuy: true, tokens: 300_000_000n, multiple: 2 },
  { sec: 40, slot: S + 100, wallet: CLUSTER_B, isBuy: true, tokens: 300_000_000n, multiple: 3 },
  { sec: 70, slot: S + 175, wallet: "Retail1", isBuy: true, tokens: 20_000_000n, multiple: 3.5 },
  { sec: 100, slot: S + 250, wallet: "Retail2", isBuy: true, tokens: 20_000_000n, multiple: 4 },
  { sec: 180, slot: S + 450, wallet: CLUSTER_A, isBuy: false, tokens: 300_000_000n, multiple: 2 },
  { sec: 181, slot: S + 452, wallet: CLUSTER_B, isBuy: false, tokens: 300_000_000n, multiple: 0.8 },
  { sec: 300, slot: S + 750, wallet: "Retail3", isBuy: true, tokens: 1_000_000n, multiple: 0.85 },
  { sec: 400, slot: S + 1000, wallet: "Retail4", isBuy: false, tokens: 1_000_000n, multiple: 0.82 }
];

describe.skipIf(!hasTestDatabase)("review: outcome labels from memory and from the database", () => {
  let database: TestDatabase;
  let launchId = 0;

  beforeAll(async () => {
    database = await createTestDatabase("review_outcome");
    const ids = await insertLaunches(database.db, [{ mint: "ClusterDumpMint", createdAtMs: T, createSlot: S, dev: DEV }]);
    launchId = ids.get("ClusterDumpMint") ?? 0;
    for (const [index, step] of steps.entries()) {
      const [vt, vq] = reservesAt(step.multiple);
      await database.db.query(
        `INSERT INTO trades (launch_id, block_time, slot, seq, signature, event_index, venue, wallet, is_buy, token_amount,
                             quote_amount, user_quote, virtual_token, virtual_quote)
         VALUES ($1, $2, $3, 0, $4, 0, 0, $5, $6, $7, 1000000, 1000000, $8, $9)`,
        [launchId, new Date(T + step.sec * 1000), step.slot, `OutcomeSig${index}`, step.wallet, step.isBuy, step.tokens.toString(), vt.toString(), vq.toString()]
      );
    }
    await database.db.query(
      `INSERT INTO launch_scores (launch_id, checkpoint_sec, mint, computed_at, slot, score, features, contributions, weights_version, insiders)
       VALUES ($1, 30, 'ClusterDumpMint', $2, $3, 80, '{}', '{}', 'hand-v1', $4)`,
      [launchId, new Date(T + 31_000), S + 80, [DEV, CLUSTER_A, CLUSTER_B]]
    );
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("labels the same launch the same way whether the finalizer reads it from memory or recompute-outcomes reads the database", async () => {
    const nowMs = T + 2 * 3_600_000;
    const market = new MarketState({ maxTradesPerLaunch: 25_000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    const launchRow = (await database.db.query(`SELECT ${LAUNCH_SELECT} FROM launches WHERE id = $1`, [launchId])).rows[0] as Record<string, unknown>;
    applyReplayEvent(market, replayEventOf(launchEventFromRow(launchRow), launchId));
    const trades = await database.db.query(
      `SELECT ${TRADE_SELECT} FROM trades t JOIN launches l ON l.id = t.launch_id WHERE t.launch_id = $1 ORDER BY t.slot`,
      [launchId]
    );
    for (const row of trades.rows as Array<Record<string, unknown>>) {
      applyReplayEvent(market, replayEventOf(tradeEventFromRow(row), launchId));
    }
    const launch = market.get("ClusterDumpMint");
    expect(launch).toBeDefined();
    if (!launch) {
      return;
    }
    for (const wallet of [DEV, CLUSTER_A, CLUSTER_B]) {
      launch.insiders.add(wallet);
    }
    const fromMemory = computeOutcome({ ...subjectFromLaunchState(launchId, launch), nowMs, params });
    const loaded = (await loadOutcomeSubjects(database.db, [launchId], 48)).get(launchId);
    expect(loaded).toBeDefined();
    if (!loaded) {
      return;
    }
    const fromDatabase = computeOutcome({ launch: loaded.launch, trades: loaded.trades, nowMs, params });
    expect(fromMemory.status).toBe("rugged");
    expect(fromDatabase.status).toBe(fromMemory.status);
  });
});
