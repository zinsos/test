import type { DecodeResult } from "../chain/events.js";
import { moduleLogger } from "../core/logger.js";
import type { IngestGap } from "../core/types.js";

const log = moduleLogger("ingest");

export interface StreamMeta {
  signature: string;
  slot: number;
  seq: number;
  receivedAtMs: number;
}

export type BatchHandler = (batch: DecodeResult, meta: StreamMeta) => void;
export type GapHandler = (gap: IngestGap) => void;

export interface StreamSource {
  readonly name: string;
  start(handler: BatchHandler): Promise<void>;
  stop(): Promise<void>;
  stats(): Record<string, number>;
  onGap(handler: GapHandler): () => void;
}

export class GapListeners {
  private readonly handlers = new Set<GapHandler>();

  add(handler: GapHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(gap: IngestGap): void {
    for (const handler of this.handlers) {
      try {
        handler(gap);
      } catch (error) {
        log.error({ err: error, gap }, "gap handler failed");
      }
    }
  }
}
