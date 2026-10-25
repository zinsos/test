import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import type { Db } from "../src/db/pool.js";
import { overridesHash, strategyHash, variantKey } from "../src/lab/identity.js";
import type { EvidenceIdentity, EvidenceWindow } from "../src/lab/learner.js";
import { loadEvidenceWindows, loadPaperEvidence, plannedArm, runLearner } from "../src/lab/learnerStore.js";
import { loadLearnerState, loadPendingPromotion, recentPromotions } from "../src/lab/promotions.js";
import { applyOverrides, type JsonObject } from "../src/lab/variants.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { ENGINE, jitter, jitterB, series, spread, STEP_MS, WEIGHTS, windowStart } from "./lab.evidence.js";

const STRICT = { name: "momentum-strict", description: "strict", overrides: { signals: { scoreMomentum: { maxRiskScore: 25 } } } };
const FAST = { name: "fast-exits", description: "fast", overrides: { exits: { timeStop: { afterSec: 120 } } } };
const LOOSE = { name: "momentum-loose", description: "loose", overrides: { signals: { scoreMomentum: { maxRiskScore: 70 } } } };

function learnerConfig(): StrategyConfig {
  const config = defaultStrategyConfig();
  config.lab.autoLearn.bootstrapIterations = 1000;
  return config;
}

function identityOf(config: StrategyConfig, engineVersion = ENGINE): EvidenceIdentity {
  return { settingsHash: strategyHash(config), engineVersion, weightsVersion: WEIGHTS };
}

async function storeWindow(db: Db, window: EvidenceWindow, input: { settingsHash: string; engineVersion?: string; status?: string; overrides: Record<string, JsonObject> }): Promise<number> {
  const notes = { variants: { baseline: { weightsVersion: window.weightsVersion } } };
  const result = await db.query<{ id: string }>(
    `INSERT INTO lab_runs (started_at, finished_at, status, data_from, data_to, notes, baseline_hash, engine_version)
     VALUES ($1, $1, $2, $3, $1, $4, $5, $6) RETURNING id::text AS id`,
    [new Date(window.toMs), input.status ?? "done", new Date(window.fromMs), JSON.stringify(notes), input.settingsHash, input.engineVersion ?? ENGINE]
  );
  const labRunId = Number(result.rows[0]?.id);
  for (const arm of window.arms) {
    const trades = arm.trades?.map((trade) => ({ ...trade, closedAtMs: trade.openedAtMs + 60_000, exitReason: "take_profit" })) ?? null;
    await db.query(
      `INSERT INTO lab_variants (lab_run_id, name, description, is_baseline, overrides, trades, error)
       VALUES ($1, $2, 'seeded', $3, $4, $5, $6)`,
      [labRunId, arm.name, arm.isBaseline, JSON.stringify(input.overrides[arm.name] ?? {}), trades === null ? null : JSON.stringify(trades), trades === null ? "failed" : null]
    );
  }
  return labRunId;
}

async function storeAll(db: Db, windows: readonly EvidenceWindow[], settingsHash: string, engineVersion = ENGINE): Promise<number[]> {
  const ids: number[] = [];
  const overrides = { [STRICT.name]: STRICT.overrides, [FAST.name]: FAST.overrides, [LOOSE.name]: LOOSE.overrides };
  for (const window of windows) {
    ids.push(await storeWindow(db, window, { settingsHash, engineVersion, overrides }));
  }
  return ids;
}

async function openPaperRun(db: Db, config: StrategyConfig, startedAtMs: number): Promise<number> {
  const result = await db.query<{ id: string }>("INSERT INTO strategy_runs (mode, label, started_at, config) VALUES ('paper', NULL, $1, $2) RETURNING id::text AS id", [
    new Date(startedAtMs),
    JSON.stringify(config)
  ]);
  return Number(result.rows[0]?.id);
}

async function paperFill(db: Db, id: string, runId: number, mint: string, openedAtMs: number, cost: bigint, pnl: bigint): Promise<void> {
  await db.query(
    `INSERT INTO positions (id, run_id, mode, mint, signal_type, risk_score, opened_at, opened_slot, entry_price, entry_tokens,
       entry_cost, tokens_held, proceeds, fees_paid, peak_price, last_price, status, closed_at, exit_reason, realized_pnl, hold_sec, peak_multiple)
     VALUES ($1, $2, 'paper', $3, 'score_momentum', 20, $4, 1, 0.0000001, 1000000000, $5, 0, $6, 1000000, 0.0000002, 0.0000001,
       'closed', $7, 'take_profit', $8, 60, 1.5)`,
    [id, runId, mint, new Date(openedAtMs), cost.toString(), (cost + pnl).toString(), new Date(openedAtMs + 60_000), pnl.toString()]
  );
}

