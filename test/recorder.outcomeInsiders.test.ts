import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyReplayEvent, LAUNCH_SELECT, launchEventFromRow, replayEventOf, TRADE_SELECT, tradeEventFromRow } from "../src/backtest/loader.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import { MarketState } from "../src/market/state.js";
import { LaunchRegistry, OutcomeFinalizer, recomputeOutcomes } from "../src/recorder/index.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { BASE_MS, insertLaunches } from "./tracker.db.js";

const T = BASE_MS;
const S = 300_000_000;
const VT0 = 1_073_000_000_000_000;
const VQ0 = 30_000_000_000;
const DEV = "OutcomeDevWallet";
const CLUSTER_A = "FundingClusterA";
const CLUSTER_B = "FundingClusterB";
const MINT = "ClusterDumpMint";

function reservesAt(multiple: number): [bigint, bigint] {
  const root = Math.sqrt(multiple);
  return [BigInt(Math.round(VT0 / root)), BigInt(Math.round(VQ0 * root))];
}

const STEPS = [
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

describe.skipIf(!hasTestDatabase)("outcome labels and stored scorer insiders", () => {
  let database: TestDatabase;
  let launchId = 0;

  beforeAll(async () => {
    database = await createTestDatabase("outcome_insiders");
    launchId = (await insertLaunches(database.db, [{ mint: MINT, createdAtMs: T, createSlot: S, dev: DEV }])).get(MINT) ?? 0;
    for (const [index, step] of STEPS.entries()) {
      const [vt, vq] = reservesAt(step.multiple);
      await database.db.query(
        `INSERT INTO trades (launch_id, block_time, slot, seq, signature, event_index, venue, wallet, is_buy, token_amount,
                             quote_amount, user_quote, virtual_token, virtual_quote)
         VALUES ($1, $2, $3, 0, $4, 0, 0, $5, $6, $7, 1000000, 1000000, $8, $9)`,
        [launchId, new Date(T + step.sec * 1000), step.slot, `OutcomeSig${index}`, step.wallet, step.isBuy, step.tokens.toString(), vt.toString(), vq.toString()]
      );
    }
    for (const [checkpointSec, insiders] of [
      [30, [DEV, CLUSTER_A]],
      [60, [DEV, CLUSTER_B]]
    ] as const) {
      await database.db.query(
        `INSERT INTO launch_scores (launch_id, checkpoint_sec, mint, computed_at, slot, score, features, contributions, weights_version, insiders)
         VALUES ($1, $2, $3, $4, $5, 80, '{}', '{}', 'hand-v1', $6)`,
        [launchId, checkpointSec, MINT, new Date(T + (checkpointSec + 1) * 1000), S + 80, insiders]
      );
    }
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("labels a cluster dump the same from memory and from the database using the union of stored insiders", async () => {
    const nowMs = T + 2 * 3_600_000;
    const config = defaultStrategyConfig();
    const clock = new VirtualClock(nowMs);
    const market = new MarketState({ maxTradesPerLaunch: 25_000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    const launchRow = (await database.db.query(`SELECT ${LAUNCH_SELECT} FROM launches WHERE id = $1`, [launchId])).rows[0] as Record<string, unknown>;
    applyReplayEvent(market, replayEventOf(launchEventFromRow(launchRow), launchId));
    const trades = await database.db.query(`SELECT ${TRADE_SELECT} FROM trades t JOIN launches l ON l.id = t.launch_id WHERE t.launch_id = $1 ORDER BY t.slot`, [
      launchId
    ]);
    for (const row of trades.rows as Array<Record<string, unknown>>) {
      applyReplayEvent(market, replayEventOf(tradeEventFromRow(row), launchId));
    }
    expect(market.get(MINT)?.insiders.size).toBe(0);
    const registry = new LaunchRegistry({ db: database.db });
    await registry.load();
    const finalizer = new OutcomeFinalizer({
      db: database.db,
      clock,
      market,
      registry,
      config: config.recorder,
      bundleSlotWindow: config.scorer.bundleSlotWindow
    });
    expect(await finalizer.tick()).toMatchObject({ computed: 1 });
    expect(finalizer.stats()).toMatchObject({ fromMemory: 1, fromDatabase: 0 });
    const status = async (): Promise<string | undefined> =>
      (await database.db.query<{ status: string }>("SELECT status FROM launch_outcomes WHERE launch_id = $1", [launchId])).rows[0]?.status;
    expect(await status()).toBe("rugged");
    await recomputeOutcomes(database.db, { from: new Date(T - 60_000), to: new Date(T + 60_000), config, nowMs });
    expect(await status()).toBe("rugged");
  });
});
