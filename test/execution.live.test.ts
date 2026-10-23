import bs58 from "bs58";
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type SendOptions
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { Clock, TimerCallback, TimerHandle } from "../src/core/clock.js";
import { PUMP_PROGRAM_ID } from "../src/core/constants.js";
import type { MarketDataSource } from "../src/core/contracts.js";
import type { OrderRequest } from "../src/core/types.js";
import type { ExecutionConfig } from "../src/config/strategy.js";
import type { ConfirmedTransaction } from "../src/execution/fillParser.js";
import {
  TradeRefusedError,
  type BuildRequest,
  type BuiltTrade,
  type TradeInstructionBuilder
} from "../src/execution/instructions.js";
import { LiveExecutor } from "../src/execution/liveExecutor.js";
import { classifyOnChainError, customErrorCode } from "../src/execution/liveFill.js";
import { JitoTransactionSender, jitoTransactionsUrl, web3TransactionFetcher } from "../src/execution/senders.js";
import { JITO_TIP_ACCOUNTS } from "../src/execution/transaction.js";
import { LaunchState, launchInfoFromEvent } from "../src/market/state.js";
import {
  PUMP_QUOTE_MINT,
  SOL,
  T0,
  confirmedFromFixture,
  createEvent,
  execConfig,
  fixture,
  order,
  rewriteWallet
} from "./execution.fixtures.js";

const CURVE_BUY = fixture("34N2fYTH");
const CURVE_BUY_MINT = "8yDsNzzeQqmaXydvRcq24J1YxLemVY8nFFbU4WmTFfk5";
const CURVE_BUY_USER = "2YCYwm44jVCw8CKta9XCpNKtL63HPuFwmSBUyNAEXh7n";

class SteppingClock implements Clock {
  readonly virtual = true;
  private now: number;
  private nextId = 1;

  constructor(startMs: number) {
    this.now = startMs;
  }

  nowMs(): number {
    return this.now;
  }

  schedule(atMs: number, fn: TimerCallback): TimerHandle {
    this.now = Math.max(this.now, atMs);
    void fn();
    return { id: this.nextId++ };
  }

  cancel(): void {}

  async sleepUntil(atMs: number): Promise<void> {
    this.now = Math.max(this.now, atMs);
  }
}

type StatusValue = { slot: number; err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" | null; confirmations: number | null };

class FakeConnection {
  blockhashCalls = 0;
  readonly sent: Uint8Array[] = [];
  readonly sendOptions: Array<SendOptions | undefined> = [];
  readonly simulated: VersionedTransaction[] = [];
  readonly statusCalls: string[] = [];
  height = 100;
  lastValidBlockHeight = 250;
  statusFor: (signature: string, call: number) => StatusValue | null = () => null;

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    this.blockhashCalls += 1;
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: this.lastValidBlockHeight };
  }

  async simulateTransaction(transaction: VersionedTransaction): Promise<unknown> {
    this.simulated.push(transaction);
    return {
      context: { slot: 1 },
      value: { err: null, logs: ["Program log: Instruction: BuyExactQuoteInV3", "Program consumed 61234"], unitsConsumed: 61_234, accounts: null }
    };
  }

  async sendRawTransaction(raw: Uint8Array, options?: SendOptions): Promise<string> {
    this.sent.push(raw);
    this.sendOptions.push(options);
    return signatureOfRaw(raw);
  }

  async getSignatureStatuses(signatures: string[]): Promise<{ context: { slot: number }; value: Array<StatusValue | null> }> {
    const signature = signatures[0] ?? "";
    this.statusCalls.push(signature);
    const call = this.statusCalls.filter((entry) => entry === signature).length;
    return { context: { slot: 1 }, value: [this.statusFor(signature, call)] };
  }

  async getBlockHeight(): Promise<number> {
    return this.height;
  }

  async getParsedTransaction(): Promise<null> {
    return null;
  }

  uniqueSignatures(): string[] {
    return [...new Set(this.sent.map(signatureOfRaw))];
  }
}

