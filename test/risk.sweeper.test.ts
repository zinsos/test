import { Keypair, PublicKey, SystemProgram, TransactionExpiredBlockheightExceededError, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SweeperConfigSchema, type SweeperConfig } from "../src/config/strategy.js";
import { VirtualClock } from "../src/core/clock.js";
import type { Db } from "../src/db/pool.js";
import {
  HotColdSweeper,
  SweeperConfigError,
  hotFloorLamports,
  insertSweepRow,
  sweepAmountLamports,
  validateColdAddress,
  type HotColdSweeperOptions,
  type SweeperConnection
} from "../src/risk/sweeper.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

const SOL = 1_000_000_000;
const FEE = 5_000n;
const START_MS = Date.UTC(2026, 9, 23, 12);

function sweeperConfig(overrides: Partial<SweeperConfig> = {}): SweeperConfig {
  return SweeperConfigSchema.parse({ enabled: true, ...overrides });
}

interface SweepRowsResult {
  rows: Array<{ id: bigint }>;
}

function fakeDb(behaviour?: () => Promise<SweepRowsResult>) {
  return {
    query: vi.fn(async (_sql: string, _params?: unknown[]): Promise<SweepRowsResult> =>
      behaviour ? behaviour() : { rows: [{ id: 7n }] }
    )
  };
}

type FakeDb = ReturnType<typeof fakeDb>;

interface ConfirmResult {
  context: { slot: number };
  value: { err: unknown };
}

interface ConnectionBehaviour {
  balance?: () => Promise<number>;
  send?: () => Promise<string>;
  confirm?: () => Promise<ConfirmResult>;
}

function fakeConnection(balance: number, behaviour: ConnectionBehaviour = {}) {
  const blockhash = Keypair.generate().publicKey.toBase58();
  return {
    getBalance: vi.fn(async (): Promise<number> => (behaviour.balance ? behaviour.balance() : balance)),
    getLatestBlockhash: vi.fn(async () => ({ blockhash, lastValidBlockHeight: 1_000 })),
    sendRawTransaction: vi.fn(async (_raw: Uint8Array, _options?: unknown): Promise<string> =>
      behaviour.send ? behaviour.send() : "ignored"
    ),
    confirmTransaction: vi.fn(async (_strategy: unknown, _commitment?: unknown): Promise<ConfirmResult> =>
      behaviour.confirm ? behaviour.confirm() : { context: { slot: 5 }, value: { err: null } }
    )
  };
}

type FakeConnection = ReturnType<typeof fakeConnection>;

interface BuildOptions extends Partial<Omit<HotColdSweeperOptions, "connection" | "db">> {
  connection: FakeConnection;
  db?: FakeDb;
  realDb?: Pick<Db, "query">;
}

function build(options: BuildOptions) {
  const hotKeypair = options.hotKeypair ?? Keypair.generate();
  const cold = Keypair.generate().publicKey.toBase58();
  const clock = new VirtualClock(START_MS);
  const db = options.db ?? fakeDb();
  const { connection, realDb, db: _ignored, ...rest } = options;
  const sweeper = new HotColdSweeper({
    coldAddress: cold,
    config: sweeperConfig(),
    clock,
    dryRun: false,
    isBusy: () => false,
    ...rest,
    hotKeypair,
    db: realDb ?? (db as unknown as Pick<Db, "query">),
    connection: connection as unknown as SweeperConnection
  });
  return { sweeper, clock, db, hotKeypair, cold: options.coldAddress ?? cold };
}

function sentTransaction(connection: FakeConnection): VersionedTransaction {
  const raw = connection.sendRawTransaction.mock.calls[0]?.[0];
  if (!raw) {
    throw new Error("nothing sent");
  }
  return VersionedTransaction.deserialize(raw);
}

function transferLamports(transaction: VersionedTransaction): { from: string; to: string; lamports: bigint; program: string } {
  const instruction = transaction.message.compiledInstructions[0];
  if (!instruction) {
    throw new Error("no instruction");
  }
  const keys = transaction.message.staticAccountKeys;
  const data = Buffer.from(instruction.data);
  return {
    program: keys[instruction.programIdIndex]?.toBase58() ?? "",
    from: keys[instruction.accountKeyIndexes[0] ?? -1]?.toBase58() ?? "",
    to: keys[instruction.accountKeyIndexes[1] ?? -1]?.toBase58() ?? "",
    lamports: data.readBigUInt64LE(4)
  };
}

