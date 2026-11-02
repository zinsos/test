import type { Env } from "../config/env.js";
import type { StrategyConfig } from "../config/strategy.js";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/pool.js";
import { stringOption, type OptionValue } from "./args.js";
import { loadConfig, openDatabase } from "./context.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CommandContext {
  env: Env;
  io: CliIo;
  options: Record<string, OptionValue>;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export async function withDatabase<T>(ctx: CommandContext, name: string, work: (db: Db) => Promise<T>): Promise<T> {
  const db = openDatabase(ctx.env, `snypra-edge:${name}`);
  try {
    await runMigrations(db);
    return await work(db);
  } finally {
    await db.end().catch(() => undefined);
  }
}

export function commandConfig(ctx: CommandContext): Promise<StrategyConfig> {
  return loadConfig(ctx.env, stringOption(ctx.options, "config"));
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}
