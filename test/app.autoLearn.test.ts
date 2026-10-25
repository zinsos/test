import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AutoLearnApplier, autoLearnRepeater, MAX_APPLY_ATTEMPTS, resolveStrategyPath, type AutoLearnTrading } from "../src/app/autoLearn.js";
import { CARRY_ENDED_BY, carryOf, parseCarry, seedCarriedRisk } from "../src/app/carry.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_RESTART } from "../src/app/commandContext.js";
import { exitCodeFor } from "../src/app/commands/start.js";
import { autoLearnFor } from "../src/app/live.js";
import { parseStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import type { RiskStatus } from "../src/core/contracts.js";
import { VirtualClock } from "../src/core/clock.js";
import type { Position } from "../src/core/types.js";
import type { Db, DbClient } from "../src/db/pool.js";
import { overridesHash, strategyHash } from "../src/lab/identity.js";
import { fileSettings, loadLearnedSettings, type LearnedSettings } from "../src/lab/learned.js";
import { loadPendingPromotion, loadPromotion, recentPromotions } from "../src/lab/promotions.js";
import { applyOverrides } from "../src/lab/variants.js";
import { RiskManager } from "../src/risk/manager.js";
import { loadRiskState } from "../src/risk/persistence.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
const HOUR_MS = 3_600_000;
const STRICT = { signals: { scoreMomentum: { maxRiskScore: 25 } } };
const FAST = { exits: { timeStop: { afterSec: 120 } } };
const FILE = {
  signals: { enabled: ["score_momentum"], scoreMomentum: { maxRiskScore: 35, minUniqueBuyersPerMin: 15 } },
  risk: { startingBankrollSol: 0.482, fractionPerTrade: 0.1, maxConcurrent: 2, dailyLossLimitFraction: 0.15, killSwitchDrawdownFraction: 0.3 },
  lab: { autoLearn: { enabled: true } }
};

interface FakeState {
  running: boolean;
  busy: boolean;
  inFlight: number;
  open: Position[];
  halts: number;
  killed: boolean;
  haltedForDay: boolean;
  equity: bigint;
  peak: bigint;
  dayStart: bigint;
}

function fakeTrading(runId: number, mode: "paper" | "live" = "paper"): { state: FakeState; trading: AutoLearnTrading } {
  const state: FakeState = {
    running: true,
    busy: false,
    inFlight: 0,
    open: [],
    halts: 0,
    killed: false,
    haltedForDay: false,
    equity: 510_123_456n,
    peak: 600_000_000n,
    dayStart: 530_000_000n
  };
  const status = (): RiskStatus => ({
    runId,
    bankrollLamports: state.equity,
    equityLamports: state.equity,
    peakEquityLamports: state.peak,
    realizedPnlLamports: state.equity - 482_000_000n,
    unrealizedPnlLamports: 0n,
    dayKey: "2026-10-24",
    dayStartEquityLamports: state.dayStart,
    dayPnlLamports: state.equity - state.dayStart,
    haltedForDay: state.haltedForDay,
    killed: state.killed,
    killReason: state.killed ? "drawdown" : null
  });
  return {
    state,
    trading: {
      mode,
      runId,
      trader: {
        isRunning: () => state.running,
        isBusy: () => state.busy,
        inFlightCount: () => state.inFlight,
        openPositions: () => state.open,
        halt: () => {
          state.halts += 1;
          state.running = false;
        }
      },
      risk: { status }
    }
  };
}

async function insertPromotion(
  db: Db,
  input: { name?: string; overrides?: Record<string, unknown>; baselineHash: string; status?: string; appliedAtMs?: number | null; kind?: string; targetId?: number | null }
): Promise<number> {
  const overrides = input.overrides ?? STRICT;
  const status = input.status ?? "pending";
  const applied = status === "applied" || status === "reverted";
  const result = await db.query<{ id: string }>(
    `INSERT INTO promotions (kind, name, overrides, overrides_hash, baseline_hash, evidence, status, target_id, created_at, updated_at, applied_at,
                             root_hash, overlay, applied_hash)
     VALUES ($1, $2, $3, $4, $5, '{"reason":"test"}', $6, $7, $8, $8, $9, $10, $11, $12) RETURNING id::text AS id`,
    [
      input.kind ?? "variant",
      input.name ?? "momentum-strict",
      JSON.stringify(overrides),
      overridesHash(overrides),
      input.baselineHash,
      status,
      input.targetId ?? null,
      new Date(NOW_MS - 2 * HOUR_MS),
      applied ? new Date(input.appliedAtMs ?? NOW_MS - 2 * HOUR_MS) : null,
      applied ? "root-elsewhere" : null,
      applied ? "{}" : null,
      applied ? "after-elsewhere" : null
    ]
  );
  return Number(result.rows[0]?.id);
}

async function openPaperRun(db: Db, config: StrategyConfig): Promise<number> {
  const result = await db.query<{ id: string }>("INSERT INTO strategy_runs (mode, label, started_at, config) VALUES ('paper', NULL, $1, $2) RETURNING id::text AS id", [
    new Date(NOW_MS - 10 * HOUR_MS),
    JSON.stringify(config)
  ]);
  return Number(result.rows[0]?.id);
}

function failingDb(db: Db, failWhen: (sql: string) => boolean): Db {
  const wrapped = { query: db.query.bind(db) } as unknown as Db;
  wrapped.connect = async () => {
    const client = await db.connect();
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    const proxy = Object.create(client) as DbClient;
    (proxy as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) =>
      typeof args[0] === "string" && failWhen(args[0]) ? Promise.reject(new Error("disk full")) : query(...args);
    proxy.release = () => client.release();
    return proxy;
  };
  return wrapped;
}

describe.skipIf(!hasTestDatabase)("auto-learn apply path", () => {
  let database: TestDatabase;
  let dir = "";
  let file = "";
  let fileText = "";
  let config: StrategyConfig;
  let hash = "";
  let restarts = 0;
  let clock: VirtualClock;
  let runId = 0;

  const applierFor = (overrides: Partial<ConstructorParameters<typeof AutoLearnApplier>[0]> = {}, trading = fakeTrading(runId)) => ({
    trading,
    applier: new AutoLearnApplier({
      db: database.db,
      clock,
      config,
      learned: fileSettings(config),
      strategyPath: file,
      trading: trading.trading,
      restart: () => {
        restarts += 1;
      },
      ...overrides
    })
  });

  beforeAll(async () => {
    database = await createTestDatabase("app_auto_learn");
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "snypra-auto-learn-"));
    file = path.join(dir, "strategy.json");
    fileText = `${JSON.stringify(FILE, null, 2)}\n`;
    writeFileSync(file, fileText);
    config = parseStrategyConfig(FILE);
    hash = strategyHash(config);
    restarts = 0;
    clock = new VirtualClock(NOW_MS);
    runId = await openPaperRun(database.db, config);
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await database.db.query("DELETE FROM promotions");
    await database.db.query("DELETE FROM risk_state");
    await database.db.query("DELETE FROM strategy_runs");
  });

  it("applies a confirmed paper promotion once: the change goes to the database, never into the strategy file, the run ends with a carry and the service restarts once", async () => {
    const id = await insertPromotion(database.db, { baselineHash: hash });
    const { applier, trading } = applierFor();
    const outcome = await applier.tick();
    expect(outcome).toMatchObject({ outcome: "applied", promotionId: id });
    expect(readFileSync(file, "utf8")).toBe(fileText);
    expect(trading.state.halts).toBe(1);
    expect(restarts).toBe(1);
    const row = await loadPromotion(database.db, id);
    const expected = applyOverrides(config, STRICT);
    expect(row).toMatchObject({
      status: "applied",
      appliedAtMs: NOW_MS,
      rootHash: hash,
      previousOverlay: {},
      overlay: STRICT,
      appliedHash: strategyHash(expected),
      undo: { signals: { scoreMomentum: { maxRiskScore: 35 } } },
      applyAttempts: 1
    });
    expect(row?.note).toBe(`applied momentum-strict; paper run #${runId} ended and the next run continues its bankroll, peak and day`);
    const run = await database.db.query<{ ended_at: Date | null; summary: unknown }>("SELECT ended_at, summary FROM strategy_runs WHERE id = $1", [runId]);
    expect(run.rows[0]?.ended_at?.getTime()).toBe(NOW_MS);
    expect(parseCarry(run.rows[0]?.summary)).toEqual({
      fromRunId: runId,
      ledgerLamports: "510123456",
      peakEquityLamports: "600000000",
      dayKey: "2026-10-24",
      dayStartEquityLamports: "530000000",
      fileBankrollSol: 0.482,
      atMs: NOW_MS
    });
    expect(await applier.tick()).toMatchObject({ outcome: "restart_pending" });
    await clock.advanceTo(NOW_MS + HOUR_MS);
    expect(restarts).toBe(1);

    const paper = await loadLearnedSettings(database.db, config, "paper");
    expect(paper).toMatchObject({ rootHash: hash, settingsHash: strategyHash(expected), eventId: id, eventName: "momentum-strict", changes: ["signals.scoreMomentum.maxRiskScore"], problem: null });
    expect(paper.config.signals.scoreMomentum.maxRiskScore).toBe(25);
    expect(paper.config.risk).toEqual(config.risk);
    const live = await loadLearnedSettings(database.db, config, "live");
    expect(live.config).toBe(config);
    expect(live.changes).toEqual([]);
    const off = structuredClone(config);
    off.lab.autoLearn.enabled = false;
    expect((await loadLearnedSettings(database.db, off, "paper")).config.signals.scoreMomentum.maxRiskScore).toBe(35);
    const edited = parseStrategyConfig({ ...FILE, signals: { ...FILE.signals, scoreMomentum: { ...FILE.signals.scoreMomentum, minMcapSol: 30 } } });
    expect((await loadLearnedSettings(database.db, edited, "paper")).changes).toEqual([]);

    const restarted = new AutoLearnApplier({ db: database.db, clock, config, learned: paper, strategyPath: file, trading: fakeTrading(runId).trading, restart: () => (restarts += 1) });
    expect(await restarted.tick()).toMatchObject({ outcome: "none_pending" });
    const next = await insertPromotion(database.db, { baselineHash: paper.settingsHash, name: "fast-exits", overrides: FAST });
    expect(await restarted.tick()).toMatchObject({ outcome: "rate_limited", promotionId: next });
    expect(restarts).toBe(1);
  });

  it("starts the next paper run from the carried bankroll, peak and day, so the kill switch and the daily limit keep counting", async () => {
    const carry = carryOf(runId, fakeTrading(runId).trading.risk.status(), 0.482, NOW_MS);
    await database.db.query("UPDATE strategy_runs SET ended_at = $2, summary = $3 WHERE id = $1", [
      runId,
      new Date(NOW_MS),
      JSON.stringify({ endedBy: CARRY_ENDED_BY, promotionId: 3, carry })
    ]);
    const next = await openPaperRun(database.db, config);
    const seeded = await seedCarriedRisk(database.db, next, config.risk);
    expect(seeded).toMatchObject({ runId: next, startingBankrollLamports: 510_123_456n, realizedPnlLamports: 0n, peakEquityLamports: 600_000_000n, dayKey: "2026-10-24" });
    expect(await seedCarriedRisk(database.db, next, config.risk)).toBeNull();
    const persisted = await loadRiskState(database.db, next);
    const risk = new RiskManager({ runId: next, config: config.risk, clock: new VirtualClock(NOW_MS + 60_000), persisted });
    expect(risk.status()).toMatchObject({ equityLamports: 510_123_456n, peakEquityLamports: 600_000_000n, dayStartEquityLamports: 530_000_000n, killed: false });
    risk.markToMarket(-95_000_000n, NOW_MS + 120_000);
    expect(risk.status().killed).toBe(true);

    const changed = await openPaperRun(database.db, config);
    await database.db.query("UPDATE strategy_runs SET ended_at = $2, summary = $3 WHERE id = $1", [next, new Date(NOW_MS), JSON.stringify({ endedBy: CARRY_ENDED_BY, carry })]);
    expect(await seedCarriedRisk(database.db, changed, { startingBankrollSol: 1 })).toBeNull();
    const manual = await openPaperRun(database.db, config);
    await database.db.query("UPDATE strategy_runs SET ended_at = $2, summary = '{\"trades\":3}' WHERE id = $1", [changed, new Date(NOW_MS)]);
    expect(await seedCarriedRisk(database.db, manual, config.risk)).toBeNull();
  });

  it("never acts in live mode or with auto-learn off, and is wired only for a paper trader with auto-learn on", async () => {
    const id = await insertPromotion(database.db, { baselineHash: hash });
    const live = applierFor({}, fakeTrading(runId, "live"));
    expect(await live.applier.tick()).toMatchObject({ outcome: "live_mode" });
    const off = structuredClone(config);
    off.lab.autoLearn.enabled = false;
    expect(await applierFor({ config: off }).applier.tick()).toMatchObject({ outcome: "disabled" });
    expect((await loadPendingPromotion(database.db))?.id).toBe(id);
    expect(live.trading.state.halts).toBe(0);
    expect(restarts).toBe(0);
    const shared = { db: database.db, clock, config, learned: fileSettings(config) };
    const restart = (): void => {
      restarts += 1;
    };
    expect(autoLearnFor({ strategyPath: file, restart }, fakeTrading(runId).trading, shared)).toBeInstanceOf(AutoLearnApplier);
    expect(autoLearnFor({ strategyPath: null, restart }, fakeTrading(runId).trading, shared)).toBeInstanceOf(AutoLearnApplier);
    expect(autoLearnFor({ strategyPath: file, restart }, fakeTrading(runId, "live").trading, shared)).toBeNull();
    expect(autoLearnFor({ strategyPath: file, restart }, fakeTrading(runId).trading, { ...shared, config: off })).toBeNull();
  });

  it("waits while a position is open or pending, the kill switch or the daily halt is on, without halting the trader", async () => {
    const id = await insertPromotion(database.db, { baselineHash: hash });
    const cases: Array<[(state: FakeState) => void, string]> = [
      [(state) => (state.busy = true), "waiting_positions"],
      [(state) => (state.inFlight = 1), "waiting_positions"],
      [(state) => (state.open = [{ id: "p" } as Position]), "waiting_positions"],
      [(state) => (state.killed = true), "waiting_risk"],
      [(state) => (state.haltedForDay = true), "waiting_risk"],
      [(state) => (state.running = false), "waiting_risk"]
    ];
    for (const [arrange, outcome] of cases) {
      const fake = fakeTrading(runId);
      arrange(fake.state);
      expect(await applierFor({}, fake).applier.tick()).toMatchObject({ outcome, promotionId: id });
      expect(fake.state.halts).toBe(0);
    }
    expect(await loadPendingPromotion(database.db)).toMatchObject({ status: "pending", applyAttempts: 0 });
    expect(restarts).toBe(0);
  });

  it("waits on a promotion learned for other settings, after a recent change and while the strategy file differs from the started settings, including lab.autoLearn", async () => {
    const other = await insertPromotion(database.db, { baselineHash: "d".repeat(64) });
    expect(await applierFor().applier.tick()).toMatchObject({ outcome: "other_settings", promotionId: other });
    await database.db.query("DELETE FROM promotions");
    await insertPromotion(database.db, { baselineHash: "c".repeat(64), name: "fast-exits", overrides: FAST, status: "applied", appliedAtMs: NOW_MS - HOUR_MS });
    const id = await insertPromotion(database.db, { baselineHash: hash });
    expect(await applierFor().applier.tick()).toMatchObject({ outcome: "rate_limited", promotionId: id });
    await database.db.query("DELETE FROM promotions WHERE status = 'applied'");
    const switchedOff = `${JSON.stringify({ ...FILE, lab: { autoLearn: { enabled: false } } }, null, 2)}\n`;
    writeFileSync(file, switchedOff);
    expect(await applierFor().applier.tick()).toMatchObject({ outcome: "file_changed", promotionId: id });
    writeFileSync(file, JSON.stringify({ ...FILE, risk: { ...FILE.risk, maxConcurrent: 3 } }));
    expect(await applierFor().applier.tick()).toMatchObject({ outcome: "file_changed" });
    writeFileSync(file, "{ not json");
    expect((await applierFor().applier.tick()).detail).toMatch(/cannot be read as a strategy file/);
    expect(restarts).toBe(0);
    expect((await loadPendingPromotion(database.db))?.id).toBe(id);
  });

  it("rejects owner-only settings, looser risk limits, invalid or empty changes and tampered overrides without touching the trader", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ risk: { fractionPerTrade: 0.3 } }, /^it changes settings only the owner changes \(risk\.fractionPerTrade\)$/],
      [{ scorer: { hardBlocks: { devShareAbove: 1 } } }, /scorer\.hardBlocks\.devShareAbove/],
      [{ signals: { scoreMomentum: { maxRiskScore: 60 } } }, /signals\.scoreMomentum\.maxRiskScore/],
      [{ exits: { maxHoldSecs: 10 } }, /^its settings are invalid: unknown strategy settings: exits\.maxHoldSecs/],
      [{ signals: { scoreMomentum: { maxRiskScore: 35 } } }, /^it does not change any setting$/]
    ];
    for (const [overrides, note] of cases) {
      const id = await insertPromotion(database.db, { baselineHash: hash, overrides });
      const fake = fakeTrading(runId);
      expect(await applierFor({}, fake).applier.tick()).toMatchObject({ outcome: "rejected", promotionId: id });
      expect((await loadPromotion(database.db, id))?.note).toMatch(note);
      expect(fake.state.halts).toBe(0);
    }
    const tampered = await insertPromotion(database.db, { baselineHash: hash });
    await database.db.query("UPDATE promotions SET overrides = $2 WHERE id = $1", [tampered, JSON.stringify({ signals: { scoreMomentum: { maxRiskScore: 5 } } })]);
    expect(await applierFor().applier.tick()).toMatchObject({ outcome: "rejected", promotionId: tampered });
    expect(restarts).toBe(0);
  });

  it("changes nothing when the transaction fails after the trader halted, restarts once to resume trading and gives up after three attempts", async () => {
    const id = await insertPromotion(database.db, { baselineHash: hash });
    const broken = failingDb(database.db, (sql) => sql.includes("SET status = 'applied'"));
    for (let attempt = 1; attempt <= MAX_APPLY_ATTEMPTS; attempt += 1) {
      const fake = fakeTrading(runId);
      const applier = applierFor({ db: broken }, fake).applier;
      await expect(applier.tick()).rejects.toThrow("disk full");
      expect(fake.state.halts).toBe(1);
      expect(restarts).toBe(attempt);
      expect(await applier.tick()).toMatchObject({ outcome: "restart_pending" });
      expect(restarts).toBe(attempt);
      expect(await loadPromotion(database.db, id)).toMatchObject({ status: "pending", applyAttempts: attempt });
      const run = await database.db.query<{ ended_at: Date | null }>("SELECT ended_at FROM strategy_runs WHERE id = $1", [runId]);
      expect(run.rows[0]?.ended_at).toBeNull();
    }
    const last = fakeTrading(runId);
    expect(await applierFor({ db: broken }, last).applier.tick()).toMatchObject({ outcome: "rejected", promotionId: id });
    expect(last.state.halts).toBe(0);
    expect((await loadPromotion(database.db, id))?.note).toBe("it could not be applied in 3 attempts");
    expect(restarts).toBe(MAX_APPLY_ATTEMPTS);
  });

  it("undoes the latest learned change when probation queued an undo, and refuses an undo that no longer matches", async () => {
    const id = await insertPromotion(database.db, { baselineHash: hash });
    expect(await applierFor().applier.tick()).toMatchObject({ outcome: "applied" });
    const learned = await loadLearnedSettings(database.db, config, "paper");
    const target = await loadPromotion(database.db, id);
    await database.db.query("UPDATE promotions SET applied_at = $2 WHERE id = $1", [id, new Date(NOW_MS - 30 * HOUR_MS)]);
    const second = await openPaperRun(database.db, learned.config);
    const undoId = await insertPromotion(database.db, { kind: "revert", name: `undo-${id}`, overrides: target?.undo ?? {}, baselineHash: learned.settingsHash, targetId: id });
    const undoing = new AutoLearnApplier({ db: database.db, clock, config, learned, strategyPath: file, trading: fakeTrading(second).trading, restart: () => (restarts += 1) });
    expect(await undoing.tick()).toMatchObject({ outcome: "applied", promotionId: undoId });
    expect(await loadPromotion(database.db, id)).toMatchObject({ status: "reverted", probationResult: "reverted" });
    expect(await loadPromotion(database.db, undoId)).toMatchObject({ status: "applied", overlay: {}, appliedHash: hash, rootHash: hash });
    const back = await loadLearnedSettings(database.db, config, "paper");
    expect(back.settingsHash).toBe(hash);
    expect(back.config.signals.scoreMomentum.maxRiskScore).toBe(35);
    expect(restarts).toBe(2);
    clock = new VirtualClock(NOW_MS + 48 * HOUR_MS);
    const stale = await insertPromotion(database.db, { kind: "revert", name: `undo-${id}`, overrides: target?.undo ?? {}, baselineHash: hash, targetId: id });
    const after = new AutoLearnApplier({ db: database.db, clock, config, learned: back as LearnedSettings, strategyPath: file, trading: fakeTrading(second).trading, restart: () => (restarts += 1) });
    expect(await after.tick()).toMatchObject({ outcome: "rejected", promotionId: stale });
    expect((await loadPromotion(database.db, stale))?.note).toBe("the change it would undo is no longer the latest learned change in effect");
  });

  it("checks every five minutes after a one-minute start delay", async () => {
    const id = await insertPromotion(database.db, { baselineHash: hash });
    const wired = autoLearnFor({ strategyPath: file, restart: () => (restarts += 1) }, fakeTrading(runId).trading, { db: database.db, clock, config, learned: fileSettings(config) });
    const repeater = autoLearnRepeater(wired as AutoLearnApplier, clock);
    repeater.start();
    await clock.advanceTo(NOW_MS + 59_000);
    expect((await loadPendingPromotion(database.db))?.id).toBe(id);
    await clock.advanceTo(NOW_MS + 61_000);
    await repeater.stop();
    expect((await recentPromotions(database.db, 1))[0]).toMatchObject({ id, status: "applied" });
    expect(restarts).toBe(1);
  });
});

describe("restarts and strategy paths", () => {
  it("exits with a dedicated non-zero code after a self-requested restart so on-failure supervisors bring the service back", () => {
    expect(exitCodeFor("SIGTERM", true)).toBe(EXIT_RESTART);
    expect(EXIT_RESTART).not.toBe(EXIT_OK);
    expect(exitCodeFor("SIGTERM", false)).toBe(EXIT_OK);
    expect(exitCodeFor("trading lock lost", false)).toBe(EXIT_FAILURE);
  });

  it("resolves the strategy file only when it exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "snypra-auto-learn-path-"));
    writeFileSync(path.join(dir, "strategy.json"), "{}");
    expect(resolveStrategyPath("strategy.json", dir)).toBe(path.join(dir, "strategy.json"));
    expect(resolveStrategyPath("missing.json", dir)).toBeNull();
    expect(resolveStrategyPath(undefined, dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
