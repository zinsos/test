import bs58 from "bs58";
import {
  PublicKey,
  SystemProgram,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
  type Connection,
  type Keypair
} from "@solana/web3.js";
import type { SweeperConfig } from "../config/strategy.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import { BASE_SIGNATURE_FEE_LAMPORTS, DEFAULT_PUBKEY } from "../core/constants.js";
import { moduleLogger } from "../core/logger.js";
import type { Db } from "../db/pool.js";
import { solToLamports } from "./money.js";

const log = moduleLogger("risk.sweeper");

export type SweeperConnection = Pick<
  Connection,
  "getBalance" | "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction"
>;

export type SweepStatus =
  | "disabled"
  | "busy"
  | "in_progress"
  | "below_minimum"
  | "dry_run"
  | "sent"
  | "confirmed"
  | "failed"
  | "error";

export type SweepRowStatus = "dry_run" | "sent" | "confirmed" | "failed";

export interface SweepResult {
  status: SweepStatus;
  balanceLamports: bigint | null;
  sweepLamports: bigint;
  signature: string | null;
  sweepId: number | null;
  error: string | null;
}

export interface HotColdSweeperOptions {
  connection: SweeperConnection;
  hotKeypair: Keypair;
  coldAddress: string;
  config: SweeperConfig;
  db: Pick<Db, "query">;
  clock: Clock;
  dryRun: boolean;
  isBusy: () => boolean;
  commitment?: Commitment;
  initialDelayMs?: number;
  networkFeeLamports?: bigint;
}

export class SweeperConfigError extends Error {
  constructor(reason: string) {
    super(`invalid sweeper configuration: ${reason}`);
    this.name = "SweeperConfigError";
  }
}

const MINUTE_MS = 60_000;
const DEFAULT_INITIAL_DELAY_MS = MINUTE_MS;

export function validateColdAddress(coldAddress: string, hot: PublicKey): PublicKey {
  const text = coldAddress.trim();
  if (text.length === 0) {
    throw new SweeperConfigError("cold wallet address is empty");
  }
  let cold: PublicKey;
  try {
    cold = new PublicKey(text);
  } catch {
    throw new SweeperConfigError("cold wallet address is not a valid public key");
  }
  if (cold.toBase58() !== text) {
    throw new SweeperConfigError("cold wallet address is not canonical base58");
  }
  if (cold.equals(hot)) {
    throw new SweeperConfigError("cold wallet address equals the hot wallet");
  }
  if (text === DEFAULT_PUBKEY) {
    throw new SweeperConfigError("cold wallet address is the system program");
  }
  if (!PublicKey.isOnCurve(cold.toBytes())) {
    throw new SweeperConfigError("cold wallet address is a program derived address, not a wallet");
  }
  return cold;
}

export function hotFloorLamports(config: SweeperConfig): bigint {
  return solToLamports(config.hotTargetSol) + solToLamports(config.reserveSol);
}

export function sweepAmountLamports(
  balanceLamports: bigint,
  config: SweeperConfig,
  networkFeeLamports: bigint = BASE_SIGNATURE_FEE_LAMPORTS
): bigint {
  const excess = balanceLamports - hotFloorLamports(config) - networkFeeLamports;
  return excess >= solToLamports(config.minSweepSol) && excess > 0n ? excess : 0n;
}

interface SweepRowInput {
  atMs: number;
  from: string;
  to: string;
  lamports: bigint;
  balanceBefore: bigint;
  signature: string | null;
  status: SweepRowStatus;
  error: string | null;
}

