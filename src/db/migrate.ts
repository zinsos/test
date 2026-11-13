import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleLogger } from "../core/logger.js";
import type { Db } from "./pool.js";

const log = moduleLogger("migrate");

export function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "migrations"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations")
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("migrations directory not found");
  }
  return found;
}

export async function runMigrations(db: Db, directory = resolveMigrationsDir()): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const applied = new Set(
    (await db.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((row) => row.version)
  );
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = await readFile(path.join(directory, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727274)");
      const again = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
      if (again.rowCount === 0) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        newlyApplied.push(file);
        log.info({ file }, "migration applied");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}
