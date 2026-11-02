import { decodeLogs, type DecodeResult } from "../chain/events.js";
import { BoundedSet } from "./lru.js";
import type { StreamMeta } from "./source.js";

export interface LogNotification {
  signature: string;
  slot: number;
  err: unknown;
  logs: readonly string[] | null;
}

export interface DecodedTransaction {
  batch: DecodeResult;
  meta: StreamMeta;
}

export interface TransactionDecoderStats {
  received: number;
  duplicates: number;
  failed: number;
  decoded: number;
  empty: number;
  events: number;
  incomplete: number;
  truncated: number;
  unknown: number;
  decodeErrors: number;
  lastSlot: number;
  lastSeq: number;
  lagMs: number;
}

export class TransactionDecoder {
  private readonly seen: BoundedSet<string>;
  private seq = 0;
  private readonly counters: TransactionDecoderStats = {
    received: 0,
    duplicates: 0,
    failed: 0,
    decoded: 0,
    empty: 0,
    events: 0,
    incomplete: 0,
    truncated: 0,
    unknown: 0,
    decodeErrors: 0,
    lastSlot: 0,
    lastSeq: 0,
    lagMs: 0
  };

  constructor(dedupeCapacity: number) {
    this.seen = new BoundedSet<string>(dedupeCapacity);
  }

  decode(notification: LogNotification, receivedAtMs: number): DecodedTransaction | null {
    this.counters.received += 1;
    if (notification.err !== null && notification.err !== undefined) {
      this.counters.failed += 1;
      return null;
    }
    if (!this.seen.addIfAbsent(notification.signature)) {
      this.counters.duplicates += 1;
      return null;
    }
    this.seq += 1;
    const meta: StreamMeta = {
      signature: notification.signature,
      slot: notification.slot,
      seq: this.seq,
      receivedAtMs
    };
    this.counters.lastSeq = this.seq;
    this.counters.lastSlot = Math.max(this.counters.lastSlot, notification.slot);
    const batch = this.safeDecode(notification.logs ?? [], meta);
    if (!batch) {
      return null;
    }
    this.record(batch, receivedAtMs);
    if (batch.events.length === 0) {
      this.counters.empty += 1;
      return null;
    }
    this.counters.decoded += 1;
    return { batch, meta };
  }

  stats(): TransactionDecoderStats {
    return { ...this.counters };
  }

  private safeDecode(logs: readonly string[], meta: StreamMeta): DecodeResult | null {
    try {
      return decodeLogs(logs, meta);
    } catch {
      this.counters.decodeErrors += 1;
      return null;
    }
  }

  private record(batch: DecodeResult, receivedAtMs: number): void {
    this.counters.events += batch.events.length;
    this.counters.incomplete += batch.incomplete;
    this.counters.unknown += batch.unknown;
    if (batch.truncated) {
      this.counters.truncated += 1;
    }
    let latestEventMs = 0;
    for (const event of batch.events) {
      latestEventMs = Math.max(latestEventMs, event.timestampMs);
    }
    if (latestEventMs > 0) {
      this.counters.lagMs = Math.max(0, receivedAtMs - latestEventMs);
    }
  }
}
