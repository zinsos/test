import { hydrateLaunches } from "../backtest/loader.js";
import { parseStrategyConfig, tradingRunConfig, type StrategyConfig } from "../config/strategy.js";
import { Bus, type BusEvents } from "../core/bus.js";
import type { Clock } from "../core/clock.js";
import type { MarketDataSource, ScoreProvider, TrackedWalletProvider } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { LaunchScore, Pubkey } from "../core/types.js";
import { toNumber, type Db } from "../db/pool.js";
import { marketDataSource } from "../execution/marketSource.js";
import { PaperExecutor } from "../execution/paperExecutor.js";
import { ExitEventWatcher } from "../exits/watcher.js";
import type { MarketState } from "../market/state.js";
import { RiskManager } from "../risk/manager.js";
import { loadRiskState } from "../risk/persistence.js";
import { SignalEngine } from "../tracker/signals.js";
import {
  canonicalJson,
  killResetRequestsAfter,
  latestKillResetRequestId,
  loadOpenPositions,
  PAPER_LANE_LABEL_PREFIX
} from "../trader/runs.js";
import { PgTradingStore } from "../trader/store.js";
import { Trader, type TraderStats } from "../trader/trader.js";
import { laneLockName, LaneLocks } from "./laneLocks.js";
import { laneNameOfLabel, laneScoreView, SharedScoreRequests, viewedScores, type PaperLaneSpec, type ScoreView } from "./paperLaneSpecs.js";
import { Repeater } from "./repeater.js";

const log = moduleLogger("app.paper-lanes");
const LAMPORTS_PER_SOL = 1e9;
const ERROR_LOG_EVERY = 1_000;

export type PaperLaneKind = "active" | "draining";
export type PaperLaneState = "ready" | "running" | "halted" | "finishing" | "finished";
export type PaperLaneEndReason = "config_changed" | "lane_removed";

export interface LaneRunRow {
  runId: number;
  label: string;
  config: unknown;
  startedAtMs: number;
}

export interface PaperLaneStatus {
  name: string;
  strategy: string;
  label: string;
  runId: number;
  kind: PaperLaneKind;
  state: PaperLaneState;
  resumed: boolean;
  startedAtMs: number;
  open: number;
  closed: number;
  signals: number;
  entriesFilled: number;
  equitySol: number;
  realizedSol: number;
  killed: boolean;
  haltedForDay: boolean;
  errors: number;
}

export interface PaperLanesOptions {
  db: Db;
  bus: Bus;
  market: MarketState;
  clock: Clock;
  tracked: TrackedWalletProvider;
  scores: ScoreProvider;
  base: StrategyConfig;
  specs: readonly PaperLaneSpec[];
  killResetPollMs?: number;
  onLaneFinished?: (lane: PaperLane) => void;
}

interface LaneSeed {
  kind: PaperLaneKind;
  name: string;
  label: string;
  runId: number;
  startedAtMs: number;
  resumed: boolean;
  config: StrategyConfig;
  endReason: PaperLaneEndReason | null;
}

interface LaneParts {
  bus: Bus;
  engine: SignalEngine;
  risk: RiskManager;
  trader: Trader;
  scoreView: ScoreView | null;
  lastResetId: number;
}

export async function openLaneRuns(db: Db): Promise<LaneRunRow[]> {
  const result = await db.query<{ id: unknown; label: string; config: unknown; started_at: Date }>(
    `SELECT id, label, config, started_at FROM strategy_runs
      WHERE mode = 'paper' AND ended_at IS NULL AND label LIKE $1
      ORDER BY id DESC`,
    [`${PAPER_LANE_LABEL_PREFIX}%`]
  );
  return result.rows.map((row) => ({ runId: toNumber(row.id), label: row.label, config: row.config, startedAtMs: row.started_at.getTime() }));
}

function lamportsToSol(value: bigint): number {
  return Math.round((Number(value) / LAMPORTS_PER_SOL) * 10_000) / 10_000;
}

function drainConfigOf(stored: unknown, fallback: StrategyConfig, runId: number): StrategyConfig {
  try {
    return parseStrategyConfig(stored);
  } catch (error) {
    log.warn({ err: error, runId }, "stored lane config no longer parses; closing its positions with the current base strategy exits");
    return fallback;
  }
}

