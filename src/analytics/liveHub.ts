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
const SHARED_RING = "shared";

export const MAIN_STRATEGY = "main";
export const STRATEGY_NAME_PATTERN = /^[a-z0-9][a-z0-9_@-]{0,63}$/;

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

export interface LiveStrategy {
  name: string;
  bus: Bus;
  config: LiveConfig;
  thresholds: LiveThresholds;
  runId?: number | null;
  label?: string | null;
  draining?: boolean;
  positions?: (() => readonly Position[]) | null;
  tradingActive?: (() => boolean) | null;
  skipReason?: ((signal: Signal) => Promise<string | null>) | null;
}

export interface LiveStrategyInfo {
  name: string;
  runId: number | null;
  label: string | null;
  draining: boolean;
  tradingActive: boolean;
}

export interface LiveHubOptions {
  bus: Bus;
  clock: Clock;
  market: LiveMarket;
  config: LiveConfig;
  thresholds: LiveThresholds;
  positions?: (() => readonly Position[]) | null;
  tradingActive?: (() => boolean) | null;
  skipReason?: ((signal: Signal) => Promise<string | null>) | null;
  runId?: (() => number | null) | null;
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
  strategies: LiveStrategyInfo[];
}

export type LiveStrategyPositionView = LivePositionView & { strategy: string };

export interface LiveHello {
  streamId: string;
  serverTimeMs: number;
  maxClients: number;
  clients: number;
  tradingActive: boolean;
  heartbeatMs: number;
  strategy: string | null;
  strategies: LiveStrategyInfo[];
  positions: LiveStrategyPositionView[];
}

export interface LivePoll {
  hello: LiveHello;
  events: LiveEvent[];
  lastId: number;
}

interface StreamClient {
  res: ServerResponse;
  strategy: string | null;
  congested: boolean;
  congestedSinceMs: number;
  dropped: number;
}

interface StrategySource {
  info: LiveStrategy;
  references: Map<Pubkey, ReferencePrice>;
  reservations: Map<Pubkey, number>;
  skips: Map<Pubkey, number>;
  unsubscribers: Array<() => void>;
}

interface PositionWatch {
  position: Position;
  source: StrategySource;
  lastSentMs: number;
  timer: TimerHandle | null;
}

interface OpenEntry {
  position: Position;
  source: StrategySource;
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

export function strategyMatches(filter: string | null, strategy: string | null): boolean {
  return filter === null || strategy === null || strategy === filter;
}

function ringKey(ringClass: RingClass, strategy: string | null): string {
  return ringClass === "score" || strategy === null ? `${ringClass}:${SHARED_RING}` : `${ringClass}:${strategy}`;
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
  private readonly main: StrategySource;
  private readonly sources = new Map<string, StrategySource>();
  private readonly mainRunId: (() => number | null) | null;
  private readonly maxClients: number;
  private readonly heartbeatMs: number;
  private readonly updateThrottleMs: number;
  private readonly ringSizes: Record<RingClass, number>;
  private readonly maxBufferedBytes: number;
  private readonly skipLookupDelayMs: number;
  private readonly maxCongestedMs: number;
  private readonly rings = new Map<string, LiveEvent[]>();
  private readonly watches = new Map<string, PositionWatch>();
  private readonly byMint = new Map<Pubkey, Set<string>>();
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
    this.mainRunId = options.runId ?? null;
    this.main = this.sourceOf({
      name: MAIN_STRATEGY,
      bus: options.bus,
      config: options.config,
      thresholds: options.thresholds,
      positions: options.positions ?? null,
      tradingActive: options.tradingActive ?? null,
      skipReason: options.skipReason ?? null
    });
    this.sources.set(MAIN_STRATEGY, this.main);
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
    this.unsubscribers = [bus.on("score", (score) => this.onScore(score)), bus.on("chain", (event) => this.onChain(event))];
    for (const source of this.sources.values()) {
      this.subscribe(source);
    }
  }