function signatureOfRaw(raw: Uint8Array): string {
  const transaction = VersionedTransaction.deserialize(raw);
  return bs58.encode(transaction.signatures[0] ?? new Uint8Array(64));
}

class FakeBuilder implements TradeInstructionBuilder {
  readonly requests: BuildRequest[] = [];

  constructor(
    private readonly outcome: Partial<BuiltTrade> | TradeRefusedError | Error = {},
    private readonly payer: PublicKey | null = null
  ) {}

  async build(request: BuildRequest): Promise<BuiltTrade> {
    this.requests.push(request);
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }
    const instruction = new TransactionInstruction({
      programId: new PublicKey(PUMP_PROGRAM_ID),
      keys: [{ pubkey: this.payer ?? request.user, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3])
    });
    return {
      venue: "curve",
      pool: null,
      instructions: [instruction],
      computeUnitLimit: 150_000,
      tokenAmount: 245_224_727_144n,
      expectedTokens: 245_224_727_144n,
      expectedQuote: 19_800_000n,
      closesTokenAccount: false,
      instructionSet: "buy_exact_quote_in_v3",
      ...this.outcome
    };
  }
}

function emptyMarket(): MarketDataSource {
  return { launch: () => undefined, view: () => null, latestSlot: () => 42 };
}

function launchMarket(launch: LaunchState): MarketDataSource {
  return { launch: (mint) => (mint === launch.mint ? launch : undefined), view: (mint) => (mint === launch.mint ? launch.view(T0) : null), latestSlot: () => 42 };
}

interface Setup {
  executor: LiveExecutor;
  connection: FakeConnection;
  builder: FakeBuilder;
  keypair: Keypair;
  fetched: string[];
}

function setup(
  options: {
    config?: Partial<ExecutionConfig>;
    dryRun?: boolean;
    builder?: FakeBuilder;
    market?: MarketDataSource;
    fetch?: (signature: string, wallet: string) => ConfirmedTransaction | null;
  } = {}
): Setup {
  const keypair = Keypair.generate();
  const connection = new FakeConnection();
  const builder = options.builder ?? new FakeBuilder();
  const fetched: string[] = [];
  const executor = new LiveExecutor({
    connection: connection as unknown as Connection,
    keypair,
    config: execConfig({ maxRetries: 1, retryDelaySlots: 2, fillTimeoutMs: 15_000, ...options.config }),
    dryRun: options.dryRun ?? false,
    clock: new SteppingClock(T0),
    market: options.market ?? emptyMarket(),
    builder,
    fetchTransaction: async (signature) => {
      fetched.push(signature);
      return options.fetch ? options.fetch(signature, keypair.publicKey.toBase58()) : null;
    },
    pollIntervalMs: 400,
    rebroadcastIntervalMs: 800,
    blockHeightCheckEvery: 2,
    fetchAttempts: 2
  });
  return { executor, connection, builder, keypair, fetched };
}

function curveBuyOrder(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return order({ mint: CURVE_BUY_MINT, quoteBudget: 19_800_000n, referencePrice: 0, ...overrides });
}

function curveBuyFor(signature: string, wallet: string, fee = 105_000n): ConfirmedTransaction {
  return rewriteWallet(confirmedFromFixture(CURVE_BUY, fee), CURVE_BUY_USER, wallet, signature);
}

function decompiled(transaction: VersionedTransaction): TransactionInstruction[] {
  return TransactionMessage.decompile(transaction.message).instructions;
}

function confirmed(slot = 500): StatusValue {
  return { slot, err: null, confirmationStatus: "confirmed", confirmations: 1 };
}

