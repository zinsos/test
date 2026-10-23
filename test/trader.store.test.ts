import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadClosedTrades } from "../src/analytics/index.js";
import type { OrderRequest, Position, Signal } from "../src/core/types.js";
import { failedFill } from "../src/execution/fill.js";
import { VirtualClock } from "../src/core/clock.js";
import { RiskManager } from "../src/risk/manager.js";
import { loadRiskState } from "../src/risk/persistence.js";
import { closePosition } from "../src/trader/accounting.js";
import { withNextFillSeq } from "../src/trader/ids.js";
import {
  findOpenRun,
  killResetRequestsAfter,
  latestKillResetRequestId,
  loadOpenPositions,
  requestKillReset,
  resumeOrCreateRun
} from "../src/trader/runs.js";
import { PgTradingStore } from "../src/trader/store.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { seedLaunch } from "./backtest.seed.js";
import { strategy, T0 } from "./trader.fixtures.js";

function signal(mint: string, atMs: number): Signal {
  return { id: null, type: "smart_convergence", mint, atMs, slot: 100, riskScore: 12.5, wallets: ["W1", "W2"], meta: { windowSec: 120 } };
}

function buyOrder(reason: string): OrderRequest {
  return {
    side: "buy",
    mint: "MintStore1111111111111111111111111111111111",
    quoteBudget: 1n,
    tokenAmount: null,
    maxSlippageBps: 100,
    reason,
    urgency: "normal",
    signalSlot: 1,
    signalAtMs: T0,
    referencePrice: 1,
    positionId: "k",
    closesPosition: false
  };
}

function position(runId: number, id: string, overrides: Partial<Position> = {}): Position {
  return {
    id,
    runId,
    mode: "paper",
    mint: "MintStore1111111111111111111111111111111111",
    launchId: null,
    signalId: null,
    signalType: "smart_convergence",
    riskScore: 12.5,
    openedAtMs: T0,
    openedSlot: 100,
    entryPrice: 3e-5,
    entryTokens: 1_000_000n,
    entryCost: 100_000_000n,
    tokensHeld: 1_000_000n,
    proceeds: 0n,
    feesPaid: 1_000n,
    peakPrice: 3e-5,
    lastPrice: 3e-5,
    takeProfitLevelsHit: 0,
    migratedSeen: false,
    status: "open",
    closedAtMs: null,
    exitReason: null,
    shadowOf: null,
    meta: { orderKey: "k", exit: { liquidating: { targetTokens: 5n } } },
    ...overrides
  };
}

