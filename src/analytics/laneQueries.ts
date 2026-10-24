import { parseStrategyConfig } from "../config/strategy.js";
import type { ClosedTrade } from "../core/types.js";
import { toNumber, type Db } from "../db/pool.js";
import { PAPER_LANE_LABEL_PREFIX } from "../trader/runs.js";
import type { LiveStrategyInfo } from "./liveHub.js";
import { summarizeTrades, type SummaryOptions } from "./metrics.js";
import { entryRulesOf, sellFeeDefaultsOf, type EntryRules, type SellFeeDefaults } from "./positionQueries.js";
import { loadClosedTrades } from "./tradeQueries.js";
import { lamportsToSol } from "./units.js";

export const MAIN_STRATEGY_NAME = "main";
export const DEFAULT_ENDED_LANES = 10;
export const MAX_CONFIG_CHANGES = 8;
const MAX_VALUE_LENGTH = 60;
const IGNORED_CONFIG_KEYS: ReadonlySet<string> = new Set(["lab"]);

type DbRecord = Record<string, unknown>;

export type LivePaperStatus = "running" | "closing" | "stopped" | "open" | "ended";

export interface ConfigChange {
  setting: string;
  main: string;
  lane: string;
}

export interface LivePaperRow {
  runId: number;
  strategy: string;
  label: string | null;
  isMain: boolean;
  status: LivePaperStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  trades: number;
  wins: number;
  winRate: number | null;
  expectancySol: number | null;
  ciLowSol: number | null;
  ciHighSol: number | null;
  totalPnlSol: number;
  maxDrawdownSol: number;
  openPositions: number;
  verdict: string;
  mainSameWindowTrades: number | null;
  mainSameWindowExpectancySol: number | null;
  vsMainSol: number | null;
  changes: ConfigChange[];
  moreChanges: number;
}

export interface LivePaperOverview {
  mainRunId: number | null;
  rows: LivePaperRow[];
}

export interface LivePaperOptions {
  summary: SummaryOptions;
  tradeLimit: number;
  strategies: readonly LiveStrategyInfo[] | null;
  endedLimit?: number;
}

interface RunRecord {
  runId: number;
  label: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  config: unknown;
  open: number;
}

export function isPaperLaneLabel(label: string | null | undefined): boolean {
  return typeof label === "string" && label.startsWith(PAPER_LANE_LABEL_PREFIX);
}

export function laneName(label: string | null | undefined): string | null {
  return isPaperLaneLabel(label) ? (label as string).slice(PAPER_LANE_LABEL_PREFIX.length) : null;
}

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runFromRecord(row: DbRecord): RunRecord {
  return {
    runId: toNumber(row.id),
    label: typeof row.label === "string" ? row.label : null,
    startedAtMs: msOf(row.started_at) ?? 0,
    endedAtMs: msOf(row.ended_at),
    config: row.config,
    open: toNumber(row.open)
  };
}

