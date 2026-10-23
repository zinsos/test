import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveApp } from "../../src/app/live.js";
import type { RpcClient } from "../../src/chain/rpc.js";
import { loadEnv } from "../../src/config/env.js";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { VirtualClock } from "../../src/core/clock.js";
import type { StreamSource } from "../../src/ingest/source.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";

const silentSource: StreamSource = {
  name: "silent",
  start: async () => undefined,
  stop: async () => undefined,
  stats: () => ({}),
  onGap: () => () => undefined
};

describe.skipIf(!hasTestDatabase)("review ops: RPC budget of the trading service", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("review_ops_rpc");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("does not run its own deep wallet-intel RPC lookups next to the data service", async () => {
    const calls: string[] = [];
    const rpc = {
      stats: () => ({ calls: calls.length, errors: 0, queued: 0, active: 0 }),
      getSignaturesForAddress: async (address: string) => {
        calls.push(`getSignaturesForAddress:${address}`);
        return [];
      },
      getParsedTransaction: async (signature: string) => {
        calls.push(`getTransaction:${signature}`);
        return null;
      },
      getTokenLargestAccounts: async () => [],
      getMultipleParsedAccounts: async () => []
    } as unknown as RpcClient;
    const clock = new VirtualClock(Date.UTC(2026, 9, 20));
    const app = await startLiveApp({
      env: loadEnv({
        DATABASE_URL: database.url,
        MODULES: "trader",
        TRADING_MODE: "paper",
        RPC_HTTP_URL: "https://rpc.example.com/?api-key=x"
      }),
      config: defaultStrategyConfig(),
      clock,
      db: database.db,
      rpc,
      source: silentSource,
      port: 0
    });
    try {
      expect(app.recorder).toBeNull();
      const intel = app.scorer?.intel ?? null;
      if (intel) {
        const lookups = intel.ensure(
          Array.from({ length: 25 }, (_, index) => ({ wallet: `EarlyBuyer${index}`, buySignature: `buy-${index}`, buySlot: 1 })),
          clock.nowMs() + 8_000
        );
        await clock.advanceTo(clock.nowMs() + 8_000);
        await lookups;
        await intel.drain();
      }
      expect(calls).toEqual([]);
    } finally {
      await app.stop("test");
    }
  });
});
