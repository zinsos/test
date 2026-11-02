import WebSocket, { type RawData } from "ws";
import type { Clock, TimerHandle } from "../core/clock.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "../core/constants.js";
import { moduleLogger } from "../core/logger.js";
import type { IngestGap } from "../core/types.js";
import { TransactionDecoder } from "./decoder.js";
import { GapListeners, type BatchHandler, type GapHandler, type StreamSource } from "./source.js";

const log = moduleLogger("ws-source");

export type StreamCommitment = "processed" | "confirmed";

export interface ReconnectBackoff {
  initialMs: number;
  maxMs: number;
  multiplier: number;
  jitter: number;
}

export interface LogsWebsocketSourceOptions {
  url: string;
  clock: Clock;
  commitment?: StreamCommitment;
  programs?: readonly string[];
  name?: string;
  createSocket?: (url: string) => WebSocket;
  dedupeCapacity?: number;
  pingIntervalMs?: number;
  stallTimeoutMs?: number;
  stallCheckIntervalMs?: number;
  subscribeTimeoutMs?: number;
  subscriptionStallMs?: number;
  closeTimeoutMs?: number;
  backoff?: Partial<ReconnectBackoff>;
  random?: () => number;
}

interface PendingGap {
  fromSlot: number;
  startedAtMs: number;
  reason: string;
}

interface SubscribeResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: unknown;
  params?: unknown;
}

interface NotificationPayload {
  subscription?: unknown;
  result?: {
    context?: { slot?: unknown };
    value?: { signature?: unknown; err?: unknown; logs?: unknown };
  };
}

export const DEFAULT_BACKOFF: ReconnectBackoff = { initialMs: 500, maxMs: 30_000, multiplier: 2, jitter: 0.2 };

export function backoffDelayMs(attempt: number, backoff: ReconnectBackoff, random: () => number): number {
  const base = Math.min(backoff.maxMs, backoff.initialMs * backoff.multiplier ** Math.max(0, attempt));
  const spread = 1 - backoff.jitter + 2 * backoff.jitter * random();
  return Math.max(0, Math.round(base * spread));
}

