import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { defaultStrategyConfig, parseStrategyConfig } from "../src/config/strategy.js";

const ENV_NAMES = [
  "DATABASE_URL",
  "DATABASE_SSL",
  "DB_MAX_CONNECTIONS",
  "RPC_HTTP_URL",
  "RPC_WS_URL",
  "RPC_MAX_RPS",
  "RPC_MAX_CONCURRENCY",
  "STREAM_COMMITMENT",
  "MODULES",
  "TRADING_MODE",
  "LIVE_DRY_RUN",
  "STRATEGY_CONFIG",
  "HOT_WALLET_SECRET_KEY",
  "COLD_WALLET_ADDRESS",
  "JITO_BLOCK_ENGINE_URL",
  "DASHBOARD_TOKEN",
  "PORT",
  "LOG_LEVEL",
  "METADATA_GATEWAY"
];

function envExample(): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of readFileSync(new URL("../.env.example", import.meta.url), "utf8").split("\n")) {
    const match = /^#?\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1]) {
      values.set(match[1], match[2] ?? "");
    }
  }
  return values;
}

describe("config/strategy.json", () => {
  const raw = JSON.parse(readFileSync(new URL("../config/strategy.json", import.meta.url), "utf8")) as unknown;

  it("is valid and spells out every knob explicitly", () => {
    expect(parseStrategyConfig(raw)).toEqual(raw);
  });

  it("matches the code defaults except for the measured token account rent", () => {
    const defaults = defaultStrategyConfig();
    const parsed = parseStrategyConfig(raw);
    expect(parsed.execution.ataRentLamports).toBe(1_513_840);
    expect({ ...parsed, execution: { ...parsed.execution, ataRentLamports: defaults.execution.ataRentLamports } }).toEqual(defaults);
  });
});

describe(".env.example", () => {
  it("documents every environment variable the service reads", () => {
    expect([...envExample().keys()].sort()).toEqual([...ENV_NAMES].sort());
  });

  it("parses with its safe defaults", () => {
    const values = Object.fromEntries([...envExample().entries()].filter(([name, value]) => value.length > 0 && name !== "DATABASE_SSL"));
    const env = loadEnv(values);
    expect(env.TRADING_MODE).toBe("paper");
    expect(env.LIVE_DRY_RUN).toBe(true);
    expect(env.MODULES).toEqual(["recorder", "scorer", "dashboard"]);
  });
});

describe("railway.json", () => {
  it("builds with npm, starts the compiled CLI and checks /healthz", () => {
    const railway = JSON.parse(readFileSync(new URL("../railway.json", import.meta.url), "utf8")) as {
      build: { buildCommand: string };
      deploy: { startCommand: string; healthcheckPath: string };
    };
    expect(railway.build.buildCommand).toBe("npm run build");
    expect(railway.deploy.startCommand).toBe("node dist/src/main.js start");
    expect(railway.deploy.healthcheckPath).toBe("/healthz");
  });
});
