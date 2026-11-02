import pg from "pg";
import { createDb, type Db } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
export const hasTestDatabase = TEST_DATABASE_URL.length > 0;

export interface TestDatabase {
  db: Db;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(prefix: string): Promise<TestDatabase> {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  const name = `${prefix}_${process.pid}_${Math.floor(Math.random() * 1e9)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = createDb({ connectionString: url.toString(), maxConnections: 5, ssl: false, applicationName: "test" });
  await runMigrations(db);
  return {
    db,
    url: url.toString(),
    async drop() {
      await db.end();
      const cleanup = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    }
  };
}
