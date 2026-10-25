import type { Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { IngestGap } from "../core/types.js";
import { TransactionDecoder } from "./decoder.js";
import { GapListeners, type BatchHandler, type GapHandler, type StreamSource } from "./source.js";

const log = moduleLogger("replay-source");

export interface ReplayTransaction {
  signature: string;
  slot: number;
  logs: readonly string[];
  err?: unknown;
  receivedAtMs?: number;
}

export interface ReplayLogSourceOptions {
  clock: Clock;
  transactions?: readonly ReplayTransaction[];
  name?: string;
  dedupeCapacity?: number;
}

export class ReplayLogSource implements StreamSource {
  readonly name: string;
  private readonly clock: Clock;
  private readonly decoder: TransactionDecoder;
  private readonly gapListeners = new GapListeners();
  private readonly initial: readonly ReplayTransaction[];
  private handler: BatchHandler | null = null;
  private handlerErrors = 0;

  constructor(options: ReplayLogSourceOptions) {
    this.name = options.name ?? "replay";
    this.clock = options.clock;
    this.initial = options.transactions ?? [];
    this.decoder = new TransactionDecoder(options.dedupeCapacity ?? 50_000);
  }

  onGap(handler: GapHandler): () => void {
    return this.gapListeners.add(handler);
  }

  async start(handler: BatchHandler): Promise<void> {
    this.handler = handler;
    for (const tx of this.initial) {
      this.push(tx);
    }
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  push(tx: ReplayTransaction): boolean {
    const decoded = this.decoder.decode(
      { signature: tx.signature, slot: tx.slot, err: tx.err ?? null, logs: tx.logs },
      tx.receivedAtMs ?? this.clock.nowMs()
    );
    if (!decoded || !this.handler) {
      return false;
    }
    try {
      this.handler(decoded.batch, decoded.meta);
    } catch (error) {
      this.handlerErrors += 1;
      log.error({ err: error, signature: tx.signature }, "replay handler failed");
    }
    return true;
  }

  reportGap(gap: IngestGap): void {
    this.gapListeners.emit(gap);
  }

  stats(): Record<string, number> {
    const decoder = this.decoder.stats();
    return {
      txReceived: decoder.received,
      txDuplicates: decoder.duplicates,
      txFailed: decoder.failed,
      txDecoded: decoder.decoded,
      events: decoder.events,
      incompleteEvents: decoder.incomplete,
      truncatedTx: decoder.truncated,
      lastSlot: decoder.lastSlot,
      lastSeq: decoder.lastSeq,
      handlerErrors: this.handlerErrors
    };
  }
}
