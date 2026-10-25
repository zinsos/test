import { loadEnv, type Env } from "../config/env.js";
import { moduleLogger } from "../core/logger.js";
import { parseArgv, usageText, UsageError, type ParsedArgs } from "./args.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo, type CommandContext } from "./commandContext.js";
import { backtestCommand } from "./commands/backtest.js";
import { labCommand } from "./commands/lab.js";
import { migrateCommand, pruneDataCommand, recomputeOutcomesCommand, resetKillCommand, sweepCommand } from "./commands/ops.js";
import { reportCommand } from "./commands/report.js";
import { exportDatasetCommand, tuneScorerCommand } from "./commands/scorer.js";
import { startCommand } from "./commands/start.js";
import { backfillWalletsCommand, rankWalletsCommand } from "./commands/wallets.js";

const log = moduleLogger("cli");

export type CommandHandler = (ctx: CommandContext) => Promise<number>;

export const COMMAND_HANDLERS: Readonly<Record<string, CommandHandler>> = {
  start: startCommand,
  migrate: migrateCommand,
  backtest: backtestCommand,
  "tune-scorer": tuneScorerCommand,
  "export-dataset": exportDatasetCommand,
  "rank-wallets": rankWalletsCommand,
  "backfill-wallets": backfillWalletsCommand,
  report: reportCommand,
  sweep: sweepCommand,
  "reset-kill": resetKillCommand,
  "recompute-outcomes": recomputeOutcomesCommand,
  "prune-data": pruneDataCommand,
  lab: labCommand
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageFailure(io: CliIo, error: UsageError): number {
  io.err(`error: ${error.message}`);
  io.err(usageText(error.command ?? undefined));
  return EXIT_USAGE;
}

export interface RunCliOptions {
  env?: Env;
  handlers?: Readonly<Record<string, CommandHandler>>;
}

export async function runCli(argv: readonly string[], io: CliIo, options: RunCliOptions = {}): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      return usageFailure(io, error);
    }
    throw error;
  }
  if (parsed.command === "help") {
    const topic = parsed.options.topic;
    io.out(usageText(typeof topic === "string" ? topic : undefined));
    return EXIT_OK;
  }
  const handler = (options.handlers ?? COMMAND_HANDLERS)[parsed.command];
  if (!handler) {
    return usageFailure(io, new UsageError(`unknown command "${parsed.command}"`));
  }
  let env: Env;
  try {
    env = options.env ?? loadEnv();
  } catch (error) {
    io.err(`error: ${messageOf(error)}`);
    return EXIT_FAILURE;
  }
  try {
    return await handler({ env, io, options: parsed.options });
  } catch (error) {
    if (error instanceof UsageError) {
      return usageFailure(io, error);
    }
    log.error({ err: error, command: parsed.command }, "command failed");
    io.err(`error: ${messageOf(error)}`);
    return EXIT_FAILURE;
  }
}
