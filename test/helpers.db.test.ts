import { describe, expect, it } from "vitest";
import { createTestDatabase, hasTestDatabase } from "./helpers/db.js";

describe.skipIf(!hasTestDatabase)("test database helper", () => {
  it("creates a migrated database and drops it", async () => {
    const database = await createTestDatabase("helper");
    const result = await database.db.query("SELECT count(*)::int AS n FROM launches");
    expect(result.rows[0]?.n).toBe(0);
    await database.drop();
  });
});
