import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { markHubs } from "../../src/scorer/intelStore.js";
import { loadWalletFacts } from "../../src/tracker/rankQueries.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";
import { BASE_MS, insertIntel, insertLaunches } from "../tracker.db.js";

const DAY = 86_400_000;

describe.skipIf(!hasTestDatabase)("review: CreateEvent.creator is a free instruction argument but drives ranking exclusions", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("review_creator_grief");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("does not exclude a smart wallet because a third party launched a coin naming it as creator", async () => {
    await insertLaunches(database.db, [{ mint: "GriefMint", createdAtMs: BASE_MS, dev: "GrieferSigner", creator: "SmartWallet" }]);
    const facts = await loadWalletFacts(database.db, ["SmartWallet"], { fromMs: BASE_MS - 90 * DAY, asOfMs: BASE_MS + DAY }, new Set());
    expect(facts.get("SmartWallet")?.devLinked).toBe(false);
  });

  it("does not mark every wallet funded by an exchange hub as dev funded after one launch names the hub as creator", async () => {
    await insertLaunches(database.db, [{ mint: "TributeMint", createdAtMs: BASE_MS, dev: "PranksterSigner", creator: "ExchangeHotWallet" }]);
    await markHubs(database.db, ["ExchangeHotWallet"]);
    await insertIntel(database.db, "SmartWallet2", "ExchangeHotWallet", BASE_MS + 1_000, BASE_MS - DAY);
    const facts = await loadWalletFacts(database.db, ["SmartWallet2"], { fromMs: BASE_MS - 90 * DAY, asOfMs: BASE_MS + DAY }, new Set());
    expect(facts.get("SmartWallet2")?.devFunded).toBe(false);
  });
});
