import type { IncomingMessage, ServerResponse } from "node:http";
import { defaultStrategyConfig } from "../config/strategy.js";
import type { Clock } from "../core/clock.js";
import type { LaunchScore, Pubkey, TradingMode } from "../core/types.js";
import type { Db } from "../db/pool.js";
import { DEFAULT_LABEL_HORIZON_HOURS } from "../scorer/dataset.js";
import type { TtlCache } from "./cache.js";
import { DEFAULT_CALIBRATION_MAX_RISK, DEFAULT_MIN_CALIBRATION_LAUNCHES } from "./calibration.js";
import { DEFAULT_RISK_BUCKET_WIDTH, isBreakdownDimension } from "./dimensions.js";
import { closedTradesCsv, scorerDatasetCsv } from "./exports.js";
import {
  cacheKey,
  HttpError,
  optionalText,
  parseFlag,
  parseInteger,
  parseMint,
  parseMode,
  parseTime
} from "./http.js";
import {
  allBreakdowns,
  breakdown,
  comparePaperLive,
  DEFAULT_BOOTSTRAP_ITERATIONS,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_MIN_PAIRS,
  DEFAULT_MIN_TRADES,
  DEFAULT_MIN_TRADES_PER_BUCKET,
  equitySeries,
  summarizeTrades,
  type TradeSummary
} from "./metrics.js";
import { describeCalibration, describeComparison, describeRecorder, describeSummary } from "./narrative.js";
import {
  DEFAULT_RECENT_CLOSED_LIMIT,
  emptyPositionsSnapshot,
  loadPositionsSnapshot,
  MAX_RECENT_CLOSED_LIMIT,
  selectPositionsRun,
  sellFeeDefaultsOf,
  type EntryRules,
  type SellFeeDefaults
} from "./positionQueries.js";
import { latestScore, recentLaunches, recentSignals, trackedWallets } from "./activityQueries.js";
import { loadLabOverview } from "./labQueries.js";
import type { LiveHub, LiveStatus } from "./liveHub.js";
import { recorderHealth } from "./recorderQueries.js";
import { scoreCheckpoints, scorerCalibration } from "./scorerQueries.js";
import {
  DEFAULT_TRADE_LIMIT,
  loadClosedTrades,
  loadModes,
  loadPaperLivePairs,
  loadRuns,
  type ClosedTradeRecord,
  type TradeFilter
} from "./tradeQueries.js";

export interface AnalyticsSettings {
  minTrades: number;
  minTradesPerBucket: number;
  minPairs: number;
  maxRisk: number;
  riskBucketWidth: number;
  bootstrapIterations: number;
  seed: string;
  tradeLimit: number;
  minCalibrationLaunches: number;
  defaultCheckpointSec: number;
  labelHorizonHours: number;
  sellFees: SellFeeDefaults;
  entryRules: EntryRules | null;
  dayResetUtcHour: number;
}

export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = {
  minTrades: DEFAULT_MIN_TRADES,
  minTradesPerBucket: DEFAULT_MIN_TRADES_PER_BUCKET,
  minPairs: DEFAULT_MIN_PAIRS,
  maxRisk: DEFAULT_CALIBRATION_MAX_RISK,
  riskBucketWidth: DEFAULT_RISK_BUCKET_WIDTH,
  bootstrapIterations: DEFAULT_BOOTSTRAP_ITERATIONS,
  seed: DEFAULT_BOOTSTRAP_SEED,
  tradeLimit: DEFAULT_TRADE_LIMIT,
  minCalibrationLaunches: DEFAULT_MIN_CALIBRATION_LAUNCHES,
  defaultCheckpointSec: 60,
  labelHorizonHours: DEFAULT_LABEL_HORIZON_HOURS,
  sellFees: sellFeeDefaultsOf(defaultStrategyConfig().execution),
  entryRules: null,
  dayResetUtcHour: defaultStrategyConfig().risk.dayResetUtcHour
};

export type ScoreLookup = (mint: Pubkey) => LaunchScore | null;
export type ExtraHealth = () => Record<string, unknown>;

export interface AnalyticsContext {
  db: Db;
  clock: Clock;
  cache: TtlCache;
  settings: AnalyticsSettings;
  scoreLookup: ScoreLookup | null;
  extraHealth: ExtraHealth | null;
  live: LiveHub | null;
}

export interface ApiRequest {
  url: URL;
  params: URLSearchParams;
  segments: string[];
}

export interface CsvStream {
  filename: string;
  chunks: AsyncGenerator<string>;
}

