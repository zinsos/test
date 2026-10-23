import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BacktestLoader } from "../../src/backtest/loader.js";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { Bus } from "../../src/core/bus.js";
import { VirtualClock } from "../../src/core/clock.js";
import { MarketState } from "../../src/market/state.js";
import { LaunchRegistry, RecorderService } from "../../src/recorder/index.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";
import { BASE_MS, insertLaunches, insertTrades, SOL } from "../tracker.db.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = BASE_MS;

describe.skipIf(!hasTestDatabase)("review: restart gaps and backtest launch selection", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("review_gap");
    const ids = await insertLaunches(database.db, [
      { mint: "DiedEarlyMint", createdAtMs: T },
      { mint: "StillAliveMint", createdAtMs: T }
    ]);
    for (const [mint, launchId] of ids) {
      await insertTrades(
        database.db,
        Array.from({ length: 6 }, (_, index) => ({
          launchId,
          wallet: `${mint}Buyer${index}`,
          atMs: T + (index + 1) * 30_000,
          isBuy: true,
          tokenAmount: 1_000_000_000n,
          userQuote: SOL / 10n,
          signature: `${mint}Sig${index}`
        }))
      );
    }
    await database.db.query("UPDATE launches SET tracking_ended_at = $1 WHERE mint = 'DiedEarlyMint'", [new Date(T + 40 * MINUTE)]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("replays a fully recorded launch whether or not it was still alive when the recorder restarted", async () => {
    const clock = new VirtualClock(T + HOUR);
    const service = new RecorderService({
      db: database.db,
      bus: new Bus(),
      market: new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null }),
      clock,
      config: defaultStrategyConfig().recorder,
      registry: new LaunchRegistry({ db: database.db }),
      aggregateFlushMs: 1e9,
      manageTradePartitions: false
    });
    await service.start();
    await service.stop();

    const loader = new BacktestLoader({ db: database.db, fromMs: T - MINUTE, toMs: T + 2 * HOUR, tradeQuoteMints: ["SOL"] });
    await loader.prepare();
    const tradesByMint = new Map<string, number>();
    for await (const window of loader.windows()) {
      for (const replay of window) {
        if (replay.event.kind === "trade") {
          tradesByMint.set(replay.event.mint, (tradesByMint.get(replay.event.mint) ?? 0) + 1);
        }
      }
    }
    expect(tradesByMint.get("DiedEarlyMint")).toBe(6);
    expect(tradesByMint.get("StillAliveMint")).toBe(6);
  });
});