export async function insertSweepRow(db: Pick<Db, "query">, row: SweepRowInput): Promise<number | null> {
  const result = await db.query<{ id: bigint | number }>(
    `INSERT INTO sweeps (at, from_wallet, to_wallet, lamports, hot_balance_before, signature, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (signature) WHERE signature IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      new Date(row.atMs),
      row.from,
      row.to,
      row.lamports.toString(),
      row.balanceBefore.toString(),
      row.signature,
      row.status,
      row.error
    ]
  );
  const id = result.rows[0]?.id;
  return id === undefined ? null : Number(id);
}

export async function updateSweepStatus(
  db: Pick<Db, "query">,
  signature: string,
  status: SweepRowStatus,
  error: string | null
): Promise<void> {
  await db.query("UPDATE sweeps SET status = $2, error = $3 WHERE signature = $1", [signature, status, error]);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

function confirmationErrorText(err: unknown): string {
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return String(err).slice(0, 500);
  }
}

export class HotColdSweeper {
  readonly hot: PublicKey;
  readonly cold: PublicKey;
  private readonly options: HotColdSweeperOptions;
  private readonly commitment: Commitment;
  private readonly networkFee: bigint;
  private timer: TimerHandle | null = null;
  private running: Promise<SweepResult> | null = null;
  private stopped = true;

  constructor(options: HotColdSweeperOptions) {
    this.options = options;
    this.hot = options.hotKeypair.publicKey;
    this.cold = validateColdAddress(options.coldAddress, this.hot);
    this.commitment = options.commitment ?? "confirmed";
    this.networkFee = options.networkFeeLamports ?? BASE_SIGNATURE_FEE_LAMPORTS;
    if (options.config.intervalMinutes <= 0) {
      throw new SweeperConfigError("intervalMinutes must be positive");
    }
  }

  start(): void {
    if (!this.options.config.enabled) {
      log.info("hot to cold sweeper disabled");
      return;
    }
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    log.info(
      { hot: this.hot.toBase58(), cold: this.cold.toBase58(), dryRun: this.options.dryRun, intervalMinutes: this.options.config.intervalMinutes },
      "hot to cold sweeper started"
    );
    this.scheduleNext(this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      this.options.clock.cancel(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running;
    }
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  tick(): Promise<SweepResult> {
    if (this.running) {
      return Promise.resolve(this.result("in_progress", null, 0n));
    }
    this.running = this.sweepOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = this.options.clock.schedule(this.options.clock.nowMs() + delayMs, async () => {
      this.timer = null;
      await this.tick();
      this.scheduleNext(this.options.config.intervalMinutes * MINUTE_MS);
    });
  }

  private result(
    status: SweepStatus,
    balance: bigint | null,
    lamports: bigint,
    extra: Partial<Pick<SweepResult, "signature" | "sweepId" | "error">> = {}
  ): SweepResult {
    return {
      status,
      balanceLamports: balance,
      sweepLamports: lamports,
      signature: extra.signature ?? null,
      sweepId: extra.sweepId ?? null,
      error: extra.error ?? null
    };
  }

  private async sweepOnce(): Promise<SweepResult> {
    if (!this.options.config.enabled) {
      return this.result("disabled", null, 0n);
    }
    if (this.options.isBusy()) {
      return this.result("busy", null, 0n);
    }
    let balance: bigint;
    try {
      balance = BigInt(await this.options.connection.getBalance(this.hot, this.commitment));
    } catch (error) {
      log.warn({ err: error }, "hot wallet balance lookup failed");
      return this.result("error", null, 0n, { error: errorText(error) });
    }
    const lamports = sweepAmountLamports(balance, this.options.config, this.networkFee);
    if (lamports <= 0n) {
      return this.result("below_minimum", balance, 0n);
    }
    if (this.options.isBusy()) {
      return this.result("busy", balance, lamports);
    }
    if (this.options.dryRun) {
      return this.recordDryRun(balance, lamports);
    }
    return this.transfer(balance, lamports);
  }

  private async recordDryRun(balance: bigint, lamports: bigint): Promise<SweepResult> {
    try {
      const sweepId = await insertSweepRow(this.options.db, this.row(balance, lamports, null, "dry_run", null));
      log.info({ lamports: lamports.toString(), balance: balance.toString() }, "dry run sweep recorded");
      return this.result("dry_run", balance, lamports, { sweepId });
    } catch (error) {
      log.error({ err: error }, "dry run sweep record failed");
      return this.result("error", balance, lamports, { error: errorText(error) });
    }
  }

  private row(
    balance: bigint,
    lamports: bigint,
    signature: string | null,
    status: SweepRowStatus,
    error: string | null
  ): SweepRowInput {
    return {
      atMs: this.options.clock.nowMs(),
      from: this.hot.toBase58(),
      to: this.cold.toBase58(),
      lamports,
      balanceBefore: balance,
      signature,
      status,
      error
    };
  }

  private async buildTransfer(lamports: bigint): Promise<{ transaction: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.options.connection.getLatestBlockhash(this.commitment);
    const message = new TransactionMessage({
      payerKey: this.hot,
      recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: this.hot, toPubkey: this.cold, lamports })]
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([this.options.hotKeypair]);
    return { transaction, blockhash, lastValidBlockHeight };
  }

  private async transfer(balance: bigint, lamports: bigint): Promise<SweepResult> {
    let built: Awaited<ReturnType<HotColdSweeper["buildTransfer"]>>;
    let signature: string;
    let sweepId: number | null;
    try {
      built = await this.buildTransfer(lamports);
      const first = built.transaction.signatures[0];
      if (!first) {
        throw new Error("signed transfer has no signature");
      }
      signature = bs58.encode(first);
      sweepId = await insertSweepRow(this.options.db, this.row(balance, lamports, signature, "sent", null));
    } catch (error) {
      log.error({ err: error }, "sweep preparation failed, nothing sent");
      return this.result("error", balance, lamports, { error: errorText(error) });
    }
    try {
      await this.options.connection.sendRawTransaction(built.transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: this.commitment,
        maxRetries: 5
      });
    } catch (error) {
      return this.finish(balance, lamports, signature, sweepId, "failed", errorText(error));
    }
    return this.confirm(balance, lamports, signature, sweepId, built.blockhash, built.lastValidBlockHeight);
  }

  private async confirm(
    balance: bigint,
    lamports: bigint,
    signature: string,
    sweepId: number | null,
    blockhash: string,
    lastValidBlockHeight: number
  ): Promise<SweepResult> {
    try {
      const response = await this.options.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        this.commitment
      );
      if (response.value.err) {
        return this.finish(balance, lamports, signature, sweepId, "failed", confirmationErrorText(response.value.err));
      }
      return this.finish(balance, lamports, signature, sweepId, "confirmed", null);
    } catch (error) {
      if (error instanceof TransactionExpiredBlockheightExceededError) {
        return this.finish(balance, lamports, signature, sweepId, "failed", "blockhash expired before confirmation");
      }
      log.warn({ err: error, signature }, "sweep confirmation unknown");
      await this.updateQuietly(signature, "sent", `confirmation unknown: ${errorText(error)}`);
      return this.result("sent", balance, lamports, { signature, sweepId, error: errorText(error) });
    }
  }

  private async finish(
    balance: bigint,
    lamports: bigint,
    signature: string,
    sweepId: number | null,
    status: "confirmed" | "failed",
    error: string | null
  ): Promise<SweepResult> {
    await this.updateQuietly(signature, status, error);
    if (status === "confirmed") {
      log.info({ lamports: lamports.toString(), signature, cold: this.cold.toBase58() }, "swept profits to cold wallet");
    } else {
      log.error({ lamports: lamports.toString(), signature, error }, "sweep failed");
    }
    return this.result(status, balance, lamports, { signature, sweepId, error });
  }

  private async updateQuietly(signature: string, status: SweepRowStatus, error: string | null): Promise<void> {
    try {
      await updateSweepStatus(this.options.db, signature, status, error);
    } catch (dbError) {
      log.error({ err: dbError, signature, status }, "sweep status update failed");
    }
  }
}