export class PaperLane {
  readonly kind: PaperLaneKind;
  readonly name: string;
  readonly strategy: string;
  readonly label: string;
  readonly runId: number;
  readonly startedAtMs: number;
  readonly resumed: boolean;
  readonly config: StrategyConfig;
  readonly endReason: PaperLaneEndReason | null;
  readonly bus: Bus;
  readonly engine: SignalEngine;
  readonly risk: RiskManager;
  readonly trader: Trader;
  private readonly scoreView: ScoreView | null;
  lastResetId: number;
  state: PaperLaneState = "ready";
  errors = 0;

  constructor(seed: LaneSeed, parts: LaneParts) {
    this.kind = seed.kind;
    this.name = seed.name;
    this.strategy = seed.kind === "active" ? seed.name : `${seed.name}@${seed.runId}`;
    this.label = seed.label;
    this.runId = seed.runId;
    this.startedAtMs = seed.startedAtMs;
    this.resumed = seed.resumed;
    this.config = seed.config;
    this.endReason = seed.endReason;
    this.bus = parts.bus;
    this.engine = parts.engine;
    this.risk = parts.risk;
    this.trader = parts.trader;
    this.scoreView = parts.scoreView;
    this.lastResetId = parts.lastResetId;
  }

  deliver<K extends "chain" | "gap">(event: K, payload: BusEvents[K]): void {
    try {
      this.bus.emit(event, payload);
    } catch (error) {
      this.fault(error, event);
    }
  }

  deliverScore(score: LaunchScore): void {
    try {
      this.bus.emit("score", this.scoreView ? this.scoreView(score) : score);
    } catch (error) {
      this.fault(error, "score");
    }
  }

  isFlat(): boolean {
    return this.trader.openPositions().length === 0 && this.trader.inFlightCount() === 0;
  }

  status(): PaperLaneStatus {
    const stats: TraderStats = this.trader.stats();
    const risk = this.risk.status();
    return {
      name: this.name,
      strategy: this.strategy,
      label: this.label,
      runId: this.runId,
      kind: this.kind,
      state: this.state,
      resumed: this.resumed,
      startedAtMs: this.startedAtMs,
      open: stats.open,
      closed: stats.closed,
      signals: stats.signals,
      entriesFilled: stats.entriesFilled,
      equitySol: lamportsToSol(risk.equityLamports),
      realizedSol: lamportsToSol(risk.realizedPnlLamports),
      killed: risk.killed,
      haltedForDay: risk.haltedForDay,
      errors: this.errors
    };
  }

  private fault(error: unknown, event: string): void {
    this.errors += 1;
    if (this.errors === 1 || this.errors % ERROR_LOG_EVERY === 0) {
      log.error({ err: error, lane: this.strategy, event, errors: this.errors }, "paper lane failed to handle an event");
    }
  }
}

export class PaperLanes {
  private readonly options: PaperLanesOptions;
  private readonly source: MarketDataSource;
  private readonly scores: SharedScoreRequests;
  private readonly locks: LaneLocks;
  private readonly store: PgTradingStore;
  private readonly all: PaperLane[] = [];
  private running: PaperLane[] = [];
  private detachShared: Array<() => void> = [];
  private repeater: Repeater | null = null;
  private storeStarted = false;
  private started = false;
  private stopping: Promise<void> | null = null;

  private constructor(options: PaperLanesOptions) {
    this.options = options;
    this.source = marketDataSource(options.market, options.clock);
    this.scores = new SharedScoreRequests(options.scores);
    this.locks = new LaneLocks({ db: options.db, onLost: () => this.onLocksLost() });
    this.store = new PgTradingStore({ db: options.db });
  }

  static async open(options: PaperLanesOptions): Promise<PaperLanes> {
    const lanes = new PaperLanes(options);
    try {
      await lanes.prepare();
    } catch (error) {
      await lanes.stop();
      throw error;
    }
    return lanes;
  }

  lanes(): readonly PaperLane[] {
    return this.all;
  }

  status(): PaperLaneStatus[] {
    return this.all.map((lane) => lane.status());
  }

  hasOpenPosition(mint: Pubkey): boolean {
    return this.all.some((lane) => lane.state !== "finished" && lane.trader.hasOpenPosition(mint));
  }