describe("LiveExecutor dry run", () => {
  it("simulates a signed transaction with compute budget and reports units and logs without sending", async () => {
    const { executor, connection, builder, keypair } = setup({ dryRun: true, config: { priorityFeeLamports: 300_000 } });
    const fill = await executor.execute(curveBuyOrder());
    expect(fill.success).toBe(false);
    expect(fill.error?.startsWith("dry_run:")).toBe(true);
    const report = JSON.parse((fill.error ?? "").slice("dry_run:".length)) as Record<string, unknown>;
    expect(report.ok).toBe(true);
    expect(report.unitsConsumed).toBe(61_234);
    expect(report.logs).toEqual(["Program log: Instruction: BuyExactQuoteInV3", "Program consumed 61234"]);
    expect(report.expectedTokens).toBe("245224727144");
    expect(report.instructionSet).toBe("buy_exact_quote_in_v3");
    expect(connection.sent).toHaveLength(0);
    expect(connection.simulated).toHaveLength(1);
    expect(builder.requests).toHaveLength(1);
    expect(fill.attempts).toHaveLength(1);
    expect(fill.attempts[0]?.error).toBe("dry_run");
    expect(fill.networkFees).toBe(0n);
    const transaction = connection.simulated[0];
    if (!transaction) {
      throw new Error("no simulated transaction");
    }
    expect(transaction.message.staticAccountKeys[0]?.equals(keypair.publicKey)).toBe(true);
    expect(transaction.signatures[0]?.some((byte) => byte !== 0)).toBe(true);
    const instructions = decompiled(transaction);
    const [limit, price, trade] = instructions;
    if (!limit || !price || !trade) {
      throw new Error("missing instructions");
    }
    expect(limit.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit).units).toBe(150_000);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(price).microLamports).toBe(2_000_000n);
    expect(trade.programId.toBase58()).toBe(PUMP_PROGRAM_ID);
    expect(instructions).toHaveLength(3);
  });

  it("adds a Jito tip transfer as the last instruction when Jito is enabled", async () => {
    const { executor, connection, keypair } = setup({ dryRun: true, config: { useJito: true, jitoTipLamports: 1_000_000 } });
    await executor.execute(curveBuyOrder());
    const transaction = connection.simulated[0];
    if (!transaction) {
      throw new Error("no simulated transaction");
    }
    const tip = decompiled(transaction).at(-1);
    if (!tip) {
      throw new Error("no tip");
    }
    expect(tip.programId.equals(SystemProgram.programId)).toBe(true);
    const transfer = SystemInstruction.decodeTransfer(tip);
    expect(transfer.lamports).toBe(1_000_000n);
    expect(transfer.fromPubkey.equals(keypair.publicKey)).toBe(true);
    expect(JITO_TIP_ACCOUNTS).toContain(transfer.toPubkey.toBase58());
  });
});

