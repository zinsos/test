import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recentSignals } from "../src/analytics/activityQueries.js";
import { configChanges, laneRunSettings, loadLivePaperStrategies, sortLivePaperRows, type LivePaperRow } from "../src/analytics/laneQueries.js";
import { thresholdsOf } from "../src/analytics/liveEvents.js";
import { LiveHub, MAIN_STRATEGY } from "../src/analytics/liveHub.js";
import { selectPositionsRun } from "../src/analytics/positionQueries.js";
import { HttpError } from "../src/analytics/http.js";
import { parseStrategyFilter } from "../src/analytics/routes.js";
import { startAnalyticsServer } from "../src/analytics/server.js";
import { loadClosedTrades, loadModes, loadRuns } from "../src/analytics/tradeQueries.js";
import { defaultStrategyConfig, tradingRunConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { Position, Signal } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import { MarketState } from "../src/market/state.js";
import { mintAt, SOL } from "./analytics.db.js";
import { jsonResponse, READ_AT_MS, startDashboard, tradesFixture, type Responder } from "./analytics.dashboardDom.js";
import { parseSse } from "./analytics.sse.js";
import { createEvent } from "./exits.fixtures.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const config = defaultStrategyConfig();
const T0 = 1_800_000_000_000;
const MINT = mintAt(31);
const LANE_MINT = mintAt(32);

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableLength = 0;

  writeHead(): this {
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.writableEnded = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }

  messages(): Array<{ event: string; data: Record<string, unknown> }> {
    return parseSse(this.chunks.join(""));
  }
}

function fakeRequest(): IncomingMessage {
  return { method: "GET", headers: {}, socket: { setNoDelay: () => undefined, setKeepAlive: () => undefined } } as unknown as IncomingMessage;
}

function signal(mint: string): Signal {
  return { id: null, type: "score_momentum", mint, atMs: T0, slot: 1, riskScore: 20, wallets: [], meta: { mcapSol: 50 } };
}

function openPosition(id: string, runId: number, mint: string): Position {
  return {
    id,
    runId,
    mode: "paper",
    mint,
    launchId: 1,
    signalId: null,
    signalType: "score_momentum",
    riskScore: 20,
    openedAtMs: T0,
    openedSlot: 1,
    entryPrice: 0.00000003,
    entryTokens: 1_000_000_000n,
    entryCost: 50_000_000n,
    tokensHeld: 1_000_000_000n,
    proceeds: 0n,
    feesPaid: 1_000_000n,
    peakPrice: 0.00000003,
    lastPrice: 0.00000003,
    takeProfitLevelsHit: 0,
    migratedSeen: false,
    status: "open",
    closedAtMs: null,
    exitReason: null,
    shadowOf: null,
    meta: {}
  };
}

