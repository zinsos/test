import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveApp, type LiveApp } from "../../src/app/live.js";
import { loadEnv } from "../../src/config/env.js";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";

describe.skipIf(!hasTestDatabase)("review ops: dashboard deployed without DASHBOARD_TOKEN", () => {
  let database: TestDatabase;
  let app: LiveApp | null = null;
  let startError: unknown = null;

  beforeAll(async () => {
    database = await createTestDatabase("review_ops_dash");
    const env = loadEnv({ DATABASE_URL: database.url, MODULES: "dashboard" });
    try {
      app = await startLiveApp({ env, config: defaultStrategyConfig(), db: database.db, port: 0, rpc: null });
    } catch (error) {
      startError = error;
    }
  });

  afterAll(async () => {
    await app?.stop("test");
    await database?.drop();
  });

  it("refuses to serve trading data publicly when no dashboard token is configured", async () => {
    if (startError !== null) {
      expect(String(startError)).toMatch(/DASHBOARD_TOKEN/);
      return;
    }
    const base = `http://127.0.0.1:${app?.httpPort}`;
    const trades = await fetch(`${base}/api/export/trades.csv`);
    const tracked = await fetch(`${base}/api/wallets/tracked`);
    expect({ trades: trades.status, tracked: tracked.status }).toEqual({ trades: 401, tracked: 401 });
  });
});
