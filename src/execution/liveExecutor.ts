import { PublicKey, type Connection, type Keypair, type VersionedTransaction } from "@solana/web3.js";
import type { ExecutionConfig } from "../config/strategy.js";
import type { Clock } from "../core/clock.js";
import { SLOT_MS, SOL_QUOTE } from "../core/constants.js";
import type { Executor, MarketDataSource } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import { createRng } from "../core/rng.js";
import type { FillAttempt, FillResult, OrderRequest, Pubkey, TradeVenue } from "../core/types.js";
import { ConfirmationTracker, type SentTransaction } from "./confirmation.js";
import { failedFill, HALTED_ERROR, successfulFill, UNCONFIRMED_ERROR, type FillAmounts } from "./fill.js";
import { parseFill, type ConfirmedTransaction } from "./fillParser.js";
import {
  PumpInstructionBuilder,
  tokenAccountAmount,
  TradeRefusedError,
  type BuiltTrade,
  type ComputeUnitLimits,
  type TradeInstructionBuilder
} from "./instructions.js";
import { amountsFromParsed, classifyOnChainError, outflowBeyondTrade, qualityOf } from "./liveFill.js";
import {
  computeTradeLeg,
  fillPriceOf,
  orderIsValid,
  remainingSlippageBps,
  slippageVersusReference
} from "./model.js";
import {
  JitoTransactionSender,
  RpcTransactionSender,
  web3TransactionFetcher,
  type TransactionFetcher,
  type TransactionSender
} from "./senders.js";
import {
  compileTransaction,
  microLamportsPerComputeUnit,
  pickTipAccount,
  priorityFeeLamportsFor,
  signatureOf,
  type TipTransfer
} from "./transaction.js";

const log = moduleLogger("execution.live");

export type LiveConnection = Pick<
  Connection,
  | "getLatestBlockhash"
  | "simulateTransaction"
  | "sendRawTransaction"
  | "getSignatureStatuses"
  | "getBlockHeight"
  | "getParsedTransaction"
  | "getTokenAccountsByOwner"
>;

export interface LiveExecutorOptions {
  connection: Connection;
  keypair: Keypair;
  config: ExecutionConfig;
  dryRun: boolean;
  clock: Clock;
  market: MarketDataSource;
  builder?: TradeInstructionBuilder;
  sender?: TransactionSender;
  jitoEndpoint?: string | null;
  fetchTransaction?: TransactionFetcher;
  pollIntervalMs?: number;
  rebroadcastIntervalMs?: number;
  blockHeightCheckEvery?: number;
  fetchAttempts?: number;
  computeUnitLimits?: Partial<ComputeUnitLimits>;
}

interface SlippageGuard {
  allowedBps: number | null;
  spotPrice: number | null;
}

type AttemptStep = { kind: "done"; fill: FillResult } | { kind: "retry"; error: string };

interface SettledContext {
  pool: string | null;
  tipLamports: bigint;
  attempts: readonly FillAttempt[];
  spotPrice: number | null;
  sentAtMs: number;
  signature: string;
}

const RETRYABLE_REFUSALS = new Set(["curve_complete", "pool_unavailable"]);
const DRY_RUN_LOG_LINES = 40;

function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === "bigint" ? inner.toString() : inner));
}

export class LiveExecutor implements Executor {
  readonly mode = "live" as const;
  readonly dryRun: boolean;
  readonly wallet: string;
  readonly #keypair: Keypair;
  private readonly connection: LiveConnection;
  private readonly config: ExecutionConfig;
  private readonly clock: Clock;
  private readonly market: MarketDataSource;
  private readonly builder: TradeInstructionBuilder;
  private readonly sender: TransactionSender;
  private readonly fetchTransaction: TransactionFetcher;
  private readonly confirmations: ConfirmationTracker;
  private readonly pollIntervalMs: number;
  private readonly fetchAttempts: number;
  private halted = false;