describe.skipIf(!hasTestDatabase)("PgTradingStore", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("trader_store");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("writes runs, signals, positions, fills and risk rows idempotently", async () => {
    const db = database.db;
    const store = new PgTradingStore({ db, signalIdBlock: 4 });
    await store.prepare();
    const runId = await store.createRun({ mode: "paper", label: "store-test", config: { a: 1n }, dataFrom: null, dataTo: null });
    const ids: Array<number | null> = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(await store.recordSignal(runId, { signal: signal(`Mint${index}`, T0 + index), acted: index === 0, skipReason: index === 0 ? null : "cooldown", launchId: null }));
    }
    expect(ids[0]).not.toBeNull();
    let open = withNextFillSeq(position(runId, `${runId}-a`, { signalId: ids[0] ?? null }));
    store.savePosition(open);
    const entryOrder = buyOrder("smart_convergence");
    store.recordFill(
      open,
      entryOrder,
      failedFill(entryOrder, "tx_failed", [{ atMs: T0, slot: 1, success: false, error: "tx_failed", networkFee: 305_000n, tip: 0n }], "curve")
    );
    open = { ...open, lastPrice: 4e-5, peakPrice: 4e-5 };
    store.savePosition(open);
    const closed = closePosition({ ...open, tokensHeld: 0n, proceeds: 150_000_000n }, T0 + 60_000, "take_profit");
    store.savePosition(closed);
    store.recordRiskEvent(runId, T0, "entry_reserved", { mint: open.mint, size: 5n });
    const risk = new RiskManager({ runId, config: strategy().risk, clock: new VirtualClock(T0), store });
    risk.persist(T0);
    await store.flush();
    store.savePosition(open);
    await store.flush();
    await store.flush();

    const positions = await db.query<{ status: string; realized_pnl: bigint; hold_sec: number; peak_multiple: number; signal_id: bigint; meta: Record<string, unknown> }>(
      "SELECT status, realized_pnl, hold_sec, peak_multiple, signal_id, meta FROM positions WHERE run_id = $1",
      [runId]
    );
    expect(positions.rows).toHaveLength(1);
    expect(positions.rows[0]?.status).toBe("closed");
    expect(positions.rows[0]?.realized_pnl).toBe(50_000_000n);
    expect(positions.rows[0]?.hold_sec).toBe(60);
    expect(positions.rows[0]?.peak_multiple).toBeCloseTo(4 / 3, 9);
    expect(Number(positions.rows[0]?.signal_id)).toBe(ids[0]);
    expect((positions.rows[0]?.meta.exit as { liquidating: { targetTokens: string } }).liquidating.targetTokens).toBe("5");

    const duplicateOrder = buyOrder("dup");
    store.recordFill(open, duplicateOrder, failedFill(duplicateOrder, "tx_failed", [], "curve"));
    await store.flush();
    const fills = await db.query<{ count: number; fill_seq: number; network_fees: bigint }>(
      "SELECT count(*) OVER ()::int AS count, fill_seq, network_fees FROM fills WHERE run_id = $1",
      [runId]
    );
    expect(fills.rows).toHaveLength(1);
    expect(fills.rows[0]?.fill_seq).toBe(0);
    expect(fills.rows[0]?.network_fees).toBe(305_000n);

    const signals = await db.query<{ id: bigint; acted: boolean; skip_reason: string | null; wallets: string[] }>(
      "SELECT id, acted, skip_reason, wallets FROM signals WHERE run_id = $1 ORDER BY at",
      [runId]
    );
    expect(signals.rows).toHaveLength(6);
    expect(signals.rows[0]?.acted).toBe(true);
    expect(signals.rows[1]?.skip_reason).toBe("cooldown");
    expect(signals.rows[0]?.wallets).toEqual(["W1", "W2"]);
    const persisted = await loadRiskState(db, runId);
    expect(persisted?.startingBankrollLamports).toBe(5_000_000_000n * 2n);
    const events = await db.query("SELECT kind FROM risk_events WHERE run_id = $1", [runId]);
    expect(events.rowCount).toBe(1);

    const trades = await loadClosedTrades(db, { runId });
    expect(trades).toHaveLength(1);
    expect(trades[0]?.pnl).toBe(50_000_000n);
    expect(trades[0]?.exitReason).toBe("take_profit");

    await store.finishRun(runId, { verdict: "test", big: 7n });
    const run = await db.query<{ ended_at: Date | null; summary: { big: string } }>("SELECT ended_at, summary FROM strategy_runs WHERE id = $1", [runId]);
    expect(run.rows[0]?.ended_at).not.toBeNull();
    expect(run.rows[0]?.summary.big).toBe("7");
    expect(store.stats().writeErrors).toBe(0);
    await store.stop();
  });

  it("fills in launch ids from the launches table when the trader did not record the launch", async () => {
    const db = database.db;
    const launchId = await seedLaunch(db, { mint: "MintKnownLaunch", dev: "DevKnown", createdAtMs: T0, slot: 10, trades: [] });
    const store = new PgTradingStore({ db });
    const runId = await store.createRun({ mode: "paper", label: null, config: {}, dataFrom: null, dataTo: null });
    store.savePosition(position(runId, `${runId}-known`, { mint: "MintKnownLaunch", launchId: null }));
    store.savePosition(position(runId, `${runId}-unknown`, { mint: "MintNeverRecorded", launchId: null }));
    await store.recordSignal(runId, { signal: signal("MintKnownLaunch", T0), acted: false, skipReason: "cooldown", launchId: null });
    await store.flush();
    const positions = await db.query<{ mint: string; launch_id: string | null }>(
      "SELECT mint, launch_id FROM positions WHERE run_id = $1 ORDER BY mint",
      [runId]
    );
    expect(positions.rows.map((row) => [row.mint, row.launch_id === null ? null : Number(row.launch_id)])).toEqual([
      ["MintKnownLaunch", launchId],
      ["MintNeverRecorded", null]
    ]);
    const signals = await db.query<{ launch_id: string | null }>("SELECT launch_id FROM signals WHERE run_id = $1", [runId]);
    expect(Number(signals.rows[0]?.launch_id)).toBe(launchId);
    await store.stop();
  });

  it("resumes the open run of a mode and restores its open positions", async () => {
    const db = database.db;
    const store = new PgTradingStore({ db });
    const first = await resumeOrCreateRun(db, store, { mode: "live", label: null, config: {} });
    expect(first.resumed).toBe(false);
    const again = await resumeOrCreateRun(db, store, { mode: "live", label: null, config: {} });
    expect(again).toEqual({ runId: first.runId, resumed: true, configChanged: false });
    const changed = await resumeOrCreateRun(db, store, { mode: "live", label: null, config: { risk: { maxConcurrent: 2 } } });
    expect(changed).toEqual({ runId: first.runId, resumed: true, configChanged: true });
    expect((await findOpenRun(db, "live"))?.runId).toBe(first.runId);
    const live = position(first.runId, `${first.runId}-live`, { mode: "live", entryCost: 123n });
    const shadow = position(first.runId, `${first.runId}-live-shadow`, { mode: "shadow", shadowOf: live.id });
    const done = closePosition(position(first.runId, `${first.runId}-done`, { mode: "live" }), T0 + 1, "stop_loss");
    store.savePosition(live);
    store.savePosition(shadow);
    store.savePosition(done);
    await store.flush();
    const restored = await loadOpenPositions(db, first.runId);
    expect(restored.map((entry) => entry.id).sort()).toEqual([live.id, shadow.id].sort());
    const restoredLive = restored.find((entry) => entry.id === live.id);
    expect(restoredLive?.entryCost).toBe(123n);
    expect(restoredLive?.tokensHeld).toBe(1_000_000n);
    expect(restoredLive?.meta.orderKey).toBe("k");
    expect(restored.find((entry) => entry.id === shadow.id)?.shadowOf).toBe(live.id);

    const before = await latestKillResetRequestId(db, first.runId);
    const requestId = await requestKillReset(db, first.runId, "operator");
    expect(requestId).toBeGreaterThan(before);
    expect(await killResetRequestsAfter(db, first.runId, before)).toEqual([{ id: requestId, reason: "operator" }]);
    expect(await killResetRequestsAfter(db, first.runId, requestId)).toEqual([]);
    await store.stop();
  });
});