describe("sweep amount", () => {
  const config = sweeperConfig();

  it("sweeps everything above target, reserve and fee", () => {
    expect(hotFloorLamports(config)).toBe(5_100_000_000n);
    expect(sweepAmountLamports(6_000_000_000n, config)).toBe(900_000_000n - FEE);
  });

  it("skips amounts below the minimum sweep", () => {
    expect(sweepAmountLamports(5_349_000_000n, config)).toBe(0n);
    expect(sweepAmountLamports(5_350_005_000n, config)).toBe(250_000_000n);
    expect(sweepAmountLamports(1_000_000_000n, config)).toBe(0n);
  });

  it("never leaves the hot wallet below its target", () => {
    const zeroReserve = sweeperConfig({ reserveSol: 0, minSweepSol: 0.000001 });
    for (let index = 0; index < 500; index += 1) {
      const balance = 5_000_000_000n + BigInt(Math.floor(Math.random() * 3 * SOL));
      for (const current of [config, zeroReserve]) {
        const amount = sweepAmountLamports(balance, current);
        expect(amount >= 0n).toBe(true);
        if (amount > 0n) {
          expect(balance - amount - FEE >= hotFloorLamports(current)).toBe(true);
        }
      }
    }
  });
});

describe("cold address validation", () => {
  const hot = Keypair.generate();

  it("accepts a normal wallet address", () => {
    const cold = Keypair.generate().publicKey;
    expect(validateColdAddress(` ${cold.toBase58()} `, hot.publicKey).equals(cold)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["garbage", "not-a-key"],
    ["short", bs58.encode(Buffer.alloc(31, 1))],
    ["system program", "11111111111111111111111111111111"]
  ])("rejects %s", (_label, address) => {
    expect(() => validateColdAddress(address, hot.publicKey)).toThrow(SweeperConfigError);
  });

  it("rejects the hot wallet itself", () => {
    expect(() => validateColdAddress(hot.publicKey.toBase58(), hot.publicKey)).toThrow(/equals the hot wallet/);
  });

  it("rejects program derived addresses", () => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], SystemProgram.programId);
    expect(() => validateColdAddress(pda.toBase58(), hot.publicKey)).toThrow(/program derived/);
  });

  it("fails construction with an invalid cold address", () => {
    expect(() => build({ connection: fakeConnection(0), coldAddress: "bad" })).toThrow(SweeperConfigError);
  });
});