export type JsonRoute = { kind: "json"; cacheable: boolean; handle: (ctx: AnalyticsContext, request: ApiRequest) => Promise<unknown> };
export type CsvRoute = { kind: "csv"; handle: (ctx: AnalyticsContext, request: ApiRequest) => CsvStream };
export type StreamRoute = {
  kind: "stream";
  handle: (ctx: AnalyticsContext, request: ApiRequest, req: IncomingMessage, res: ServerResponse) => void;
};
export type ApiRoute = JsonRoute | CsvRoute | StreamRoute;

const BREAKDOWN_ALL = "all";

export interface FilterEcho {
  mode: TradingMode | null;
  runId: number | null;
  fromMs: number | null;
  toMs: number | null;
  includeShadows: boolean;
}

export function tradeFilterFrom(params: URLSearchParams): FilterEcho {
  return {
    mode: parseMode(params),
    runId: parseInteger(params, "runId", { min: 1 }),
    fromMs: parseTime(params, "from"),
    toMs: parseTime(params, "to"),
    includeShadows: parseFlag(params, "shadows")
  };
}

function loadTrades(ctx: AnalyticsContext, filter: TradeFilter): Promise<ClosedTradeRecord[]> {
  const key = `trades:${JSON.stringify({ ...filter, limit: ctx.settings.tradeLimit })}`;
  return ctx.cache.getOrLoad(key, () => loadClosedTrades(ctx.db, { ...filter, limit: ctx.settings.tradeLimit }));
}

function summaryOf(ctx: AnalyticsContext, trades: readonly ClosedTradeRecord[]): TradeSummary {
  return summarizeTrades(trades, {
    minTrades: ctx.settings.minTrades,
    bootstrapIterations: ctx.settings.bootstrapIterations,
    seed: ctx.settings.seed
  });
}

async function summaryRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const filter = tradeFilterFrom(request.params);
  const trades = await loadTrades(ctx, filter);
  const summary = summaryOf(ctx, trades);
  return { filter, truncated: trades.length >= ctx.settings.tradeLimit, summary, narrative: describeSummary(summary) };
}

async function breakdownRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const filter = tradeFilterFrom(request.params);
  const by = optionalText(request.params, "by") ?? BREAKDOWN_ALL;
  if (by !== BREAKDOWN_ALL && !isBreakdownDimension(by)) {
    throw new HttpError(400, "invalid_by", "by must be riskBucket, signalType, hourUtc, holdBucket, exitReason, weekday or all");
  }
  const trades = await loadTrades(ctx, filter);
  const options = { minTradesPerBucket: ctx.settings.minTradesPerBucket, riskBucketWidth: ctx.settings.riskBucketWidth };
  if (by === BREAKDOWN_ALL) {
    return { filter, n: trades.length, breakdowns: allBreakdowns(trades, options) };
  }
  return { filter, n: trades.length, breakdown: breakdown(trades, by, options) };
}

async function equityRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const filter = tradeFilterFrom(request.params);
  const maxPoints = parseInteger(request.params, "points", { min: 4, max: 5_000 }) ?? undefined;
  const trades = await loadTrades(ctx, filter);
  return { filter, n: trades.length, points: equitySeries(trades, { maxPoints }) };
}

async function modeSnapshot(ctx: AnalyticsContext, filter: FilterEcho, mode: TradingMode): Promise<unknown> {
  const summary = summaryOf(ctx, await loadTrades(ctx, { ...filter, mode, runId: null }));
  return {
    mode,
    n: summary.n,
    winRate: summary.winRate,
    expectancySol: summary.expectancySol,
    decisionCi95: summary.decisionCi95,
    totalPnlSol: summary.totalPnlSol,
    verdict: summary.verdict
  };
}

async function compareRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const filter = tradeFilterFrom(request.params);
  const pairs = await loadPaperLivePairs(ctx.db, { runId: filter.runId, fromMs: filter.fromMs, toMs: filter.toMs });
  const comparison = comparePaperLive(pairs, { minPairs: ctx.settings.minPairs });
  const byMode = [await modeSnapshot(ctx, filter, "live"), await modeSnapshot(ctx, filter, "paper")];
  return { filter, comparison, narrative: describeComparison(comparison), byMode };
}

async function runsRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const limit = parseInteger(request.params, "limit", { min: 1, max: 1_000 }) ?? undefined;
  const includeLab = parseFlag(request.params, "lab");
  return { runs: await loadRuns(ctx.db, { limit, mode: parseMode(request.params), includeLab }), modes: await loadModes(ctx.db) };
}

async function scoreRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const mint = parseMint(request.segments[0] ?? "");
  const memory = ctx.scoreLookup ? ctx.scoreLookup(mint) : null;
  const score = memory ?? (await latestScore(ctx.db, mint));
  if (!score) {
    throw new HttpError(404, "not_scored", "no score recorded for this mint yet");
  }
  return { ...score, source: memory ? "memory" : "db", ageMs: Math.max(0, ctx.clock.nowMs() - score.computedAtMs) };
}