describe("live hub strategies", () => {
  function hubSetup() {
    const clock = new VirtualClock(T0);
    const bus = new Bus();
    const laneBus = new Bus();
    const market = new MarketState({ maxTradesPerLaunch: 1_000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    market.apply(createEvent({ mint: MINT, symbol: "MAIN", timestampMs: T0 - 10_000 }));
    market.apply(createEvent({ mint: LANE_MINT, symbol: "LANE", timestampMs: T0 - 10_000 }));
    const mainOpen: Position[] = [];
    const laneOpen: Position[] = [];
    const hub = new LiveHub({
      bus,
      clock,
      market,
      config: { exits: config.exits, execution: config.execution },
      thresholds: thresholdsOf(config),
      positions: () => mainOpen,
      tradingActive: () => true,
      runId: () => 1
    });
    hub.start();
    const lane = structuredClone(config);
    lane.signals.scoreMomentum.maxRiskScore = 50;
    lane.exits.stopLossMultiple = 0.5;
    const detach = hub.addStrategy({
      name: "momentum-loose",
      bus: laneBus,
      config: { exits: lane.exits, execution: lane.execution },
      thresholds: thresholdsOf(lane),
      runId: 2,
      label: "paper:momentum-loose",
      positions: () => laneOpen,
      tradingActive: () => true
    });
    return { clock, bus, laneBus, hub, mainOpen, laneOpen, detach };
  }

  it("tags every event with its strategy, keeps scores shared and filters polls and streams by strategy", () => {
    const { bus, laneBus, hub } = hubSetup();
    bus.emit("score", { mint: MINT, launchId: 1, checkpointSec: 60, computedAtMs: T0, slot: 1, score: 40, hardBlocked: false, flags: [], features: {}, contributions: {}, weightsVersion: "w" });
    bus.emit("signalRejected", { signal: { ...signal(MINT), riskScore: 40 }, reason: "risk_too_high" });
    laneBus.emit("signal", { ...signal(MINT), riskScore: 40 });
    laneBus.emit("signalSkipped", { signal: signal(LANE_MINT), reason: "max_concurrent" });
    const all = hub.recentEvents().map((event) => [event.kind, event.strategy]);
    expect(all).toEqual([
      ["score", null],
      ["rejected", MAIN_STRATEGY],
      ["signal", "momentum-loose"],
      ["skipped", "momentum-loose"]
    ]);
    expect(hub.recentEvents()[1]?.text).toBe("Rejected $MAIN: risk 40 above 35");
    const lanePoll = hub.poll(null, 0, "momentum-loose");
    expect(lanePoll.events.map((event) => event.kind)).toEqual(["score", "signal", "skipped"]);
    expect(lanePoll.hello.strategy).toBe("momentum-loose");
    expect(lanePoll.hello.strategies).toEqual([
      { name: "main", runId: 1, label: null, draining: false, tradingActive: true },
      { name: "momentum-loose", runId: 2, label: "paper:momentum-loose", draining: false, tradingActive: true }
    ]);
    expect(hub.poll(null, 0, MAIN_STRATEGY).events.map((event) => event.kind)).toEqual(["score", "rejected"]);
    const res = new FakeResponse();
    hub.connect(fakeRequest(), res as unknown as ServerResponse, MAIN_STRATEGY);
    laneBus.emit("signal", signal(LANE_MINT));
    bus.emit("signal", signal(MINT));
    const streamed = res.messages().filter((message) => message.event === "message").map((message) => [message.data.kind, message.data.strategy]);
    expect(streamed).toEqual([
      ["score", null],
      ["rejected", "main"],
      ["signal", "main"]
    ]);
    expect(hub.status().strategies.map((strategy) => strategy.name)).toEqual(["main", "momentum-loose"]);
  });

  it("keeps rings per strategy so a busy lane never pushes the main strategy's trades out", () => {
    const { bus, laneBus, hub } = hubSetup();
    bus.emit("signal", signal(MINT));
    for (let index = 0; index < 400; index += 1) {
      laneBus.emit("signal", signal(LANE_MINT));
    }
    expect(hub.recentEvents(MAIN_STRATEGY).filter((event) => event.kind === "signal")).toHaveLength(1);
    expect(hub.recentEvents("momentum-loose")).toHaveLength(150);
  });

  it("shows each strategy's positions with its own exit levels and drops them when the strategy detaches", () => {
    const { hub, mainOpen, laneOpen, detach } = hubSetup();
    mainOpen.push(openPosition("1-main", 1, MINT));
    laneOpen.push(openPosition("2-lane", 2, LANE_MINT));
    const hello = hub.poll(null, 0).hello;
    expect(hello.positions.map((view) => [view.id, view.strategy])).toEqual([
      ["1-main", "main"],
      ["2-lane", "momentum-loose"]
    ]);
    const stops = Object.fromEntries(hello.positions.map((view) => [view.strategy, (view.levels.stopLossPrice ?? 0) / view.entryPrice]));
    expect(stops.main).toBeCloseTo(0.65, 9);
    expect(stops["momentum-loose"]).toBeCloseTo(0.5, 9);
    expect(hub.poll(null, 0, "momentum-loose").hello.positions.map((view) => view.id)).toEqual(["2-lane"]);
    expect(hub.series("2-lane")?.position).toMatchObject({ id: "2-lane", strategy: "momentum-loose" });
    expect(hub.status().openPositions).toBe(2);
    detach();
    expect(hub.poll(null, 0).hello.positions.map((view) => view.id)).toEqual(["1-main"]);
    expect(hub.series("2-lane")).toBeNull();
    expect(hub.status().strategies.map((strategy) => strategy.name)).toEqual(["main"]);
    expect(() => hub.addStrategy({ name: "main", bus: new Bus(), config: { exits: config.exits, execution: config.execution }, thresholds: thresholdsOf(config) })).toThrow(/already in use/);
  });
});

describe("live strategy filter parameter", () => {
  it("accepts all, main and variant names and refuses anything else", () => {
    expect(parseStrategyFilter(new URLSearchParams(""))).toBeNull();
    expect(parseStrategyFilter(new URLSearchParams("strategy=all"))).toBeNull();
    expect(parseStrategyFilter(new URLSearchParams("strategy=main"))).toBe("main");
    expect(parseStrategyFilter(new URLSearchParams("strategy=fast-exits%4012"))).toBe("fast-exits@12");
    expect(() => parseStrategyFilter(new URLSearchParams(`strategy=${encodeURIComponent("x' OR 1=1")}`))).toThrow(HttpError);
  });
});

describe("live paper strategy rows", () => {
  function row(overrides: Partial<LivePaperRow>): LivePaperRow {
    return {
      runId: 1,
      strategy: "x",
      label: null,
      isMain: false,
      status: "running",
      startedAtMs: 0,
      endedAtMs: null,
      trades: 0,
      wins: 0,
      winRate: null,
      expectancySol: null,
      ciLowSol: null,
      ciHighSol: null,
      totalPnlSol: 0,
      maxDrawdownSol: 0,
      openPositions: 0,
      verdict: "insufficient_data",
      mainSameWindowTrades: null,
      mainSameWindowExpectancySol: null,
      vsMainSol: null,
      changes: [],
      moreChanges: 0,
      ...overrides
    };
  }

  it("puts the main strategy first, then running lanes by expectancy, then stopped and ended ones", () => {
    const sorted = sortLivePaperRows([
      row({ runId: 5, strategy: "ended", status: "ended", expectancySol: 0.5 }),
      row({ runId: 4, strategy: "low", expectancySol: -0.01 }),
      row({ runId: 3, strategy: "untraded" }),
      row({ runId: 2, strategy: "high", expectancySol: 0.02 }),
      row({ runId: 1, strategy: "main", isMain: true, expectancySol: -1 })
    ]);
    expect(sorted.map((entry) => entry.strategy)).toEqual(["main", "high", "low", "untraded", "ended"]);
  });

  it("lists the settings a lane changes against the main run's stored config", () => {
    const main = tradingRunConfig(config);
    const lane = structuredClone(main);
    lane.signals.scoreMomentum.maxRiskScore = 50;
    lane.exits.timeStop.afterSec = 120;
    expect(configChanges(main, lane)).toEqual([
      { setting: "exits.timeStop.afterSec", main: "300", lane: "120" },
      { setting: "signals.scoreMomentum.maxRiskScore", main: "35", lane: "50" }
    ]);
    expect(configChanges({ ...main, lab: { livePaperVariants: ["a"] } }, main)).toEqual([]);
  });
});

describe("dashboard with live paper strategies", () => {
  const runs = [
    { id: 3, mode: "paper", label: "paper:fast-exits", startedAtMs: READ_AT_MS - 3_600_000, endedAtMs: null, closedTrades: 4 },
    { id: 2, mode: "paper", label: "paper:momentum-loose", startedAtMs: READ_AT_MS - 3_600_000, endedAtMs: null, closedTrades: 9 },
    { id: 1, mode: "paper", label: null, startedAtMs: READ_AT_MS - 86_400_000, endedAtMs: null, closedTrades: 40 }
  ];

  it("lists lane runs in the Trades run selector, keeps the main run as the default and shows a lane by name", async () => {
    const fixture = tradesFixture();
    const responder: Responder = (path) => {
      if (path.startsWith("/api/runs")) {
        return Promise.resolve(jsonResponse({ runs, modes: [] }));
      }
      if (path === "/api/positions?runId=3") {
        return Promise.resolve(jsonResponse({ ...fixture, run: { ...(fixture.run as Record<string, unknown>), id: 3, label: "paper:fast-exits" } }));
      }
      return Promise.resolve(jsonResponse(fixture));
    };
    const dashboard = await startDashboard(fixture, { responder });
    expect(dashboard.paths).toContain("/api/positions");
    const options = dashboard.find("controls")[0]?.descendants().filter((node) => node.tagName === "option").map((node) => node.textContent);
    expect(options).toEqual(["Latest run (auto)", "#1 paper main", "#3 paper strategy fast-exits", "#2 paper strategy momentum-loose"]);
    expect(dashboard.view().text).toContain("Paper run #1");
    await dashboard.change("Run", "3");
    expect(dashboard.paths).toContain("/api/positions?runId=3");
    expect(dashboard.view().text).toContain("Paper strategy fast-exits · run #3");
    expect(dashboard.view().text).toContain("Signals its entry filter rejected are not stored for extra strategies");
    expect(JSON.parse(dashboard.storage.get("snypra-edge-prefs") ?? "{}")).toMatchObject({ tradesRun: "3" });
  });

  it("filters the Live tab by strategy, tags lane events and asks the server for one strategy only", async () => {
    const strategies = [
      { name: "main", runId: 1, label: null, draining: false, tradingActive: true },
      { name: "fast-exits", runId: 3, label: "paper:fast-exits", draining: false, tradingActive: true }
    ];
    const status = { enabled: true, streamId: "s1", clients: 0, maxClients: 10, tradingActive: true, events: 0, lastEventAtMs: null, openPositions: 0, heartbeatMs: 15_000, strategies };
    const responder: Responder = (path) => {
      if (path.startsWith("/api/runs")) {
        return Promise.resolve(jsonResponse({ runs: [], modes: [] }));
      }
      if (path === "/api/live/status") {
        return Promise.resolve(jsonResponse(status));
      }
      if (path.startsWith("/api/live/events")) {
        return Promise.resolve(jsonResponse({ hello: { streamId: "p1", serverTimeMs: READ_AT_MS, tradingActive: true, positions: [], strategies }, events: [], lastId: 0 }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    };
    const dashboard = await startDashboard({}, { hash: "#live", eventSource: true, responder });
    const first = dashboard.streams[0];
    expect(first?.url).toBe("/api/live/stream?token=dom-token");
    first?.open();
    first?.send("hello", { streamId: "s1", serverTimeMs: READ_AT_MS, tradingActive: true, positions: [], strategies });
    first?.send("message", { id: 1, kind: "signal", category: "signal", tone: "info", atMs: READ_AT_MS, mint: MINT, symbol: "GEN", text: "Signal $GEN: score momentum", data: {}, strategy: "fast-exits" }, "s1:1");
    first?.send("message", { id: 2, kind: "score", category: "score", tone: "good", atMs: READ_AT_MS, mint: MINT, symbol: "GEN", text: "Scored $GEN 60s: 18 (clean)", data: {}, strategy: null }, "s1:2");
    await dashboard.flush();
    expect(dashboard.find("feed-strategy").map((node) => node.textContent)).toEqual(["fast-exits"]);
    const strategySelect = dashboard.find("live-strategy")[0]?.descendants().filter((node) => node.tagName === "option").map((node) => node.textContent);
    expect(strategySelect).toEqual(["All strategies", "Main strategy", "fast-exits"]);
    await dashboard.change("Strategy", "fast-exits");
    expect(first?.closed).toBe(true);
    expect(dashboard.streams[1]?.url).toBe("/api/live/stream?token=dom-token&strategy=fast-exits");
    expect(dashboard.find("feed-text")).toHaveLength(0);
    expect(JSON.parse(dashboard.storage.get("snypra-edge-prefs") ?? "{}")).toMatchObject({ liveStrategy: "fast-exits" });
    await dashboard.advance(7_000);
    expect(dashboard.paths).toContain("/api/live/events?after=0&strategy=fast-exits");
  });

  it("shows the live paper strategies side by side on the Lab tab and opens one in the Trades tab", async () => {
    const rows = [
      {
        runId: 1, strategy: "main", label: null, isMain: true, status: "running", startedAtMs: READ_AT_MS - 86_400_000, endedAtMs: null,
        trades: 40, wins: 16, winRate: 0.4, expectancySol: 0.002, ciLowSol: -0.004, ciHighSol: 0.008, totalPnlSol: 0.08, maxDrawdownSol: 0.1,
        openPositions: 2, verdict: "no_edge", mainSameWindowTrades: null, mainSameWindowExpectancySol: null, vsMainSol: null, changes: [], moreChanges: 0
      },
      {
        runId: 2, strategy: "momentum-loose", label: "paper:momentum-loose", isMain: false, status: "running", startedAtMs: READ_AT_MS - 3_600_000, endedAtMs: null,
        trades: 9, wins: 5, winRate: 0.5556, expectancySol: 0.011, ciLowSol: -0.003, ciHighSol: 0.025, totalPnlSol: 0.099, maxDrawdownSol: 0.02,
        openPositions: 1, verdict: "insufficient_data", mainSameWindowTrades: 3, mainSameWindowExpectancySol: 0.001, vsMainSol: 0.01,
        changes: [{ setting: "signals.scoreMomentum.maxRiskScore", main: "35", lane: "50" }], moreChanges: 0
      }
    ];
    const responder: Responder = (path) =>
      Promise.resolve(
        jsonResponse(
          path.startsWith("/api/runs")
            ? { runs, modes: [] }
            : path === "/api/lab/live"
              ? { mainRunId: 1, rows }
              : path === "/api/lab"
                ? { available: true, runs: 0, latest: null, run: null, variants: [], scorer: [], history: [], takeaway: null }
                : tradesFixture()
        )
      );
    const dashboard = await startDashboard({}, { hash: "#lab", responder });
    const text = dashboard.view().text;
    for (const expected of ["Live paper strategies", "Main strategy", "momentum-loose", "maxRiskScore 35 → 50", "+0.011", "-0.003 to +0.025", "+0.010 (3 main)", "56%", "No lab run yet"]) {
      expect(text).toContain(expected);
    }
    expect(dashboard.find("main-row")).toHaveLength(1);
    await dashboard.click("momentum-loose");
    expect(JSON.parse(dashboard.storage.get("snypra-edge-prefs") ?? "{}")).toMatchObject({ tradesRun: "2" });
    expect(dashboard.location.hash).toBe("trades");
  });
});

describe.skipIf(!hasTestDatabase)("lane runs in analytics queries", () => {
  let database: TestDatabase;
  let mainRun = 0;
  let laneRun = 0;
  let endedLane = 0;
  let labRun = 0;
  const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
  const HOUR = 3_600_000;

  async function insertRun(mode: string, label: string | null, startedAtMs: number, stored: unknown, endedAtMs: number | null = null): Promise<number> {
    const result = await database.db.query<{ id: number }>(
      "INSERT INTO strategy_runs (mode, label, started_at, ended_at, config) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id::int",
      [mode, label, new Date(startedAtMs), endedAtMs === null ? null : new Date(endedAtMs), JSON.stringify(stored)]
    );
    return result.rows[0]?.id ?? 0;
  }

  async function insertPosition(id: string, runId: number, mode: string, openedAtMs: number, pnl: bigint | null): Promise<void> {
    const closed = pnl !== null;
    await database.db.query(
      `INSERT INTO positions (id, run_id, mode, mint, signal_type, risk_score, opened_at, opened_slot, entry_price, entry_tokens,
         entry_cost, tokens_held, proceeds, fees_paid, peak_price, last_price, status, closed_at, exit_reason, realized_pnl, hold_sec)
       VALUES ($1, $2, $3, $4, 'score_momentum', 20, $5, 1, 0.0000001, 1000000000, $6, 0, $7, 1000000, 0.0000002, 0.0000001, $8, $9, $10, $11, 60)`,
      [
        id,
        runId,
        mode,
        mintAt(50),
        new Date(openedAtMs),
        (SOL / 10n).toString(),
        closed ? (SOL / 10n + pnl).toString() : "0",
        closed ? "closed" : "open",
        closed ? new Date(openedAtMs + 60_000) : null,
        closed ? "take_profit" : null,
        closed ? pnl.toString() : null
      ]
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase("analytics_lanes");
    const main = tradingRunConfig(config);
    const loose = structuredClone(main);
    loose.signals.scoreMomentum.maxRiskScore = 50;
    loose.signals.enabled = ["score_momentum"];
    mainRun = await insertRun("paper", null, NOW - 48 * HOUR, main);
    laneRun = await insertRun("paper", "paper:momentum-loose", NOW - 10 * HOUR, loose);
    endedLane = await insertRun("paper", "paper:fast-exits", NOW - 30 * HOUR, main, NOW - 20 * HOUR);
    labRun = await insertRun("backtest", "lab:1:baseline", NOW - 5 * HOUR, main, NOW - 4 * HOUR);
    for (let index = 0; index < 6; index += 1) {
      await insertPosition(`main-${index}`, mainRun, "paper", NOW - (40 - index * 6) * HOUR, index < 3 ? -SOL / 100n : SOL / 50n);
    }
    for (let index = 0; index < 4; index += 1) {
      await insertPosition(`lane-${index}`, laneRun, "paper", NOW - (9 - index) * HOUR, SOL / 20n);
    }
    await insertPosition("lane-open", laneRun, "paper", NOW - HOUR, null);
    await insertPosition("ended-0", endedLane, "paper", NOW - 25 * HOUR, -SOL / 10n);
    await insertPosition("lab-0", labRun, "backtest", NOW - 5 * HOUR, SOL);
    await database.db.query(
      `INSERT INTO signals (run_id, type, mint, at, slot, acted) VALUES ($1, 'score_momentum', $3, $4, 1, true), ($2, 'score_momentum', $3, $4, 1, true)`,
      [mainRun, laneRun, mintAt(50), new Date(NOW - HOUR)]
    );
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("leaves lane runs out of every automatic run and mode pick, like lab runs, and includes them when chosen", async () => {
    const paper = await loadClosedTrades(database.db, { mode: "paper" });
    expect(new Set(paper.map((trade) => trade.runId))).toEqual(new Set([mainRun]));
    expect(await loadClosedTrades(database.db, { runId: laneRun })).toHaveLength(4);
    expect((await loadModes(database.db)).find((mode) => mode.mode === "paper")?.closedTrades).toBe(6);
    expect((await selectPositionsRun(database.db, {}))?.id).toBe(mainRun);
    expect((await selectPositionsRun(database.db, { runId: laneRun }))?.label).toBe("paper:momentum-loose");
    expect((await recentSignals(database.db, {})).map((item) => item.runId)).toEqual([mainRun]);
    expect((await recentSignals(database.db, { runId: laneRun })).map((item) => item.runId)).toEqual([laneRun]);
    const listed = (await loadRuns(database.db)).map((run) => run.label);
    expect(listed).toContain("paper:momentum-loose");
    expect(listed).not.toContain("lab:1:baseline");
  });

  it("summarizes the main run and every lane with confidence intervals, open positions and a same-period comparison", async () => {
    const overview = await loadLivePaperStrategies(database.db, {
      summary: { minTrades: 3, bootstrapIterations: 200, seed: "lanes" },
      tradeLimit: 1_000,
      strategies: [
        { name: "main", runId: mainRun, label: null, draining: false, tradingActive: true },
        { name: "momentum-loose", runId: laneRun, label: "paper:momentum-loose", draining: false, tradingActive: true }
      ]
    });
    expect(overview.mainRunId).toBe(mainRun);
    expect(overview.rows.map((entry) => [entry.strategy, entry.status, entry.trades, entry.openPositions])).toEqual([
      ["main", "running", 6, 0],
      ["momentum-loose", "running", 4, 1],
      ["fast-exits", "ended", 1, 0]
    ]);
    const lane = overview.rows[1];
    expect(lane?.expectancySol).toBeCloseTo(0.05, 9);
    expect(lane?.winRate).toBe(1);
    expect(lane?.totalPnlSol).toBeCloseTo(0.2, 9);
    expect(lane?.ciLowSol).not.toBeNull();
    expect(lane?.mainSameWindowTrades).toBe(1);
    expect(lane?.mainSameWindowExpectancySol).toBeCloseTo(0.02, 9);
    expect(lane?.vsMainSol).toBeCloseTo(0.03, 9);
    expect(lane?.changes.map((change) => change.setting)).toEqual(["signals.enabled", "signals.scoreMomentum.maxRiskScore"]);
    expect(overview.rows[0]?.vsMainSol).toBeNull();
    const elsewhere = await loadLivePaperStrategies(database.db, { summary: { bootstrapIterations: 200 }, tradeLimit: 1_000, strategies: null });
    expect(elsewhere.rows.map((entry) => entry.status)).toEqual(["open", "open", "ended"]);
  });

  it("serves the lane table and lane entry rules over the API", async () => {
    const server = await startAnalyticsServer({ db: database.db as Db, port: 0, host: "127.0.0.1", token: "lanes-token-0123456789abcdef", cacheTtlMs: 0 });
    try {
      const get = async (path: string): Promise<Record<string, unknown>> =>
        (await (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: "Bearer lanes-token-0123456789abcdef" } })).json()) as Record<string, unknown>;
      const live = (await get("/api/lab/live")) as { rows: Array<{ strategy: string }> };
      expect(live.rows.map((entry) => entry.strategy)).toEqual(["main", "momentum-loose", "fast-exits"]);
      const lanePositions = (await get(`/api/positions?runId=${laneRun}`)) as { run: { label: string }; entryRules: { enabled: string[]; scoreMomentum: { maxRiskScore: number } } };
      expect(lanePositions.run.label).toBe("paper:momentum-loose");
      expect(lanePositions.entryRules).toMatchObject({ enabled: ["score_momentum"], scoreMomentum: { maxRiskScore: 50 } });
      const main = (await get("/api/positions")) as { run: { id: number } };
      expect(main.run.id).toBe(mainRun);
      expect(await laneRunSettings(database.db, mainRun)).toMatchObject({ entryRules: { scoreMomentum: { maxRiskScore: 35 } } });
    } finally {
      await server.close();
    }
  });
});
