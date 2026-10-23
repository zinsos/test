import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ParsedInstruction, ParsedTransaction, SignatureInfo } from "../src/chain/rpc.js";
import { VirtualClock } from "../src/core/clock.js";
import { SYSTEM_PROGRAM_ID } from "../src/core/constants.js";
import { fundingTransfer, incomingTransfers, transferToWallet } from "../src/scorer/funding.js";
import { Bus } from "../src/core/bus.js";
import { buildFundingClusters } from "../src/scorer/clusters.js";
import { createScorerModule } from "../src/scorer/index.js";
import { isHubFromFacts, WalletIntelService, type IntelRpc } from "../src/scorer/intel.js";
import { ScoringModel } from "../src/scorer/model.js";
import type { IntelRequest, WalletIntel } from "../src/scorer/types.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { newMarket, scorerConfig, SOL, T0 } from "./scorer.fixtures.js";

interface FixtureTx {
  signature: string;
  slot: number;
  blockTime: number;
  category: string;
  logs: string[];
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
}

const fixtures: FixtureTx[] = JSON.parse(readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8"));
const MIN_FUNDING = 10_000_000n;

function systemInstruction(type: string, info: Record<string, unknown>): ParsedInstruction {
  return { programId: SYSTEM_PROGRAM_ID, program: "system", parsed: { type, info } };
}

function parsedShell(fixture: FixtureTx): ParsedTransaction {
  const payer = fixture.accountKeys[0] ?? "";
  const created = fixture.accountKeys.flatMap((key, index) =>
    (fixture.preBalances[index] ?? 0) === 0 && (fixture.postBalances[index] ?? 0) > 0
      ? [systemInstruction("createAccount", { source: payer, newAccount: key, lamports: fixture.postBalances[index], space: 165 })]
      : []
  );
  return {
    slot: fixture.slot,
    blockTime: fixture.blockTime,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: fixture.preBalances,
      postBalances: fixture.postBalances,
      logMessages: fixture.logs,
      innerInstructions: created.length > 0 ? [{ index: 0, instructions: created }] : []
    },
    transaction: {
      signatures: [fixture.signature],
      message: {
        accountKeys: fixture.accountKeys.map((pubkey, index) => ({ pubkey, signer: index === 0, writable: true })),
        instructions: [{ programId: "ComputeBudget111111111111111111111111111111", data: "3" }]
      }
    }
  };
}

function syntheticTx(signature: string, slot: number, outer: ParsedInstruction[], inner: ParsedInstruction[] = [], err: unknown = null): ParsedTransaction {
  return {
    slot,
    blockTime: Math.floor(T0 / 1000) - 3_600,
    meta: { err, fee: 5_000, preBalances: [], postBalances: [], innerInstructions: inner.length > 0 ? [{ index: 0, instructions: inner }] : [] },
    transaction: { signatures: [signature], message: { accountKeys: [], instructions: outer } }
  };
}

class FakeRpc implements IntelRpc {
  readonly signatures = new Map<string, SignatureInfo[]>();
  readonly transactions = new Map<string, ParsedTransaction>();
  readonly failingWallets = new Set<string>();
  signatureCalls = 0;
  transactionCalls = 0;
  gate: Promise<void> | null = null;

  async getSignaturesForAddress(address: string, options: { before?: string; limit?: number }): Promise<SignatureInfo[]> {
    this.signatureCalls += 1;
    if (this.gate) {
      await this.gate;
    }
    if (this.failingWallets.has(address)) {
      throw new Error("rpc down");
    }
    const all = this.signatures.get(address) ?? [];
    const start = options.before ? all.findIndex((info) => info.signature === options.before) + 1 : 0;
    return all.slice(Math.max(0, start), Math.max(0, start) + (options.limit ?? 1000));
  }

  async getParsedTransaction(signature: string): Promise<ParsedTransaction | null> {
    this.transactionCalls += 1;
    return this.transactions.get(signature) ?? null;
  }