async function signalsRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const signals = await recentSignals(ctx.db, {
    limit: parseInteger(request.params, "limit", { min: 1 }) ?? undefined,
    runId: parseInteger(request.params, "runId", { min: 1 }),
    type: optionalText(request.params, "type")
  });
  return { signals };
}

async function launchesRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const launches = await recentLaunches(ctx.db, {
    limit: parseInteger(request.params, "limit", { min: 1 }) ?? undefined,
    quoteMint: optionalText(request.params, "quote")
  });
  return { launches };
}

function chooseCheckpoint(ctx: AnalyticsContext, requested: number | null, available: readonly number[]): number | null {
  if (requested !== null) {
    return requested;
  }
  if (available.includes(ctx.settings.defaultCheckpointSec)) {
    return ctx.settings.defaultCheckpointSec;
  }
  return available[0] ?? null;
}

async function calibrationRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const params = request.params;
  const checkpoints = await scoreCheckpoints(ctx.db);
  const checkpointSec = chooseCheckpoint(ctx, parseInteger(params, "checkpoint", { min: 0 }), checkpoints);
  const calibration = await scorerCalibration(ctx.db, {
    checkpointSec: checkpointSec ?? ctx.settings.defaultCheckpointSec,
    bucketWidth: parseInteger(params, "width", { min: 1, max: 100 }) ?? ctx.settings.riskBucketWidth,
    maxRisk: parseInteger(params, "maxRisk", { min: 0, max: 100 }) ?? ctx.settings.maxRisk,
    fromMs: parseTime(params, "from"),
    toMs: parseTime(params, "to"),
    quoteMint: optionalText(params, "quote"),
    minLaunches: ctx.settings.minCalibrationLaunches
  });
  return {
    checkpoints,
    ...calibration,
    narrative: describeCalibration(calibration.assessment, calibration.pass, calibration.block)
  };
}

function safeExtraHealth(ctx: AnalyticsContext): Record<string, unknown> | null {
  if (!ctx.extraHealth) {
    return null;
  }
  try {
    return ctx.extraHealth();
  } catch {
    return { error: "unavailable" };
  }
}

async function recorderRoute(ctx: AnalyticsContext): Promise<unknown> {
  const health = await recorderHealth(ctx.db, { nowMs: ctx.clock.nowMs() });
  const narrative = describeRecorder({
    recordingDays: health.recordingDays,
    lastTradeAgeSec: health.lastTradeAgeSec,
    gapCount24h: health.gaps24h.count,
    gapSeconds24h: health.gaps24h.totalSec
  });
  return { ...health, narrative, process: safeExtraHealth(ctx) };
}

async function positionsRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const params = request.params;
  const runId = parseInteger(params, "runId", { min: 1 });
  const mode = parseMode(params);
  const closedLimit = parseInteger(params, "closedLimit", { min: 1, max: MAX_RECENT_CLOSED_LIMIT }) ?? DEFAULT_RECENT_CLOSED_LIMIT;
  const nowMs = ctx.clock.nowMs();
  const run = await selectPositionsRun(ctx.db, { runId, mode });
  if (!run && runId !== null) {
    throw new HttpError(404, "run_not_found", "no strategy run with this id and mode");
  }
  const dayResetUtcHour = ctx.settings.dayResetUtcHour;
  const snapshot = run
    ? await loadPositionsSnapshot(ctx.db, run, { closedLimit, nowMs, fees: ctx.settings.sellFees, dayResetUtcHour })
    : emptyPositionsSnapshot(nowMs, dayResetUtcHour);
  return { filter: { runId, mode }, ...snapshot, entryRules: ctx.settings.entryRules };
}

async function walletsRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  return trackedWallets(ctx.db, { limit: parseInteger(request.params, "limit", { min: 1 }) ?? undefined });
}

const POSITION_ID = /^[A-Za-z0-9_-]{1,160}$/;

const LIVE_DISABLED: LiveStatus = {
  enabled: false,
  streamId: null,
  clients: 0,
  maxClients: 0,
  tradingActive: false,
  events: 0,
  lastEventAtMs: null,
  openPositions: 0,
  heartbeatMs: 0
};

function liveStatusRoute(ctx: AnalyticsContext): Promise<unknown> {
  return Promise.resolve(ctx.live ? ctx.live.status() : LIVE_DISABLED);
}

function liveSeriesRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  const raw = request.segments[0] ?? "";
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "invalid_position", "position id is malformed");
  }
  if (!POSITION_ID.test(id)) {
    throw new HttpError(400, "invalid_position", "position id is malformed");
  }
  const series = ctx.live?.series(id) ?? null;
  if (!series) {
    throw new HttpError(404, "position_not_open", "no open position with this id in this process");
  }
  return Promise.resolve(series);
}