  start(): void {
    if (this.started || this.stopping) {
      return;
    }
    this.started = true;
    if (this.all.length === 0) {
      return;
    }
    const bus = this.options.bus;
    this.detachShared = [
      bus.on("chain", (event) => this.forward("chain", event)),
      bus.on("gap", (gap) => this.forward("gap", gap)),
      bus.on("score", (score) => this.forwardScore(score))
    ];
    for (const lane of this.all) {
      if (lane.state !== "ready") {
        continue;
      }
      lane.engine.start();
      lane.trader.start();
      lane.state = "running";
      log.info({ lane: lane.strategy, runId: lane.runId, kind: lane.kind, resumed: lane.resumed, open: lane.trader.openPositions().length }, "paper lane trading");
    }
    this.refreshRunning();
    this.repeater = new Repeater({
      clock: this.options.clock,
      name: "paper-lane-kill-reset",
      intervalMs: this.options.killResetPollMs ?? 30_000,
      run: () => this.pollKillResets()
    });
    this.repeater.start();
    for (const lane of this.all) {
      this.maybeFinish(lane);
    }
  }

  halt(): void {
    for (const detach of this.detachShared) {
      detach();
    }
    this.detachShared = [];
    for (const lane of this.all) {
      lane.trader.halt();
      if (lane.state === "running" || lane.state === "ready") {
        lane.state = "halted";
      }
    }
    this.running = [];
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.halt();
    await this.repeater?.stop();
    await Promise.all(
      this.all.map(async (lane) => {
        try {
          await lane.engine.stop();
          await lane.trader.stop();
        } catch (error) {
          log.error({ err: error, lane: lane.strategy }, "paper lane stop failed");
        }
      })
    );
    if (this.storeStarted) {
      await this.store.stop().catch((error: unknown) => log.error({ err: error }, "paper lane store flush failed"));
    }
    await this.locks.release();
  }

  private async prepare(): Promise<void> {
    const runs = await openLaneRuns(this.options.db);
    if (this.options.specs.length === 0 && runs.length === 0) {
      return;
    }
    const resumedRunIds = new Set<number>();
    for (const spec of this.options.specs) {
      const lane = await this.openActive(spec, runs).catch((error: unknown) => {
        log.error({ err: error, lane: spec.name }, "paper lane failed to start; the main trader and other lanes continue");
        return null;
      });
      if (lane) {
        resumedRunIds.add(lane.runId);
      }
    }
    const activeLabels = new Set(this.options.specs.map((spec) => spec.label));
    for (const run of runs) {
      if (resumedRunIds.has(run.runId)) {
        continue;
      }
      const reason: PaperLaneEndReason = activeLabels.has(run.label) ? "config_changed" : "lane_removed";
      await this.retire(run, reason).catch((error: unknown) => {
        log.error({ err: error, runId: run.runId, label: run.label }, "retiring an old paper lane run failed");
      });
    }
  }

  private async ensureStore(): Promise<void> {
    if (this.storeStarted) {
      return;
    }
    await this.store.prepare();
    this.store.start();
    this.storeStarted = true;
  }

  private async openActive(spec: PaperLaneSpec, runs: readonly LaneRunRow[]): Promise<PaperLane | null> {
    if (!(await this.locks.tryAcquire(laneLockName(spec.label)))) {
      log.warn({ lane: spec.name }, "another process trades this paper lane; it is not started here");
      return null;
    }
    await this.ensureStore();
    const runConfig = tradingRunConfig(spec.config);
    const wanted = canonicalJson(runConfig);
    const match = runs.find((run) => run.label === spec.label && canonicalJson(run.config) === wanted) ?? null;
    const runId = match?.runId ?? (await this.store.createRun({ mode: "paper", label: spec.label, config: runConfig, dataFrom: null, dataTo: null }));
    const startedAtMs = match?.startedAtMs ?? this.options.clock.nowMs();
    return this.build({
      kind: "active",
      name: spec.name,
      label: spec.label,
      runId,
      startedAtMs,
      resumed: match !== null,
      config: spec.config,
      endReason: null
    });
  }

