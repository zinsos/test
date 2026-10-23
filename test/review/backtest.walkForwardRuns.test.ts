import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { Bus } from "../../src/core/bus.js";
import { VirtualClock } from "../../src/core/clock.js";
import { MarketState } from "../../src/market/state.js";
import { createTrackerModule } from "../../src/tracker/index.js";
import { rankWallets } from "../../src/tracker/ranker.js";
import { latestRun, latestRunAsOf, TrackedWalletRegistry } from "../../src/tracker/registry.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 23);

function backtestTracker(db: TestDatabase["db"], topN: number) {
  const config = defaultStrategyConfig();
  config.tracker.topN = topN;
  const clock = new VirtualClock(NOW - 7 * DAY);
  const market = new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: ["SOL"] });
  return createTrackerModule({
    db,
    rpc: null,
    bus: new Bus(),
    market,
    clock,
    config,
    scores: { latest: () => null, scoreNow: async () => null },
    mode: "backtest",
    backtestRange: { fromMs: NOW - 7 * DAY, toMs: NOW }
  });
}

describe.skipIf(!hasTestDatabase)("review: walk-forward backtest rank runs", () => {
  let database: TestDatabase;
  let liveRunId = 0;

  beforeAll(async () => {
    database = await createTestDatabase("review_wf");
    const config = defaultStrategyConfig();
    const live = await rankWallets(database.db, { asOfMs: NOW - 2 * DAY, config: config.tracker, bundleSlotWindow: 1, label: "live" });
    liveRunId = live.runId ?? 0;
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("a walk-forward backtest must not replace the run the live trader and SNYPRA read", async () => {
    const tracker = backtestTracker(database.db, 100);
    await tracker.prepareWalkForward(NOW - 7 * DAY, NOW);
    const liveRegistry = new TrackedWalletRegistry({ db: database.db });
    await liveRegistry.load(NOW);
    expect(liveRegistry.currentRun()?.runId).toBe(liveRunId);
    expect((await latestRunAsOf(database.db, NOW))?.runId).toBe(liveRunId);
    expect((await latestRun(database.db))?.runId).toBe(liveRunId);
  });

  it("a walk-forward backtest only switches between its own point-in-time runs", async () => {
    const tracker = backtestTracker(database.db, 100);
    const walkForwardRuns = await tracker.prepareWalkForward(NOW - 7 * DAY, NOW);
    await tracker.start();
    tracker.registry.setAsOf(NOW - DAY);
    const used = tracker.registry.currentRun()?.runId ?? -1;
    await tracker.stop();
    expect(walkForwardRuns).toContain(used);
  });

  it("a walk-forward backtest with a different tracker config must not reuse another config's runs", async () => {
    const first = await backtestTracker(database.db, 100).prepareWalkForward(NOW - 7 * DAY, NOW);
    const second = await backtestTracker(database.db, 3).prepareWalkForward(NOW - 7 * DAY, NOW);
    const params = await database.db.query<{ id: string; top_n: string }>(
      "SELECT id::text, params->>'topN' AS top_n FROM wallet_rank_runs WHERE id = ANY($1::bigint[]) ORDER BY id",
      [second.map(String)]
    );
    expect(second).not.toEqual(first);
    expect(params.rows.map((row) => Number(row.top_n))).toEqual(second.map(() => 3));
  });
});
