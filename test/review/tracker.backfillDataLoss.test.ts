import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ParsedTransaction, SignatureInfo } from "../../src/chain/rpc.js";
import { backfillWallet, type BackfillRpc } from "../../src/tracker/backfill.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "../helpers/db.js";
import { insertHistory } from "../tracker.db.js";
import { asParsed, fixture, signerOf } from "../tracker.fixtures.js";

const MIGRATOR = signerOf(fixture("GK5Z3vZ6"));
const NEWER = fixture("GK5Z3vZ6");
const OLDER = fixture("4uaZFYCy");
const SINCE_MS = (OLDER.blockTime - 3_600) * 1000;

interface Entry {
  info: SignatureInfo;
  tx: ParsedTransaction;
}

function real(prefix: string): Entry {
  const tx = fixture(prefix);
  return { info: { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, err: null }, tx: asParsed(tx) };
}

class Rpc implements BackfillRpc {
  readonly failing = new Set<string>();

  constructor(private readonly entries: Entry[]) {}

  async getSignaturesForAddress(_address: string, options: { before?: string; until?: string; limit?: number }): Promise<SignatureInfo[]> {
    let start = 0;
    if (options.before) {
      start = this.entries.findIndex((entry) => entry.info.signature === options.before) + 1;
    }
    const page: SignatureInfo[] = [];
    for (let index = start; index < this.entries.length && page.length < (options.limit ?? 1000); index += 1) {
      const entry = this.entries[index];
      if (!entry || entry.info.signature === options.until) {
        break;
      }
      page.push(entry.info);
    }
    return page;
  }

  async getParsedTransaction(signature: string): Promise<ParsedTransaction | null> {
    if (this.failing.has(signature)) {
      throw new Error("429 too many requests");
    }
    return this.entries.find((entry) => entry.info.signature === signature)?.tx ?? null;
  }
}

const options = {
  sinceMs: SINCE_MS,
  maxSignatures: 1_000,
  concurrency: 1,
  txConcurrency: 1,
  pageSize: 10,
  maxConsecutiveErrors: 5,
  shouldStop: () => false
};

async function storedFor(db: TestDatabase["db"], wallet: string, signature: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM wallet_history_trades WHERE wallet = $1 AND signature = $2",
    [wallet, signature]
  );
  return result.rows[0]?.n ?? 0;
}

describe.skipIf(!hasTestDatabase)("review: wallet history backfill loses trades", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("review_backfill");
  });

  beforeEach(async () => {
    await database.db.query("TRUNCATE wallet_history_trades, wallet_backfill_state");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("recovers a trade whose transaction fetch failed transiently on a later run", async () => {
    const entries = [real("GK5Z3vZ6"), real("4uaZFYCy")];
    const flaky = new Rpc(entries);
    flaky.failing.add(OLDER.signature);
    const first = await backfillWallet(database.db, flaky, MIGRATOR, options);
    expect(first.skipped.fetch_error).toBe(1);
    expect(await storedFor(database.db, MIGRATOR, OLDER.signature)).toBe(0);
    const healthy = new Rpc(entries);
    await backfillWallet(database.db, healthy, MIGRATOR, options);
    expect(await storedFor(database.db, MIGRATOR, OLDER.signature)).toBeGreaterThan(0);
  });

  it("stores this wallet's trade even when another wallet's trade from the same transaction is already stored", async () => {
    await insertHistory(database.db, [
      {
        wallet: "CoSignerWallet",
        mint: "OtherMint",
        signature: NEWER.signature,
        eventIndex: 7,
        atMs: NEWER.blockTime * 1000,
        isBuy: true,
        tokenAmount: 1_000n,
        userQuote: 1_000_000n,
        fetchedAtMs: NEWER.blockTime * 1000
      }
    ]);
    const rpc = new Rpc([real("GK5Z3vZ6")]);
    const result = await backfillWallet(database.db, rpc, MIGRATOR, options);
    expect(result.skipped.already_stored).toBe(1);
    expect(await storedFor(database.db, MIGRATOR, NEWER.signature)).toBeGreaterThan(0);
  });
});