  addHistory(wallet: string, txs: ParsedTransaction[], extra: SignatureInfo[] = []): void {
    const infos = txs.map((tx) => ({
      signature: tx.transaction.signatures[0] ?? "",
      slot: tx.slot,
      blockTime: tx.blockTime,
      err: tx.meta?.err ?? null
    }));
    for (const tx of txs) {
      this.transactions.set(tx.transaction.signatures[0] ?? "", tx);
    }
    this.signatures.set(wallet, [...infos, ...extra]);
  }
}

function fundingTx(signature: string, from: string, to: string, lamports: bigint, slot = 1_000): ParsedTransaction {
  return syntheticTx(signature, slot, [systemInstruction("transfer", { source: from, destination: to, lamports: Number(lamports) })]);
}

function fundingTxAt(signature: string, from: string, to: string, lamports: bigint, atMs: number): ParsedTransaction {
  return { ...fundingTx(signature, from, to, lamports), blockTime: Math.floor(atMs / 1000) };
}

function request(wallet: string, buySignature = "buy"): IntelRequest {
  return { wallet, buySignature, buySlot: 5_000 };
}

describe("funding transfer parsing", () => {
  it("never treats fixture pump transactions as funding for their signer", () => {
    for (const fixture of fixtures) {
      const tx = parsedShell(fixture);
      const signer = fixture.accountKeys[0] ?? "";
      expect(fundingTransfer(tx, signer, 1n), fixture.signature).toBeNull();
    }
  });

  it("sees createAccount rent from the payer in fixture create transactions", () => {
    const create = fixtures.find((fixture) => fixture.signature.startsWith("K48XDQLk"));
    expect(create).toBeDefined();
    const fixture = create as FixtureTx;
    const tx = parsedShell(fixture);
    const ata = fixture.accountKeys[4] ?? "";
    const transfers = incomingTransfers(tx, ata);
    expect(transfers).toEqual([{ source: fixture.accountKeys[0], lamports: 1_513_840n, kind: "createAccount" }]);
    expect(fundingTransfer(tx, ata, MIN_FUNDING)).toBeNull();
    expect(fundingTransfer(tx, ata, 1n)?.source).toBe(fixture.accountKeys[0]);
  });

  it("parses transfer, transferWithSeed and createAccountWithSeed in outer and inner instructions", () => {
    const tx = syntheticTx(
      "multi",
      10,
      [
        systemInstruction("transfer", { source: "A", destination: "W", lamports: 20_000_000 }),
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", program: "spl-token", parsed: { type: "transfer", info: { source: "T", destination: "W", amount: "999999999999" } } }
      ],
      [
        systemInstruction("transferWithSeed", { source: "Derived", sourceBase: "B", destination: "W", lamports: "50000000" }),
        systemInstruction("createAccountWithSeed", { source: "C", base: "C", newAccount: "W", lamports: 30_000_000 }),
        systemInstruction("transfer", { source: "W", destination: "W", lamports: 90_000_000 }),
        systemInstruction("transfer", { source: "D", destination: "Other", lamports: 90_000_000 })
      ]
    );
    expect(incomingTransfers(tx, "W").map((transfer) => [transfer.source, transfer.kind])).toEqual([
      ["A", "transfer"],
      ["Derived", "transferWithSeed"],
      ["C", "createAccountWithSeed"]
    ]);
    expect(fundingTransfer(tx, "W", MIN_FUNDING)).toEqual({ source: "Derived", lamports: 50_000_000n, kind: "transferWithSeed" });
    expect(fundingTransfer(tx, "W", 60_000_000n)).toBeNull();
  });

  it("ignores failed transactions and malformed instructions", () => {
    const failed = syntheticTx("failed", 1, [systemInstruction("transfer", { source: "A", destination: "W", lamports: 5e9 })], [], {
      InstructionError: [0, "Custom"]
    });
    expect(fundingTransfer(failed, "W", 1n)).toBeNull();
    expect(transferToWallet({ programId: SYSTEM_PROGRAM_ID, parsed: "raw" }, "W")).toBeNull();
    expect(transferToWallet(systemInstruction("transfer", { source: "A", destination: "W", lamports: -5 }), "W")).toBeNull();
    expect(transferToWallet(systemInstruction("assign", { account: "W" }), "W")).toBeNull();
  });
});

