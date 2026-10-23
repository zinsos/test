import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchWriter } from "../src/db/batch.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

describe.skipIf(!hasTestDatabase)("BatchWriter flush barrier", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("batch_barrier");
    await database.db.query("CREATE TABLE barrier_rows (id INTEGER PRIMARY KEY)");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("makes every pushed row visible once flush resolves, even with size-triggered flushes running", async () => {
    const writer = new BatchWriter(database.db, { flushIntervalMs: 60_000, maxBufferedRows: 50, maxRetries: 1 });
    writer.register({ table: "barrier_rows", columns: ["id"], conflict: "ON CONFLICT DO NOTHING" });
    for (let id = 0; id < 3_000; id += 1) {
      writer.push("barrier_rows", [id]);
    }
    await writer.flush();
    const result = await database.db.query<{ n: number }>("SELECT count(*)::int AS n FROM barrier_rows");
    expect(result.rows[0]?.n).toBe(3_000);
    expect(writer.stats()).toEqual({ buffered: 0, written: 3_000, dropped: 0 });
  });
});