  private async retire(run: LaneRunRow, reason: PaperLaneEndReason): Promise<void> {
    if (!(await this.locks.tryAcquire(laneLockName(run.label)))) {
      log.debug({ runId: run.runId, label: run.label }, "another process holds this paper lane run");
      return;
    }
    await this.ensureStore();
    const open = await loadOpenPositions(this.options.db, run.runId);
    if (open.length === 0) {
      await this.store.finishRun(run.runId, { endedBy: "paper-lanes", reason, openPositions: 0 });
      log.info({ runId: run.runId, label: run.label, reason }, "old paper lane run ended");
      return;
    }
    const name = laneNameOfLabel(run.label) ?? run.label;
    const config = drainConfigOf(run.config, this.options.base, run.runId);
    const lane = await this.build({ kind: "draining", name, label: run.label, runId: run.runId, startedAtMs: run.startedAtMs, resumed: true, config, endReason: reason });
    log.info({ runId: run.runId, label: run.label, reason, open: lane.trader.openPositions().length }, "old paper lane run closes its open positions without new entries, then ends");
  }

  private async build(seed: LaneSeed): Promise<PaperLane> {
    const { db, clock, market, tracked } = this.options;
    const config = seed.config;
    const bus = new Bus();
    const scoreView = laneScoreView(this.options.base, config);
    const signals = seed.kind === "draining" ? { ...config.signals, enabled: [] } : config.signals;
    const engine = new SignalEngine({
      clock,
      bus,
      market,
      scores: viewedScores(this.scores, scoreView),
      tracked,
      signals,
      convergence: config.tracker.convergence,
      onRejected: null
    });
    const risk = new RiskManager({
      runId: seed.runId,
      config: config.risk,
      clock,
      mode: "paper",
      store: this.store,
      persisted: await loadRiskState(db, seed.runId),
      bus
    });
    const trader = new Trader({
      runId: seed.runId,
      mode: "paper",
      clock,
      bus,
      market: this.source,
      executor: new PaperExecutor({ clock, market: this.source, config: config.execution, mode: "paper" }),
      risk,
      exits: config.exits,
      execution: config.execution,
      watcher: new ExitEventWatcher({ market: this.source, creationWindowSlots: config.scorer.bundleSlotWindow }),
      store: this.store,
      smartExitCount: (mint, sinceMs) => engine.smartExitCount(mint, sinceMs),
      tradableQuoteMints: config.signals.quoteMints
    });
    const open = await loadOpenPositions(db, seed.runId);
    if (open.length > 0) {
      await hydrateLaunches(db, market, open.map((position) => position.mint));
    }
    trader.restore(open);
    const lane = new PaperLane(seed, { bus, engine, risk, trader, scoreView, lastResetId: await latestKillResetRequestId(db, seed.runId) });
    if (seed.kind === "draining") {
      bus.on("positionClosed", () => queueMicrotask(() => this.maybeFinish(lane)));
    }
    this.all.push(lane);
    return lane;
  }

  private refreshRunning(): void {
    this.running = this.all.filter((lane) => lane.state === "running");
  }

  private forward<K extends "chain" | "gap">(event: K, payload: BusEvents[K]): void {
    for (const lane of this.running) {
      lane.deliver(event, payload);
    }
  }

  private forwardScore(score: LaunchScore): void {
    for (const lane of this.running) {
      lane.deliverScore(score);
    }
  }

  private maybeFinish(lane: PaperLane): void {
    if (lane.kind !== "draining" || lane.state !== "running" || !lane.isFlat()) {
      return;
    }
    lane.state = "finishing";
    this.refreshRunning();
    void this.finish(lane);
  }

  private async finish(lane: PaperLane): Promise<void> {
    try {
      await lane.engine.stop();
      await lane.trader.stop();
      await this.store.finishRun(lane.runId, { endedBy: "paper-lanes", reason: lane.endReason, closedTrades: lane.trader.stats().closed });
      lane.state = "finished";
      log.info({ runId: lane.runId, label: lane.label, reason: lane.endReason }, "old paper lane run closed its last position and ended");
      this.options.onLaneFinished?.(lane);
    } catch (error) {
      lane.state = "halted";
      log.error({ err: error, runId: lane.runId }, "ending an old paper lane run failed; it is retried on the next start");
    }
  }

  private async pollKillResets(): Promise<void> {
    for (const lane of this.all) {
      if (lane.state === "finished") {
        continue;
      }
      for (const request of await killResetRequestsAfter(this.options.db, lane.runId, lane.lastResetId)) {
        lane.lastResetId = request.id;
        lane.risk.resetKill(`cli: ${request.reason}`);
        log.warn({ lane: lane.strategy, runId: lane.runId, reason: request.reason }, "paper lane kill switch reset by request");
      }
    }
  }

  private onLocksLost(): void {
    this.halt();
  }
}
