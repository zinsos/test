import type { Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Db } from "./pool.js";

const log = moduleLogger("db.wait");
const ABORT_POLL_MS = 1_000;

export interface WaitForDatabaseOptions {
  clock: Clock;
  abort?: () => boolean;
  maxWaitMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export class DatabaseWaitAborted extends Error {
  constructor() {
    super("stopped while waiting for the database");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pause(clock: Clock, delayMs: number, abort: () => boolean): Promise<void> {
  const until = clock.nowMs() + delayMs;
  while (clock.nowMs() < until && !abort()) {
    await clock.sleepUntil(Math.min(until, clock.nowMs() + ABORT_POLL_MS));
  }
}

export async function waitForDatabase(db: Db, options: WaitForDatabaseOptions): Promise<number> {
  const { clock } = options;
  const abort = options.abort ?? (() => false);
  const maxWaitMs = options.maxWaitMs ?? 10 * 60_000;
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const startedAtMs = clock.nowMs();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.query("SELECT 1");
      if (attempt > 0) {
        log.info({ attempts: attempt + 1, waitedMs: clock.nowMs() - startedAtMs }, "database reachable");
      }
      return attempt + 1;
    } catch (error) {
      if (abort()) {
        throw new DatabaseWaitAborted();
      }
      const waitedMs = clock.nowMs() - startedAtMs;
      if (waitedMs >= maxWaitMs) {
        throw new Error(`database unreachable for ${Math.round(waitedMs / 1000)}s: ${messageOf(error)}`);
      }
      const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt, maxWaitMs - waitedMs);
      log.warn({ err: messageOf(error), attempt: attempt + 1, retryInMs: delayMs }, "database unreachable, waiting");
      await pause(clock, delayMs, abort);
      if (abort()) {
        throw new DatabaseWaitAborted();
      }
    }
  }
}