describe("LiveExecutor sends and parses fills", () => {
  it("sends without preflight, polls until confirmed and parses the fill from the confirmed transaction", async () => {
    const { executor, connection, fetched } = setup({ fetch: (signature, wallet) => curveBuyFor(signature, wallet) });
    connection.statusFor = (_signature, call) => (call >= 3 ? confirmed() : null);
    const fill = await executor.execute(curveBuyOrder());
    expect(connection.sendOptions[0]).toEqual({ skipPreflight: true, maxRetries: 0 });
    expect(connection.uniqueSignatures()).toHaveLength(1);
    expect(fill.success).toBe(true);
    expect(fill.signature).toBe(connection.uniqueSignatures()[0]);
    expect(fetched).toEqual([fill.signature]);
    expect(fill.venue).toBe("curve");
    expect(fill.tokenAmount).toBe(245_224_727_144n);
    expect(fill.quoteAmount).toBe(19_555_555n);
    expect(fill.userQuote).toBe(19_800_000n);
    expect(fill.networkFees).toBe(105_000n);
    expect(fill.tips).toBe(1_200_000n);
    expect(fill.rentPaid).toBe(1_513_840n);
    expect(fill.rentRefunded).toBe(0n);
    expect(fill.filledSlot).toBe(CURVE_BUY.slot);
    expect(fill.filledAtMs).toBe(CURVE_BUY.blockTime * 1000);
    expect(fill.fillPrice).toBeCloseTo(19_800_000 / 245_224_727_144, 15);
    expect(fill.error).toBeNull();
    expect(fill.attempts).toHaveLength(1);
  });

  it("retries with a fresh blockhash after an on-chain slippage failure and keeps the failed fee", async () => {
    const { executor, connection, fetched } = setup({ fetch: (signature, wallet) => curveBuyFor(signature, wallet) });
    connection.statusFor = (signature) =>
      signature === connection.uniqueSignatures()[0]
        ? { slot: 400, err: { InstructionError: [2, { Custom: 6042 }] }, confirmationStatus: "confirmed", confirmations: 1 }
        : confirmed();
    const fill = await executor.execute(curveBuyOrder());
    expect(connection.blockhashCalls).toBe(2);
    expect(connection.uniqueSignatures()).toHaveLength(2);
    expect(fill.success).toBe(true);
    expect(fill.attempts.map((attempt) => attempt.error)).toEqual(["slippage_exceeded", null]);
    expect(fill.attempts[0]?.networkFee).toBe(5_000n + 300_000n);
    expect(fill.attempts[0]?.tip).toBe(0n);
    expect(fill.networkFees).toBe(305_000n + 105_000n);
    expect(fill.signature).toBe(connection.uniqueSignatures()[1]);
    expect(fetched).toEqual([connection.uniqueSignatures()[1]]);
  });

  it("retries when the blockhash expires and reports expiry after the last retry", async () => {
    const { executor, connection } = setup({ config: { maxRetries: 1 } });
    connection.height = connection.lastValidBlockHeight + 1;
    const fill = await executor.execute(curveBuyOrder());
    expect(fill.success).toBe(false);
    expect(fill.error).toBe("expired");
    expect(fill.attempts.map((attempt) => attempt.error)).toEqual(["expired", "expired"]);
    expect(fill.networkFees).toBe(0n);
    expect(connection.uniqueSignatures()).toHaveLength(2);
  });

  it("does not retry when the outcome is unknown at the fill timeout, and rebroadcasts while waiting", async () => {
    const { executor, connection } = setup({ config: { fillTimeoutMs: 4_000, maxRetries: 3 } });
    const fill = await executor.execute(curveBuyOrder());
    expect(fill.success).toBe(false);
    expect(fill.error).toBe("unconfirmed");
    expect(fill.signature).toBe(connection.uniqueSignatures()[0]);
    expect(connection.uniqueSignatures()).toHaveLength(1);
    expect(connection.sent.length).toBeGreaterThan(2);
    expect(connection.blockhashCalls).toBe(1);
    expect(fill.attempts).toHaveLength(1);
  });

  it("falls back to the expected amounts when the confirmed transaction cannot be fetched", async () => {
    const { executor, connection, fetched } = setup();
    connection.statusFor = () => confirmed(777);
    const fill = await executor.execute(curveBuyOrder());
    expect(fill.success).toBe(true);
    expect(fill.error).toBe("fill_unparsed");
    expect(fill.tokenAmount).toBe(245_224_727_144n);
    expect(fill.filledSlot).toBe(777);
    expect(fetched).toHaveLength(2);
  });
});

describe("LiveExecutor reconcile", () => {
  it("rebuilds a fill for a signature that landed after the executor gave up", async () => {
    const { executor } = setup({ fetch: (signature, wallet) => (signature === "late" ? curveBuyFor(signature, wallet) : null) });
    const fill = await executor.reconcile(curveBuyOrder(), "late");
    expect(fill?.success).toBe(true);
    expect(fill?.signature).toBe("late");
    expect(fill?.tokenAmount).toBe(245_224_727_144n);
    expect(fill?.networkFees).toBe(105_000n);
    expect(fill?.attempts).toHaveLength(1);
    expect(await executor.reconcile(curveBuyOrder(), "missing")).toBeNull();
  });

  it("reports a failed landed transaction with its fee", async () => {
    const { executor } = setup({
      fetch: (signature, wallet) => ({ ...curveBuyFor(signature, wallet, 5_000n), err: { InstructionError: [2, { Custom: 6005 }] } })
    });
    const fill = await executor.reconcile(curveBuyOrder(), "failed");
    expect(fill?.success).toBe(false);
    expect(fill?.error).toBe("curve_complete");
    expect(fill?.networkFees).toBe(5_000n);
    expect(fill?.signature).toBe("failed");
  });
});

