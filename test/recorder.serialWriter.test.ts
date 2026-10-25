import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BatchTableSpec } from "../src/db/batch.js";
import { toNumber } from "../src/db/pool.js";
import { SerialBatchWriter } from "../src/recorder/serialWriter.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const GAPS_SPEC: BatchTableSpec = {
  table: "ingest_gaps",
  columns: ["source", "from_slot", "to_slot", "started_at", "ended_at", "reason"],
  conflict: ""
};

describe.skipIf(!hasTestDatabase)("serial batch writer", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase("serial_writer");
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it("makes flush a barrier even while size-triggered flushes are running", async () => {
    const writer = new SerialBatchWriter(testDb.db, [GAPS_SPEC], { flushIntervalMs: 60_000, flushAtRows: 50, maxRetries: 1 });
    const at = new Date(1_800_000_000_000);
    for (let index = 0; index < 3_000; index += 1) {
      writer.push(GAPS_SPEC.table, ["test", BigInt(index), null, at, at, `row ${index}`]);
    }
    await writer.flush();
    const result = await testDb.db.query<{ n: unknown }>("SELECT count(*) AS n FROM ingest_gaps WHERE source = 'test'");
    expect(toNumber(result.rows[0]?.n)).toBe(3_000);
    expect(writer.stats()).toEqual({ buffered: 0, written: 3_000, dropped: 0 });
  });

  it("flushes remaining rows on stop", async () => {
    const writer = new SerialBatchWriter(testDb.db, [GAPS_SPEC], { flushIntervalMs: 60_000, flushAtRows: 1_000, maxRetries: 1 });
    writer.start();
    const at = new Date(1_800_000_000_000);
    writer.push(GAPS_SPEC.table, ["stop", 1n, 2n, at, at, "pending"]);
    await writer.stop();
    const result = await testDb.db.query<{ n: unknown }>("SELECT count(*) AS n FROM ingest_gaps WHERE source = 'stop'");
    expect(toNumber(result.rows[0]?.n)).toBe(1);
  });
});
