import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { Bus } from "../../src/core/bus.js";
import { VirtualClock } from "../../src/core/clock.js";
import { MarketState } from "../../src/market/state.js";
import { createRecorderModule, type FetchLike } from "../../src/recorder/index.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const URI = "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

describe.skipIf(!hasTestDatabase)("review ops: launch metadata across a deploy", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("review_ops_meta");
    await database.db.query(
      `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, uri, create_signature, create_slot, created_at,
                             token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token)
       VALUES ('QueuedAtShutdownMint', 'curve', 'dev', 'dev', $1, 'sig', 1, $2, 1000000000000000, 1073000000000000, 30000000000, 793100000000000)`,
      [URI, new Date(NOW - 5 * 60_000)]
    );
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("fetches metadata for a tracked launch whose fetch was still queued when the previous instance stopped", async () => {
    const fetched: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      fetched.push(input);
      return new Response(JSON.stringify({ name: "x", twitter: "https://x.com/x" }), { status: 200 });
    };
    const config = defaultStrategyConfig();
    config.recorder.rpcSnapshotsEnabled = false;
    const clock = new VirtualClock(NOW);
    const recorder = createRecorderModule({
      db: database.db,
      rpc: null,
      bus: new Bus(),
      market: new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null }),
      clock,
      config,
      env: { METADATA_GATEWAY: undefined },
      fetchImpl,
      service: { manageTradePartitions: false, recordRestartGap: false, aggregateFlushMs: 1e9 }
    });
    await recorder.start();
    await clock.advanceTo(NOW + 120_000);
    await recorder.metadata.drain();
    await recorder.stop();
    const row = await database.db.query<{ fetched: Date | null }>(
      "SELECT metadata_fetched_at AS fetched FROM launches WHERE mint = 'QueuedAtShutdownMint'"
    );
    expect({ fetched: fetched.length, stored: row.rows[0]?.fetched !== null }).toEqual({ fetched: 1, stored: true });
  });
});