describe("LiveExecutor refusals and guards", () => {
  it("refuses coins quoted in anything but SOL before touching the chain", async () => {
    const launch = new LaunchState(launchInfoFromEvent(createEvent({ mint: CURVE_BUY_MINT, quoteMint: PUMP_QUOTE_MINT })));
    const { executor, connection, builder } = setup({ market: launchMarket(launch) });
    const fill = await executor.execute(curveBuyOrder());
    expect(fill.success).toBe(false);
    expect(fill.error).toBe("non_sol_quote");
    expect(fill.attempts).toHaveLength(0);
    expect(builder.requests).toHaveLength(0);
    expect(connection.blockhashCalls).toBe(0);
  });

  it("refuses when the builder finds a non-SOL quote on chain", async () => {
    const builder = new FakeBuilder(new TradeRefusedError("non_sol_quote", "curve is quoted in a pump coin"));
    const { executor, connection } = setup({ builder });
    const fill = await executor.execute(curveBuyOrder());
    expect(fill.error).toBe("non_sol_quote");
    expect(connection.sent).toHaveLength(0);
    expect(builder.requests).toHaveLength(1);
  });

  it("retries retryable refusals such as a completed curve", async () => {
    const builder = new FakeBuilder(new TradeRefusedError("curve_complete", "complete"));
    const { executor, connection } = setup({ builder, config: { maxRetries: 2 } });
    const fill = await executor.execute(curveBuyOrder());
    expect(fill.error).toBe("curve_complete");
    expect(fill.attempts.map((attempt) => attempt.error)).toEqual(["curve_complete", "curve_complete", "curve_complete"]);
    expect(builder.requests).toHaveLength(3);
    expect(connection.sent).toHaveLength(0);
  });

  it("records build failures and retries them", async () => {
    const builder = new FakeBuilder(new Error("rpc down"));
    const { executor } = setup({ builder, config: { maxRetries: 1 } });
    const fill = await executor.execute(curveBuyOrder());
    expect(fill.error).toBe("build_failed");
    expect(fill.attempts).toHaveLength(2);
  });

  it("rejects invalid orders", async () => {
    const { executor, builder } = setup();
    const fill = await executor.execute(curveBuyOrder({ quoteBudget: null, tokenAmount: null }));
    expect(fill.error).toBe("invalid_order");
    expect(builder.requests).toHaveLength(0);
  });

  it("refuses to send when the current price is already beyond the reference bound", async () => {
    const launch = new LaunchState(launchInfoFromEvent(createEvent({ mint: CURVE_BUY_MINT })));
    const { executor, connection, builder } = setup({ market: launchMarket(launch), config: { maxRetries: 1 } });
    const fill = await executor.execute(curveBuyOrder({ quoteBudget: SOL / 10n, referencePrice: launch.price() * 0.5, maxSlippageBps: 1500 }));
    expect(fill.error).toBe("slippage_exceeded");
    expect(fill.attempts.map((attempt) => attempt.error)).toEqual(["slippage_exceeded", "slippage_exceeded"]);
    expect(builder.requests).toHaveLength(0);
    expect(connection.sent).toHaveLength(0);
  });

  it("passes only the slippage left after the current price drift, plus market hints, to the builder", async () => {
    const launch = new LaunchState(
      launchInfoFromEvent(createEvent({ mint: CURVE_BUY_MINT, tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }))
    );
    const { executor, builder } = setup({ market: launchMarket(launch), dryRun: true });
    await executor.execute(curveBuyOrder({ quoteBudget: SOL / 10n, referencePrice: launch.price(), maxSlippageBps: 1500 }));
    const request = builder.requests[0];
    expect(request?.slippageBps).toBeGreaterThan(0);
    expect(request?.slippageBps).toBeLessThan(1500);
    expect(request?.hints).toEqual({ migrated: false, pool: null, tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" });
    expect(request?.closeTokenAccount).toBe(false);
  });

  it("asks the builder to close the token account on a closing sell when refunds are enabled", async () => {
    const { executor, builder } = setup({ dryRun: true });
    await executor.execute(curveBuyOrder({ side: "sell", quoteBudget: null, tokenAmount: 10n, closesPosition: true }));
    expect(builder.requests[0]?.closeTokenAccount).toBe(true);
    const disabled = setup({ dryRun: true, config: { refundAtaOnClose: false } });
    await disabled.executor.execute(curveBuyOrder({ side: "sell", quoteBudget: null, tokenAmount: 10n, closesPosition: true }));
    expect(disabled.builder.requests[0]?.closeTokenAccount).toBe(false);
  });

  it("never exposes the secret key through enumeration or serialization", () => {
    const { executor, keypair } = setup();
    const serialized = JSON.stringify(executor, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    expect(serialized).not.toContain(bs58.encode(keypair.secretKey));
    expect(serialized).not.toContain(JSON.stringify(Array.from(keypair.secretKey)));
    expect(Object.keys(executor)).not.toContain("keypair");
    expect(executor.wallet).toBe(keypair.publicKey.toBase58());
    expect(executor.mode).toBe("live");
  });
});

describe("on-chain error classification", () => {
  it("maps pump and PumpSwap custom errors", () => {
    expect(customErrorCode({ InstructionError: [3, { Custom: 6002 }] })).toBe(6002);
    expect(customErrorCode({ InstructionError: [3, "InvalidAccountData"] })).toBeNull();
    expect(customErrorCode("BlockhashNotFound")).toBeNull();
    expect(classifyOnChainError("curve", { InstructionError: [3, { Custom: 6003 }] })).toBe("slippage_exceeded");
    expect(classifyOnChainError("curve", { InstructionError: [3, { Custom: 6005 }] })).toBe("curve_complete");
    expect(classifyOnChainError("pool", { InstructionError: [3, { Custom: 6004 }] })).toBe("slippage_exceeded");
    expect(classifyOnChainError("pool", { InstructionError: [3, { Custom: 6005 }] })).toBe("tx_failed");
    expect(classifyOnChainError("curve", { InstructionError: [3, { Custom: 1 }] })).toBe("tx_failed");
  });
});

describe("senders and fetchers", () => {
  it("posts base64 transactions to the Jito transactions endpoint", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "sig123" }), { status: 200 });
    }) as typeof fetch;
    const sender = new JitoTransactionSender({ endpoint: "https://mainnet.block-engine.jito.wtf/", fetchImpl: fakeFetch });
    expect(await sender.send(Uint8Array.from([1, 2, 3]))).toBe("sig123");
    expect(calls[0]?.url).toBe("https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true");
    const body = JSON.parse(calls[0]?.body ?? "{}") as { method: string; params: [string, { encoding: string }] };
    expect(body.method).toBe("sendTransaction");
    expect(body.params).toEqual([Buffer.from([1, 2, 3]).toString("base64"), { encoding: "base64" }]);
    expect(jitoTransactionsUrl("https://x/api/v1/transactions")).toBe("https://x/api/v1/transactions?bundleOnly=true");
    const failing = new JitoTransactionSender({
      endpoint: "https://x",
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "bundle rejected" } }), { status: 400 })) as typeof fetch
    });
    await expect(failing.send(Uint8Array.from([1]))).rejects.toThrow("bundle rejected");
  });

  it("fetches confirmed transactions with version 1 support", async () => {
    const calls: unknown[] = [];
    const fetcher = web3TransactionFetcher({
      getParsedTransaction: (async (...args: unknown[]) => {
        calls.push(args);
        return null;
      }) as unknown as Connection["getParsedTransaction"]
    });
    expect(await fetcher("abc")).toBeNull();
    expect(calls[0]).toEqual(["abc", { commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
  });
});
