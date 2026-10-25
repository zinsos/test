import type { Connection } from "@solana/web3.js";
import type { Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { TransactionSender } from "./senders.js";
import type { TipTransfer } from "./transaction.js";

const log = moduleLogger("execution.confirmation");

export type ConfirmationOutcome =
  | { status: "confirmed"; slot: number }
  | { status: "failed"; slot: number; err: unknown }
  | { status: "expired" }
  | { status: "unknown" };

export interface SentTransaction {
  signature: string;
  raw: Uint8Array;
  sentAtMs: number;
  lastValidBlockHeight: number;
  tip: TipTransfer | null;
}

export interface SignatureState {
  slot: number;
  err: unknown;
  confirmationStatus?: string | null;
}

export interface ConfirmationTrackerOptions {
  connection: Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;
  clock: Clock;
  sender: TransactionSender;
  fillTimeoutMs: number;
  pollIntervalMs: number;
  rebroadcastIntervalMs: number;
  blockHeightCheckEvery: number;
}

export function outcomeOfStatus(status: SignatureState | null): ConfirmationOutcome | null {
  if (!status) {
    return null;
  }
  if (status.err) {
    return { status: "failed", slot: status.slot, err: status.err };
  }
  if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
    return { status: "confirmed", slot: status.slot };
  }
  return null;
}

export class ConfirmationTracker {
  private readonly options: ConfirmationTrackerOptions;
  private readonly blockHeightCheckEvery: number;

  constructor(options: ConfirmationTrackerOptions) {
    this.options = options;
    this.blockHeightCheckEvery = Math.max(1, Math.floor(options.blockHeightCheckEvery));
  }

  async await(sent: SentTransaction): Promise<ConfirmationOutcome> {
    const { clock } = this.options;
    const deadline = sent.sentAtMs + this.options.fillTimeoutMs;
    let nextRebroadcastMs = sent.sentAtMs + this.options.rebroadcastIntervalMs;
    for (let poll = 1; ; poll += 1) {
      await clock.sleepUntil(clock.nowMs() + this.options.pollIntervalMs);
      const outcome = outcomeOfStatus(await this.statusOf(sent.signature, false));
      if (outcome) {
        return outcome;
      }
      const now = clock.nowMs();
      if ((poll % this.blockHeightCheckEvery === 0 || now >= deadline) && (await this.blockhashExpired(sent))) {
        return outcomeOfStatus(await this.statusOf(sent.signature, true)) ?? { status: "expired" };
      }
      if (now >= deadline) {
        return outcomeOfStatus(await this.statusOf(sent.signature, true)) ?? { status: "unknown" };
      }
      if (now >= nextRebroadcastMs) {
        await this.rebroadcast(sent);
        nextRebroadcastMs = now + this.options.rebroadcastIntervalMs;
      }
    }
  }

  private async statusOf(signature: string, searchHistory: boolean): Promise<SignatureState | null> {
    try {
      const response = await this.options.connection.getSignatureStatuses([signature], { searchTransactionHistory: searchHistory });
      return response.value[0] ?? null;
    } catch (error) {
      log.debug({ err: error, signature }, "signature status failed");
      return null;
    }
  }

  private async blockhashExpired(sent: SentTransaction): Promise<boolean> {
    try {
      return (await this.options.connection.getBlockHeight("confirmed")) > sent.lastValidBlockHeight;
    } catch (error) {
      log.debug({ err: error }, "block height failed");
      return false;
    }
  }

  private async rebroadcast(sent: SentTransaction): Promise<void> {
    try {
      await this.options.sender.send(sent.raw);
    } catch (error) {
      log.debug({ err: error, signature: sent.signature }, "rebroadcast failed");
    }
  }
}
