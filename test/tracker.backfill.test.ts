import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RpcClient, type ParsedTransaction, type SignatureInfo } from "../src/chain/rpc.js";
import { backfillWallet, backfillWallets, loadBackfillState, type BackfillRpc } from "../src/tracker/backfill.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { insertHistory } from "./tracker.db.js";
import { asParsed, fixture, signerOf } from "./tracker.fixtures.js";

const MIGRATOR = signerOf(fixture("GK5Z3vZ6"));
const DEV = signerOf(fixture("4bGWUf7U"));
const NEWER = fixture("GK5Z3vZ6");
const OLDER = fixture("4uaZFYCy");
const SINCE_MS = (OLDER.blockTime - 3_600) * 1000;

interface ChainEntry {
  info: SignatureInfo;
  tx: ParsedTransaction | null;
}

function filler(signature: string, blockTime: number, err: unknown = null): ChainEntry {
  return {
    info: { signature, slot: blockTime, blockTime, err },
    tx: {
      slot: blockTime,
      blockTime,
      meta: { err, fee: 5000, preBalances: [], postBalances: [], logMessages: ["Program 11111111111111111111111111111111 invoke [1]"] },
      transaction: { signatures: [signature], message: { accountKeys: [], instructions: [] } }
    }
  };
}

function real(prefix: string): ChainEntry {
  const tx = fixture(prefix);
  return { info: { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, err: null }, tx: asParsed(tx) };
}

class FakeRpc implements BackfillRpc {
  readonly history = new Map<string, ChainEntry[]>();
  readonly fetched: string[] = [];
  readonly failing = new Set<string>();
  signatureCalls = 0;

  setHistory(wallet: string, entries: ChainEntry[]): void {
    this.history.set(wallet, [...entries].sort((a, b) => (b.info.blockTime ?? 0) - (a.info.blockTime ?? 0)));
  }

  prepend(wallet: string, entries: ChainEntry[]): void {
    this.setHistory(wallet, [...entries, ...(this.history.get(wallet) ?? [])]);
  }

  async getSignaturesForAddress(address: string, options: { before?: string; until?: string; limit?: number }): Promise<SignatureInfo[]> {
    this.signatureCalls += 1;
    const entries = this.history.get(address) ?? [];
    let start = 0;
    if (options.before) {
      start = entries.findIndex((entry) => entry.info.signature === options.before) + 1;
    }
    const page: SignatureInfo[] = [];
    for (let index = start; index < entries.length && page.length < (options.limit ?? 1000); index += 1) {
      const entry = entries[index];
      if (!entry || entry.info.signature === options.until) {
        break;
      }
      page.push(entry.info);
    }
    return page;
  }

  async getParsedTransaction(signature: string): Promise<ParsedTransaction | null> {
    this.fetched.push(signature);
    if (this.failing.has(signature)) {
      throw new Error("rpc unavailable");
    }
    for (const entries of this.history.values()) {
      const found = entries.find((entry) => entry.info.signature === signature);
      if (found) {
        return found.tx;
      }
    }
    return null;
  }
}

function migratorHistory(): ChainEntry[] {
  return [
    filler("f-new-2", NEWER.blockTime + 50),
    filler("f-new-1", NEWER.blockTime + 20),
    filler("f-failed", NEWER.blockTime + 10, { InstructionError: [0, "Custom"] }),
    real("GK5Z3vZ6"),
    filler("f-mid", NEWER.blockTime - 5),
    real("4uaZFYCy"),
    filler("f-old-1", OLDER.blockTime - 60),
    filler("f-ancient-1", OLDER.blockTime - 7_200),
    filler("f-ancient-2", OLDER.blockTime - 9_000)
  ];
}

const baseOptions = { sinceMs: SINCE_MS, maxSignatures: 1_000, concurrency: 2, pageSize: 3, txConcurrency: 2 };

