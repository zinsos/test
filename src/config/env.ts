import { z } from "zod";

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(value.toLowerCase())));

const ModuleName = z.enum(["recorder", "scorer", "tracker", "trader", "dashboard"]);
export type ModuleName = z.infer<typeof ModuleName>;

const EnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: booleanFromString.optional(),
  DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),
  RPC_HTTP_URL: z.string().url().optional(),
  RPC_WS_URL: z.string().optional(),
  RPC_MAX_RPS: z.coerce.number().positive().default(20),
  RPC_MAX_CONCURRENCY: z.coerce.number().int().positive().default(8),
  STREAM_COMMITMENT: z.enum(["processed", "confirmed"]).default("confirmed"),
  MODULES: z
    .string()
    .default("recorder,scorer,dashboard")
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    )
    .pipe(z.array(ModuleName)),
  TRADING_MODE: z.enum(["paper", "live"]).default("paper"),
  LIVE_DRY_RUN: booleanFromString.default(true),
  STRATEGY_CONFIG: z.string().default("config/strategy.json"),
  HOT_WALLET_SECRET_KEY: z.string().optional(),
  COLD_WALLET_ADDRESS: z.string().optional(),
  DASHBOARD_TOKEN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default("info"),
  METADATA_GATEWAY: z.string().optional()
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`invalid environment: ${issues}`);
  }
  return parsed.data;
}

export function requireEnv<K extends keyof Env>(env: Env, key: K): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing required environment variable ${String(key)}`);
  }
  return value as NonNullable<Env[K]>;
}

export function databaseSsl(env: Env): boolean {
  if (env.DATABASE_SSL !== undefined) {
    return env.DATABASE_SSL;
  }
  const url = env.DATABASE_URL ?? "";
  return !(url.includes("localhost") || url.includes("127.0.0.1") || url.includes(".railway.internal"));
}