  addStrategy(strategy: LiveStrategy): () => void {
    if (!STRATEGY_NAME_PATTERN.test(strategy.name) || this.sources.has(strategy.name)) {
      throw new Error(`live strategy name ${JSON.stringify(strategy.name)} is invalid or already in use`);
    }
    const source = this.sourceOf(strategy);
    this.sources.set(strategy.name, source);
    if (this.unsubscribers.length > 0) {
      this.subscribe(source);
    }
    return () => this.removeStrategy(source);
  }

  strategies(): LiveStrategyInfo[] {
    return [...this.sources.values()].map((source) => ({
      name: source.info.name,
      runId: source === this.main ? this.safeMainRunId() : (source.info.runId ?? null),
      label: source.info.label ?? null,
      draining: source.info.draining === true,
      tradingActive: this.isSourceTrading(source)
    }));
  }

  stop(): void {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    for (const source of this.sources.values()) {
      this.unsubscribe(source);
    }
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

  recentEvents(strategy: string | null = null): LiveEvent[] {
    const events: LiveEvent[] = [];
    for (const ring of this.rings.values()) {
      for (const event of ring) {
        if (strategyMatches(strategy, event.strategy)) {
          events.push(event);
        }
      }
    }
    return events.sort((a, b) => a.id - b.id);
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
      openPositions: this.openPositionCount(),
      heartbeatMs: this.heartbeatMs,
      strategies: this.strategies()
    };
  }

  series(positionId: string): PositionSeries | null {
    const entry = this.findOpen(positionId);
    if (!entry) {
      return null;
    }
    const series = positionSeries(entry.position, this.market.get(entry.position.mint), entry.source.info.config, this.clock.nowMs());
    return { ...series, position: { ...series.position, strategy: entry.source.info.name } as LiveStrategyPositionView };
  }

  poll(streamId: string | null, afterId: number, strategy: string | null = null): LivePoll {
    const nowMs = this.clock.nowMs();
    this.syncPositions(nowMs);
    const after = streamId === this.streamId && Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0;
    return {
      hello: this.hello(nowMs, strategy),
      events: this.recentEvents(strategy).filter((event) => event.id > after),
      lastId: this.nextId - 1
    };
  }

  connect(req: IncomingMessage, res: ServerResponse, strategy: string | null = null): void {
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
    const client: StreamClient = { res, strategy, congested: false, congestedSinceMs: 0, dropped: 0 };
    this.clients.add(client);
    res.on("close", () => this.drop(client));
    res.on("error", () => this.drop(client));
    const nowMs = this.clock.nowMs();
    this.syncPositions(nowMs);
    const afterId = this.lastSeenId(headerText(req.headers["last-event-id"]));
    const replay = this.recentEvents(strategy)
      .filter((event) => event.id > afterId)
      .map((event) => this.eventChunk(event))
      .join("");
    this.write(client, `retry: ${RETRY_MS}\n\n${sseChunk("hello", null, this.hello(nowMs, strategy))}${replay}`);
    this.ensureHeartbeat();
  }

  private hello(nowMs: number, strategy: string | null): LiveHello {
    const positions: LiveStrategyPositionView[] = [];
    for (const watch of this.watches.values()) {
      if (strategyMatches(strategy, watch.source.info.name)) {
        positions.push(this.viewOf(this.currentPosition(watch), watch.source, nowMs));
      }
    }
    return {
      streamId: this.streamId,
      serverTimeMs: nowMs,
      maxClients: this.maxClients,
      clients: this.clients.size,
      tradingActive: this.isTrading(),
      heartbeatMs: this.heartbeatMs,
      strategy,
      strategies: this.strategies(),
      positions
    };
  }

  private sourceOf(info: LiveStrategy): StrategySource {
    return { info, references: new Map(), reservations: new Map(), skips: new Map(), unsubscribers: [] };
  }

