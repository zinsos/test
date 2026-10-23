import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Bus, RiskEvent, SignalRejection } from "../core/bus.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { ChainEvent, LaunchScore, Position, Pubkey, Signal } from "../core/types.js";
import { isUsablePrice } from "../exits/math.js";
import { readExitState } from "../exits/state.js";
import { sendJson, toJson } from "./http.js";
import {
  closedEvent,
  enteringEvent,
  openedEvent,
  partialEvent,
  positionEvent,
  rejectedEvent,
  riskEventDraft,
  scoreEvent,
  signalEvent,
  signalTimeOf,
  skippedEvent,
  type LiveEvent,
  type LiveEventDraft,
  type LiveKind,
  type LiveThresholds
} from "./liveEvents.js";
import { cleanSymbol, livePositionView, positionSeries, type LiveConfig, type LiveMarket, type LivePositionView, type PositionSeries } from "./liveSeries.js";

export const DEFAULT_LIVE_MAX_CLIENTS = 10;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_UPDATE_THROTTLE_MS = 2_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;
export const DEFAULT_SKIP_LOOKUP_DELAY_MS = 2_500;
export const DEFAULT_MAX_CONGESTED_MS = 30_000;
export const DEFAULT_RING_SIZES: Readonly<Record<RingClass, number>> = { trade: 150, rejected: 75, score: 75 };
const RETRY_MS = 3_000;
const RESERVATION_MATCH_MS = 5_000;
const POSITION_SYNC_MS = 15_000;
const REFERENCE_TTL_MS = 10 * 60_000;
const MAX_TRACKED_MINTS = 256;

export type RingClass = "trade" | "rejected" | "score";

const log = moduleLogger("analytics.live");

const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  Connection: "keep-alive"
};

export interface LiveHubOptions {
  bus: Bus;
  clock: Clock;
  market: LiveMarket;
  config: LiveConfig;
  thresholds: LiveThresholds;
  positions?: (() => readonly Position[]) | null;
  tradingActive?: (() => boolean) | null;
  skipReason?: ((signal: Signal) => Promise<string | null>) | null;
  maxClients?: number;
  heartbeatMs?: number;
  updateThrottleMs?: number;
  ringSizes?: Partial<Record<RingClass, number>>;
  maxBufferedBytes?: number;
  skipLookupDelayMs?: number;
  maxCongestedMs?: number;
}

export interface LiveStatus {
  enabled: boolean;
  streamId: string | null;
  clients: number;
  maxClients: number;
  tradingActive: boolean;
  events: number;
  lastEventAtMs: number | null;
  openPositions: number;
  heartbeatMs: number;
}

export interface LiveHello {
  streamId: string;
  serverTimeMs: number;
  maxClients: number;
  clients: number;
  tradingActive: boolean;
  heartbeatMs: number;
  positions: LivePositionView[];
}

export interface LivePoll {
  hello: LiveHello;
  events: LiveEvent[];
  lastId: number;
}

interface StreamClient {
  res: ServerResponse;
  congested: boolean;
  congestedSinceMs: number;
  dropped: number;
}

interface PositionWatch {
  position: Position;
  lastSentMs: number;
  timer: TimerHandle | null;
}

interface ReferencePrice {
  price: number;
  atMs: number;
}

export function sseChunk(event: string | null, id: string | null, data: unknown): string {
  return `${id === null ? "" : `id: ${id}\n`}${event === null ? "" : `event: ${event}\n`}data: ${toJson(data)}\n\n`;
}

export function ringClassOf(kind: LiveKind): RingClass {
  if (kind === "score") {
    return "score";
  }
  return kind === "rejected" ? "rejected" : "trade";
}

function headerText(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}