function defaultSocketFactory(url: string): WebSocket {
  return new WebSocket(url, { handshakeTimeout: 15_000 });
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

export class LogsWebsocketSource implements StreamSource {
  readonly name: string;
  private readonly clock: Clock;
  private readonly url: string;
  private readonly commitment: StreamCommitment;
  private readonly programs: readonly string[];
  private readonly createSocket: (url: string) => WebSocket;
  private readonly pingIntervalMs: number;
  private readonly stallTimeoutMs: number;
  private readonly stallCheckIntervalMs: number;
  private readonly subscribeTimeoutMs: number;
  private readonly subscriptionStallMs: number;
  private readonly closeTimeoutMs: number;
  private readonly backoff: ReconnectBackoff;
  private readonly random: () => number;
  private readonly decoder: TransactionDecoder;
  private readonly gapListeners = new GapListeners();
  private readonly requests = new Map<number, string>();
  private readonly subscriptions = new Map<number, string>();
  private readonly subscriptionActivity = new Map<number, number>();
  private handler: BatchHandler | null = null;
  private socket: WebSocket | null = null;
  private connectionId = 0;
  private running = false;
  private attempt = 0;
  private nextRequestId = 1;
  private reconnectTimer: TimerHandle | null = null;
  private pingTimer: TimerHandle | null = null;
  private stallTimer: TimerHandle | null = null;
  private awaitingPong = false;
  private lastActivityMs = 0;
  private connectedAtMs = 0;
  private lastNotificationMs: number | null = null;
  private lastSlotSeen: number | null = null;
  private pendingGap: PendingGap | null = null;
  private firstSettle: (() => void) | null = null;
  private readonly counters = {
    connects: 0,
    reconnects: 0,
    disconnects: 0,
    stalls: 0,
    subscriptionStalls: 0,
    subscribeTimeouts: 0,
    heartbeatTimeouts: 0,
    badMessages: 0,
    subscribeErrors: 0,
    handlerErrors: 0,
    notifications: 0,
    gaps: 0
  };

  constructor(options: LogsWebsocketSourceOptions) {
    this.name = options.name ?? "ws";
    this.clock = options.clock;
    this.url = options.url;
    this.commitment = options.commitment ?? "confirmed";
    this.programs = options.programs ?? [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID];
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.pingIntervalMs = options.pingIntervalMs ?? 15_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 30_000;
    this.stallCheckIntervalMs = options.stallCheckIntervalMs ?? Math.max(50, Math.min(5_000, this.stallTimeoutMs / 3));
    this.subscribeTimeoutMs = options.subscribeTimeoutMs ?? 10_000;
    this.subscriptionStallMs = options.subscriptionStallMs ?? 120_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.random = options.random ?? Math.random;
    this.decoder = new TransactionDecoder(options.dedupeCapacity ?? 50_000);
  }

  onGap(handler: GapHandler): () => void {
    return this.gapListeners.add(handler);
  }

  start(handler: BatchHandler): Promise<void> {
    if (this.running) {
      return Promise.resolve();
    }
    this.handler = handler;
    this.running = true;
    const settled = new Promise<void>((resolve) => {
      this.firstSettle = resolve;
    });
    this.connect();
    return settled;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.cancelReconnect();
    this.clearConnectionTimers();
    const socket = this.socket;
    this.connectionId += 1;
    this.socket = null;
    if (socket) {
      await this.closeSocket(socket);
    }
    this.settleFirst();
    if (this.pendingGap) {
      this.emitGap(this.pendingGap, null, this.clock.nowMs(), `${this.pendingGap.reason}; unresolved at stop`);
    }
  }

  stats(): Record<string, number> {
    const decoder = this.decoder.stats();
    return {
      connected: this.socket?.readyState === WebSocket.OPEN ? 1 : 0,
      subscriptions: this.subscriptions.size,
      ...this.counters,
      txReceived: decoder.received,
      txDuplicates: decoder.duplicates,
      txFailed: decoder.failed,
      txDecoded: decoder.decoded,
      txEmpty: decoder.empty,
      events: decoder.events,
      incompleteEvents: decoder.incomplete,
      truncatedTx: decoder.truncated,
      unknownEvents: decoder.unknown,
      decodeErrors: decoder.decodeErrors,
      lastSlot: this.lastSlotSeen ?? 0,
      lastSeq: decoder.lastSeq,
      lagMs: decoder.lagMs,
      pendingGap: this.pendingGap ? 1 : 0,
      msSinceLastNotification: this.lastNotificationMs === null ? -1 : this.clock.nowMs() - this.lastNotificationMs
    };
  }

  private connect(): void {
    this.connectionId += 1;
    const id = this.connectionId;
    this.requests.clear();
    this.subscriptions.clear();
    this.subscriptionActivity.clear();
    this.awaitingPong = false;
    let socket: WebSocket;
    try {
      socket = this.createSocket(this.url);
    } catch (error) {
      this.handleDisconnect(id, `connect failed: ${(error as Error).message}`);
      return;
    }
    this.socket = socket;
    socket.on("open", () => this.handleOpen(id));
    socket.on("message", (data: RawData) => this.handleMessage(id, data));
    socket.on("pong", () => {
      if (id === this.connectionId) {
        this.awaitingPong = false;
      }
    });
    socket.on("error", (error: Error) => {
      if (id === this.connectionId) {
        log.warn({ err: error, source: this.name }, "websocket error");
      }
    });
    socket.on("close", (code: number, reason: Buffer) => {
      this.handleDisconnect(id, `closed ${code}${reason.length > 0 ? ` ${reason.toString("utf8")}` : ""}`);
    });
  }

  private handleOpen(id: number): void {
    if (id !== this.connectionId || !this.socket) {
      return;
    }
    this.counters.connects += 1;
    this.lastActivityMs = this.clock.nowMs();
    this.connectedAtMs = this.lastActivityMs;
    for (const program of this.programs) {
      this.subscribe(this.socket, program);
    }
    this.schedulePing(id);
    this.scheduleStallCheck(id);
    this.settleFirst();
    log.info({ source: this.name, programs: this.programs.length }, "websocket connected");
  }

  private subscribe(socket: WebSocket, program: string): void {
    const requestId = this.nextRequestId++;
    this.requests.set(requestId, program);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "logsSubscribe",
        params: [{ mentions: [program] }, { commitment: this.commitment }]
      })
    );
  }

  private handleMessage(id: number, data: RawData): void {
    if (id !== this.connectionId) {
      return;
    }
    let message: SubscribeResponse;
    try {
      message = JSON.parse(rawToString(data)) as SubscribeResponse;
    } catch {
      this.counters.badMessages += 1;
      return;
    }
    if (typeof message.id === "number" && this.requests.has(message.id)) {
      this.handleSubscribeResponse(message.id, message);
      return;
    }
    if (message.method === "logsNotification") {
      this.handleNotification(message.params as NotificationPayload | undefined);
    }
  }

  private handleSubscribeResponse(requestId: number, message: SubscribeResponse): void {
    const program = this.requests.get(requestId);
    this.requests.delete(requestId);
    if (message.error || typeof message.result !== "number" || !program) {
      this.counters.subscribeErrors += 1;
      log.error({ source: this.name, program, error: message.error }, "logsSubscribe failed");
      this.forceReconnect(`subscribe failed: ${message.error?.message ?? "no subscription id"}`);
      return;
    }
    this.subscriptions.set(message.result, program);
    this.lastActivityMs = this.clock.nowMs();
    this.subscriptionActivity.set(message.result, this.lastActivityMs);
  }

  private handleNotification(params: NotificationPayload | undefined): void {
    const value = params?.result?.value;
    const slot = params?.result?.context?.slot;
    if (!value || typeof value.signature !== "string" || typeof slot !== "number") {
      this.counters.badMessages += 1;
      return;
    }
    const now = this.clock.nowMs();
    this.counters.notifications += 1;
    this.lastActivityMs = now;
    this.lastNotificationMs = now;
    this.attempt = 0;
    if (typeof params?.subscription === "number" && this.subscriptionActivity.has(params.subscription)) {
      this.subscriptionActivity.set(params.subscription, now);
    }
    if (this.pendingGap) {
      this.emitGap(this.pendingGap, slot, now, this.pendingGap.reason);
    }
    this.lastSlotSeen = Math.max(this.lastSlotSeen ?? 0, slot);
    const logs = Array.isArray(value.logs) ? value.logs.filter((line): line is string => typeof line === "string") : null;
    const decoded = this.decoder.decode({ signature: value.signature, slot, err: value.err ?? null, logs }, now);
    if (!decoded || !this.handler) {
      return;
    }
    try {
      this.handler(decoded.batch, decoded.meta);
    } catch (error) {
      this.counters.handlerErrors += 1;
      log.error({ err: error, signature: decoded.meta.signature }, "stream handler failed");
    }
  }

  private emitGap(pending: PendingGap, toSlot: number | null, endedAtMs: number, reason: string): void {
    this.pendingGap = null;
    this.counters.gaps += 1;
    const gap: IngestGap = {
      source: this.name,
      fromSlot: pending.fromSlot,
      toSlot,
      startedAtMs: pending.startedAtMs,
      endedAtMs,
      reason
    };
    log.warn({ gap }, "ingest gap");
    this.gapListeners.emit(gap);
  }

  private handleDisconnect(id: number, reason: string): void {
    if (id !== this.connectionId) {
      return;
    }
    this.connectionId += 1;
    this.clearConnectionTimers();
    this.socket = null;
    this.subscriptions.clear();
    this.subscriptionActivity.clear();
    this.requests.clear();
    this.counters.disconnects += 1;
    if (!this.pendingGap && this.lastSlotSeen !== null) {
      this.pendingGap = {
        fromSlot: this.lastSlotSeen,
        startedAtMs: this.lastNotificationMs ?? this.clock.nowMs(),
        reason
      };
    }
    this.settleFirst();
    if (!this.running) {
      return;
    }
    log.warn({ source: this.name, reason, attempt: this.attempt }, "websocket disconnected");
    this.scheduleReconnect();
  }

  private forceReconnect(reason: string): void {
    const socket = this.socket;
    this.handleDisconnect(this.connectionId, reason);
    if (socket) {
      try {
        socket.terminate();
      } catch (error) {
        log.debug({ err: error }, "terminate failed");
      }
    }
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    const delay = backoffDelayMs(this.attempt, this.backoff, this.random);
    this.attempt += 1;
    this.reconnectTimer = this.clock.schedule(this.clock.nowMs() + delay, () => {
      this.reconnectTimer = null;
      if (this.running) {
        this.counters.reconnects += 1;
        this.connect();
      }
    });
  }

  private schedulePing(id: number): void {
    this.pingTimer = this.clock.schedule(this.clock.nowMs() + this.pingIntervalMs, () => {
      this.pingTimer = null;
      if (id !== this.connectionId || !this.socket) {
        return;
      }
      if (this.awaitingPong) {
        this.counters.heartbeatTimeouts += 1;
        this.forceReconnect("heartbeat timeout");
        return;
      }
      this.awaitingPong = true;
      try {
        this.socket.ping();
      } catch (error) {
        this.forceReconnect(`ping failed: ${(error as Error).message}`);
        return;
      }
      this.schedulePing(id);
    });
  }

  private scheduleStallCheck(id: number): void {
    this.stallTimer = this.clock.schedule(this.clock.nowMs() + this.stallCheckIntervalMs, () => {
      this.stallTimer = null;
      if (id !== this.connectionId) {
        return;
      }
      const problem = this.connectionProblem(this.clock.nowMs());
      if (problem) {
        this.forceReconnect(problem);
        return;
      }
      this.scheduleStallCheck(id);
    });
  }

  private connectionProblem(now: number): string | null {
    if (now - this.lastActivityMs > this.stallTimeoutMs) {
      this.counters.stalls += 1;
      return "stall";
    }
    if (this.subscriptions.size < this.programs.length && now - this.connectedAtMs > this.subscribeTimeoutMs) {
      this.counters.subscribeTimeouts += 1;
      return "subscribe timeout";
    }
    for (const [subscription, lastMs] of this.subscriptionActivity) {
      if (now - lastMs > this.subscriptionStallMs) {
        this.counters.subscriptionStalls += 1;
        return `subscription stalled: ${this.subscriptions.get(subscription) ?? subscription}`;
      }
    }
    return null;
  }

  private clearConnectionTimers(): void {
    if (this.pingTimer) {
      this.clock.cancel(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.stallTimer) {
      this.clock.cancel(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      this.clock.cancel(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private settleFirst(): void {
    const settle = this.firstSettle;
    this.firstSettle = null;
    settle?.();
  }

  private closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        this.clock.cancel(timer);
        resolve();
      };
      const timer = this.clock.schedule(this.clock.nowMs() + this.closeTimeoutMs, () => {
        socket.terminate();
        finish();
      });
      socket.once("close", finish);
      try {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        } else {
          socket.close(1000, "stopping");
        }
      } catch {
        finish();
      }
    });
  }
}