  private subscribe(source: StrategySource): void {
    if (source.unsubscribers.length > 0) {
      return;
    }
    const bus = source.info.bus;
    source.unsubscribers = [
      bus.on("signal", (signal) => this.onSignal(source, signal)),
      bus.on("signalRejected", (rejection) => this.onRejected(source, rejection)),
      bus.on("signalSkipped", (skip) => this.onSkipped(source, skip)),
      bus.on("risk", (event) => this.onRisk(source, event)),
      bus.on("positionOpened", (position) => this.onOpened(source, position)),
      bus.on("positionUpdated", (position) => this.onUpdated(source, position)),
      bus.on("positionClosed", (position) => this.onClosed(source, position))
    ];
  }

  private unsubscribe(source: StrategySource): void {
    for (const unsubscribe of source.unsubscribers) {
      unsubscribe();
    }
    source.unsubscribers = [];
  }

  private removeStrategy(source: StrategySource): void {
    if (source === this.main || this.sources.get(source.info.name) !== source) {
      return;
    }
    this.unsubscribe(source);
    this.sources.delete(source.info.name);
    for (const [id, watch] of [...this.watches]) {
      if (watch.source === source) {
        this.unwatch(id);
      }
    }
  }

  private safeMainRunId(): number | null {
    try {
      return this.mainRunId?.() ?? null;
    } catch {
      return null;
    }
  }

