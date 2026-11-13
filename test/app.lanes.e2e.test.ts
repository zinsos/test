import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadClosedTrades } from "../src/analytics/index.js";
import { runCli } from "../src/app/cli.js";
import { startLiveApp } from "../src/app/live.js";
import { resolvePaperLanes, type PaperLaneSpec } from "../src/app/paperLaneSpecs.js";
import type { RpcClient } from "../src/chain/rpc.js";
import { loadEnv } from "../src/config/env.js";
import { loadStrategyConfig, type StrategyConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import type { ClosedTrade } from "../src/core/types.js";
import { ReplayLogSource } from "../src/ingest/replaySource.js";
import { loadLabVariants } from "../src/lab/variants.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { buildScenario, decodeResultOf, ScenarioIntelRpc, simulateScenario, type Scenario } from "./e2e.market.js";
import { recordScenario, STREAM_LAG_MS } from "./e2e.recording.js";

interface BacktestJson {
  runId: number;
  trades: { n: number };
  counts: { signalsAccepted: number };
}

interface ActedSignal {
  mint: string;
  type: string;
}

function comparableTrade(trade: ClosedTrade): string {
  return [trade.mint, trade.signalType, trade.openedAtMs, trade.closedAtMs, trade.cost, trade.proceeds, trade.pnl, trade.fees, trade.exitReason, trade.riskScore].join("|");
}

function serviceConfig(base: StrategyConfig): StrategyConfig {
  const config = structuredClone(base);
  config.signals.enabled = ["smart_convergence", "score_momentum"];
  return config;
}

describe.skipIf(!hasTestDatabase)("end to end: live paper lanes trade exactly like backtests of their variants", () => {
  let database: TestDatabase;
  let scenario: Scenario;
  let config: StrategyConfig;
  let configDir: string;
  let lanes: PaperLaneSpec[] = [];
  const backtests = new Map<string, BacktestJson>();

  const cli = async (argv: string[]): Promise<{ code: number; out: string[] }> => {
    const out: string[] = [];
    const code = await runCli(argv, { out: (line) => out.push(line), err: () => undefined }, { env: loadEnv({ DATABASE_URL: database.url, LOG_LEVEL: "warn" }) });
    return { code, out };
  };

  const backtest = async (label: string, strategy: StrategyConfig): Promise<BacktestJson> => {
    const file = path.join(configDir, `${label}.json`);
    writeFileSync(file, JSON.stringify(strategy, null, 2));
    const run = await cli(["backtest", "--from", String(scenario.windowStartMs), "--to", String(scenario.windowEndMs), "--label", label, "--config", file, "--json"]);
    expect(run.code).toBe(0);
    return JSON.parse(run.out[run.out.length - 1] ?? "{}") as BacktestJson;
  };

  beforeAll(async () => {
    database = await createTestDatabase("app_lanes_e2e");
    configDir = mkdtempSync(path.join(tmpdir(), "snypra-lanes-"));
    scenario = buildScenario("e2e-backtest-v1");
    config = serviceConfig(await loadStrategyConfig("config/strategy.json"));
    const recording = structuredClone(config);
    recording.recorder.metadata.enabled = false;
    recording.recorder.rpcSnapshotsEnabled = false;
    await database.db.query("INSERT INTO known_entities (address, kind, label, added_at) VALUES ($1, 'cex', 'exchange hot wallet', $2)", [
      scenario.cex,
      new Date(scenario.t0Ms - 86_400_000)
    ]);
    await recordScenario(database.db, scenario, recording);
    const rankFile = path.join(configDir, "rank.json");
    writeFileSync(rankFile, JSON.stringify(config));
    expect((await cli(["rank-wallets", "--as-of", String(scenario.windowStartMs), "--config", rankFile])).code).toBe(0);
    lanes = resolvePaperLanes({ names: ["all"], source: "test" }, await loadLabVariants(), config);
    backtests.set("main", await backtest("lanes-main", config));
    for (const lane of lanes) {
      backtests.set(lane.name, await backtest(`lanes-${lane.name}`, lane.config));
    }
  }, 600_000);

  afterAll(async () => {
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
    }
    await database?.drop();
  });

  it("streams the window once through the main trader and six lanes and matches seven separate backtests trade for trade", async () => {
    const clock = new VirtualClock(scenario.windowStartMs);
    const app = await startLiveApp({
      env: loadEnv({
        DATABASE_URL: database.url,
        MODULES: "trader",
        TRADING_MODE: "paper",
        RPC_WS_URL: "ws://127.0.0.1:9",
        LOG_LEVEL: "warn",
        PAPER_VARIANTS: "all"
      }),
      config,
      clock,
      db: database.db,
      rpc: new ScenarioIntelRpc(scenario.profiles) as unknown as RpcClient,
      source: new ReplayLogSource({ clock, transactions: [] }),
      port: 0
    });
    const pipeline = app.ingest?.pipeline;
    const engines = [app.tracker?.signals, ...(app.paperLanes?.lanes() ?? []).map((lane) => lane.engine)];
    expect(engines).toHaveLength(7);
    const window = simulateScenario(scenario).filter((tx) => tx.atMs >= scenario.windowStartMs && tx.atMs < scenario.windowEndMs);
    for (const tx of window) {
      await clock.advanceTo(tx.atMs + STREAM_LAG_MS);
      pipeline?.handleBatch(decodeResultOf(tx, clock.nowMs()), {
        signature: tx.signature,
        slot: tx.slot,
        seq: tx.events[0]?.tx.seq ?? 0,
        receivedAtMs: clock.nowMs()
      });
      for (const engine of engines) {
        await engine?.idle();
      }
    }
    await clock.advanceTo(scenario.windowEndMs);
    const runIds = new Map<string, number>([["main", app.runId ?? 0], ...(app.paperLanes?.lanes() ?? []).map((lane) => [lane.name, lane.runId] as [string, number])]);
    await app.stop("parity");
    const acted = async (runId: number): Promise<string[]> => {
      const result = await database.db.query<ActedSignal>("SELECT mint, type FROM signals WHERE run_id = $1 AND acted ORDER BY at, id", [runId]);
      return result.rows.map((row) => `${row.mint}|${row.type}`);
    };
    const differing = new Set<string>();
    const baseline = (await loadClosedTrades(database.db, { runId: backtests.get("main")?.runId ?? 0 })).map(comparableTrade);
    for (const [name, runId] of runIds) {
      const replay = backtests.get(name);
      expect(replay, name).toBeDefined();
      const live = (await loadClosedTrades(database.db, { runId, mode: "paper" })).map(comparableTrade);
      const replayed = (await loadClosedTrades(database.db, { runId: replay?.runId ?? 0, mode: "backtest" })).map(comparableTrade);
      expect({ name, trades: live }).toEqual({ name, trades: replayed });
      expect(live.length, name).toBe(replay?.trades.n);
      expect({ name, signals: await acted(runId) }).toEqual({ name, signals: await acted(replay?.runId ?? 0) });
      if (JSON.stringify(replayed) !== JSON.stringify(baseline)) {
        differing.add(name);
      }
    }
    expect(backtests.get("main")?.trades.n).toBeGreaterThan(5);
    expect([...differing].sort()).toEqual(expect.arrayContaining(["fast-exits", "trade-blocked-event-exits"]));
  }, 300_000);
});
