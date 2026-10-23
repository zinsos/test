import { describe, expect, it } from "vitest";
import { startLiveApp, type LiveApp } from "../../src/app/live.js";
import { loadEnv } from "../../src/config/env.js";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import type { StreamSource } from "../../src/ingest/source.js";

const silentSource: StreamSource = {
  name: "silent",
  start: async () => undefined,
  stop: async () => undefined,
  stats: () => ({}),
  onGap: () => () => undefined
};

describe("review ops: trader start while Postgres is restarting", () => {
  it("waits for the database instead of exiting, so Railway's ON_FAILURE retry budget is not burned in seconds", async () => {
    let aborted = false;
    const env = loadEnv({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/snypra",
      MODULES: "trader",
      TRADING_MODE: "paper",
      RPC_WS_URL: "ws://127.0.0.1:9"
    });
    const started = startLiveApp({
      env,
      config: defaultStrategyConfig(),
      rpc: null,
      source: silentSource,
      port: 0,
      abort: () => aborted
    });
    const outcome = await Promise.race([
      started.then(
        () => "started",
        (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting for the database"), 3_000))
    ]);
    aborted = true;
    void started.then((app: LiveApp) => app.stop("test")).catch(() => undefined);
    expect(outcome.startsWith("failed")).toBe(false);
  });
});