  constructor(options: LiveExecutorOptions) {
    this.#keypair = options.keypair;
    this.wallet = options.keypair.publicKey.toBase58();
    this.dryRun = options.dryRun;
    this.connection = options.connection;
    this.config = options.config;
    this.clock = options.clock;
    this.market = options.market;
    this.builder =
      options.builder ??
      new PumpInstructionBuilder({ connection: options.connection, clock: options.clock, computeUnitLimits: options.computeUnitLimits });
    this.sender = options.sender ?? this.defaultSender(options);
    this.fetchTransaction = options.fetchTransaction ?? web3TransactionFetcher(options.connection);
    this.pollIntervalMs = options.pollIntervalMs ?? SLOT_MS;
    this.fetchAttempts = Math.max(1, options.fetchAttempts ?? 10);
    this.confirmations = new ConfirmationTracker({
      connection: options.connection,
      clock: options.clock,
      sender: this.sender,
      fillTimeoutMs: options.config.fillTimeoutMs,
      pollIntervalMs: this.pollIntervalMs,
      rebroadcastIntervalMs: options.rebroadcastIntervalMs ?? 2_000,
      blockHeightCheckEvery: options.blockHeightCheckEvery ?? 5
    });
    if (options.config.useJito && !options.sender && !options.jitoEndpoint) {
      log.warn("useJito is on without a Jito endpoint: tips are added but transactions go through the RPC without bundle protection");
    }
  }

  halt(): void {
    if (!this.halted) {
      this.halted = true;
      log.warn({ wallet: this.wallet }, "live executor halted: no further transactions are sent");
    }
  }