export class LiveHub {
  readonly streamId: string;
  private readonly bus: Bus;
  private readonly clock: Clock;
  private readonly market: LiveMarket;
  private readonly config: LiveConfig;
  private readonly thresholds: LiveThresholds;
  private readonly positions: (() => readonly Position[]) | null;
  private readonly tradingActive: (() => boolean) | null;
  private readonly skipReason: ((signal: Signal) => Promise<string | null>) | null;
  private readonly maxClients: number;
  private readonly heartbeatMs: number;
  private readonly updateThrottleMs: number;
  private readonly ringSizes: Record<RingClass, number>;
  private readonly maxBufferedBytes: number;
  private readonly skipLookupDelayMs: number;
  private readonly maxCongestedMs: number;
  private readonly rings: Record<RingClass, LiveEvent[]> = { trade: [], rejected: [], score: [] };
  private readonly watches = new Map<string, PositionWatch>();
  private readonly byMint = new Map<Pubkey, Set<string>>();
  private readonly references = new Map<Pubkey, ReferencePrice>();
  private readonly reservations = new Map<Pubkey, number>();
  private readonly skips = new Map<Pubkey, number>();
  private readonly clients = new Set<StreamClient>();
  private readonly lookups = new Set<TimerHandle>();
  private unsubscribers: Array<() => void> = [];
  private heartbeat: TimerHandle | null = null;
  private nextId = 1;
  private lastEventAtMs: number | null = null;
  private lastSyncMs = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(options: LiveHubOptions) {
    this.bus = options.bus;
    this.clock = options.clock;
    this.market = options.market;
    this.config = options.config;
    this.thresholds = options.thresholds;
    this.positions = options.positions ?? null;
    this.tradingActive = options.tradingActive ?? null;
    this.skipReason = options.skipReason ?? null;
    this.maxClients = options.maxClients ?? DEFAULT_LIVE_MAX_CLIENTS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.updateThrottleMs = options.updateThrottleMs ?? DEFAULT_UPDATE_THROTTLE_MS;
    this.ringSizes = { ...DEFAULT_RING_SIZES, ...options.ringSizes };
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.skipLookupDelayMs = options.skipLookupDelayMs ?? DEFAULT_SKIP_LOOKUP_DELAY_MS;
    this.maxCongestedMs = options.maxCongestedMs ?? DEFAULT_MAX_CONGESTED_MS;
    this.streamId = randomBytes(6).toString("hex");
  }

  start(): void {
    if (this.unsubscribers.length > 0 || this.stopped) {
      return;
    }
    const bus = this.bus;
    this.unsubscribers = [
      bus.on("score", (score) => this.onScore(score)),
      bus.on("signal", (signal) => this.onSignal(signal)),
      bus.on("signalRejected", (rejection) => this.onRejected(rejection)),
      bus.on("signalSkipped", (skip) => this.onSkipped(skip)),
      bus.on("risk", (event) => this.onRisk(event)),
      bus.on("positionOpened", (position) => this.onOpened(position)),
      bus.on("positionUpdated", (position) => this.onUpdated(position)),
      bus.on("positionClosed", (position) => this.onClosed(position)),
      bus.on("chain", (event) => this.onChain(event))
    ];
  }

  stop(): void {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.disconnectAll();
    for (const watch of this.watches.values()) {
      if (watch.timer) {
        this.clock.cancel(watch.timer);
      }
    }
    this.watches.clear();
    this.byMint.clear();
    for (const handle of this.lookups) {
      this.clock.cancel(handle);
    }
    this.lookups.clear();
  }