function liveStreamRoute(ctx: AnalyticsContext, _request: ApiRequest, req: IncomingMessage, res: ServerResponse): void {
  if (!ctx.live) {
    throw new HttpError(404, "live_unavailable", "this service has no live event stream; run the dashboard in the trading service");
  }
  ctx.live.connect(req, res);
}

async function labRoute(ctx: AnalyticsContext, request: ApiRequest): Promise<unknown> {
  return loadLabOverview(ctx.db, { historyLimit: parseInteger(request.params, "history", { min: 1, max: 200 }) ?? undefined });
}

function scorerDatasetRoute(ctx: AnalyticsContext, request: ApiRequest): CsvStream {
  const params = request.params;
  return {
    filename: "scorer-dataset.csv",
    chunks: scorerDatasetCsv(ctx.db, {
      checkpointSec: parseInteger(params, "checkpoint", { min: 0 }),
      fromMs: parseTime(params, "from"),
      toMs: parseTime(params, "to"),
      quoteMint: optionalText(params, "quote"),
      includeUnknown: parseFlag(params, "all"),
      maturedBeforeMs: ctx.clock.nowMs() - ctx.settings.labelHorizonHours * 3_600_000,
      limit: parseInteger(params, "limit", { min: 1 })
    })
  };
}

function tradesCsvRoute(ctx: AnalyticsContext, request: ApiRequest): CsvStream {
  const filter = tradeFilterFrom(request.params);
  return {
    filename: "trades.csv",
    chunks: closedTradesCsv(ctx.db, { ...filter, limit: parseInteger(request.params, "limit", { min: 1 }) })
  };
}

const ROUTES: ReadonlyMap<string, ApiRoute> = new Map<string, ApiRoute>([
  ["summary", { kind: "json", cacheable: true, handle: summaryRoute }],
  ["breakdown", { kind: "json", cacheable: true, handle: breakdownRoute }],
  ["equity", { kind: "json", cacheable: true, handle: equityRoute }],
  ["compare", { kind: "json", cacheable: true, handle: compareRoute }],
  ["runs", { kind: "json", cacheable: true, handle: runsRoute }],
  ["positions", { kind: "json", cacheable: false, handle: positionsRoute }],
  ["score", { kind: "json", cacheable: false, handle: scoreRoute }],
  ["signals/recent", { kind: "json", cacheable: true, handle: signalsRoute }],
  ["launches/recent", { kind: "json", cacheable: true, handle: launchesRoute }],
  ["scorer/calibration", { kind: "json", cacheable: true, handle: calibrationRoute }],
  ["recorder/health", { kind: "json", cacheable: true, handle: (ctx) => recorderRoute(ctx) }],
  ["wallets/tracked", { kind: "json", cacheable: true, handle: walletsRoute }],
  ["lab", { kind: "json", cacheable: true, handle: labRoute }],
  ["live/status", { kind: "json", cacheable: false, handle: (ctx) => liveStatusRoute(ctx) }],
  ["live/stream", { kind: "stream", handle: liveStreamRoute }],
  ["export/scorer-dataset.csv", { kind: "csv", handle: scorerDatasetRoute }],
  ["export/trades.csv", { kind: "csv", handle: tradesCsvRoute }]
]);

interface ParameterizedRoute {
  prefix: string;
  suffix: string;
  route: ApiRoute;
}

const PARAMETERIZED_ROUTES: readonly ParameterizedRoute[] = [
  { prefix: "score/", suffix: "", route: { kind: "json", cacheable: false, handle: scoreRoute } },
  { prefix: "live/position/", suffix: "/series", route: { kind: "json", cacheable: false, handle: liveSeriesRoute } }
];

export function resolveRoute(apiPath: string): { route: ApiRoute; segments: string[] } | null {
  const exact = ROUTES.get(apiPath);
  if (exact) {
    return { route: exact, segments: [] };
  }
  for (const pattern of PARAMETERIZED_ROUTES) {
    if (apiPath.length <= pattern.prefix.length + pattern.suffix.length) {
      continue;
    }
    if (!apiPath.startsWith(pattern.prefix) || !apiPath.endsWith(pattern.suffix)) {
      continue;
    }
    const rest = apiPath.slice(pattern.prefix.length, apiPath.length - pattern.suffix.length);
    if (!rest.includes("/")) {
      return { route: pattern.route, segments: [rest] };
    }
  }
  return null;
}

export function runJsonRoute(ctx: AnalyticsContext, route: JsonRoute, request: ApiRequest): Promise<unknown> {
  if (!route.cacheable) {
    return route.handle(ctx, request);
  }
  return ctx.cache.getOrLoad(`json:${cacheKey(request.url)}`, () => route.handle(ctx, request));
}
