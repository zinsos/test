import type { ChainEvent, IngestGap, LaunchScore, Position, Signal } from "./types.js";
import { moduleLogger } from "./logger.js";

export interface RiskEvent {
  runId: number;
  atMs: number;
  kind: string;
  detail: Record<string, unknown>;
}

export interface SignalRejection {
  signal: Signal;
  reason: string;
}

export interface BusEvents {
  chain: ChainEvent;
  gap: IngestGap;
  score: LaunchScore;
  signal: Signal;
  signalRejected: SignalRejection;
  positionOpened: Position;
  positionUpdated: Position;
  positionClosed: Position;
  risk: RiskEvent;
}

type Listener<T> = (payload: T) => void;

const log = moduleLogger("bus");

export class Bus {
  private readonly listeners = new Map<keyof BusEvents, Set<Listener<never>>>();

  on<K extends keyof BusEvents>(event: K, listener: Listener<BusEvents[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<K extends keyof BusEvents>(event: K, listener: Listener<BusEvents[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const listener of set) {
      try {
        (listener as Listener<BusEvents[K]>)(payload);
      } catch (error) {
        log.error({ err: error, event }, "bus listener failed");
      }
    }
  }

  listenerCount(event: keyof BusEvents): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