  disconnectAll(): void {
    for (const client of [...this.clients]) {
      client.res.end();
      this.drop(client);
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  recentEvents(): LiveEvent[] {
    return [...this.rings.trade, ...this.rings.rejected, ...this.rings.score].sort((a, b) => a.id - b.id);
  }

  status(): LiveStatus {
    return {
      enabled: true,
      streamId: this.streamId,
      clients: this.clients.size,
      maxClients: this.maxClients,
      tradingActive: this.isTrading(),
      events: this.nextId - 1,
      lastEventAtMs: this.lastEventAtMs,
      openPositions: this.positions ? this.openPrimaryPositions().length : this.watches.size,
      heartbeatMs: this.heartbeatMs
    };
  }

  series(positionId: string): PositionSeries | null {
    const position = this.findOpen(positionId);
    if (!position) {
      return null;
    }
    return positionSeries(position, this.market.get(position.mint), this.config, this.clock.nowMs());
  }

  poll(streamId: string | null, afterId: number): LivePoll {
    const nowMs = this.clock.nowMs();
    if (this.positions) {
      this.syncPositions(nowMs);
    }
    const after = streamId === this.streamId && Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0;
    return {
      hello: this.hello(nowMs),
      events: this.recentEvents().filter((event) => event.id > after),
      lastId: this.nextId - 1
    };
  }

  connect(req: IncomingMessage, res: ServerResponse): void {
    if (this.stopped) {
      sendJson(res, 503, { error: "live_stopped", message: "the live stream is shutting down" }, { "Retry-After": "15" });
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, SSE_HEADERS);
      res.end();
      return;
    }
    if (this.clients.size >= this.maxClients) {
      sendJson(res, 503, { error: "too_many_streams", message: `at most ${this.maxClients} live streams at once` }, { "Retry-After": "15" });
      return;
    }
    res.writeHead(200, SSE_HEADERS);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    const client: StreamClient = { res, congested: false, congestedSinceMs: 0, dropped: 0 };
    this.clients.add(client);
    res.on("close", () => this.drop(client));
    res.on("error", () => this.drop(client));
    const nowMs = this.clock.nowMs();
    if (this.positions) {
      this.syncPositions(nowMs);
    }
    const afterId = this.lastSeenId(headerText(req.headers["last-event-id"]));
    const replay = this.recentEvents()
      .filter((event) => event.id > afterId)
      .map((event) => this.eventChunk(event))
      .join("");
    this.write(client, `retry: ${RETRY_MS}\n\n${sseChunk("hello", null, this.hello(nowMs))}${replay}`);
    this.ensureHeartbeat();
  }

  private hello(nowMs: number): LiveHello {
    return {
      streamId: this.streamId,
      serverTimeMs: nowMs,
      maxClients: this.maxClients,
      clients: this.clients.size,
      tradingActive: this.isTrading(),
      heartbeatMs: this.heartbeatMs,
      positions: [...this.watches.values()].map((watch) => this.viewOf(this.currentPosition(watch), nowMs))
    };
  }

  private lastSeenId(header: string | null): number {
    if (!header) {
      return 0;
    }
    const [stream, id] = header.split(":");
    const parsed = Number(id);
    return stream === this.streamId && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  private isTrading(): boolean {
    try {
      return this.tradingActive?.() ?? false;
    } catch {
      return false;
    }
  }

  private eventChunk(event: LiveEvent): string {
    return sseChunk(null, `${this.streamId}:${event.id}`, event);
  }

  private publish(draft: LiveEventDraft): LiveEvent {
    const event: LiveEvent = { id: this.nextId, ...draft };
    this.nextId += 1;
    this.lastEventAtMs = this.clock.nowMs();
    if (event.kind !== "position") {
      const ringClass = ringClassOf(event.kind);
      const ring = this.rings[ringClass];
      ring.push(event);
      if (ring.length > this.ringSizes[ringClass]) {
        ring.splice(0, ring.length - this.ringSizes[ringClass]);
      }
    }
    if (this.clients.size > 0) {
      const chunk = this.eventChunk(event);
      for (const client of [...this.clients]) {
        this.write(client, chunk);
      }
    }
    return event;
  }

  private write(client: StreamClient, chunk: string): void {
    const res = client.res;
    if (res.destroyed || res.writableEnded) {
      this.drop(client);
      return;
    }
    if (client.congested) {
      if (this.clock.nowMs() - client.congestedSinceMs > this.maxCongestedMs) {
        log.warn({ dropped: client.dropped }, "live stream client stuck, disconnecting");
        res.destroy();
        this.drop(client);
        return;
      }
      client.dropped += 1;
      return;
    }
    if (res.writableLength > this.maxBufferedBytes) {
      log.warn({ buffered: res.writableLength }, "live stream client too slow, disconnecting");
      res.destroy();
      this.drop(client);
      return;
    }
    if (!res.write(chunk)) {
      client.congested = true;
      client.congestedSinceMs = this.clock.nowMs();
      res.once("drain", () => this.onDrain(client));
    }
  }

  private onDrain(client: StreamClient): void {
    client.congested = false;
    if (client.dropped > 0 && this.clients.has(client)) {
      const dropped = client.dropped;
      client.dropped = 0;
      this.write(client, sseChunk("gap", null, { dropped }));
    }
  }

  private drop(client: StreamClient): void {
    if (!this.clients.delete(client)) {
      return;
    }
    if (this.clients.size === 0 && this.heartbeat) {
      this.clock.cancel(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat || this.clients.size === 0 || this.stopped) {
      return;
    }
    this.heartbeat = this.clock.schedule(this.clock.nowMs() + this.heartbeatMs, () => this.beat());
  }

  private beat(): void {
    this.heartbeat = null;
    if (this.clients.size === 0 || this.stopped) {
      return;
    }
    const nowMs = this.clock.nowMs();
    if (this.positions) {
      this.syncPositions(nowMs);
    }
    const chunk = sseChunk("heartbeat", null, { atMs: nowMs, clients: this.clients.size, tradingActive: this.isTrading() });
    for (const client of [...this.clients]) {
      this.write(client, chunk);
    }
    this.ensureHeartbeat();
  }

  private symbolOf(mint: Pubkey): string | null {
    return cleanSymbol(this.market.get(mint)?.info.symbol);
  }

  private openPrimaryPositions(): Position[] {
    if (!this.positions) {
      return [];
    }
    try {
      return this.positions().filter((position) => position.shadowOf === null && position.status === "open");
    } catch (error) {
      log.warn({ err: error }, "open positions lookup failed");
      return [];
    }
  }

  private findOpen(positionId: string): Position | null {
    if (this.positions) {
      return this.openPrimaryPositions().find((position) => position.id === positionId) ?? null;
    }
    return this.watches.get(positionId)?.position ?? null;
  }

  private currentPosition(watch: PositionWatch): Position {
    if (this.positions) {
      const current = this.openPrimaryPositions().find((position) => position.id === watch.position.id);
      if (current) {
        watch.position = current;
      }
    }
    return watch.position;
  }

  private viewOf(position: Position, nowMs: number): LivePositionView {
    return livePositionView(position, this.market.get(position.mint), this.config, nowMs);
  }

  private syncPositions(nowMs: number): void {
    this.lastSyncMs = nowMs;
    const open = this.openPrimaryPositions();
    const seen = new Set<string>();
    for (const position of open) {
      seen.add(position.id);
      const watch = this.watches.get(position.id);
      if (watch) {
        watch.position = position;
      } else {
        this.watch(position);
      }
    }
    for (const id of [...this.watches.keys()]) {
      if (!seen.has(id)) {
        this.unwatch(id);
      }
    }
  }

  private maybeSync(): void {
    if (!this.positions) {
      return;
    }
    const nowMs = this.clock.nowMs();
    if (nowMs - this.lastSyncMs >= POSITION_SYNC_MS) {
      this.syncPositions(nowMs);
    }
  }

  private watch(position: Position): PositionWatch {
    const existing = this.watches.get(position.id);
    if (existing) {
      existing.position = position;
      return existing;
    }
    const watch: PositionWatch = { position, lastSentMs: Number.NEGATIVE_INFINITY, timer: null };
    this.watches.set(position.id, watch);
    let ids = this.byMint.get(position.mint);
    if (!ids) {
      ids = new Set();
      this.byMint.set(position.mint, ids);
    }
    ids.add(position.id);
    return watch;
  }

  private unwatch(positionId: string): void {
    const watch = this.watches.get(positionId);
    if (!watch) {
      return;
    }
    if (watch.timer) {
      this.clock.cancel(watch.timer);
    }
    this.watches.delete(positionId);
    const ids = this.byMint.get(watch.position.mint);
    ids?.delete(positionId);
    if (ids && ids.size === 0) {
      this.byMint.delete(watch.position.mint);
    }
  }

  private touch(positionId: string): void {
    const watch = this.watches.get(positionId);
    if (!watch) {
      return;
    }
    const nowMs = this.clock.nowMs();
    const dueMs = watch.lastSentMs + this.updateThrottleMs;
    if (nowMs >= dueMs) {
      this.sendPosition(watch, nowMs);
      return;
    }
    if (!watch.timer) {
      watch.timer = this.clock.schedule(dueMs, () => {
        watch.timer = null;
        if (this.watches.get(positionId) === watch) {
          this.sendPosition(watch, this.clock.nowMs());
        }
      });
    }
  }

  private sendPosition(watch: PositionWatch, nowMs: number): void {
    watch.lastSentMs = nowMs;
    try {
      this.publish(positionEvent(this.viewOf(this.currentPosition(watch), nowMs), nowMs));
    } catch (error) {
      log.warn({ err: error, positionId: watch.position.id }, "live position update failed");
    }
  }

  private pruneMaps(nowMs: number): void {
    for (const [mint, reference] of this.references) {
      if (nowMs - reference.atMs > REFERENCE_TTL_MS || this.references.size > MAX_TRACKED_MINTS) {
        this.references.delete(mint);
      }
    }
    for (const decisions of [this.reservations, this.skips]) {
      for (const [mint, atMs] of decisions) {
        if (nowMs - atMs > REFERENCE_TTL_MS || decisions.size > MAX_TRACKED_MINTS) {
          decisions.delete(mint);
        }
      }
    }
  }

  private onChain(event: ChainEvent): void {
    if (event.kind !== "create") {
      const ids = this.byMint.get(event.mint);
      if (ids) {
        for (const id of [...ids]) {
          this.touch(id);
        }
      }
    }
    this.maybeSync();
  }

  private onScore(score: LaunchScore): void {
    this.publish(scoreEvent(score, this.symbolOf(score.mint), this.thresholds));
  }

  private onSignal(signal: Signal): void {
    const nowMs = this.clock.nowMs();
    this.pruneMaps(nowMs);
    const price = this.market.get(signal.mint)?.price() ?? 0;
    if (isUsablePrice(price)) {
      this.references.set(signal.mint, { price, atMs: nowMs });
    }
    this.publish(signalEvent(signal, this.symbolOf(signal.mint)));
    if (this.isTrading()) {
      queueMicrotask(() => this.checkEntered(signal, nowMs));
    }
  }

  private decided(mint: Pubkey, seenAtMs: number): boolean {
    const reservedAtMs = this.reservations.get(mint);
    const skippedAtMs = this.skips.get(mint);
    return (
      (reservedAtMs !== undefined && reservedAtMs >= seenAtMs - RESERVATION_MATCH_MS) ||
      (skippedAtMs !== undefined && skippedAtMs >= seenAtMs - RESERVATION_MATCH_MS)
    );
  }

  private checkEntered(signal: Signal, seenAtMs: number): void {
    if (this.stopped || this.decided(signal.mint, seenAtMs)) {
      return;
    }
    const lookup = this.skipReason;
    if (!lookup) {
      this.publish(skippedEvent(signal, null, this.symbolOf(signal.mint), this.clock.nowMs()));
      return;
    }
    const handle = this.clock.schedule(this.clock.nowMs() + this.skipLookupDelayMs, () => {
      this.lookups.delete(handle);
      if (this.stopped || this.decided(signal.mint, seenAtMs)) {
        return undefined;
      }
      return lookup(signal)
        .catch(() => null)
        .then((reason) => {
          if (!this.stopped && !this.decided(signal.mint, seenAtMs)) {
            this.publish(skippedEvent(signal, reason, this.symbolOf(signal.mint), this.clock.nowMs()));
          }
        });
    });
    this.lookups.add(handle);
  }

  private onSkipped(skip: SignalRejection): void {
    const nowMs = this.clock.nowMs();
    this.skips.set(skip.signal.mint, nowMs);
    this.publish(skippedEvent(skip.signal, skip.reason, this.symbolOf(skip.signal.mint), nowMs));
  }

  private onRejected(rejection: SignalRejection): void {
    this.publish(rejectedEvent(rejection, this.symbolOf(rejection.signal.mint), this.thresholds, this.clock.nowMs()));
  }

  private onRisk(event: RiskEvent): void {
    if (event.kind === "entry_reserved") {
      const mint = typeof event.detail.mint === "string" ? event.detail.mint : null;
      if (mint) {
        this.reservations.set(mint, this.clock.nowMs());
        this.publish(enteringEvent(event, mint, this.symbolOf(mint)));
      }
      return;
    }
    const draft = riskEventDraft(event);
    if (draft) {
      this.publish(draft);
    }
  }

  private onOpened(position: Position): void {
    if (position.shadowOf !== null) {
      return;
    }
    const launch = this.market.get(position.mint);
    const reference = this.references.get(position.mint) ?? null;
    this.references.delete(position.mint);
    this.publish(
      openedEvent(position, {
        symbol: this.symbolOf(position.mint),
        entryMcapMultiple: launch && launch.isSolQuoted ? launch.mcapMultiple() : null,
        referencePrice: reference?.price ?? null,
        signalAtMs: signalTimeOf(position) ?? reference?.atMs ?? null
      })
    );
    if (position.status === "open") {
      this.watch(position);
      this.touch(position.id);
    }
  }

  private onUpdated(position: Position): void {
    if (position.shadowOf !== null) {
      return;
    }
    const watch = this.watches.get(position.id);
    if (watch) {
      const price = this.market.get(position.mint)?.price() ?? 0;
      const reason = readExitState(position).liquidating?.reason ?? null;
      const draft = partialEvent(watch.position, position, this.symbolOf(position.mint), isUsablePrice(price) ? price : null, reason, this.clock.nowMs());
      if (draft) {
        this.publish(draft);
      }
    }
    this.watch(position);
    this.touch(position.id);
  }

  private onClosed(position: Position): void {
    if (position.shadowOf !== null) {
      return;
    }
    this.unwatch(position.id);
    this.publish(closedEvent(position, this.symbolOf(position.mint)));
  }
}