  private lastSeenId(header: string | null): number {
    if (!header) {
      return 0;
    }
    const [stream, id] = header.split(":");
    const parsed = Number(id);
    return stream === this.streamId && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  private isSourceTrading(source: StrategySource): boolean {
    try {
      return source.info.tradingActive?.() ?? false;
    } catch {
      return false;
    }
  }

  private isTrading(): boolean {
    for (const source of this.sources.values()) {
      if (this.isSourceTrading(source)) {
        return true;
      }
    }
    return false;
  }

  private eventChunk(event: LiveEvent): string {
    return sseChunk(null, `${this.streamId}:${event.id}`, event);
  }

  private publish(draft: LiveEventDraft, strategy: string | null): LiveEvent {
    const event: LiveEvent = { id: this.nextId, strategy, ...draft };
    this.nextId += 1;
    this.lastEventAtMs = this.clock.nowMs();
    if (event.kind !== "position") {
      const ringClass = ringClassOf(event.kind);
      const key = ringKey(ringClass, strategy);
      let ring = this.rings.get(key);
      if (!ring) {
        ring = [];
        this.rings.set(key, ring);
      }
      ring.push(event);
      if (ring.length > this.ringSizes[ringClass]) {
        ring.splice(0, ring.length - this.ringSizes[ringClass]);
      }
    }
    if (this.clients.size > 0) {
      let chunk: string | null = null;
      for (const client of [...this.clients]) {
        if (strategyMatches(client.strategy, strategy)) {
          chunk ??= this.eventChunk(event);
          this.write(client, chunk);
        }
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
    this.syncPositions(nowMs);
    const chunk = sseChunk("heartbeat", null, { atMs: nowMs, clients: this.clients.size, tradingActive: this.isTrading() });
    for (const client of [...this.clients]) {
      this.write(client, chunk);
    }
    this.ensureHeartbeat();
  }

  private symbolOf(mint: Pubkey): string | null {
    return cleanSymbol(this.market.get(mint)?.info.symbol);
  }

  private sourcePositions(source: StrategySource): Position[] {
    const positions = source.info.positions;
    if (!positions) {
      return [];
    }
    try {
      return positions().filter((position) => position.shadowOf === null && position.status === "open");
    } catch (error) {
      log.warn({ err: error, strategy: source.info.name }, "open positions lookup failed");
      return [];
    }
  }

  private openPositionCount(): number {
    let count = 0;
    for (const source of this.sources.values()) {
      if (source.info.positions) {
        count += this.sourcePositions(source).length;
        continue;
      }
      for (const watch of this.watches.values()) {
        if (watch.source === source) {
          count += 1;
        }
      }
    }
    return count;
  }

  private findOpen(positionId: string): OpenEntry | null {
    const watch = this.watches.get(positionId);
    const sources = watch ? [watch.source] : [...this.sources.values()];
    for (const source of sources) {
      if (!source.info.positions) {
        if (watch && watch.source === source) {
          return { position: watch.position, source };
        }
        continue;
      }
      const position = this.sourcePositions(source).find((candidate) => candidate.id === positionId);
      if (position) {
        return { position, source };
      }
    }
    return null;
  }

  private currentPosition(watch: PositionWatch): Position {
    if (watch.source.info.positions) {
      const current = this.sourcePositions(watch.source).find((position) => position.id === watch.position.id);
      if (current) {
        watch.position = current;
      }
    }
    return watch.position;
  }

  private viewOf(position: Position, source: StrategySource, nowMs: number): LiveStrategyPositionView {
    return { ...livePositionView(position, this.market.get(position.mint), source.info.config, nowMs), strategy: source.info.name };
  }

  private syncPositions(nowMs: number): void {
    this.lastSyncMs = nowMs;
    const seen = new Set<string>();
    const synced = new Set<StrategySource>();
    for (const source of this.sources.values()) {
      if (!source.info.positions) {
        continue;
      }
      synced.add(source);
      for (const position of this.sourcePositions(source)) {
        seen.add(position.id);
        const watch = this.watches.get(position.id);
        if (watch) {
          watch.position = position;
        } else {
          this.watch(position, source);
        }
      }
    }
    for (const [id, watch] of [...this.watches]) {
      if (synced.has(watch.source) && !seen.has(id)) {
        this.unwatch(id);
      }
    }
  }

  private maybeSync(): void {
    const nowMs = this.clock.nowMs();
    if (nowMs - this.lastSyncMs >= POSITION_SYNC_MS) {
      this.syncPositions(nowMs);
    }
  }

  private watch(position: Position, source: StrategySource): PositionWatch {
    const existing = this.watches.get(position.id);
    if (existing) {
      existing.position = position;
      return existing;
    }
    const watch: PositionWatch = { position, source, lastSentMs: Number.NEGATIVE_INFINITY, timer: null };
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
      this.publish(positionEvent(this.viewOf(this.currentPosition(watch), watch.source, nowMs), nowMs), watch.source.info.name);
    } catch (error) {
      log.warn({ err: error, positionId: watch.position.id }, "live position update failed");
    }
  }

  private pruneMaps(source: StrategySource, nowMs: number): void {
    for (const [mint, reference] of source.references) {
      if (nowMs - reference.atMs > REFERENCE_TTL_MS || source.references.size > MAX_TRACKED_MINTS) {
        source.references.delete(mint);
      }
    }
    for (const decisions of [source.reservations, source.skips]) {
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
    this.publish(scoreEvent(score, this.symbolOf(score.mint), this.main.info.thresholds), null);
  }

  private onSignal(source: StrategySource, signal: Signal): void {
    const nowMs = this.clock.nowMs();
    this.pruneMaps(source, nowMs);
    const price = this.market.get(signal.mint)?.price() ?? 0;
    if (isUsablePrice(price)) {
      source.references.set(signal.mint, { price, atMs: nowMs });
    }
    this.publish(signalEvent(signal, this.symbolOf(signal.mint)), source.info.name);
    if (this.isSourceTrading(source)) {
      queueMicrotask(() => this.checkEntered(source, signal, nowMs));
    }
  }

  private decided(source: StrategySource, mint: Pubkey, seenAtMs: number): boolean {
    const reservedAtMs = source.reservations.get(mint);
    const skippedAtMs = source.skips.get(mint);
    return (
      (reservedAtMs !== undefined && reservedAtMs >= seenAtMs - RESERVATION_MATCH_MS) ||
      (skippedAtMs !== undefined && skippedAtMs >= seenAtMs - RESERVATION_MATCH_MS)
    );
  }

  private isAttached(source: StrategySource): boolean {
    return !this.stopped && this.sources.get(source.info.name) === source;
  }

  private checkEntered(source: StrategySource, signal: Signal, seenAtMs: number): void {
    if (!this.isAttached(source) || this.decided(source, signal.mint, seenAtMs)) {
      return;
    }
    const lookup = source.info.skipReason ?? null;
    if (!lookup) {
      this.publish(skippedEvent(signal, null, this.symbolOf(signal.mint), this.clock.nowMs()), source.info.name);
      return;
    }
    const handle = this.clock.schedule(this.clock.nowMs() + this.skipLookupDelayMs, () => {
      this.lookups.delete(handle);
      if (!this.isAttached(source) || this.decided(source, signal.mint, seenAtMs)) {
        return undefined;
      }
      return lookup(signal)
        .catch(() => null)
        .then((reason) => {
          if (this.isAttached(source) && !this.decided(source, signal.mint, seenAtMs)) {
            this.publish(skippedEvent(signal, reason, this.symbolOf(signal.mint), this.clock.nowMs()), source.info.name);
          }
        });
    });
    this.lookups.add(handle);
  }

  private onSkipped(source: StrategySource, skip: SignalRejection): void {
    const nowMs = this.clock.nowMs();
    source.skips.set(skip.signal.mint, nowMs);
    this.publish(skippedEvent(skip.signal, skip.reason, this.symbolOf(skip.signal.mint), nowMs), source.info.name);
  }

  private onRejected(source: StrategySource, rejection: SignalRejection): void {
    this.publish(rejectedEvent(rejection, this.symbolOf(rejection.signal.mint), source.info.thresholds, this.clock.nowMs()), source.info.name);
  }

  private onRisk(source: StrategySource, event: RiskEvent): void {
    if (event.kind === "entry_reserved") {
      const mint = typeof event.detail.mint === "string" ? event.detail.mint : null;
      if (mint) {
        source.reservations.set(mint, this.clock.nowMs());
        this.publish(enteringEvent(event, mint, this.symbolOf(mint)), source.info.name);
      }
      return;
    }
    const draft = riskEventDraft(event);
    if (draft) {
      this.publish(draft, source.info.name);
    }
  }

  private onOpened(source: StrategySource, position: Position): void {
    if (position.shadowOf !== null) {
      return;
    }
    const launch = this.market.get(position.mint);
    const reference = source.references.get(position.mint) ?? null;
    source.references.delete(position.mint);
    this.publish(
      openedEvent(position, {
        symbol: this.symbolOf(position.mint),
        entryMcapMultiple: launch && launch.isSolQuoted ? launch.mcapMultiple() : null,
        referencePrice: reference?.price ?? null,
        signalAtMs: signalTimeOf(position) ?? reference?.atMs ?? null
      }),
      source.info.name
    );
    if (position.status === "open") {
      this.watch(position, source);
      this.touch(position.id);
    }
  }

  private onUpdated(source: StrategySource, position: Position): void {
    if (position.shadowOf !== null) {
      return;
    }
    const watch = this.watches.get(position.id);
    if (watch) {
      const price = this.market.get(position.mint)?.price() ?? 0;
      const reason = readExitState(position).liquidating?.reason ?? null;
      const draft = partialEvent(watch.position, position, this.symbolOf(position.mint), isUsablePrice(price) ? price : null, reason, this.clock.nowMs());
      if (draft) {
        this.publish(draft, source.info.name);
      }
    }
    this.watch(position, source);
    this.touch(position.id);
  }

  private onClosed(source: StrategySource, position: Position): void {
    if (position.shadowOf !== null) {
      return;
    }
    this.unwatch(position.id);
    this.publish(closedEvent(position, this.symbolOf(position.mint)), source.info.name);
  }
}