describe("hot to cold sweeper", () => {
  it("transfers the excess from hot to cold and records it", async () => {
    const connection = fakeConnection(6 * SOL);
    const { sweeper, db, hotKeypair, cold } = build({ connection });
    const result = await sweeper.tick();
    expect(result.status).toBe("confirmed");
    expect(result.sweepLamports).toBe(900_000_000n - FEE);
    expect(result.balanceLamports).toBe(6_000_000_000n);
    expect(result.sweepId).toBe(7);
    const transaction = sentTransaction(connection);
    expect(transaction.version).toBe(0);
    expect(transferLamports(transaction)).toEqual({
      program: SystemProgram.programId.toBase58(),
      from: hotKeypair.publicKey.toBase58(),
      to: cold,
      lamports: 900_000_000n - FEE
    });
    const signature = transaction.signatures[0];
    expect(signature && bs58.encode(signature)).toBe(result.signature);
    const [insertSql, insertParams = []] = db.query.mock.calls[0] ?? ["", []];
    expect(insertSql).toMatch(/INSERT INTO sweeps/);
    expect(insertParams.slice(1, 7)).toEqual([hotKeypair.publicKey.toBase58(), cold, "899995000", "6000000000", result.signature, "sent"]);
    const [updateSql, updateParams] = db.query.mock.calls[1] ?? ["", []];
    expect(updateSql).toMatch(/UPDATE sweeps/);
    expect(updateParams).toEqual([result.signature, "confirmed", null]);
    expect(connection.confirmTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ signature: result.signature, lastValidBlockHeight: 1_000 }),
      "confirmed"
    );
  });

  it("does nothing below the minimum sweep", async () => {
    const connection = fakeConnection(5.2 * SOL);
    const { sweeper, db } = build({ connection });
    expect((await sweeper.tick()).status).toBe("below_minimum");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("skips while the trader is busy", async () => {
    const connection = fakeConnection(9 * SOL);
    const { sweeper } = build({ connection, isBusy: () => true });
    expect((await sweeper.tick()).status).toBe("busy");
    expect(connection.getBalance).not.toHaveBeenCalled();
    let calls = 0;
    const lateBusy = build({ connection, isBusy: () => (calls += 1) > 1 });
    expect((await lateBusy.sweeper.tick()).status).toBe("busy");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("records a dry run without sending", async () => {
    const connection = fakeConnection(8 * SOL);
    const { sweeper, db } = build({ connection, dryRun: true });
    const result = await sweeper.tick();
    expect(result.status).toBe("dry_run");
    expect(result.sweepLamports).toBe(2_900_000_000n - FEE);
    expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    const [, params = []] = db.query.mock.calls[0] ?? ["", []];
    expect(params[5]).toBeNull();
    expect(params[6]).toBe("dry_run");
  });

  it("reports disabled when the sweeper is off", async () => {
    const connection = fakeConnection(9 * SOL);
    const { sweeper } = build({ connection, config: sweeperConfig({ enabled: false }) });
    expect((await sweeper.tick()).status).toBe("disabled");
    sweeper.start();
    expect(sweeper.isRunning()).toBe(false);
  });

  it("marks the sweep failed when sending fails", async () => {
    const connection = fakeConnection(6 * SOL, { send: async () => Promise.reject(new Error("preflight failed")) });
    const { sweeper, db } = build({ connection });
    const result = await sweeper.tick();
    expect(result.status).toBe("failed");
    expect(result.error).toBe("preflight failed");
    expect(db.query.mock.calls[1]?.[1]).toEqual([result.signature, "failed", "preflight failed"]);
  });

  it("marks the sweep failed on an on chain error or expiry", async () => {
    const onChain = fakeConnection(6 * SOL, {
      confirm: async () => ({ context: { slot: 5 }, value: { err: { InstructionError: [0, "Custom"] } } })
    });
    expect((await build({ connection: onChain }).sweeper.tick()).status).toBe("failed");
    const expired = fakeConnection(6 * SOL, {
      confirm: async () => Promise.reject(new TransactionExpiredBlockheightExceededError("sig"))
    });
    const result = await build({ connection: expired }).sweeper.tick();
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/expired/);
  });

  it("leaves the sweep as sent when confirmation is unknown", async () => {
    const connection = fakeConnection(6 * SOL, { confirm: async () => Promise.reject(new Error("socket hang up")) });
    const { sweeper, db } = build({ connection });
    const result = await sweeper.tick();
    expect(result.status).toBe("sent");
    expect(db.query.mock.calls[1]?.[1]).toEqual([result.signature, "sent", "confirmation unknown: socket hang up"]);
  });

  it("never sends when the sweep cannot be recorded first", async () => {
    const connection = fakeConnection(6 * SOL);
    const db = fakeDb(async () => Promise.reject(new Error("db down")));
    const { sweeper } = build({ connection, db });
    const result = await sweeper.tick();
    expect(result.status).toBe("error");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("reports balance lookup errors", async () => {
    const connection = fakeConnection(0, { balance: async () => Promise.reject(new Error("429")) });
    expect((await build({ connection }).sweeper.tick()).status).toBe("error");
  });

  it("does not run two sweeps at once", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = fakeConnection(6 * SOL, {
      balance: async () => {
        await gate;
        return 6 * SOL;
      }
    });
    const { sweeper } = build({ connection });
    const first = sweeper.tick();
    expect((await sweeper.tick()).status).toBe("in_progress");
    release();
    expect((await first).status).toBe("confirmed");
  });

  it("runs on the clock schedule and stops cleanly", async () => {
    const connection = fakeConnection(5 * SOL);
    const { sweeper, clock } = build({ connection, config: sweeperConfig({ intervalMinutes: 30 }), initialDelayMs: 1000 });
    sweeper.start();
    sweeper.start();
    expect(sweeper.isRunning()).toBe(true);
    await clock.advanceTo(START_MS + 999);
    expect(connection.getBalance).toHaveBeenCalledTimes(0);
    await clock.advanceTo(START_MS + 1000);
    expect(connection.getBalance).toHaveBeenCalledTimes(1);
    await clock.advanceTo(START_MS + 1000 + 30 * 60_000);
    expect(connection.getBalance).toHaveBeenCalledTimes(2);
    await sweeper.stop();
    await clock.advanceTo(START_MS + 1000 + 120 * 60_000);
    expect(connection.getBalance).toHaveBeenCalledTimes(2);
    expect(clock.pendingCount()).toBe(0);
  });
});

describe.skipIf(!hasTestDatabase)("hot to cold sweeper with postgres", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("risk_sweeper");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("writes dry run and confirmed sweeps and ignores duplicate signatures", async () => {
    const dry = build({ connection: fakeConnection(7 * SOL), realDb: database.db, dryRun: true });
    expect((await dry.sweeper.tick()).status).toBe("dry_run");
    const live = build({ connection: fakeConnection(7 * SOL), realDb: database.db });
    const result = await live.sweeper.tick();
    expect(result.status).toBe("confirmed");
    const rows = await database.db.query<{ status: string; lamports: bigint; hot_balance_before: bigint; signature: string | null; at: Date }>(
      "SELECT status, lamports, hot_balance_before, signature, at FROM sweeps ORDER BY id"
    );
    expect(rows.rows.map((row) => row.status)).toEqual(["dry_run", "confirmed"]);
    expect(rows.rows[1]?.lamports).toBe(1_900_000_000n - FEE);
    expect(rows.rows[1]?.hot_balance_before).toBe(7_000_000_000n);
    expect(rows.rows[1]?.signature).toBe(result.signature);
    expect(rows.rows[1]?.at.getTime()).toBe(START_MS);
    const duplicate = await insertSweepRow(database.db, {
      atMs: START_MS,
      from: "a",
      to: "b",
      lamports: 1n,
      balanceBefore: 1n,
      signature: result.signature,
      status: "sent",
      error: null
    });
    expect(duplicate).toBeNull();
    const count = await database.db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM sweeps");
    expect(count.rows[0]?.count).toBe(2);
  });
});
