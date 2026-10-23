import {
  allBreakdowns,
  comparePaperLive,
  describeComparison,
  describeSummary,
  formatPct,
  formatSol,
  isTradingMode,
  loadClosedTrades,
  loadModes,
  loadPaperLivePairs,
  loadRuns,
  summarizeTrades,
  type PaperLiveComparison,
  type RunInfo,
  type TradeFilter
} from "../../analytics/index.js";
import { formatBps } from "../../analytics/format.js";
import { formatTradeReport } from "../../backtest/report.js";
import type { TradingMode } from "../../core/types.js";
import { dateOption, numberOption, stringOption, UsageError } from "../args.js";
import { EXIT_OK, isoDay, withDatabase, type CommandContext } from "../commandContext.js";

export function formatComparisonLines(comparison: PaperLiveComparison): string[] {
  const narrative = describeComparison(comparison);
  return [
    "paper vs live:",
    `  pairs          ${comparison.n}`,
    `  mean gap       ${formatSol(comparison.meanDiffSol)} SOL/trade (live minus paper)`,
    `  entry gap      ${formatBps(comparison.entryGap.meanBps)}, exit gap ${formatBps(comparison.exitGap.meanBps)}`,
    `  failed fills   ${formatPct(comparison.fillFailureRate.live)} live vs ${formatPct(comparison.fillFailureRate.paper)} paper`,
    `  verdict        ${comparison.verdict}`,
    `  ${narrative.headline}`,
    `  ${narrative.detail}`
  ];
}

function runText(run: RunInfo | undefined, runId: number | undefined): string {
  if (!run) {
    return runId === undefined ? "all runs" : `run ${runId} (not found)`;
  }
  const range = run.dataFromMs !== null && run.dataToMs !== null ? `, data ${isoDay(run.dataFromMs)} to ${isoDay(run.dataToMs)}` : "";
  return `run ${run.id} ${run.mode}${run.label ? ` (${run.label})` : ""}, started ${isoDay(run.startedAtMs)}${range}${run.endedAtMs === null ? ", still running" : ""}`;
}

export async function reportCommand(ctx: CommandContext): Promise<number> {
  const runId = numberOption(ctx.options, "run");
  const modeOption = stringOption(ctx.options, "mode");
  if (modeOption !== undefined && !isTradingMode(modeOption)) {
    throw new UsageError("--mode must be paper, live, backtest or shadow", "report");
  }
  return withDatabase(ctx, "report", async (db) => {
    let mode: TradingMode | null = modeOption ?? null;
    if (runId === undefined && mode === null) {
      const modes = await loadModes(db);
      const latest = modes[0]?.mode;
      mode = latest !== undefined && isTradingMode(latest) ? latest : null;
    }
    const filter: TradeFilter = {
      runId: runId ?? null,
      mode: runId === undefined ? mode : null,
      fromMs: dateOption(ctx.options, "from")?.getTime() ?? null,
      toMs: dateOption(ctx.options, "to")?.getTime() ?? null,
      includeShadows: mode === "shadow"
    };
    const trades = await loadClosedTrades(db, filter);
    const summary = summarizeTrades(trades);
    const run = runId === undefined ? undefined : (await loadRuns(db, { limit: 1_000, includeLab: true })).find((entry) => entry.id === runId);
    ctx.io.out(
      formatTradeReport({
        title: runId === undefined ? `${mode ?? "all"} trades` : `run ${runId}`,
        summary,
        breakdowns: allBreakdowns(trades),
        narrative: describeSummary(summary),
        details: [
          ["filter", runId === undefined ? `mode ${mode ?? "any"}` : runText(run, runId)],
          ["window", `${filter.fromMs ? isoDay(filter.fromMs) : "start"} to ${filter.toMs ? isoDay(filter.toMs) : "now"}`]
        ]
      })
    );
    if (mode === "live" || run?.mode === "live") {
      const pairs = await loadPaperLivePairs(db, { runId: runId ?? null, fromMs: filter.fromMs, toMs: filter.toMs });
      if (pairs.length > 0) {
        ctx.io.out(formatComparisonLines(comparePaperLive(pairs)).join("\n"));
      }
    }
    return EXIT_OK;
  });
}
