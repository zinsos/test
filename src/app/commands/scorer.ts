import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { buildDataset, DATASET_LABELS, streamDatasetCsv, type DatasetLabelName } from "../../scorer/dataset.js";
import { tune, type TuneResult } from "../../scorer/tune.js";
import { saveWeights } from "../../scorer/weights.js";
import { dateOption, flagOption, numberOption, stringOption, UsageError } from "../args.js";
import { commandConfig, EXIT_FAILURE, EXIT_OK, withDatabase, type CommandContext } from "../commandContext.js";

function isLabel(value: string): value is DatasetLabelName {
  return (DATASET_LABELS as readonly string[]).includes(value);
}

function auc(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

export function formatTuneReport(result: TuneResult, checkpointSec: number, maxFeatures = 15): string {
  const lines = [
    `== scorer tuning: ${result.target} at ${checkpointSec}s ==`,
    `rows             ${result.rows} (train ${result.trainRows}, validation ${result.validationRows}, base rate ${result.baseRate === null ? "n/a" : (result.baseRate * 100).toFixed(1) + "%"})`,
    `validation AUC   model ${auc(result.validation.modelAuc)}, current score ${auc(result.validation.currentScoreAuc)}, suggested weights ${auc(result.validation.suggestedScoreAuc)}`,
    `suggested        version ${result.suggestedWeights.version}`,
    "features (oriented AUC on train, AUC on validation, coverage, direction, suggested weight):"
  ];
  for (const report of result.features.slice(0, maxFeatures)) {
    lines.push(
      `  ${report.feature.padEnd(26)} ${auc(report.orientedAuc)}  ${auc(report.validationAuc)}  ${(report.coverage * 100).toFixed(0).padStart(3)}%  ${report.direction.padEnd(14)} ${report.suggestedWeight.toFixed(2)}`
    );
  }
  return lines.join("\n");
}

export async function tuneScorerCommand(ctx: CommandContext): Promise<number> {
  const checkpointSec = numberOption(ctx.options, "checkpoint") ?? 0;
  const label = stringOption(ctx.options, "label") ?? "";
  if (!isLabel(label)) {
    throw new UsageError(`--label must be one of ${DATASET_LABELS.join(", ")}`, "tune-scorer");
  }
  const config = await commandConfig(ctx);
  return withDatabase(ctx, "tune-scorer", async (db) => {
    const from = dateOption(ctx.options, "from") ?? null;
    const to = dateOption(ctx.options, "to") ?? null;
    const rows = await buildDataset(db, { checkpointSec, from, to });
    if (rows.length === 0) {
      ctx.io.err(`no scored launches with known outcomes at checkpoint ${checkpointSec}s; record longer or check --from/--to`);
      return EXIT_FAILURE;
    }
    const result = tune(rows, label, { version: stringOption(ctx.options, "version") });
    ctx.io.out(formatTuneReport(result, checkpointSec));
    const activate = flagOption(ctx.options, "activate");
    const filePath = flagOption(ctx.options, "write-file") ? config.scorer.weightsFile : null;
    await saveWeights(db, {
      weights: result.suggestedWeights,
      labelName: label,
      metrics: {
        checkpointSec,
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
        rows: result.rows,
        trainRows: result.trainRows,
        validationRows: result.validationRows,
        splitAtMs: result.splitAtMs,
        baseRate: result.baseRate,
        validation: result.validation
      },
      activate,
      filePath
    });
    ctx.io.out(
      `saved weights ${result.suggestedWeights.version}${activate ? " (active; restart the scorer services to load them)" : " (inactive; backtest them with --weights)"}${filePath ? `, written to ${filePath}` : ""}`
    );
    return EXIT_OK;
  });
}

export async function exportDatasetCommand(ctx: CommandContext): Promise<number> {
  const checkpointSec = numberOption(ctx.options, "checkpoint") ?? 0;
  const out = stringOption(ctx.options, "out") ?? "-";
  return withDatabase(ctx, "export-dataset", async (db) => {
    const stream = out === "-" ? process.stdout : createWriteStream(out, { encoding: "utf8" });
    let rows = -1;
    for await (const chunk of streamDatasetCsv(db, {
      checkpointSec,
      from: dateOption(ctx.options, "from") ?? null,
      to: dateOption(ctx.options, "to") ?? null,
      quoteMint: stringOption(ctx.options, "quote") ?? null
    })) {
      rows += chunk.split("\n").filter((line) => line.length > 0).length;
      if (!stream.write(chunk)) {
        await once(stream, "drain");
      }
    }
    if (stream !== process.stdout) {
      await new Promise<void>((resolve, reject) => {
        stream.once("error", reject);
        stream.end(() => resolve());
      });
      ctx.io.err(`wrote ${Math.max(0, rows)} rows to ${out}`);
    }
    return EXIT_OK;
  });
}
