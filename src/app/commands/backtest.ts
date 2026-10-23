import { existsSync } from "node:fs";
import path from "node:path";
import { formatTradeReport } from "../../backtest/report.js";
import { runBacktest, type BacktestProgress, type BacktestSummary } from "../../backtest/runner.js";
import type { SkippedWeights, WeightsProvenance } from "../../backtest/weights.js";
import { jsonSafe, type Db } from "../../db/pool.js";
import { ScoringModel } from "../../scorer/model.js";
import { loadWeightsFile, loadWeightsVersion } from "../../scorer/weights.js";
import { dateOption, flagOption, stringOption, UsageError } from "../args.js";
import { commandConfig, EXIT_OK, isoDay, withDatabase, type CommandContext } from "../commandContext.js";

export async function resolveWeights(db: Db, spec: string): Promise<ScoringModel> {
  if (existsSync(path.resolve(process.cwd(), spec))) {
    const fromFile = await loadWeightsFile(spec);
    if (fromFile) {
      return new ScoringModel(fromFile);
    }
  }
  const stored = await loadWeightsVersion(db, spec);
  if (stored) {
    return new ScoringModel(stored);
  }
  throw new UsageError(`weights "${spec}" is neither a file nor a stored weights version`, "backtest");
}

export function progressLine(progress: BacktestProgress): string {
  const span = Math.max(1, progress.toMs - progress.fromMs);
  const pct = Math.min(100, Math.max(0, ((progress.virtualNowMs - progress.fromMs) / span) * 100));
  return `backtest ${pct.toFixed(0)}% at ${isoDay(progress.virtualNowMs)}: ${progress.events} events, ${progress.openPositions} open, ${progress.closedTrades} closed`;
}

function trainingText(fromMs: number | null, toMs: number | null): string {
  return `${fromMs === null ? "the start" : isoDay(fromMs)} to ${toMs === null ? "?" : isoDay(toMs)}`;
}

export function weightsText(weights: WeightsProvenance): string {
  if (weights.trainedToMs === null) {
    return `${weights.version} (${weights.source}, not fitted on recorded data)`;
  }
  const trained = trainingText(weights.trainedFromMs, weights.trainedToMs);
  return weights.inSample
    ? `${weights.version} (${weights.source}, fitted on ${trained}: IN-SAMPLE, results are optimistic)`
    : `${weights.version} (${weights.source}, fitted on ${trained})`;
}

export function skippedWeightsText(skipped: SkippedWeights): string {
  return `skipped ${skipped.source} weights ${skipped.version}: fitted on ${trainingText(skipped.trainedFromMs, skipped.trainedToMs)}, which overlaps or follows the backtest window (pass --weights ${skipped.version} or --allow-in-sample to use them)`;
}

function exitReasonText(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "none" : entries.map(([reason, count]) => `${reason} ${count}`).join(", ");
}

export function formatBacktestReport(summary: BacktestSummary): string {
  const counts = summary.counts;
  const riskText = summary.risk.killed
    ? `kill switch tripped (${summary.risk.killReason ?? "drawdown"})`
    : summary.risk.haltedForDay
      ? "halted for the day at the end"
      : "within limits";
  return formatTradeReport({
    title: `backtest run ${summary.runId}${summary.label ? ` (${summary.label})` : ""}`,
    summary: summary.trades,
    breakdowns: summary.breakdowns,
    narrative: summary.narrative,
    details: [
      ["data", `${isoDay(summary.fromMs)} to ${isoDay(summary.toMs)}`],
      ["replayed", `${counts.launches} launches, ${counts.trades} trades, ${counts.events} events`],
      ["stored scores", `${counts.storedScoreLaunches} launches with live launch_scores rows`],
      ["signals", `${counts.signalsAccepted} accepted, ${counts.signalsRejected} rejected by signal filters`],
      [
        "entries",
        `${counts.entriesAttempted} attempted, ${counts.entriesFilled} filled, ${counts.entriesFailed} failed, ${counts.rejectedByRisk} blocked by risk, ${counts.skipped} skipped`
      ],
      ["exits", exitReasonText(summary.exitReasons)],
      ["closed at end", `${counts.closedAtEnd} positions closed at the last quote`],
      ["weights", weightsText(summary.weights)],
      ["wallets", summary.trackedVersionAtEnd],
      ["risk", riskText],
      ["fingerprint", summary.fingerprint.slice(0, 16)]
    ]
  });
}

export async function backtestCommand(ctx: CommandContext): Promise<number> {
  const from = dateOption(ctx.options, "from");
  const to = dateOption(ctx.options, "to");
  if (!from || !to || to.getTime() <= from.getTime()) {
    throw new UsageError("--to must be after --from", "backtest");
  }
  const config = await commandConfig(ctx);
  return withDatabase(ctx, "backtest", async (db) => {
    const weightsSpec = stringOption(ctx.options, "weights");
    const model = weightsSpec ? await resolveWeights(db, weightsSpec) : null;
    const result = await runBacktest({
      db,
      fromMs: from.getTime(),
      toMs: to.getTime(),
      config,
      label: stringOption(ctx.options, "label") ?? null,
      includeIncomplete: flagOption(ctx.options, "include-incomplete"),
      walkForward: flagOption(ctx.options, "walk-forward"),
      model,
      weightsFile: model ? null : config.scorer.weightsFile,
      allowInSampleWeights: flagOption(ctx.options, "allow-in-sample"),
      onProgress: (progress) => ctx.io.err(progressLine(progress))
    });
    for (const skipped of result.summary.skippedWeights) {
      ctx.io.err(`warning: ${skippedWeightsText(skipped)}`);
    }
    if (result.summary.weights.inSample) {
      ctx.io.err(`warning: scoring with in-sample weights ${weightsText(result.summary.weights)}`);
    }
    ctx.io.out(formatBacktestReport(result.summary));
    if (flagOption(ctx.options, "json")) {
      ctx.io.out(JSON.stringify(jsonSafe(result.summary), null, 2));
    }
    return EXIT_OK;
  });
}