  async tokenBalance(mint: Pubkey): Promise<bigint | null> {
    try {
      const accounts = await this.connection.getTokenAccountsByOwner(this.#keypair.publicKey, { mint: new PublicKey(mint) }, "confirmed");
      return accounts.value.reduce((total, entry) => total + tokenAccountAmount(entry.account), 0n);
    } catch (error) {
      log.warn({ err: error, mint }, "wallet token balance lookup failed");
      return null;
    }
  }

  async reconcile(order: OrderRequest, signature: string): Promise<FillResult | null> {
    const tx = await this.fetchConfirmed(signature);
    if (!tx) {
      return null;
    }
    const pool = this.market.launch(order.mint)?.pool ?? null;
    const venue: TradeVenue = pool ? "pool" : "curve";
    const atMs = tx.blockTimeMs ?? this.clock.nowMs();
    if (tx.err !== null && tx.err !== undefined) {
      const error = classifyOnChainError(venue, tx.err);
      const attempt: FillAttempt = { atMs, slot: tx.slot, success: false, error, networkFee: tx.fee, tip: 0n };
      return { ...failedFill(order, error, [attempt], venue), signature };
    }
    return this.fillFromTransaction(order, tx, { pool, tipLamports: 0n, attempts: [], spotPrice: null, sentAtMs: atMs, signature });
  }

  async execute(order: OrderRequest): Promise<FillResult> {
    const launch = this.market.launch(order.mint);
    const venue: TradeVenue = this.market.view(order.mint)?.venue ?? launch?.venue ?? "curve";
    if (launch && !launch.isSolQuoted) {
      return failedFill(order, "non_sol_quote", [], venue);
    }
    if (!orderIsValid(order)) {
      return failedFill(order, "invalid_order", [], venue);
    }
    const attempts: FillAttempt[] = [];
    let lastError = "no_attempt";
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.clock.sleepUntil(this.clock.nowMs() + this.config.retryDelaySlots * SLOT_MS);
      }
      if (this.halted) {
        return failedFill(order, HALTED_ERROR, attempts, venue);
      }
      const step = await this.runAttempt(order, attempt, attempts);
      if (step.kind === "done") {
        return step.fill;
      }
      lastError = step.error;
    }
    return failedFill(order, lastError, attempts, venue);
  }

  private defaultSender(options: LiveExecutorOptions): TransactionSender {
    if (options.config.useJito && options.jitoEndpoint) {
      return new JitoTransactionSender({ endpoint: options.jitoEndpoint });
    }
    return new RpcTransactionSender(options.connection);
  }

  private localAttempt(error: string, slot?: number): FillAttempt {
    return {
      atMs: this.clock.nowMs(),
      slot: slot ?? this.market.latestSlot(),
      success: false,
      error,
      networkFee: 0n,
      tip: 0n
    };
  }

  private slippageGuard(order: OrderRequest): SlippageGuard {
    const view = this.market.view(order.mint);
    if (!view) {
      return { allowedBps: order.maxSlippageBps, spotPrice: null };
    }
    const computed = computeTradeLeg(order, view, { ...this.config, extraPlatformFeeBps: 0 });
    if ("error" in computed) {
      return { allowedBps: order.maxSlippageBps, spotPrice: null };
    }
    const fillPrice = fillPriceOf(computed.leg);
    const expected = fillPrice === null ? null : slippageVersusReference(order.side, fillPrice, order.referencePrice);
    return {
      allowedBps: expected === null ? order.maxSlippageBps : remainingSlippageBps(order.side, order.maxSlippageBps, expected),
      spotPrice: computed.leg.spotPrice
    };
  }

  private async buildTrade(order: OrderRequest, allowedBps: number): Promise<BuiltTrade> {
    const launch = this.market.launch(order.mint);
    const view = this.market.view(order.mint);
    return this.builder.build({
      order,
      user: this.#keypair.publicKey,
      slippageBps: allowedBps,
      closeTokenAccount: order.side === "sell" && order.closesPosition && this.config.refundAtaOnClose,
      hints: {
        migrated: launch?.migrated ?? view?.migrated ?? false,
        pool: launch?.pool ?? null,
        tokenProgram: launch?.info.tokenProgram ?? null
      }
    });
  }

  private refusalStep(order: OrderRequest, error: TradeRefusedError, attempts: FillAttempt[], venue: TradeVenue): AttemptStep {
    if (RETRYABLE_REFUSALS.has(error.code)) {
      attempts.push(this.localAttempt(error.code));
      return { kind: "retry", error: error.code };
    }
    return { kind: "done", fill: failedFill(order, error.code, attempts, venue) };
  }

  private async runAttempt(order: OrderRequest, attempt: number, attempts: FillAttempt[]): Promise<AttemptStep> {
    const guard = this.slippageGuard(order);
    if (guard.allowedBps === null) {
      attempts.push(this.localAttempt("slippage_exceeded"));
      return { kind: "retry", error: "slippage_exceeded" };
    }
    let built: BuiltTrade;
    try {
      built = await this.buildTrade(order, guard.allowedBps);
    } catch (error) {
      if (error instanceof TradeRefusedError) {
        return this.refusalStep(order, error, attempts, this.market.view(order.mint)?.venue ?? "curve");
      }
      log.warn({ err: error, mint: order.mint, side: order.side, attempt }, "trade build failed");
      attempts.push(this.localAttempt("build_failed"));
      return { kind: "retry", error: "build_failed" };
    }
    let blockhash: { blockhash: string; lastValidBlockHeight: number };
    try {
      blockhash = await this.connection.getLatestBlockhash("confirmed");
    } catch (error) {
      log.warn({ err: error, mint: order.mint }, "blockhash fetch failed");
      attempts.push(this.localAttempt("rpc_error"));
      return { kind: "retry", error: "rpc_error" };
    }
    const tip = this.tipFor(order, attempt);
    const transaction = compileTransaction({
      payer: this.#keypair.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: built.instructions,
      computeUnitLimit: built.computeUnitLimit,
      priorityFeeLamports: this.config.priorityFeeLamports,
      tip
    });
    transaction.sign([this.#keypair]);
    if (this.dryRun) {
      return { kind: "done", fill: await this.dryRunFill(order, transaction, built, attempts, guard) };
    }
    if (this.halted) {
      return { kind: "done", fill: failedFill(order, HALTED_ERROR, attempts, built.venue) };
    }
    const sent = await this.send(transaction, blockhash.lastValidBlockHeight, tip, order, built);
    return this.settle(order, sent, built, attempts, guard);
  }

  private tipFor(order: OrderRequest, attempt: number): TipTransfer | null {
    if (!this.config.useJito || this.config.jitoTipLamports <= 0) {
      return null;
    }
    const rng = createRng([this.config.seed, "tip", order.mint, order.side, order.signalAtMs, attempt].join("|"));
    return { account: pickTipAccount(rng), lamports: BigInt(this.config.jitoTipLamports) };
  }

  private async dryRunFill(
    order: OrderRequest,
    transaction: VersionedTransaction,
    built: BuiltTrade,
    attempts: FillAttempt[],
    guard: SlippageGuard
  ): Promise<FillResult> {
    let report: Record<string, unknown>;
    try {
      const simulation = await this.connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "processed"
      });
      const value = simulation.value;
      report = {
        ok: value.err === null,
        err: value.err,
        unitsConsumed: value.unitsConsumed ?? null,
        logs: (value.logs ?? []).slice(-DRY_RUN_LOG_LINES)
      };
    } catch (error) {
      report = { ok: false, err: (error as Error).message, unitsConsumed: null, logs: [] };
    }
    const summary = {
      ...report,
      venue: built.venue,
      instructionSet: built.instructionSet,
      computeUnitLimit: built.computeUnitLimit,
      slippageBps: guard.allowedBps,
      tokenAmount: built.tokenAmount,
      expectedTokens: built.expectedTokens,
      expectedQuote: built.expectedQuote,
      closesTokenAccount: built.closesTokenAccount
    };
    log.info({ mint: order.mint, side: order.side, ok: report.ok, unitsConsumed: report.unitsConsumed }, "dry run simulated");
    attempts.push(this.localAttempt("dry_run"));
    return failedFill(order, `dry_run:${jsonSafe(summary)}`, attempts, built.venue);
  }

  private async send(
    transaction: VersionedTransaction,
    lastValidBlockHeight: number,
    tip: TipTransfer | null,
    order: OrderRequest,
    built: BuiltTrade
  ): Promise<SentTransaction> {
    const raw = transaction.serialize();
    const signature = signatureOf(transaction);
    const sentAtMs = this.clock.nowMs();
    try {
      await this.sender.send(raw);
      log.info({ signature, mint: order.mint, side: order.side, venue: built.venue, sender: this.sender.name }, "order sent");
    } catch (error) {
      log.warn({ err: error, signature, mint: order.mint, sender: this.sender.name }, "send failed, polling in case it landed");
    }
    return { signature, raw, sentAtMs, lastValidBlockHeight, tip };
  }

  private async fetchConfirmed(signature: string): Promise<ConfirmedTransaction | null> {
    for (let attempt = 0; attempt < this.fetchAttempts; attempt += 1) {
      try {
        const tx = await this.fetchTransaction(signature);
        if (tx) {
          return tx;
        }
      } catch (error) {
        log.debug({ err: error, signature }, "transaction fetch failed");
      }
      await this.clock.sleepUntil(this.clock.nowMs() + this.pollIntervalMs);
    }
    return null;
  }

  private networkFeeOf(built: BuiltTrade): bigint {
    const microLamports = microLamportsPerComputeUnit(this.config.priorityFeeLamports, built.computeUnitLimit);
    return BigInt(this.config.baseFeeLamports) + priorityFeeLamportsFor(microLamports, built.computeUnitLimit);
  }

  private async settle(
    order: OrderRequest,
    sent: SentTransaction,
    built: BuiltTrade,
    attempts: FillAttempt[],
    guard: SlippageGuard
  ): Promise<AttemptStep> {
    const outcome = await this.confirmations.await(sent);
    switch (outcome.status) {
      case "confirmed":
        return { kind: "done", fill: await this.confirmedFill(order, sent, built, outcome.slot, attempts, guard) };
      case "failed":
        return this.failedOnChain(order, sent, built, outcome, attempts);
      case "expired":
        log.warn({ signature: sent.signature, mint: order.mint }, "blockhash expired before confirmation");
        attempts.push({ ...this.localAttempt("expired"), atMs: sent.sentAtMs });
        return { kind: "retry", error: "expired" };
      case "unknown": {
        log.error({ signature: sent.signature, mint: order.mint }, "transaction unconfirmed at timeout, not retrying");
        attempts.push({ ...this.localAttempt(UNCONFIRMED_ERROR), atMs: sent.sentAtMs });
        const fill = failedFill(order, UNCONFIRMED_ERROR, attempts, built.venue);
        return { kind: "done", fill: { ...fill, signature: sent.signature } };
      }
    }
  }

  private failedOnChain(
    order: OrderRequest,
    sent: SentTransaction,
    built: BuiltTrade,
    outcome: { slot: number; err: unknown },
    attempts: FillAttempt[]
  ): AttemptStep {
    const error = classifyOnChainError(built.venue, outcome.err);
    log.warn({ signature: sent.signature, mint: order.mint, error, err: outcome.err }, "transaction failed on chain");
    attempts.push({ atMs: sent.sentAtMs, slot: outcome.slot, success: false, error, networkFee: this.networkFeeOf(built), tip: 0n });
    return { kind: "retry", error };
  }

  private async confirmedFill(
    order: OrderRequest,
    sent: SentTransaction,
    built: BuiltTrade,
    slot: number,
    attempts: FillAttempt[],
    guard: SlippageGuard
  ): Promise<FillResult> {
    const tipLamports = sent.tip?.lamports ?? 0n;
    const tx = await this.fetchConfirmed(sent.signature);
    if (!tx) {
      attempts.push({ atMs: sent.sentAtMs, slot, success: true, error: null, networkFee: this.networkFeeOf(built), tip: tipLamports });
      return this.expectedFill(order, sent, built, slot, attempts, guard, await this.receivedTokens(order, built));
    }
    return this.fillFromTransaction(order, tx, {
      pool: built.pool,
      tipLamports,
      attempts,
      spotPrice: guard.spotPrice,
      sentAtMs: sent.sentAtMs,
      signature: sent.signature
    });
  }

  private fillFromTransaction(order: OrderRequest, tx: ConfirmedTransaction, context: SettledContext): FillResult {
    const parsed = parseFill(tx, { user: this.wallet, mint: order.mint, pool: context.pool });
    const attempts: FillAttempt[] = [
      ...context.attempts,
      {
        atMs: context.sentAtMs,
        slot: parsed.slot,
        success: true,
        error: null,
        networkFee: parsed.networkFee,
        tip: outflowBeyondTrade(parsed, context.tipLamports)
      }
    ];
    const amounts = amountsFromParsed(parsed, context.tipLamports, order.side);
    const note = parsed.tradeEvents === 0 ? "fill_from_balances" : parsed.quoteMint !== SOL_QUOTE ? "non_sol_quote_fill" : null;
    return successfulFill({
      order,
      amounts,
      quality: qualityOf(order, amounts, context.spotPrice),
      attempts,
      filledAtMs: parsed.blockTimeMs ?? this.clock.nowMs(),
      filledSlot: parsed.slot,
      rentPaid: parsed.rentPaid,
      rentRefunded: parsed.rentRefunded,
      signature: context.signature,
      note
    });
  }

  private async receivedTokens(order: OrderRequest, built: BuiltTrade): Promise<bigint> {
    if (order.side === "sell") {
      return built.tokenAmount;
    }
    const balance = await this.tokenBalance(order.mint);
    const received = balance === null ? 0n : balance - built.tokenBalanceBefore;
    return received > 0n ? received : built.expectedTokens;
  }

  private expectedFill(
    order: OrderRequest,
    sent: SentTransaction,
    built: BuiltTrade,
    slot: number,
    attempts: FillAttempt[],
    guard: SlippageGuard,
    tokenAmount: bigint
  ): FillResult {
    const rent = BigInt(this.config.ataRentLamports);
    const amounts: FillAmounts = {
      venue: built.venue,
      tokenAmount,
      quoteAmount: built.expectedQuote,
      userQuote: built.expectedQuote,
      protocolFee: 0n,
      creatorFee: 0n,
      lpFee: 0n,
      extraPlatformFee: 0n
    };
    log.error({ signature: sent.signature, mint: order.mint }, "confirmed transaction could not be fetched, using expected amounts");
    return successfulFill({
      order,
      amounts,
      quality: qualityOf(order, amounts, guard.spotPrice),
      attempts,
      filledAtMs: this.clock.nowMs(),
      filledSlot: slot,
      rentPaid: order.side === "buy" && built.createsTokenAccount ? rent : 0n,
      rentRefunded: order.side === "sell" && built.closesTokenAccount ? rent : 0n,
      signature: sent.signature,
      note: "fill_unparsed"
    });
  }
}