function shortValue(value: unknown): string {
  const text = value === undefined ? "unset" : JSON.stringify(value);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

export function configChanges(main: unknown, lane: unknown, prefix = ""): ConfigChange[] {
  if (isRecord(main) && isRecord(lane)) {
    const keys = [...new Set([...Object.keys(main), ...Object.keys(lane)])].filter((key) => prefix !== "" || !IGNORED_CONFIG_KEYS.has(key)).sort();
    return keys.flatMap((key) => configChanges(main[key], lane[key], prefix ? `${prefix}.${key}` : key));
  }
  if (JSON.stringify(main) === JSON.stringify(lane)) {
    return [];
  }
  return [{ setting: prefix, main: shortValue(main), lane: shortValue(lane) }];
}

const RUN_COLUMNS = `r.id, r.label, r.started_at, r.ended_at, r.config,
  (SELECT count(*)::int FROM positions p WHERE p.run_id = r.id AND p.status IN ('open', 'pending') AND p.shadow_of IS NULL) AS open`;

async function loadMainRun(db: Db): Promise<RunRecord | null> {
  const result = await db.query<DbRecord>(
    `SELECT ${RUN_COLUMNS} FROM strategy_runs r
     WHERE r.mode = 'paper' AND r.label IS NULL
     ORDER BY (r.ended_at IS NULL) DESC, r.id DESC
     LIMIT 1`
  );
  const row = result.rows[0];
  return row ? runFromRecord(row) : null;
}

async function loadLaneRuns(db: Db, endedLimit: number): Promise<RunRecord[]> {
  const result = await db.query<DbRecord>(
    `(SELECT ${RUN_COLUMNS} FROM strategy_runs r
      WHERE r.mode = 'paper' AND r.label LIKE $1 AND r.ended_at IS NULL)
     UNION ALL
     (SELECT ${RUN_COLUMNS} FROM strategy_runs r
      WHERE r.mode = 'paper' AND r.label LIKE $1 AND r.ended_at IS NOT NULL
      ORDER BY r.ended_at DESC, r.id DESC
      LIMIT $2)`,
    [`${PAPER_LANE_LABEL_PREFIX}%`, Math.max(0, Math.floor(endedLimit))]
  );
  return result.rows.map(runFromRecord);
}

function statusOf(run: RunRecord, strategies: readonly LiveStrategyInfo[] | null): LivePaperStatus {
  if (run.endedAtMs !== null) {
    return "ended";
  }
  const live = strategies?.find((strategy) => strategy.runId === run.runId) ?? null;
  if (!live) {
    return "open";
  }
  if (!live.tradingActive) {
    return "stopped";
  }
  return live.draining ? "closing" : "running";
}

function meanPnlSol(trades: readonly ClosedTrade[]): number | null {
  if (trades.length === 0) {
    return null;
  }
  let total = 0n;
  for (const trade of trades) {
    total += trade.pnl;
  }
  return lamportsToSol(total) / trades.length;
}

function rowOf(run: RunRecord, trades: readonly ClosedTrade[], options: LivePaperOptions, main: { run: RunRecord; trades: readonly ClosedTrade[] } | null): LivePaperRow {
  const summary = summarizeTrades(trades, options.summary);
  const isMain = main !== null && main.run.runId === run.runId;
  const traded = summary.n > 0;
  const sameWindow = main && !isMain ? main.trades.filter((trade) => trade.openedAtMs >= run.startedAtMs) : null;
  const mainExpectancy = sameWindow ? meanPnlSol(sameWindow) : null;
  const changes = main && !isMain ? configChanges(main.run.config, run.config) : [];
  return {
    runId: run.runId,
    strategy: isMain ? MAIN_STRATEGY_NAME : (laneName(run.label) ?? run.label ?? `run-${run.runId}`),
    label: run.label,
    isMain,
    status: statusOf(run, options.strategies),
    startedAtMs: run.startedAtMs,
    endedAtMs: run.endedAtMs,
    trades: summary.n,
    wins: summary.wins,
    winRate: summary.winRate,
    expectancySol: traded ? summary.expectancySol : null,
    ciLowSol: summary.decisionCi95?.low ?? null,
    ciHighSol: summary.decisionCi95?.high ?? null,
    totalPnlSol: summary.totalPnlSol,
    maxDrawdownSol: summary.maxDrawdownSol,
    openPositions: run.open,
    verdict: summary.verdict,
    mainSameWindowTrades: sameWindow ? sameWindow.length : null,
    mainSameWindowExpectancySol: mainExpectancy,
    vsMainSol: traded && mainExpectancy !== null && summary.expectancySol !== null ? summary.expectancySol - mainExpectancy : null,
    changes: changes.slice(0, MAX_CONFIG_CHANGES),
    moreChanges: Math.max(0, changes.length - MAX_CONFIG_CHANGES)
  };
}

const STATUS_ORDER: Readonly<Record<LivePaperStatus, number>> = { running: 0, closing: 1, stopped: 2, open: 3, ended: 4 };

export function sortLivePaperRows(rows: readonly LivePaperRow[]): LivePaperRow[] {
  return [...rows].sort((a, b) => {
    if (a.isMain !== b.isMain) {
      return a.isMain ? -1 : 1;
    }
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) {
      return byStatus;
    }
    const ea = a.expectancySol;
    const eb = b.expectancySol;
    if (ea === null || eb === null) {
      return ea === eb ? b.runId - a.runId : ea === null ? 1 : -1;
    }
    return eb - ea || b.runId - a.runId;
  });
}

export async function loadLivePaperStrategies(db: Db, options: LivePaperOptions): Promise<LivePaperOverview> {
  const lanes = await loadLaneRuns(db, options.endedLimit ?? DEFAULT_ENDED_LANES);
  if (lanes.length === 0) {
    return { mainRunId: null, rows: [] };
  }
  const mainRun = await loadMainRun(db);
  const mainTrades = mainRun ? await loadClosedTrades(db, { runId: mainRun.runId, limit: options.tradeLimit }) : [];
  const main = mainRun ? { run: mainRun, trades: mainTrades } : null;
  const rows: LivePaperRow[] = main ? [rowOf(main.run, main.trades, options, main)] : [];
  for (const lane of lanes) {
    rows.push(rowOf(lane, await loadClosedTrades(db, { runId: lane.runId, limit: options.tradeLimit }), options, main));
  }
  return { mainRunId: mainRun?.runId ?? null, rows: sortLivePaperRows(rows) };
}

export interface RunSettings {
  entryRules: EntryRules;
  sellFees: SellFeeDefaults;
}

export async function laneRunSettings(db: Db, runId: number): Promise<RunSettings | null> {
  const result = await db.query<DbRecord>("SELECT config FROM strategy_runs WHERE id = $1", [runId]);
  const stored = result.rows[0]?.config;
  if (!isRecord(stored)) {
    return null;
  }
  try {
    const config = parseStrategyConfig(stored);
    return { entryRules: entryRulesOf(config), sellFees: sellFeeDefaultsOf(config.execution) };
  } catch {
    return null;
  }
}