describe.skipIf(!hasTestDatabase)("wallet history backfill", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("tracker_backfill");
  });

  beforeEach(async () => {
    await database.db.query("TRUNCATE wallet_history_trades, wallet_backfill_state");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("pages back to the since time, keeps the wallet's pump trades and records coverage", async () => {
    const rpc = new FakeRpc();
    rpc.setHistory(MIGRATOR, migratorHistory());
    const result = await backfillWallet(database.db, rpc, MIGRATOR, {
      ...baseOptions,
      maxConsecutiveErrors: 5,
      shouldStop: () => false
    });
    expect(result.error).toBeNull();
    expect(result.tradesWritten).toBe(2);
    expect(result.reachedSince).toBe(true);
    expect(result.skipped.failed_tx).toBe(1);
    expect(rpc.fetched).not.toContain("f-failed");
    expect(rpc.fetched).not.toContain("f-ancient-1");
    const rows = await database.db.query<{ mint: string; venue: number; quote_mint: string; event_index: number; is_buy: boolean; block_time: Date; token_amount: bigint }>(
      `SELECT mint, venue, quote_mint, event_index, is_buy, block_time, token_amount FROM wallet_history_trades WHERE wallet = $1 ORDER BY block_time`,
      [MIGRATOR]
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.venue).toBe(1);
      expect(row.quote_mint).toBe("SOL");
      expect(row.is_buy).toBe(true);
      expect(row.token_amount).toBe(300_000_000_000n);
      expect(row.event_index).toBe(2);
    }
    expect(rows.rows[0]?.block_time.getTime()).toBe(OLDER.blockTime * 1000);
    const state = await loadBackfillState(database.db, MIGRATOR);
    expect(state?.newestSignature).toBe("f-new-2");
    expect(state?.oldestSignature).toBe("f-old-1");
    expect(state?.coveredFromMs).toBeLessThanOrEqual(SINCE_MS);
    expect(state?.coveredToMs).toBe((NEWER.blockTime + 50) * 1000);
  });

  it("resumes without refetching and only scans new signatures on the next run", async () => {
    const rpc = new FakeRpc();
    rpc.setHistory(MIGRATOR, migratorHistory());
    const options = { ...baseOptions, maxConsecutiveErrors: 5, shouldStop: () => false };
    await backfillWallet(database.db, rpc, MIGRATOR, options);
    const firstFetches = rpc.fetched.length;
    const again = await backfillWallet(database.db, rpc, MIGRATOR, options);
    expect(again.transactionsFetched).toBe(0);
    expect(again.tradesWritten).toBe(0);
    expect(rpc.fetched.length).toBe(firstFetches);
    rpc.prepend(MIGRATOR, [filler("f-newest", NEWER.blockTime + 500)]);
    const third = await backfillWallet(database.db, rpc, MIGRATOR, options);
    expect(rpc.fetched.slice(firstFetches)).toEqual(["f-newest"]);
    expect(third.signaturesSeen).toBe(1);
    const state = await loadBackfillState(database.db, MIGRATOR);
    expect(state?.newestSignature).toBe("f-newest");
  });

  it("respects the signature cap and continues from the oldest scanned signature later", async () => {
    const rpc = new FakeRpc();
    rpc.setHistory(MIGRATOR, migratorHistory());
    const capped = { ...baseOptions, maxSignatures: 4, pageSize: 2, maxConsecutiveErrors: 5, shouldStop: () => false };
    const first = await backfillWallet(database.db, rpc, MIGRATOR, capped);
    expect(first.signaturesSeen).toBe(4);
    expect(first.reachedSince).toBe(false);
    expect(first.tradesWritten).toBe(1);
    const state = await loadBackfillState(database.db, MIGRATOR);
    expect(state?.oldestSignature).toBe(NEWER.signature);
    const fetchedBefore = new Set(rpc.fetched);
    const second = await backfillWallet(database.db, rpc, MIGRATOR, { ...capped, maxSignatures: 100 });
    expect(second.tradesWritten).toBe(1);
    expect(second.reachedSince).toBe(true);
    const refetched = rpc.fetched.slice(fetchedBefore.size).filter((signature) => fetchedBefore.has(signature));
    expect(refetched).toEqual([]);
  });

  it("skips signatures whose trades are already stored", async () => {
    const rpc = new FakeRpc();
    rpc.setHistory(MIGRATOR, migratorHistory());
    await insertHistory(database.db, [
      {
        wallet: MIGRATOR,
        mint: "Known",
        atMs: NEWER.blockTime * 1000,
        isBuy: true,
        tokenAmount: 1n,
        userQuote: 1n,
        signature: NEWER.signature,
        eventIndex: 2,
        fetchedAtMs: Date.UTC(2026, 0, 1)
      }
    ]);
    const result = await backfillWallet(database.db, rpc, MIGRATOR, { ...baseOptions, maxConsecutiveErrors: 5, shouldStop: () => false });
    expect(rpc.fetched).not.toContain(NEWER.signature);
    expect(result.skipped.already_stored).toBe(1);
    expect(result.tradesWritten).toBe(1);
  });

  it("counts transient fetch errors and aborts a wallet after too many in a row", async () => {
    const rpc = new FakeRpc();
    rpc.setHistory(MIGRATOR, migratorHistory());
    rpc.failing.add(OLDER.signature);
    const tolerant = await backfillWallet(database.db, rpc, MIGRATOR, { ...baseOptions, maxConsecutiveErrors: 5, shouldStop: () => false });
    expect(tolerant.error).toBeNull();
    expect(tolerant.skipped.fetch_error).toBe(1);
    expect(tolerant.tradesWritten).toBe(1);
    await database.db.query("TRUNCATE wallet_history_trades, wallet_backfill_state");
    const broken = new FakeRpc();
    broken.setHistory(MIGRATOR, migratorHistory());
    for (const entry of migratorHistory()) {
      broken.failing.add(entry.info.signature);
    }
    const aborted = await backfillWallet(database.db, broken, MIGRATOR, {
      ...baseOptions,
      txConcurrency: 1,
      maxConsecutiveErrors: 2,
      shouldStop: () => false
    });
    expect(aborted.error).toContain("rpc unavailable");
    const state = await database.db.query<{ last_error: string | null }>(`SELECT last_error FROM wallet_backfill_state WHERE wallet = $1`, [MIGRATOR]);
    expect(state.rows[0]?.last_error).toContain("rpc unavailable");
  });

  it("backfills several wallets concurrently and stops when asked", async () => {
    const rpc = new FakeRpc();
    rpc.setHistory(MIGRATOR, migratorHistory());
    rpc.setHistory(DEV, [real("4bGWUf7U"), real("c2YcmJMq"), real("2LVgW26R")]);
    const summary = await backfillWallets(database.db, rpc, [MIGRATOR, DEV, MIGRATOR], {
      sinceMs: SINCE_MS,
      maxSignatures: 100,
      concurrency: 2
    });
    expect(summary.wallets.map((item) => item.wallet).sort()).toEqual([DEV, MIGRATOR].sort());
    expect(summary.errors).toBe(0);
    expect(summary.tradesWritten).toBe(2);
    const stopped = await backfillWallets(database.db, rpc, ["Other"], {
      sinceMs: SINCE_MS,
      maxSignatures: 100,
      concurrency: 1,
      shouldStop: () => true
    });
    expect(stopped.wallets).toEqual([]);
  });

  it("marks wallets whose history ends before the since time as exhausted", async () => {
    const rpc = new FakeRpc();
    rpc.setHistory(MIGRATOR, [real("GK5Z3vZ6")]);
    const result = await backfillWallet(database.db, rpc, MIGRATOR, { ...baseOptions, maxConsecutiveErrors: 5, shouldStop: () => false });
    expect(result.exhausted).toBe(true);
    const calls = rpc.signatureCalls;
    await backfillWallet(database.db, rpc, MIGRATOR, { ...baseOptions, maxConsecutiveErrors: 5, shouldStop: () => false });
    expect(rpc.signatureCalls - calls).toBe(1);
  });

  it("discovers activity for a wallet whose history was empty on the first run", async () => {
    const rpc = new FakeRpc();
    rpc.setHistory(MIGRATOR, []);
    const options = { ...baseOptions, maxConsecutiveErrors: 5, shouldStop: () => false };
    const empty = await backfillWallet(database.db, rpc, MIGRATOR, options);
    expect(empty.exhausted).toBe(true);
    expect((await loadBackfillState(database.db, MIGRATOR))?.newestSignature).toBeNull();
    rpc.setHistory(MIGRATOR, [real("GK5Z3vZ6")]);
    const later = await backfillWallet(database.db, rpc, MIGRATOR, options);
    expect(later.tradesWritten).toBe(1);
    expect((await loadBackfillState(database.db, MIGRATOR))?.newestSignature).toBe(NEWER.signature);
  });

  it("moves the newest marker forward and reports a gap when new activity exceeds the budget", async () => {
    const rpc = new FakeRpc();
    rpc.setHistory(MIGRATOR, [real("4uaZFYCy")]);
    const options = { ...baseOptions, pageSize: 2, maxConsecutiveErrors: 5, shouldStop: () => false };
    await backfillWallet(database.db, rpc, MIGRATOR, options);
    rpc.prepend(MIGRATOR, [
      filler("burst-1", NEWER.blockTime + 1),
      filler("burst-2", NEWER.blockTime + 2),
      filler("burst-3", NEWER.blockTime + 3),
      filler("burst-4", NEWER.blockTime + 4)
    ]);
    const result = await backfillWallet(database.db, rpc, MIGRATOR, { ...options, maxSignatures: 2 });
    expect(result.forwardGap).toBe(true);
    expect(result.signaturesSeen).toBe(2);
    expect((await loadBackfillState(database.db, MIGRATOR))?.newestSignature).toBe("burst-4");
  });
});

describe("backfill rpc contract", () => {
  it("is satisfied by the shared rpc client", () => {
    const client: BackfillRpc = new RpcClient({ url: "http://127.0.0.1:1", maxRps: 1, maxConcurrency: 1, timeoutMs: 10, maxRetries: 0 });
    expect(typeof client.getParsedTransaction).toBe("function");
  });
});