describe("WalletIntelService without a database", () => {
  const config = scorerConfig();

  it("finds the most recent qualifying funder scanning newest first past fixture transactions", async () => {
    const fixture = fixtures.find((candidate) => candidate.signature.startsWith("K48XDQLk")) as FixtureTx;
    const wallet = fixture.accountKeys[0] ?? "";
    const rpc = new FakeRpc();
    const buy = syntheticTx("buySig", fixture.slot + 5, []);
    rpc.addHistory(wallet, [
      buy,
      parsedShell(fixture),
      fundingTx("dust", "Duster", wallet, 1_000n, 900),
      fundingTx("funding", "Funder", wallet, 2n * SOL, 800),
      fundingTx("older", "OldFunder", wallet, 5n * SOL, 700)
    ]);
    const clock = new VirtualClock(T0);
    const service = new WalletIntelService({ db: null, rpc, clock, config });
    const result = await service.ensure([request(wallet, "buySig")], T0 + 5_000);
    const intel = result.get(wallet);
    expect(intel?.funder).toBe("Funder");
    expect(intel?.fundingAmount).toBe(2n * SOL);
    expect(intel?.fundingSignature).toBe("funding");
    expect(intel?.fundingSlot).toBe(800);
    expect(intel?.priorTxCount).toBe(4);
    expect(intel?.priorTxCapped).toBe(false);
    expect(intel?.checkedBeforeSignature).toBe("buySig");
    expect(rpc.transactionCalls).toBe(3);
    await service.ensure([request(wallet, "buySig")], T0 + 5_000);
    expect(rpc.signatureCalls).toBe(1);
    expect(service.stats().memoryHits).toBe(1);
  });

  it("caps prior transaction counts and funding lookups and skips failed signatures", async () => {
    const rpc = new FakeRpc();
    const busy = Array.from({ length: 40 }, (_, index) => syntheticTx(`busy${index}`, 2_000 - index, []));
    const failedInfo: SignatureInfo = { signature: "failedSig", slot: 1, blockTime: null, err: { InstructionError: [0, "x"] } };
    rpc.addHistory("Busy", busy);
    rpc.signatures.set("Busy", [failedInfo, ...(rpc.signatures.get("Busy") ?? [])]);
    const service = new WalletIntelService({ db: null, rpc, clock: new VirtualClock(T0), config });
    const result = await service.ensure([request("Busy", "none")], T0 + 5_000);
    const intel = result.get("Busy");
    expect(intel?.priorTxCount).toBe(config.deepIntel.signatureLookback);
    expect(intel?.priorTxCapped).toBe(true);
    expect(intel?.funder).toBeNull();
    expect(rpc.transactionCalls).toBe(config.deepIntel.maxFundingLookups);
  });

  it("deduplicates concurrent lookups and returns partial results at the deadline", async () => {
    const rpc = new FakeRpc();
    rpc.addHistory("Slow", [fundingTx("f", "Funder", "Slow", SOL)]);
    let release: () => void = () => undefined;
    rpc.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clock = new VirtualClock(T0);
    const service = new WalletIntelService({ db: null, rpc, clock, config });
    const first = service.ensure([request("Slow"), request("Slow")], T0 + 1_000);
    const second = service.ensure([request("Slow")], T0 + 1_000);
    await clock.advanceTo(T0 + 1_000);
    const [a, b] = await Promise.all([first, second]);
    expect(a.size).toBe(0);
    expect(b.size).toBe(0);
    expect(rpc.signatureCalls).toBe(1);
    rpc.gate = null;
    release();
    await service.drain();
    expect(service.cached(["Slow"]).get("Slow")?.funder).toBe("Funder");
    expect(service.stats().inflight).toBe(0);
  });

  it("remembers failures briefly and retries after the error window", async () => {
    const rpc = new FakeRpc();
    rpc.failingWallets.add("Flaky");
    const clock = new VirtualClock(T0);
    const service = new WalletIntelService({ db: null, rpc, clock, config, errorRetryMs: 60_000 });
    const failed = await service.ensure([request("Flaky")], T0 + 1_000);
    expect(failed.get("Flaky")?.error).toBe("rpc down");
    expect(failed.get("Flaky")?.priorTxCount).toBeNull();
    await service.ensure([request("Flaky")], T0 + 1_000);
    expect(rpc.signatureCalls).toBe(1);
    rpc.failingWallets.clear();
    rpc.addHistory("Flaky", [fundingTx("ff", "Funder", "Flaky", SOL)]);
    await clock.advanceTo(T0 + 61_000);
    const retried = await service.ensure([request("Flaky")], T0 + 70_000);
    expect(rpc.signatureCalls).toBe(2);
    expect(retried.get("Flaky")?.funder).toBe("Funder");
    expect(service.stats().failures).toBe(1);
  });

  it("flags funders with large in-memory fan-out as hubs", async () => {
    const rpc = new FakeRpc();
    const wallets = ["h1", "h2", "h3"];
    for (const [index, wallet] of wallets.entries()) {
      rpc.addHistory(wallet, [fundingTxAt(`fund-${wallet}`, "BigFunder", wallet, SOL, T0 - (index + 1) * 3_600_000)]);
    }
    const hubConfig = scorerConfig({ deepIntel: { ...config.deepIntel, hubFanoutThreshold: 3 } });
    const service = new WalletIntelService({ db: null, rpc, clock: new VirtualClock(T0), config: hubConfig });
    const result = await service.ensure(wallets.map((wallet) => request(wallet)), T0 + 5_000);
    for (const wallet of wallets) {
      expect(result.get(wallet)?.funderIsHub).toBe(true);
    }
    expect(service.isHub("BigFunder")).toBe(true);
  });

  it("finds the funder of a zero-history wallet inside its own buy transaction", async () => {
    const rpc = new FakeRpc();
    const wallets = ["Fresh0", "Fresh1", "Fresh2", "Fresh3", "Fresh4"];
    for (const wallet of wallets) {
      const buy = syntheticTx(`buy-${wallet}`, 2_000, [
        systemInstruction("transfer", { source: "BundleMaster", destination: wallet, lamports: Number(SOL) }),
        { programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", data: "buy" }
      ]);
      rpc.addHistory(wallet, [buy]);
    }
    const service = new WalletIntelService({ db: null, rpc, clock: new VirtualClock(T0), config });
    const intel = await service.ensure(
      wallets.map((wallet) => request(wallet, `buy-${wallet}`)),
      T0 + 5_000
    );
    expect(intel.get("Fresh0")).toMatchObject({ funder: "BundleMaster", fundingSignature: "buy-Fresh0", priorTxCount: 0, fundingSlot: 2_000 });
    expect(rpc.transactionCalls).toBe(wallets.length);
    const clusters = buildFundingClusters({ buyers: wallets, devWallets: ["DevWallet"], intel });
    expect(clusters.clusters[0]?.buyers).toHaveLength(5);
  });

  it("re-checks a wallet that looked fresh before an earlier buy and keeps its known funder", async () => {
    const rpc = new FakeRpc();
    rpc.addHistory("Sniper", [syntheticTx("buy-A", 900, []), fundingTx("funding", "SniperFunder", "Sniper", SOL, 800)]);
    const clock = new VirtualClock(T0);
    const service = new WalletIntelService({ db: null, rpc, clock, config });
    const first = await service.ensure([request("Sniper", "buy-A")], T0 + 5_000);
    expect(first.get("Sniper")).toMatchObject({ priorTxCount: 1, funder: "SniperFunder" });
    await service.ensure([request("Sniper", "buy-A")], T0 + 5_000);
    expect(rpc.signatureCalls).toBe(1);
    const later = Array.from({ length: 40 }, (_, index) => syntheticTx(`trade-${index}`, 2_000 - index, []));
    rpc.addHistory("Sniper", [syntheticTx("buy-B", 3_000, []), ...later, syntheticTx("buy-A", 900, []), fundingTx("funding", "SniperFunder", "Sniper", SOL, 800)]);
    await clock.advanceTo(T0 + 20 * 3_600_000);
    const second = await service.ensure([request("Sniper", "buy-B")], clock.nowMs() + 5_000);
    expect(second.get("Sniper")).toMatchObject({ checkedBeforeSignature: "buy-B", priorTxCapped: true, funder: "SniperFunder" });
    expect(rpc.signatureCalls).toBe(2);
    const veteran = await service.ensure([request("Sniper", "buy-C")], clock.nowMs() + 5_000);
    expect(veteran.get("Sniper")?.checkedBeforeSignature).toBe("buy-B");
    expect(rpc.signatureCalls).toBe(2);
  });

  it("does not turn a serial bundler's master into a hub when it funds wallets in bursts", async () => {
    const rpc = new FakeRpc();
    const clock = new VirtualClock(T0);
    const service = new WalletIntelService({ db: null, rpc, clock, config });
    let ninth: Map<string, WalletIntel> = new Map();
    for (let launch = 0; launch < 9; launch += 1) {
      const wallets = Array.from({ length: 5 }, (_, index) => `L${launch}W${index}`);
      for (const [index, wallet] of wallets.entries()) {
        rpc.addHistory(wallet, [fundingTxAt(`fund-${wallet}`, "SerialMaster", wallet, SOL, clock.nowMs() - 60_000 + index * 2_000)]);
      }
      ninth = await service.ensure(wallets.map((wallet) => request(wallet, `buy-${wallet}`)), clock.nowMs() + 5_000);
      await clock.advanceTo(clock.nowMs() + 15 * 60_000);
    }
    expect(ninth.get("L8W0")?.funderIsHub).toBe(false);
    expect(service.isHub("SerialMaster")).toBe(false);
    const clusters = buildFundingClusters({ buyers: [...ninth.keys()], devWallets: ["DevWallet"], intel: ninth });
    expect(clusters.clusters[0]?.buyers).toHaveLength(5);
  });

  it("stops promptly with lookups in flight and starts no new ones", async () => {
    let calls = 0;
    const hanging: IntelRpc = {
      getSignaturesForAddress: () => {
        calls += 1;
        return new Promise(() => undefined);
      },
      getParsedTransaction: () => new Promise(() => undefined)
    };
    const clock = new VirtualClock(T0);
    const service = new WalletIntelService({ db: null, rpc: hanging, clock, config });
    const pending = service.ensure([request("Slow")], T0 + 1_000);
    await clock.advanceTo(T0 + 1_000);
    expect((await pending).size).toBe(0);
    await service.stop();
    expect(await service.ensure([request("Other")], T0 + 2_000)).toEqual(new Map());
    expect(calls).toBe(1);
    expect(service.stats().skipped).toBe(1);
  });

  it("stops the scorer module without waiting for wallet intel rpc calls", async () => {
    const hanging: IntelRpc = {
      getSignaturesForAddress: () => new Promise(() => undefined),
      getParsedTransaction: () => new Promise(() => undefined)
    };
    const clock = new VirtualClock(T0);
    const scorer = createScorerModule({
      db: null,
      rpc: hanging,
      bus: new Bus(),
      market: newMarket(),
      clock,
      config,
      mode: "live",
      model: ScoringModel.default()
    });
    await scorer.start();
    void scorer.intel?.ensure([request("SlowWallet")], T0 + 8_000);
    await clock.advanceTo(T0 + 8_000);
    await expect(scorer.stop()).resolves.toBeUndefined();
  });

  it("skips lookups without rpc or beyond the in-flight cap", async () => {
    const service = new WalletIntelService({ db: null, rpc: null, clock: new VirtualClock(T0), config });
    expect((await service.ensure([request("x")], T0 + 1_000)).size).toBe(0);
    expect(service.stats().skipped).toBe(1);
  });

  it("decides hubs from entity kinds, flags and fan-out", () => {
    expect(isHubFromFacts({ address: "a", entityKind: "exchange", fundingBursts: 0, flagged: false }, 0, 40)).toBe(true);
    expect(isHubFromFacts({ address: "a", entityKind: "bundler", fundingBursts: 500, flagged: true }, 0, 40)).toBe(false);
    expect(isHubFromFacts({ address: "a", entityKind: null, fundingBursts: 39, flagged: false }, 0, 40)).toBe(false);
    expect(isHubFromFacts({ address: "a", entityKind: null, fundingBursts: 40, flagged: false }, 0, 40)).toBe(true);
    expect(isHubFromFacts({ address: "a", entityKind: null, fundingBursts: 0, flagged: true }, 0, 40)).toBe(true);
    expect(isHubFromFacts(undefined, 45, 40)).toBe(true);
    expect(isHubFromFacts(undefined, 1, 40)).toBe(false);
  });
});

describe.skipIf(!hasTestDatabase)("WalletIntelService with a database", () => {
  let database: TestDatabase;
  const config = scorerConfig();

  beforeAll(async () => {
    database = await createTestDatabase("scorer_intel");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("persists lookups and serves them to a fresh instance without rpc", async () => {
    const rpc = new FakeRpc();
    rpc.addHistory("Persisted", [fundingTx("p1", "PFunder", "Persisted", 3n * SOL, 1_234)]);
    const clock = new VirtualClock(T0);
    const writer = new WalletIntelService({ db: database.db, rpc, clock, config });
    await writer.ensure([request("Persisted")], T0 + 5_000);
    await writer.drain();
    const row = await database.db.query("SELECT funder, funding_amount, prior_tx_count, funding_slot FROM wallet_intel WHERE wallet = 'Persisted'");
    expect(row.rows[0]).toEqual({ funder: "PFunder", funding_amount: 3n * SOL, prior_tx_count: 1, funding_slot: 1_234n });
    const silentRpc = new FakeRpc();
    const reader = new WalletIntelService({ db: database.db, rpc: silentRpc, clock: new VirtualClock(T0 + 60_000), config });
    const result = await reader.ensure([request("Persisted")], T0 + 65_000);
    expect(result.get("Persisted")?.funder).toBe("PFunder");
    expect(result.get("Persisted")?.fundingAmount).toBe(3n * SOL);
    expect(silentRpc.signatureCalls).toBe(0);
    expect(reader.stats().dbHits).toBe(1);
  });

  it("serves stored rows without rpc when fetching is off and never uses rows checked after now", async () => {
    await database.db.query(
      `INSERT INTO wallet_intel (wallet, funder, prior_tx_count, checked_before_signature, checked_at)
       VALUES ('KnownEarlier', 'EarlyFunder', 30, 'a', $1), ('KnownLater', 'LateFunder', 2, 'b', $2)`,
      [new Date(T0 - 60_000), new Date(T0 + 60_000)]
    );
    const rpc = new FakeRpc();
    rpc.addHistory("NeverSeen", [fundingTx("n1", "AnyFunder", "NeverSeen", SOL)]);
    const service = new WalletIntelService({ db: database.db, rpc, clock: new VirtualClock(T0), config });
    const result = await service.ensure([request("KnownEarlier"), request("KnownLater"), request("NeverSeen")], T0 + 5_000, { fetch: false });
    expect([...result.keys()]).toEqual(["KnownEarlier"]);
    expect(result.get("KnownEarlier")?.funder).toBe("EarlyFunder");
    expect(rpc.signatureCalls).toBe(0);
    const later = new WalletIntelService({ db: database.db, rpc, clock: new VirtualClock(T0 + 120_000), config });
    const known = await later.ensure([request("KnownLater", "b")], T0 + 125_000, { fetch: false });
    expect(known.get("KnownLater")?.funder).toBe("LateFunder");
    expect(rpc.signatureCalls).toBe(0);
  });

  it("ignores database rows older than the ttl", async () => {
    await database.db.query(
      `INSERT INTO wallet_intel (wallet, funder, prior_tx_count, checked_before_signature, checked_at)
       VALUES ('Stale', 'OldFunder', 3, 'x', $1)`,
      [new Date(T0 - (config.deepIntel.cacheTtlHours + 1) * 3_600_000)]
    );
    const rpc = new FakeRpc();
    rpc.addHistory("Stale", [fundingTx("s1", "NewFunder", "Stale", SOL)]);
    const service = new WalletIntelService({ db: database.db, rpc, clock: new VirtualClock(T0), config });
    const result = await service.ensure([request("Stale")], T0 + 5_000);
    expect(result.get("Stale")?.funder).toBe("NewFunder");
    expect(rpc.signatureCalls).toBe(1);
    await service.drain();
  });

  it("uses known entities and database fan-out for hub detection", async () => {
    await database.db.query("INSERT INTO known_entities (address, kind, label) VALUES ('ExchangeHot', 'exchange', 'cex'), ('KnownBundler', 'bundler', NULL)");
    const fanoutWallets = Array.from({ length: 5 }, (_, index) => `fan${index}`);
    for (const wallet of fanoutWallets) {
      await database.db.query(
        "INSERT INTO wallet_intel (wallet, funder, prior_tx_count, checked_before_signature, checked_at) VALUES ($1, 'Distributor', 1, 'x', $2)",
        [wallet, new Date(T0)]
      );
    }
    const rpc = new FakeRpc();
    rpc.addHistory("viaExchange", [fundingTx("e1", "ExchangeHot", "viaExchange", SOL)]);
    rpc.addHistory("viaBundler", [fundingTx("b1", "KnownBundler", "viaBundler", SOL)]);
    rpc.addHistory("viaDistributor", [fundingTx("d1", "Distributor", "viaDistributor", SOL)]);
    const hubConfig = scorerConfig({ deepIntel: { ...config.deepIntel, hubFanoutThreshold: 5 } });
    const service = new WalletIntelService({ db: database.db, rpc, clock: new VirtualClock(T0), config: hubConfig });
    const result = await service.ensure(
      [request("viaExchange"), request("viaBundler"), request("viaDistributor")],
      T0 + 5_000
    );
    expect(result.get("viaExchange")?.funderIsHub).toBe(true);
    expect(result.get("viaBundler")?.funderIsHub).toBe(false);
    expect(result.get("viaDistributor")?.funderIsHub).toBe(true);
    await service.drain();
    const flagged = await database.db.query("SELECT is_hub, checked_before_signature FROM wallet_intel WHERE wallet = 'Distributor'");
    expect(flagged.rows[0]).toEqual({ is_hub: true, checked_before_signature: null });
  });

  it("counts stored fundees funded in one burst once when deciding hubs", async () => {
    for (let index = 0; index < 6; index += 1) {
      await database.db.query(
        "INSERT INTO wallet_intel (wallet, funder, funded_at, prior_tx_count, checked_before_signature, checked_at) VALUES ($1, 'BurstMaster', $2, 0, 'x', $3)",
        [`burst${index}`, new Date(T0 - 300_000 + index * 5_000), new Date(T0)]
      );
    }
    const rpc = new FakeRpc();
    rpc.addHistory("nextBundle", [fundingTx("nb", "BurstMaster", "nextBundle", SOL)]);
    const hubConfig = scorerConfig({ deepIntel: { ...config.deepIntel, hubFanoutThreshold: 5 } });
    const service = new WalletIntelService({ db: database.db, rpc, clock: new VirtualClock(T0), config: hubConfig });
    const result = await service.ensure([request("nextBundle")], T0 + 5_000);
    expect(result.get("nextBundle")?.funderIsHub).toBe(false);
    await service.drain();
    const flagged = await database.db.query("SELECT count(*)::int AS n FROM wallet_intel WHERE wallet = 'BurstMaster' AND is_hub");
    expect(flagged.rows[0]?.n).toBe(0);
  });
});
