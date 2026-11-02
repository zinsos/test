import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VirtualClock } from "../src/core/clock.js";
import { RiskManager } from "../src/risk/manager.js";
import { RiskStateDbWriter, insertRiskEvents, loadRiskState, saveRiskStateRow } from "../src/risk/persistence.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { NOON_UTC, SOL, closedTrade, entry, riskConfig } from "./risk.fixtures.js";

const DEV = "DevP111111111111111111111111111111111111111";

describe.skipIf(!hasTestDatabase)("risk persistence with postgres", () => {
  let database: TestDatabase;

  async function createRun(): Promise<number> {
    const result = await database.db.query<{ id: bigint }>(
      "INSERT INTO strategy_runs (mode, config) VALUES ('paper', '{}') RETURNING id"
    );
    return Number(result.rows[0]?.id);
  }

  beforeAll(async () => {
    database = await createTestDatabase("risk_state");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("returns null for a run without state", async () => {
    expect(await loadRiskState(database.db, await createRun())).toBeNull();
  });

  it("round trips the manager state through risk_state and records events", async () => {
    const runId = await createRun();
    const writer = new RiskStateDbWriter({ db: database.db });
    const clock = new VirtualClock(NOON_UTC);
    const risk = new RiskManager({ runId, config: riskConfig(), clock, store: writer });
    expect(risk.evaluateEntry(entry("MintA", DEV, NOON_UTC)).allowed).toBe(true);
    risk.onPositionClosed(closedTrade("p1", "MintA", -450_000_000n, NOON_UTC + 1000));
    risk.markToMarket(0n, NOON_UTC + 2000);
    await writer.flush();
    expect(writer.stats()).toEqual({ queuedEvents: 0, statePending: false, droppedEvents: 0 });
    const persisted = await loadRiskState(database.db, runId);
    expect(persisted).toMatchObject({
      runId,
      startingBankrollLamports: 5n * SOL,
      realizedPnlLamports: -450_000_000n,
      peakEquityLamports: 5n * SOL,
      dayKey: "2026-10-23",
      dayStartEquityLamports: 5n * SOL,
      haltedUntilMs: Date.UTC(2026, 9, 24),
      killed: false,
      killReason: null
    });
    expect(persisted?.state).toMatchObject({ devEntries: { [DEV]: 1 }, unrealizedPnlLamports: "0" });
    const restored = new RiskManager({ runId, config: riskConfig(), clock: new VirtualClock(NOON_UTC + 5000), persisted });
    expect(restored.status()).toEqual(risk.status());
    expect(restored.evaluateEntry(entry("MintB", "Other", NOON_UTC + 5000)).reason).toBe("halted_daily_loss");
    const events = await database.db.query<{ kind: string; at: Date; detail: Record<string, unknown> }>(
      "SELECT kind, at, detail FROM risk_events WHERE run_id = $1 ORDER BY id",
      [runId]
    );
    expect(events.rows.map((row) => row.kind)).toEqual(["entry_reserved", "position_closed", "daily_loss_halt"]);
    expect(events.rows[0]?.at.getTime()).toBe(NOON_UTC);
    expect(events.rows[1]?.detail.pnlLamports).toBe("-450000000");
  });

  it("upserts the latest state for a run", async () => {
    const runId = await createRun();
    const base = {
      runId,
      startingBankrollLamports: 5n * SOL,
      realizedPnlLamports: 0n,
      peakEquityLamports: 5n * SOL,
      dayKey: "2026-10-23",
      dayStartEquityLamports: 5n * SOL,
      haltedUntilMs: null,
      killed: false,
      killReason: null,
      state: { note: "first" }
    };
    await saveRiskStateRow(database.db, base);
    await saveRiskStateRow(database.db, { ...base, realizedPnlLamports: -2n * SOL, killed: true, killReason: "drawdown", state: { note: "second" } });
    const loaded = await loadRiskState(database.db, runId);
    expect(loaded).toEqual({ ...base, realizedPnlLamports: -2n * SOL, killed: true, killReason: "drawdown", state: { note: "second" } });
    const count = await database.db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM risk_state WHERE run_id = $1", [runId]);
    expect(count.rows[0]?.count).toBe(1);
  });

  it("keeps queued writes after a failure and retries on flush", async () => {
    const runId = await createRun();
    let failNext = true;
    const flaky = {
      query: async (sql: string, params?: unknown[]) => {
        if (failNext) {
          failNext = false;
          throw new Error("connection reset");
        }
        return database.db.query(sql, params);
      }
    };
    const writer = new RiskStateDbWriter({ db: flaky as unknown as typeof database.db });
    writer.recordRiskEvent(runId, NOON_UTC, "kill_switch", { reason: "test" });
    await writer.flush();
    expect(writer.stats().queuedEvents).toBe(0);
    const events = await database.db.query<{ kind: string }>("SELECT kind FROM risk_events WHERE run_id = $1", [runId]);
    expect(events.rows.map((row) => row.kind)).toEqual(["kill_switch"]);
  });

  it("bounds the event queue", () => {
    const writer = new RiskStateDbWriter({ db: { query: () => new Promise(() => undefined) } as never, maxQueuedEvents: 3 });
    for (let index = 0; index < 10; index += 1) {
      writer.recordRiskEvent(1, index, "k", {});
    }
    expect(writer.stats().queuedEvents).toBeLessThanOrEqual(3);
    expect(writer.stats().droppedEvents).toBeGreaterThan(0);
  });

  it("inserts nothing for an empty event batch", async () => {
    await expect(insertRiskEvents(database.db, [])).resolves.toBeUndefined();
  });
});
