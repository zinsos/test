import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeList, loadLabOverview, loadLearning, loadRecentPromotion, parseLearningReport } from "../src/analytics/labQueries.js";
import { startAnalyticsServer, type AnalyticsServer } from "../src/analytics/server.js";
import { VirtualClock } from "../src/core/clock.js";
import { overridesHash } from "../src/lab/identity.js";
import { evaluateLearning } from "../src/lab/learner.js";
import { jsonResponse, READ_AT_MS, renderTradesView, startDashboard, tradesFixture, type Responder } from "./analytics.dashboardDom.js";
import { HOSTILE, labResponse, learningFixture } from "./analytics.learningFixture.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { IDENTITY, jitter, jitterB, learnerInput, series, SETTINGS, spread, STRICT } from "./lab.evidence.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TOKEN = "learning-dashboard-token-0123456789";

function responderFor(lab: Record<string, unknown>): Responder {
  return (path) => Promise.resolve(jsonResponse(path.startsWith("/api/runs") ? { runs: [], modes: [] } : path === "/api/lab" ? lab : { summary: { n: 0 }, points: [] }));
}

function report(fixture: Record<string, unknown>): Record<string, unknown> {
  return fixture.report as Record<string, unknown>;
}

describe("learning on the dashboard", () => {
  it("shows the learned change in effect, the current step, the rule, per-variant evidence, the paper check, the weights and the promotion history", async () => {
    const dashboard = await startDashboard({}, { hash: "#lab", responder: responderFor(labResponse(learningFixture())) });
    const text = dashboard.view().text;
    for (const expected of [
      "Learning",
      "Auto-apply on",
      "Paper only",
      "Learned changes in effect. The paper trader runs the strategy file plus promotion #3 (Fast-exits, 3.0d ago): exits.timeStop.afterSec = 120. Live mode and the file itself are never changed.",
      "Keeping the current settings. momentum-strict is being confirmed on fresh data: 9 of 24 windows so far, tested once at the end.",
      "Confirming Momentum-strict",
      "9 of 24 fresh windows since",
      "tested once at 96.96% (nominee #1 with these settings)",
      "Windows14",
      "Baseline trades168",
      "Baseline per window−1.57 bets−13.1% per trade",
      "Settingsabcd1234code 0123456789abcdef; evidence restarts when either changes",
      "Step 1, nominate: with 100+ trades in it and in the baseline over 10+ non-overlapping 3-hour replays",
      "above zero with 97.5% confidence (corrected for 2 candidates)",
      "Step 2, confirm: the nominee is replayed on at least 24 fresh windows that start after the nomination and is tested once, at 96.96% for the next nominee with these settings (each nominee is held to a stricter level than the one before)",
      "Step 3, probation",
      "live mode never uses learned settings",
      "+4.20 bets per window vs the baseline · 97.5% lower bound +1.10 bets",
      "Better in 11 of 14 windows · without its best window +3.60 bets · older half +4.00 bets · newer half +4.40 bets · own +2.25 bets per window · +21.0% per trade vs −13.1%",
      "150 of 100 trades in both · 14 of 10 windows",
      "signals.scoreMomentum.maxRiskScore = 25",
      HOSTILE,
      "Collecting",
      "41 of 100 trades in both",
      "needs 100 trades in both arms, has 41",
      "Paper check: The replay matches the paper fills of the same coins · 31 paper trades matched a replayed trade (80% of the coins, needs 20) · replay minus paper +1.2% per trade (95% range −1.0% to +3.4%).",
      "Scorer weights (reported only)",
      "This is a hint, not a confirmed result, and they are never activated",
      "Better twice",
      "Last promotion #4",
      "+4.20 bets per window (lower bound +1.10 bets) over 150 trades in 14 windows",
      "Confirmation24 fresh windows · nominee #1",
      "Fast-exits",
      "Applied"
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toMatch(/null|undefined|NaN/);
    expect(dashboard.find("learn-row")).toHaveLength(2);
    expect(dashboard.find("learn-stage")).toHaveLength(1);
    expect(dashboard.find("lb-range")).toHaveLength(2);
    expect(dashboard.find("meter")).toHaveLength(3);
  });

  it("explains a confirmed change, a disabled auto-apply, an undo, report-only runs, the first run and a learner failure", async () => {
    const confirmed = learningFixture();
    report(confirmed).decision = { kind: "confirm", promotionId: 4, name: "momentum-strict", reason: "momentum-strict confirmed on 24 fresh windows" };
    const on = await startDashboard({}, { hash: "#lab", responder: responderFor(labResponse(confirmed)) });
    expect(on.view().text).toContain("Confirmed. momentum-strict confirmed on 24 fresh windows. The paper trader switches once no position is open, then restarts and keeps its bankroll, peak and day.");
    expect(on.find("banner").some((node) => node.className.includes("good"))).toBe(true);
    report(confirmed).enabled = false;
    const off = await startDashboard({}, { hash: "#lab", responder: responderFor(labResponse(confirmed)) });
    expect(off.view().text).toContain("Auto-apply off");
    expect(off.view().text).toContain("Auto-apply is off (lab.autoLearn.enabled), so nothing changes until it is turned on.");
    const undo = learningFixture();
    report(undo).confirmation = null;
    report(undo).probation = { promotionId: 3, name: "fast-exits", undoName: "undo-3", fromMs: READ_AT_MS - DAY_MS, needed: 24, collected: 24, complete: true, stats: null, result: "revert" };
    report(undo).decision = { kind: "revert", promotionId: 3, name: "undo-3", reason: "on 24 fresh windows after fast-exits was applied the old settings did as well or better (+0.10 bets per window), so the change is undone" };
    report(undo).canPromote = false;
    const undoing = await startDashboard({}, { hash: "#lab", responder: responderFor(labResponse(undo)) });
    expect(undoing.view().text).toContain("Undoing a change. on 24 fresh windows after fast-exits was applied the old settings did as well or better");
    expect(undoing.view().text).toContain("Probation for Fast-exits");
    expect(undoing.view().text).toContain("24 of 24 fresh windows replay the old settings (undo-3) next to the new ones");
    expect(undoing.view().text).toContain("Report only");
    const problem = learningFixture();
    problem.inEffect = { autoLearn: true, promotionId: null, name: null, appliedAtMs: null, changes: [], problem: "the learned changes of promotion #3 are no longer valid" };
    expect((await startDashboard({}, { hash: "#lab", responder: responderFor(labResponse(problem)) })).view().text).toContain("the learned changes of promotion #3 are no longer valid.");
    const first = await startDashboard({}, { hash: "#lab", responder: responderFor(labResponse({ available: true, report: null, error: "boom", promotions: [], inEffect: null })) });
    expect(first.view().text).toContain("The latest learner run failed: boom");
    expect(first.view().text).toContain("Its first verdicts appear after the next one.");
    expect(first.view().text).toContain("No promotion yet.");
    const missing = await startDashboard({}, { hash: "#lab", responder: responderFor(labResponse({ available: false, report: null, error: null, promotions: [], inEffect: null })) });
    expect(missing.view().text).toContain("Run the database migrations so the learner can store its results.");
  });

  it("notes a change applied or undone in the last day on the Overview", async () => {
    const recentPromotion = { ...(learningFixture().promotions as Array<Record<string, unknown>>)[1], appliedAtMs: READ_AT_MS - 2 * HOUR_MS };
    const rendered = await renderTradesView({ ...tradesFixture(), recentPromotion });
    expect(rendered.text).toContain(
      "Auto-learn switched the paper settings to Fast-exits 2h ago: +1.90 bets per window over the old settings on fresh replays. A new paper run continues the same bankroll; the evidence is in Lab."
    );
    const undone = await renderTradesView({ ...tradesFixture(), recentPromotion: { ...recentPromotion, kind: "revert", name: "undo-3" } });
    expect(undone.text).toContain("Auto-learn undid the last learned change (Undo-3) 2h ago. A new paper run continues the same bankroll");
    expect((await renderTradesView({ ...tradesFixture(), recentPromotion: null })).text).not.toContain("Auto-learn");
    expect((await renderTradesView(tradesFixture())).text).not.toContain("Auto-learn");
  });
});

describe("learning api data", () => {
  it("parses learner reports defensively and round-trips a real report", () => {
    expect(parseLearningReport(1, null)).toBeNull();
    expect(parseLearningReport(1, { variants: [], identity: {} })).toBeNull();
    const parsed = parseLearningReport(5, { identity: { settingsHash: "0123456789abcdef" }, variants: [{ name: "x", reasons: ["a", 3, ""], overrides: { exits: { maxHoldSec: 9 } } }, { nope: true }], weights: { candidates: [{}] } });
    expect(parsed).toMatchObject({ labRunId: 5, settings: "01234567", engine: null, enabled: false, canPromote: false, windows: 0, confirmation: null, probation: null, decision: { kind: "hold", name: null, reason: "" }, weights: [], promotion: null });
    expect(parsed?.variants).toHaveLength(1);
    expect(parsed?.variants[0]).toMatchObject({ name: "x", verdict: "unknown", reasons: ["a"], changes: ["exits.maxHoldSec = 9"], stats: null, tradeProgress: 0 });
    const windows = series(12, (index) => spread(12, 0.05 + jitter(index)), [{ arm: STRICT, rs: (index) => spread(12, 0.4 + jitterB(index)) }]);
    const real = JSON.parse(JSON.stringify(evaluateLearning(learnerInput({ windows })))) as unknown;
    const round = parseLearningReport(9, real);
    expect(round).toMatchObject({ settings: SETTINGS.slice(0, 8), engine: IDENTITY.engineVersion, canPromote: true, windowHours: 3, minWindows: 10, confirmWindows: 24, comparisons: 1, windows: 12, decision: { kind: "nominate", name: STRICT.name } });
    expect(round?.variants[0]?.stats).toMatchObject({ windows: 12, variantTrades: 144, baselineTrades: 144 });
    expect(round?.paper).toMatchObject({ status: "consistent", matched: 144, coverage: 1 });
    expect(changeList({ exits: { takeProfit: Array.from({ length: 40 }, () => ({ atMultiple: 1.5, sellFractionOfInitial: 0.5 })) } })[0]).toMatch(/^exits\.takeProfit = \[.{100,}…$/);
    expect(changeList("nope")).toEqual([]);
  });
});

describe.skipIf(!hasTestDatabase)("learning in the lab and positions api", () => {
  let database: TestDatabase;
  let server: AnalyticsServer;
  let base = "";
  const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
  const inEffect = { autoLearn: true, promotionId: 2, name: "fast-exits", appliedAtMs: NOW_MS - 3 * HOUR_MS, changes: ["exits.timeStop.afterSec = 120"], problem: null };

  async function get(path: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  beforeAll(async () => {
    database = await createTestDatabase("analytics_learning");
    const windows = series(12, (index) => spread(12, 0.05 + jitter(index)), [{ arm: STRICT, rs: (index) => spread(12, 0.4 + jitterB(index)) }]);
    const learner = evaluateLearning(learnerInput({ windows, enabled: false }));
    const lab = await database.db.query<{ id: string }>(
      `INSERT INTO lab_runs (started_at, finished_at, status, data_from, data_to, notes, baseline_hash, engine_version, learner)
       VALUES ($1, $1, 'done', $2, $1, '{}', $3, $4, $5) RETURNING id::text AS id`,
      [new Date(NOW_MS - HOUR_MS), new Date(NOW_MS - 4 * HOUR_MS), SETTINGS, IDENTITY.engineVersion, JSON.stringify(learner)]
    );
    await database.db.query(
      `INSERT INTO lab_runs (started_at, finished_at, status, data_from, data_to, notes) VALUES ($1, $1, 'done', $2, $1, '{"learner":{"error":"disk full"}}')`,
      [new Date(NOW_MS - 30 * 60_000), new Date(NOW_MS - 3 * HOUR_MS)]
    );
    const evidence = { discovery: { stats: { windows: 12, variantTrades: 144, gain: 3.9, gainSol: 0.19, gainLow: 2.1 } }, confirmation: { stats: { windows: 24, variantTrades: 290, gain: 3.5, gainSol: 0.17, gainLow: 1.4 } }, applied: { endedRunId: 3 } };
    const insert = (name: string, status: string, appliedAtMs: number | null, createdAtMs: number) =>
      database.db.query(
        `INSERT INTO promotions (kind, name, overrides, overrides_hash, baseline_hash, evidence, status, note, lab_run_id, confirm_from, confirm_windows, confirm_index,
                                 root_hash, overlay, applied_hash, probation_result, created_at, updated_at, applied_at)
         VALUES ('variant', $1, $2, $3, $4, $5, $6, 'seeded', $7, $8, 24, 1, $9, $10, $11, $12, $8, $8, $13)`,
        [
          name,
          JSON.stringify(STRICT.overrides),
          overridesHash(STRICT.overrides),
          SETTINGS,
          JSON.stringify(evidence),
          status,
          Number(lab.rows[0]?.id),
          new Date(createdAtMs),
          appliedAtMs === null ? null : SETTINGS,
          appliedAtMs === null ? null : JSON.stringify(STRICT.overrides),
          appliedAtMs === null ? null : "after",
          status === "reverted" ? "reverted" : null,
          appliedAtMs === null ? null : new Date(appliedAtMs)
        ]
      );
    await insert("fast-exits", "reverted", NOW_MS - 2 * DAY_MS, NOW_MS - 2 * DAY_MS - HOUR_MS);
    await insert("momentum-strict", "applied", NOW_MS - 3 * HOUR_MS, NOW_MS - 4 * HOUR_MS);
    server = await startAnalyticsServer({ db: database.db, port: 0, host: "127.0.0.1", token: TOKEN, clock: new VirtualClock(NOW_MS), cacheTtlMs: 0, settings: { learned: inEffect } });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  it("serves the latest learner report, the newest failure, the promotion history and the learned changes in effect", async () => {
    const learning = await loadLearning(database.db);
    expect(learning.available).toBe(true);
    expect(learning.error).toBe("disk full");
    expect(learning.inEffect).toBeNull();
    expect(learning.report?.variants.map((variant) => [variant.name, variant.verdict])).toEqual([[STRICT.name, "candidate"]]);
    expect(learning.report).toMatchObject({ enabled: false, windows: 12, minTrades: 100, comparisons: 1, decision: { kind: "nominate", name: STRICT.name } });
    expect(learning.report?.baseline.trades).toBe(144);
    expect(learning.promotions.map((row) => [row.name, row.status])).toEqual([
      ["momentum-strict", "applied"],
      ["fast-exits", "reverted"]
    ]);
    expect(learning.promotions[0]).toMatchObject({ windows: 24, trades: 290, gain: 3.5, gainLow: 1.4, confirmIndex: 1, confirmWindows: 24, endedRunId: 3, changes: ["signals.scoreMomentum.maxRiskScore = 25"] });
    expect(learning.promotions[1]).toMatchObject({ probationResult: "reverted" });
    expect((await loadLabOverview(database.db)).learning.report?.labRunId).toBe(learning.report?.labRunId);
    const api = await get("/api/lab");
    expect((api.learning as { report: { decision: { kind: string } } }).report.decision.kind).toBe("nominate");
    expect((api.learning as { inEffect: unknown }).inEffect).toEqual(inEffect);
  });

  it("adds a change applied or undone in the last 24 hours to the positions api", async () => {
    expect((await loadRecentPromotion(database.db, NOW_MS - DAY_MS))?.name).toBe("momentum-strict");
    expect(await loadRecentPromotion(database.db, NOW_MS)).toBeNull();
    expect((await loadRecentPromotion(database.db, NOW_MS - 3 * DAY_MS))?.name).toBe("momentum-strict");
    const positions = await get("/api/positions");
    expect(positions.recentPromotion).toMatchObject({ name: "momentum-strict", status: "applied", appliedAtMs: NOW_MS - 3 * HOUR_MS });
    const missing = { query: () => Promise.reject(Object.assign(new Error("no table"), { code: "42P01" })) } as unknown as Parameters<typeof loadLearning>[0];
    expect(await loadLearning(missing)).toEqual({ available: false, report: null, error: null, promotions: [], inEffect: null });
    expect(await loadRecentPromotion(missing, 0)).toBeNull();
  });
});
