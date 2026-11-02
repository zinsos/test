import { existsSync } from "node:fs";
import path from "node:path";
import { databaseSsl, requireEnv, type Env } from "../config/env.js";
import { loadStrategyConfig, type StrategyConfig } from "../config/strategy.js";
import { RpcClient } from "../chain/rpc.js";
import { createDb, type Db } from "../db/pool.js";
import { MarketState } from "../market/state.js";
import { moduleLogger } from "../core/logger.js";

const log = moduleLogger("app.context");

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export function openDatabase(env: Env, applicationName: string): Db {
  return createDb({
    connectionString: requireEnv(env, "DATABASE_URL"),
    maxConnections: env.DB_MAX_CONNECTIONS,
    ssl: databaseSsl(env),
    applicationName
  });
}

export function createRpc(env: Env, timeoutMs = 15_000, maxRetries = 3): RpcClient | null {
  if (!env.RPC_HTTP_URL) {
    return null;
  }
  return new RpcClient({
    url: env.RPC_HTTP_URL,
    maxRps: env.RPC_MAX_RPS,
    maxConcurrency: env.RPC_MAX_CONCURRENCY,
    timeoutMs,
    maxRetries
  });
}

export function requireRpc(env: Env): RpcClient {
  const rpc = createRpc(env);
  if (!rpc) {
    throw new Error("missing required environment variable RPC_HTTP_URL");
  }
  return rpc;
}

export function createMarket(config: StrategyConfig, quoteMints: readonly string[] | null): MarketState {
  const memory = config.recorder.memory;
  return new MarketState({
    maxTradesPerLaunch: memory.maxTradesPerLaunch,
    evictInactiveMs: memory.evictInactiveMinutes * MINUTE_MS,
    evictMaxAgeMs: memory.evictMaxAgeHours * HOUR_MS,
    quoteMints
  });
}

export async function loadConfig(env: Env, override?: string): Promise<StrategyConfig> {
  if (override !== undefined && !existsSync(path.resolve(process.cwd(), override))) {
    throw new Error(`strategy config file not found: ${override}`);
  }
  const file = override ?? env.STRATEGY_CONFIG;
  if (!existsSync(path.resolve(process.cwd(), file))) {
    log.warn({ file, cwd: process.cwd() }, "strategy config file not found, using built-in defaults");
  }
  return loadStrategyConfig(file);
}