async function mirrorOnPaper(db: Db, runId: number, windows: readonly EvidenceWindow[]): Promise<void> {
  for (const window of windows) {
    for (const [index, trade] of (window.arms.find((arm) => arm.isBaseline)?.trades ?? []).entries()) {
      const cost = 48_000_000n;
      await paperFill(db, `paper-${runId}-${window.fromMs}-${index}`, runId, trade.mint ?? "m", trade.openedAtMs + 1_000, cost, BigInt(Math.round(trade.r * Number(cost))));
    }
  }
}

function strongWindows(count: number, startIndex = 0): EvidenceWindow[] {
  const config = learnerConfig();
  const strict = plannedArm(config, STRICT, applyOverrides(config, STRICT.overrides));
  const fast = plannedArm(config, FAST, applyOverrides(config, FAST.overrides));
  return series(
    count,
    (index) => spread(12, 0.05 + jitter(index)),
    [
      { arm: strict, rs: (index) => spread(12, 0.4 + jitterB(index)) },
      { arm: fast, rs: (index) => spread(12, 0.05 + jitterB(index)) }
    ],
    startIndex
  );
}

describe.skipIf(!hasTestDatabase)("learner storage and promotions", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("lab_learning");
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function reset(): Promise<void> {
    await database.db.query("DELETE FROM promotions");
    await database.db.query("DELETE FROM lab_runs");
    await database.db.query("DELETE FROM positions");
    await database.db.query("DELETE FROM strategy_runs");
  }

  beforeEach(reset);

  it("keeps at most one open promotion and the applied facts only on applied rows", async () => {
    const db = database.db;
    const columns = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'lab_runs' AND column_name IN ('baseline_hash', 'engine_version', 'learner'))
           OR (table_name = 'lab_variants' AND column_name = 'trades')
           OR table_name = 'promotions'
        ORDER BY table_name, column_name`
    );
    expect(columns.rows.filter((row) => row.table_name === "promotions").map((row) => row.column_name)).toEqual(
      expect.arrayContaining(["confirm_from", "confirm_windows", "confirm_index", "target_id", "root_hash", "overlay", "previous_overlay", "applied_hash", "undo", "probation_result", "apply_attempts"])
    );
    expect(columns.rows.filter((row) => row.table_name !== "promotions")).toHaveLength(4);
    const insert = (status: string, extra: { appliedAt?: Date | null; applied?: boolean; kind?: string; target?: number | null } = {}) =>
      db.query(
        `INSERT INTO promotions (kind, name, overrides, overrides_hash, baseline_hash, status, created_at, updated_at, applied_at, root_hash, overlay, applied_hash, target_id)
         VALUES ($1, 'x', '{}', 'h', 'b', $2, now(), now(), $3, $4, $5, $6, $7) RETURNING id`,
        [
          extra.kind ?? "variant",
          status,
          extra.appliedAt ?? null,
          extra.applied ? "root" : null,
          extra.applied ? "{}" : null,
          extra.applied ? "after" : null,
          extra.target ?? null
        ]
      );
    await insert("confirming");
    await expect(insert("pending")).rejects.toMatchObject({ code: "23505" });
    await expect(insert("confirming")).rejects.toMatchObject({ code: "23505" });
    await expect(insert("applied", { appliedAt: null, applied: true })).rejects.toMatchObject({ code: "23514" });
    await expect(insert("applied", { appliedAt: new Date() })).rejects.toMatchObject({ code: "23514" });
    await expect(insert("superseded", { appliedAt: new Date(), applied: true })).rejects.toMatchObject({ code: "23514" });
    await expect(insert("rejected", { kind: "revert" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert("rejected", { kind: "weights" })).rejects.toMatchObject({ code: "23514" });
    await insert("applied", { appliedAt: new Date(), applied: true });
    await insert("reverted", { appliedAt: new Date(), applied: true });
    await reset();
  });

  it("loads evidence windows with their identity, trades and which arms could ever be promoted", async () => {
    const db = database.db;
    const config = learnerConfig();
    const hash = strategyHash(config);
    const windows = strongWindows(2);
    const [first] = await storeAll(db, windows, hash);
    const failed = await storeWindow(db, { ...windows[1]!, labRunId: 99, arms: [windows[1]!.arms[0]!, { ...windows[1]!.arms[1]!, trades: null }] }, { settingsHash: hash, overrides: {} });
    await storeWindow(db, strongWindows(1, 5)[0]!, { settingsHash: "f".repeat(64), overrides: {} });
    await storeWindow(db, strongWindows(1, 6)[0]!, { settingsHash: hash, status: "failed", overrides: {} });
    const looseRun = await storeWindow(
      db,
      { ...windows[0]!, arms: [windows[0]!.arms[0]!, { name: LOOSE.name, key: variantKey(LOOSE.name, LOOSE.overrides), isBaseline: false, promotable: false, trades: [] }, { name: "undo-3", key: "u", isBaseline: false, promotable: false, trades: [] }] },
      { settingsHash: hash, overrides: { [LOOSE.name]: LOOSE.overrides, "undo-3": { exits: { maxHoldSec: 100 } } } }
    );
    const loaded = await loadEvidenceWindows(db, { currentLabRunId: 0, settingsHash: hash, maxWindows: 10, config });
    expect(loaded.map((window) => window.labRunId).sort((a, b) => a - b)).toEqual([first, first! + 1, failed, looseRun].sort((a, b) => (a ?? 0) - (b ?? 0)));
    const one = loaded.find((window) => window.labRunId === first);
    expect(one).toMatchObject({ settingsHash: hash, engineVersion: ENGINE, weightsVersion: WEIGHTS, fromMs: windowStart(0), toMs: windowStart(0) + 3 * 3_600_000 });
    expect(one?.arms.map((arm) => [arm.name, arm.key, arm.isBaseline, arm.promotable, arm.trades?.length])).toEqual([
      ["baseline", variantKey("baseline", {}), true, false, 12],
      [STRICT.name, variantKey(STRICT.name, STRICT.overrides), false, true, 12],
      [FAST.name, variantKey(FAST.name, FAST.overrides), false, true, 12]
    ]);
    expect(one?.arms[1]?.trades?.[0]).toEqual(windows[0]?.arms[1]?.trades?.[0]);
    expect(loaded.find((window) => window.labRunId === failed)?.arms[1]?.trades).toBeNull();
    expect(loaded.find((window) => window.labRunId === looseRun)?.arms.map((arm) => arm.promotable)).toEqual([false, false, false]);
    await reset();
  });

  it("reads the open paper run's closed trades with their coins and whether it runs the same settings", async () => {
    const db = database.db;
    const config = learnerConfig();
    const hash = strategyHash(config);
    const t0 = windowStart(0);
    expect(await loadPaperEvidence(db, { settingsHash: hash, sinceMs: t0 })).toBeNull();
    const paper = await openPaperRun(db, config, t0 - 3_600_000);
    await paperFill(db, "paper-before", paper, "MintA", t0 - 30 * 60_000, 40_000_000n, 4_000_000n);
    await paperFill(db, "paper-after", paper, "MintB", t0 + 30 * 60_000, 40_000_000n, -8_000_000n);
    expect(await loadPaperEvidence(db, { settingsHash: hash, sinceMs: t0 })).toEqual({
      runId: paper,
      startedAtMs: t0 - 3_600_000,
      configMatches: true,
      trades: [{ r: -0.2, sol: -0.008, mint: "MintB", openedAtMs: t0 + 30 * 60_000 }]
    });
    expect((await loadPaperEvidence(db, { settingsHash: "c".repeat(64), sinceMs: t0 }))?.configMatches).toBe(false);
    await reset();
  });

  it("nominates once, confirms on fresh windows into a pending promotion and never nominates a tried change again", async () => {
    const db = database.db;
    const config = learnerConfig();
    const identity = identityOf(config);
    const variants = [STRICT, FAST].map((variant) => plannedArm(config, variant, applyOverrides(config, variant.overrides)));
    const learn = (labRunId: number, nowMs: number, canPromote = true) =>
      runLearner(db, { labRunId, nowMs, config, identity, activeWeightsVersion: WEIGHTS, variants, canPromote });
    const discovery = strongWindows(12);
    const ids = await storeAll(db, discovery, identity.settingsHash);
    const paper = await openPaperRun(db, config, windowStart(0) - 3_600_000);
    await mirrorOnPaper(db, paper, discovery);
    const reportOnly = await learn(ids.at(-1) ?? 0, windowStart(14), false);
    expect(reportOnly.decision.kind).toBe("hold");
    expect(reportOnly.promotion).toBeNull();
    expect(await recentPromotions(db, 5)).toEqual([]);
    const first = await learn(ids.at(-1) ?? 0, windowStart(14));
    expect(first.decision).toMatchObject({ kind: "nominate", name: STRICT.name, index: 1, confirmWindows: 24 });
    expect(first.promotion).toMatchObject({ status: "confirming", name: STRICT.name });
    const [row] = await recentPromotions(db, 5);
    expect(row).toMatchObject({ kind: "variant", status: "confirming", name: STRICT.name, overrides: STRICT.overrides, baselineHash: identity.settingsHash, confirmWindows: 24, confirmIndex: 1 });
    expect(row?.confirmFromMs).toBe(Math.max(...discovery.map((window) => window.toMs)));
    expect(row?.evidence).toMatchObject({ identity, discovery: { stats: { windows: 12 } }, paper: { status: "consistent" } });
    const stored = await db.query<{ learner: { decision: { kind: string }; promotion: { id: number } } }>("SELECT learner FROM lab_runs WHERE id = $1", [ids.at(-1)]);
    expect(stored.rows[0]?.learner).toMatchObject({ decision: { kind: "nominate" }, promotion: { id: row?.id } });
    const again = await learn(ids.at(-1) ?? 0, windowStart(14));
    expect(again.decision.kind).toBe("hold");
    expect(again.promotion?.id).toBe(row?.id);
    expect(await recentPromotions(db, 5)).toHaveLength(1);

    const start = Math.ceil(((row?.confirmFromMs ?? 0) - windowStart(0)) / STEP_MS);
    const fresh = strongWindows(24, start);
    const freshIds = await storeAll(db, fresh, identity.settingsHash);
    await mirrorOnPaper(db, paper, fresh);
    const confirmed = await learn(freshIds.at(-1) ?? 0, windowStart(start + 26));
    expect(confirmed.decision).toMatchObject({ kind: "confirm", promotionId: row?.id });
    const pending = await loadPendingPromotion(db);
    expect(pending).toMatchObject({ id: row?.id, status: "pending" });
    expect(pending?.evidence).toMatchObject({ confirmation: { collected: 24, complete: true }, confirmationPaper: { status: "consistent" } });
    const waiting = await learn(freshIds.at(-1) ?? 0, windowStart(start + 26));
    expect(waiting.decision).toMatchObject({ kind: "hold", name: STRICT.name });

    await db.query("UPDATE promotions SET status = 'rejected', updated_at = now() WHERE id = $1", [row?.id]);
    const state = await loadLearnerState(db, identity, 24);
    expect(state.state.tried.has(variantKey(STRICT.name, STRICT.overrides))).toBe(true);
    expect(state.state.nominations).toBe(1);
    const afterReject = await learn(freshIds.at(-1) ?? 0, windowStart(start + 26));
    expect(afterReject.variants.find((variant) => variant.name === STRICT.name)?.verdict).toBe("tried");
    expect(afterReject.decision.kind).toBe("hold");
    await reset();
  });

  it("supersedes an open promotion when the settings or the replay code change", async () => {
    const db = database.db;
    const config = learnerConfig();
    const identity = identityOf(config);
    const insert = (status: string, baselineHash: string, engineVersion: string) =>
      db.query<{ id: string }>(
        `INSERT INTO promotions (kind, name, overrides, overrides_hash, baseline_hash, evidence, status, confirm_from, confirm_windows, confirm_index, created_at, updated_at)
         VALUES ('variant', $1, $2, $3, $4, $5, $6, now(), 24, 1, now(), now()) RETURNING id::text AS id`,
        [STRICT.name, JSON.stringify(STRICT.overrides), overridesHash(STRICT.overrides), baselineHash, JSON.stringify({ identity: { ...identity, settingsHash: baselineHash, engineVersion } }), status]
      );
    const labRunId = (await storeAll(db, strongWindows(1), identity.settingsHash))[0] ?? 0;
    const variants = [plannedArm(config, STRICT, applyOverrides(config, STRICT.overrides))];
    await insert("confirming", identity.settingsHash, "older-code");
    await runLearner(db, { labRunId, nowMs: windowStart(3), config, identity, activeWeightsVersion: WEIGHTS, variants, canPromote: true });
    const [code] = await recentPromotions(db, 1);
    expect(code?.status).toBe("superseded");
    expect(code?.note).toMatch(/^the replay code or the scorer weights changed during its confirmation/);
    await insert("pending", "e".repeat(64), ENGINE);
    await runLearner(db, { labRunId, nowMs: windowStart(3), config, identity, activeWeightsVersion: WEIGHTS, variants, canPromote: true });
    const [settings] = await recentPromotions(db, 1);
    expect(settings?.status).toBe("superseded");
    expect(settings?.note).toMatch(/^the paper settings changed before it finished/);
    await insert("pending", identity.settingsHash, "older-code");
    await runLearner(db, { labRunId, nowMs: windowStart(3), config, identity, activeWeightsVersion: WEIGHTS, variants, canPromote: true });
    expect((await recentPromotions(db, 1))[0]?.status).toBe("pending");
    await reset();
  });

  it("queues an undo when the old settings do as well during probation and records a kept change otherwise", async () => {
    const db = database.db;
    const before = learnerConfig();
    const config = applyOverrides(before, STRICT.overrides);
    const identity = identityOf(config);
    const undo = { signals: { scoreMomentum: { maxRiskScore: before.signals.scoreMomentum.maxRiskScore } } };
    const appliedAtMs = windowStart(0);
    const applied = await db.query<{ id: string }>(
      `INSERT INTO promotions (kind, name, overrides, overrides_hash, baseline_hash, evidence, status, confirm_from, confirm_windows, confirm_index,
                               root_hash, previous_overlay, overlay, applied_hash, undo, created_at, updated_at, applied_at)
       VALUES ('variant', $1, $2, $3, $4, '{}', 'applied', $5, 24, 1, $4, '{}', $2, $6, $7, $5, $5, $5) RETURNING id::text AS id`,
      [STRICT.name, JSON.stringify(STRICT.overrides), overridesHash(STRICT.overrides), strategyHash(before), new Date(appliedAtMs - 3_600_000), identity.settingsHash, JSON.stringify(undo)]
    );
    const id = Number(applied.rows[0]?.id);
    const undoArm = plannedArm(config, { name: `undo-${id}`, description: "undo", overrides: undo }, before);
    const windows = series(24, (index) => spread(12, 0.1 + jitter(index)), [{ arm: undoArm, rs: (index) => spread(12, 0.15 + jitterB(index)) }]);
    const overrides = { [undoArm.name]: undo };
    const ids: number[] = [];
    for (const window of windows) {
      ids.push(await storeWindow(db, window, { settingsHash: identity.settingsHash, overrides }));
    }
    const report = await runLearner(db, { labRunId: ids.at(-1) ?? 0, nowMs: windowStart(30), config, identity, activeWeightsVersion: WEIGHTS, variants: [undoArm], canPromote: true });
    expect(report.decision).toMatchObject({ kind: "revert", promotionId: id, name: `undo-${id}` });
    const pending = await loadPendingPromotion(db);
    expect(pending).toMatchObject({ kind: "revert", name: `undo-${id}`, targetId: id, overrides: undo, baselineHash: identity.settingsHash, status: "pending" });
    await db.query("DELETE FROM promotions WHERE kind = 'revert'");
    await db.query("DELETE FROM lab_variants WHERE name = $1", [undoArm.name]);
    for (const [index, window] of windows.entries()) {
      const arm = { ...window.arms[0]!, name: undoArm.name, key: undoArm.key, isBaseline: false, promotable: false, trades: series(1, () => null, [{ arm: undoArm, rs: () => spread(12, -0.1 + jitterB(index)) }], index)[0]?.arms[1]?.trades ?? [] };
      await db.query(`INSERT INTO lab_variants (lab_run_id, name, description, is_baseline, overrides, trades) VALUES ($1, $2, 'seeded', false, $3, $4)`, [
        ids[index],
        arm.name,
        JSON.stringify(undo),
        JSON.stringify(arm.trades.map((trade) => ({ ...trade, closedAtMs: trade.openedAtMs + 60_000, exitReason: "take_profit" })))
      ]);
    }
    const kept = await runLearner(db, { labRunId: ids.at(-1) ?? 0, nowMs: windowStart(30), config, identity, activeWeightsVersion: WEIGHTS, variants: [undoArm], canPromote: true });
    expect(kept.decision).toMatchObject({ kind: "keep", promotionId: id });
    const [row] = (await recentPromotions(db, 5)).filter((entry) => entry.id === id);
    expect(row).toMatchObject({ status: "applied", probationResult: "kept" });
    expect(row?.note).toMatch(/^probation passed at lab run #\d+$/);
    expect((await loadLearnerState(db, identity, 24)).state.probation).toBeNull();
    await reset();
  });
});
