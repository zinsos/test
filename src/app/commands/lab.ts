import { jsonSafe } from "../../db/pool.js";
import {
  DEFAULT_LAB_HOURS,
  DEFAULT_LAB_LABELS,
  durationText,
  formatLabReport,
  LAB_VARIANTS_FILE,
  loadLabVariants,
  MAX_LAB_HOURS,
  pruneLabRuns,
  pruneText,
  runLab,
  type LabProgress
} from "../../lab/index.js";
import { loadLearnedSettings } from "../../lab/learned.js";
import { DATASET_LABELS, type DatasetLabelName } from "../../scorer/dataset.js";
import { tradingModeOf } from "../trading.js";
import { flagOption, numberOption, stringOption, UsageError } from "../args.js";
import { commandConfig, EXIT_FAILURE, EXIT_OK, isoDay, withDatabase, type CommandContext } from "../commandContext.js";
import { isDatasetLabel } from "./scorer.js";

export function parseLabLabels(raw: string | undefined): DatasetLabelName[] {
  if (raw === undefined) {
    return [...DEFAULT_LAB_LABELS];
  }
  const labels = raw
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  if (labels.length === 0) {
    throw new UsageError("--labels needs at least one label", "lab");
  }
  const unknown = labels.filter((label) => !isDatasetLabel(label));
  if (unknown.length > 0) {
    throw new UsageError(`unknown label ${unknown.join(", ")}; use ${DATASET_LABELS.join(", ")}`, "lab");
  }
  return [...new Set(labels as DatasetLabelName[])];
}

function wholeNumber(ctx: CommandContext, name: string, min: number): number | undefined {
  const value = numberOption(ctx.options, name);
  if (value !== undefined && (!Number.isInteger(value) || value < min)) {
    throw new UsageError(`--${name} must be a whole number of at least ${min}`, "lab");
  }
  return value;
}

export function progressText(progress: LabProgress): string | null {
  switch (progress.phase) {
    case "start":
      return `lab run ${progress.labRunId}: replaying ${isoDay(progress.dataFromMs)} to ${isoDay(progress.dataToMs)} for ${progress.variants} variants`;
    case "scorer": {
      const entry = progress.entry;
      const outcome = "reason" in entry ? `skipped, ${entry.reason}` : `validation AUC ${entry.validationAuc?.toFixed(3) ?? "n/a"}`;
      return `  scorer ${entry.label} at ${entry.checkpointSec}s: ${entry.rows} rows, ${outcome}`;
    }
    case "variant-start":
      return `  variant ${progress.index + 1}/${progress.total} ${progress.name} ...`;
    case "variant-progress":
      return null;
    case "variant-done": {
      const result = progress.result;
      const outcome = result.summary ? `${result.summary.trades} trades` : (result.error ?? "not run");
      return `  variant ${progress.index + 1}/${progress.total} ${result.name}: ${outcome}${result.runtimeMs === null ? "" : ` in ${durationText(result.runtimeMs)}`}`;
    }
    default:
      return null;
  }
}

export function promotionBlockers(input: { hours: number; windowHours: number; maxVariants: number | null; variantsFile: string | undefined }): string[] {
  const blockers: string[] = [];
  if (Math.abs(input.hours - input.windowHours) * 3_600_000 > 60_000) {
    blockers.push(`--hours ${input.hours} differs from lab.autoLearn.windowHours ${input.windowHours}`);
  }
  if (input.maxVariants !== null) {
    blockers.push("--max-variants is set");
  }
  if (input.variantsFile !== undefined && input.variantsFile !== LAB_VARIANTS_FILE) {
    blockers.push("--variants points at another variants file");
  }
  return blockers;
}

export async function labCommand(ctx: CommandContext): Promise<number> {
  const pruneKeep = wholeNumber(ctx, "prune-keep", 1);
  if (pruneKeep !== undefined) {
    return withDatabase(ctx, "lab", async (db) => {
      ctx.io.out(pruneText(await pruneLabRuns(db, pruneKeep)));
      return EXIT_OK;
    });
  }
  const hours = numberOption(ctx.options, "hours") ?? DEFAULT_LAB_HOURS;
  if (!(hours > 0 && hours <= MAX_LAB_HOURS)) {
    throw new UsageError(`--hours must be more than 0 and at most ${MAX_LAB_HOURS}`, "lab");
  }
  const maxVariants = wholeNumber(ctx, "max-variants", 0) ?? null;
  const labels = parseLabLabels(stringOption(ctx.options, "labels"));
  const variantsOption = stringOption(ctx.options, "variants");
  const variants = await loadLabVariants(variantsOption ?? LAB_VARIANTS_FILE);
  const fileConfig = await commandConfig(ctx);
  const configSource = stringOption(ctx.options, "config") ?? ctx.env.STRATEGY_CONFIG;
  const blockers = promotionBlockers({ hours, windowHours: fileConfig.lab.autoLearn.windowHours, maxVariants, variantsFile: variantsOption });
  if (blockers.length > 0) {
    ctx.io.err(`learning is report-only for this run: ${blockers.join("; ")}`);
  }
  return withDatabase(ctx, "lab", async (db) => {
    const learned = await loadLearnedSettings(db, fileConfig, tradingModeOf(ctx.env));
    const learnedText = learned.changes.length > 0 ? ` plus learned changes from promotion #${learned.eventId ?? "?"}: ${learned.changes.join(", ")}` : "";
    const result = await runLab(db, {
      config: learned.config,
      variants,
      hours,
      labels,
      maxVariants,
      canPromote: blockers.length === 0,
      baselineDescription: `the strategy the paper trader runs (${configSource}${learnedText})`,
      onProgress: (progress) => {
        const line = progressText(progress);
        if (line) {
          ctx.io.err(line);
        }
      }
    });
    ctx.io.out(formatLabReport(result));
    if (flagOption(ctx.options, "json")) {
      ctx.io.out(JSON.stringify(jsonSafe(result), null, 2));
    }
    return result.status === "done" ? EXIT_OK : EXIT_FAILURE;
  });
}
