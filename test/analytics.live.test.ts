import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { thresholdsOf } from "../src/analytics/liveEvents.js";
import { LiveHub, type LiveHubOptions } from "../src/analytics/liveHub.js";
import { downsamplePoints, exitLevels, livePositionView } from "../src/analytics/liveSeries.js";
import { estimatedCloseProceeds, sellFeeBpsFor, sellFeeDefaultsOf } from "../src/analytics/positionQueries.js";
import { lamportsToSol } from "../src/analytics/units.js";
import { startAnalyticsServer, type AnalyticsServer } from "../src/analytics/server.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { ChainEvent, LaunchScore, Position, Signal, TradeEvent } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import { serializeExitState } from "../src/exits/state.js";
import { MarketState } from "../src/market/state.js";
import { TrackedWalletRegistry } from "../src/tracker/registry.js";
import { SignalEngine } from "../src/tracker/signals.js";
import { mintAt } from "./analytics.db.js";
import { openStream, parseSse, type SseMessage } from "./analytics.sse.js";
import { createEvent } from "./exits.fixtures.js";

const TOKEN = "live-stream-test-token-0123456789";
const T0 = 1_800_000_000_000;
const MINT = mintAt(21);
const OTHER_MINT = mintAt(22);
const INITIAL_TOKENS = 1_073_000_000_000_000n;
const INITIAL_QUOTE = 30_000_000_000;
const INITIAL_PRICE = INITIAL_QUOTE / Number(INITIAL_TOKENS);
const POSITION_ID = `7-${T0 - 1_100}-${MINT}`;
const ENTRY_PRICE = INITIAL_PRICE * 2.1 * 1.018;
const ENTRY_TOKENS = BigInt(Math.floor(75_000_000 / ENTRY_PRICE));
const config = defaultStrategyConfig();

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  chunks: string[] = [];
  accept = true;
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  headersSent = false;

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.accept;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.chunks.push(chunk);
    }
    this.writableEnded = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }

  messages(): SseMessage[] {
    return parseSse(this.chunks.join(""));
  }

  events(): Array<Record<string, unknown>> {
    return this.messages()
      .filter((message) => message.event === "message")
      .map((message) => message.data);
  }
}

function fakeRequest(headers: Record<string, string> = {}): IncomingMessage {
  return { method: "GET", headers, socket: { setNoDelay: () => undefined, setKeepAlive: () => undefined } } as unknown as IncomingMessage;
}

function connectFake(hub: LiveHub, headers: Record<string, string> = {}): FakeResponse {
  const res = new FakeResponse();
  hub.connect(fakeRequest(headers), res as unknown as ServerResponse);
  return res;
}

let tradeSeq = 0;

function tradeAt(mint: string, multipleOfInitial: number, atMs: number, slot: number): TradeEvent {
  tradeSeq += 1;
  return {
    kind: "trade",
    tx: { signature: `live-trade-${tradeSeq}`, slot, seq: tradeSeq, eventIndex: 0, receivedAtMs: atMs },
    venue: "curve",
    mint,
    pool: null,
    wallet: `Wallet${tradeSeq % 7}`,
    isBuy: true,
    tokenAmount: 1_000_000_000n,
    quoteAmount: 10_000_000n,
    userQuote: 10_125_000n,
    protocolFee: 95_000n,
    creatorFee: 30_000n,
    lpFee: 0n,
    protocolFeeBps: 95,
    creatorFeeBps: 30,
    lpFeeBps: 0,
    virtualTokenReserves: INITIAL_TOKENS,
    virtualQuoteReserves: BigInt(Math.round(INITIAL_QUOTE * multipleOfInitial)),
    realTokenReserves: 700_000_000_000_000n,
    realQuoteReserves: 5_000_000_000n,
    timestampMs: atMs,
    ixName: "buy"
  };
}

function position(overrides: Partial<Position> = {}): Position {
  const entryPrice = ENTRY_PRICE;
  return {
    id: POSITION_ID,
    runId: 7,
    mode: "paper",
    mint: MINT,
    launchId: 1,
    signalId: null,
    signalType: "score_momentum",
    riskScore: 18,
    openedAtMs: T0,
    openedSlot: 1_000,
    entryPrice,
    entryTokens: ENTRY_TOKENS,
    entryCost: 75_000_000n,
    tokensHeld: ENTRY_TOKENS,
    proceeds: 0n,
    feesPaid: 1_300_000n,
    peakPrice: entryPrice,
    lastPrice: entryPrice,
    takeProfitLevelsHit: 0,
    migratedSeen: false,
    status: "open",
    closedAtMs: null,
    exitReason: null,
    shadowOf: null,
    meta: { signal: { type: "score_momentum", atMs: T0 - 1_100, slot: 999, wallets: 0, riskScore: 18 } },
    ...overrides
  };
}

function score(overrides: Partial<LaunchScore> = {}): LaunchScore {
  return {
    mint: MINT,
    launchId: 1,
    checkpointSec: 60,
    computedAtMs: T0,
    slot: 10,
    score: 18.2,
    hardBlocked: false,
    flags: [],
    features: { unique_buyers_per_min: 30, buy_sell_count_ratio: 3 },
    contributions: { dev_share: 4, bundle_share: 9, fresh_wallets: 1, tiny: 0.5 },
    weightsVersion: "w1",
    ...overrides
  };
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: null,
    type: "score_momentum",
    mint: MINT,
    atMs: T0 - 1_100,
    slot: 999,
    riskScore: 18,
    wallets: [],
    meta: { mcapSol: 42.4, launchAgeSec: 60 },
    ...overrides
  };
}

interface Setup {
  clock: VirtualClock;
  bus: Bus;
  market: MarketState;
  hub: LiveHub;
  open: Position[];
  apply(event: ChainEvent): void;
}

function setup(options: Partial<LiveHubOptions> = {}): Setup {
  const clock = new VirtualClock(T0 - 120_000);
  const bus = new Bus();
  const market = new MarketState({ maxTradesPerLaunch: 25_000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
  market.apply(createEvent({ mint: MINT, symbol: "GEN", name: "Genesis", timestampMs: T0 - 180_000 }));
  market.apply(createEvent({ mint: OTHER_MINT, symbol: "XYZ", name: "Other", timestampMs: T0 - 180_000 }));
  const open: Position[] = [];
  const hub = new LiveHub({
    bus,
    clock,
    market,
    config: { exits: config.exits, execution: config.execution },
    thresholds: thresholdsOf(config),
    positions: () => open,
    ...options
  });
  hub.start();
  return {
    clock,
    bus,
    market,
    hub,
    open,
    apply(event) {
      market.apply(event);
      bus.emit("chain", event);
    }
  };
}

const servers: AnalyticsServer[] = [];
const hubs: LiveHub[] = [];

async function serve(hub: LiveHub | null, clock: VirtualClock): Promise<number> {
  const server = await startAnalyticsServer({
    db: {} as unknown as Db,
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    clock,
    cacheTtlMs: 0,
    live: hub
  });
  servers.push(server);
  if (hub) {
    hubs.push(hub);
  }
  return server.port;
}

async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error("condition not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const hub of hubs.splice(0)) {
    hub.stop();
  }
});

describe("live event stream over http", () => {
  it("requires the dashboard token as ?token= or a bearer and sends proxy-safe event-stream headers", async () => {
    const { hub, clock } = setup();
    const port = await serve(hub, clock);
    const missing = await openStream(port, "/api/live/stream");
    expect(missing.status).toBe(401);
    await missing.ended();
    expect(JSON.parse(missing.raw())).toMatchObject({ error: "unauthorized" });
    const wrong = await openStream(port, `/api/live/stream?token=${TOKEN}x`);
    expect(wrong.status).toBe(401);
    wrong.close();
    const byQuery = await openStream(port, `/api/live/stream?token=${TOKEN}`);
    expect(byQuery.status).toBe(200);
    expect(byQuery.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(byQuery.headers["cache-control"]).toContain("no-cache");
    expect(byQuery.headers["x-accel-buffering"]).toBe("no");
    expect(byQuery.headers["content-length"]).toBeUndefined();
    const hello = await byQuery.next((message) => message.event === "hello");
    expect(hello.data).toMatchObject({ streamId: hub.streamId, maxClients: 10, positions: [] });
    expect(byQuery.raw().startsWith("retry: 3000\n\n")).toBe(true);
    byQuery.close();
    const byBearer = await openStream(port, "/api/live/stream", { Authorization: `Bearer ${TOKEN}` });
    expect(byBearer.status).toBe(200);
    await byBearer.next((message) => message.event === "hello");
    byBearer.close();
  });

  it("replays the ring buffer on connect, then delivers new events and heartbeats", async () => {
    const { hub, clock, bus } = setup();
    const port = await serve(hub, clock);
    bus.emit("score", score());
    bus.emit("signalRejected", { signal: signal({ mint: OTHER_MINT, riskScore: 82 }), reason: "risk_too_high" });
    bus.emit("signal", signal());
    const stream = await openStream(port, `/api/live/stream?token=${TOKEN}`);
    await stream.next((message) => message.data.kind === "signal");
    const replay = stream.messages().filter((message) => message.event === "message");
    expect(replay.map((message) => message.data.kind)).toEqual(["score", "rejected", "signal"]);
    expect(replay.map((message) => message.id)).toEqual([`${hub.streamId}:1`, `${hub.streamId}:2`, `${hub.streamId}:3`]);
    expect(replay.map((message) => message.data.text)).toEqual([
      "Scored $GEN 60s: 18 (clean)",
      "Rejected $XYZ: risk 82 above 35",
      "Signal $GEN: score momentum, risk 18, mcap 42 SOL"
    ]);
    bus.emit("score", score({ mint: OTHER_MINT, score: 91, hardBlocked: true, flags: ["dev_cluster", "bundle"], checkpointSec: 30 }));
    const blocked = await stream.next((message) => message.data.kind === "score" && message.data.mint === OTHER_MINT);
    expect(blocked.data).toMatchObject({ tone: "bad", category: "score", text: "Blocked $XYZ 30s: hard block (dev cluster, bundle)" });
    expect(stream.messages().some((message) => message.event === "heartbeat")).toBe(false);
    await clock.advanceTo(clock.nowMs() + 15_000);
    const beat = await stream.next((message) => message.event === "heartbeat");
    expect(beat.data).toMatchObject({ clients: 1, tradingActive: false });
    stream.close();
    await waitUntil(() => hub.clientCount() === 0);
    expect(clock.pendingCount()).toBe(0);
  });

  it("caps concurrent streams and frees a slot when a client leaves", async () => {
    const { hub, clock } = setup({ maxClients: 2 });
    const port = await serve(hub, clock);
    const first = await openStream(port, `/api/live/stream?token=${TOKEN}`);
    const second = await openStream(port, `/api/live/stream?token=${TOKEN}`);
    await first.next((message) => message.event === "hello");
    await second.next((message) => message.event === "hello");
    const third = await openStream(port, `/api/live/stream?token=${TOKEN}`);
    expect(third.status).toBe(503);
    expect(third.headers["retry-after"]).toBe("15");
    await third.ended();
    expect(JSON.parse(third.raw())).toMatchObject({ error: "too_many_streams" });
    first.close();
    await waitUntil(() => hub.clientCount() === 1);
    const fourth = await openStream(port, `/api/live/stream?token=${TOKEN}`);
    expect(fourth.status).toBe(200);
    await fourth.next((message) => message.event === "hello");
    second.close();
    fourth.close();
  });

  it("reports status and 404s the stream when this process has no live hub", async () => {
    const clock = new VirtualClock(T0);
    const port = await serve(null, clock);
    const status = await fetch(`http://127.0.0.1:${port}/api/live/status?token=${TOKEN}`);
    expect(await status.json()).toMatchObject({ enabled: false, clients: 0 });
    const stream = await fetch(`http://127.0.0.1:${port}/api/live/stream?token=${TOKEN}`);
    expect(stream.status).toBe(404);
    expect(await stream.json()).toMatchObject({ error: "live_unavailable" });
    const series = await fetch(`http://127.0.0.1:${port}/api/live/position/${POSITION_ID}/series?token=${TOKEN}`);
    expect(series.status).toBe(404);
  });
});

describe("live hub", () => {
  it("throttles position updates to one per position every two seconds and keeps the latest state", async () => {
    const { hub, clock, bus, open, apply } = setup();
    await clock.advanceTo(T0);
    apply(tradeAt(MINT, 2.1, T0 - 1_000, 990));
    const res = connectFake(hub);
    const opened = position();
    open.push(opened);
    bus.emit("positionOpened", opened);
    const positionEvents = (): Array<Record<string, unknown>> => res.events().filter((event) => event.kind === "position");
    expect(positionEvents()).toHaveLength(1);
    for (let index = 1; index <= 5; index += 1) {
      apply(tradeAt(MINT, 2.1 + index * 0.1, T0 + index * 100, 1_000 + index));
    }
    expect(positionEvents()).toHaveLength(1);
    expect(clock.pendingCount()).toBe(2);
    await clock.advanceTo(T0 + 1_999);
    expect(positionEvents()).toHaveLength(1);
    await clock.advanceTo(T0 + 2_000);
    const updates = positionEvents();
    expect(updates).toHaveLength(2);
    const latest = updates[1]?.data as Record<string, unknown>;
    expect(latest.price).toBeCloseTo(INITIAL_PRICE * 2.6, 12);
    expect(latest.multiple).toBeCloseTo(2.6 / (2.1 * 1.018), 6);
    expect(latest.soldPct).toBe(0);
    expect(latest.pnlEstimateSol).toBeGreaterThan(0);
    expect((latest.levels as Record<string, unknown>).stopLossPrice).toBeCloseTo(opened.entryPrice * 0.65, 12);
    apply(tradeAt(OTHER_MINT, 5, T0 + 2_100, 1_010));
    await clock.advanceTo(T0 + 10_000);
    expect(positionEvents()).toHaveLength(2);
    apply(tradeAt(MINT, 2.7, T0 + 10_000, 1_011));
    expect(positionEvents()).toHaveLength(3);
  });

  it("describes buys, take-profits and closes in plain language", async () => {
    const { hub, clock, bus, open, apply } = setup();
    await clock.advanceTo(T0 - 1_100);
    apply(tradeAt(MINT, 2.1, T0 - 2_000, 990));
    bus.emit("signal", signal());
    bus.emit("risk", { runId: 7, atMs: T0 - 1_100, kind: "entry_reserved", detail: { mint: MINT, sizeLamports: "75000000", signalType: "score_momentum" } });
    await clock.advanceTo(T0);
    const opened = position();
    open.push(opened);
    bus.emit("positionOpened", opened);
    const texts = (): string[] => hub.recentEvents().map((event) => event.text);
    expect(texts()).toEqual([
      "Signal $GEN: score momentum, risk 18, mcap 42 SOL",
      "Buying $GEN 0.075 SOL (score momentum)",
      "Bought $GEN 0.075 SOL at 2.1x latency 1.1s slippage +1.8% fees 0.0013 SOL"
    ]);
    const boughtEvent = hub.recentEvents()[2];
    expect(boughtEvent?.data).toMatchObject({ latencyMs: 1_100, slippageBps: 180, positionId: POSITION_ID });
    await clock.advanceTo(T0 + 60_000);
    apply(tradeAt(MINT, 2.1 * 1.018 * 2, T0 + 60_000, 1_100));
    const liquidating = { reason: "take_profit" as const, urgency: "normal" as const, closesPosition: false, targetTokens: 500_000_000_000n, startedAtMs: T0 + 60_000 };
    const sold = position({
      tokensHeld: ENTRY_TOKENS / 2n,
      proceeds: 80_000_000n,
      takeProfitLevelsHit: 1,
      meta: { ...opened.meta, exit: serializeExitState({ liquidating, migratedSeenAtMs: null }) }
    });
    open.splice(0, 1, sold);
    bus.emit("positionUpdated", sold);
    expect(texts().at(-1)).toBe("Took profit on $GEN: sold 50% at 2.0x for 0.080 SOL");
    await clock.advanceTo(T0 + 300_000);
    const closed = position({ ...sold, tokensHeld: 0n, proceeds: 100_000_000n, status: "closed", closedAtMs: T0 + 300_000, exitReason: "trailing_stop" });
    open.splice(0, 1);
    bus.emit("positionClosed", closed);
    expect(texts().at(-1)).toBe("Closed $GEN: +0.025 SOL (+33.3%), trailing stop after 5m");
    expect(hub.recentEvents().at(-1)).toMatchObject({ tone: "good", category: "trade", kind: "closed" });
    bus.emit("positionClosed", position({ id: "7-x-fail", status: "closed", exitReason: "entry_failed", entryCost: 305_000n, feesPaid: 305_000n, closedAtMs: T0 + 301_000, meta: { entryError: "tx_failed" } }));
    expect(texts().at(-1)).toBe("Buy failed $GEN: tx_failed, fees 0.0003 SOL");
  });

  it("reports signals the trader skipped, with the stored reason, and never for entered ones", async () => {
    const lookups: string[] = [];
    const { hub, clock, bus } = setup({
      tradingActive: () => true,
      skipReason: (skipped) => {
        lookups.push(skipped.mint);
        return Promise.resolve("max_concurrent");
      }
    });
    bus.on("signal", (accepted) => {
      if (accepted.mint === MINT) {
        bus.emit("risk", { runId: 7, atMs: clock.nowMs(), kind: "entry_reserved", detail: { mint: MINT, sizeLamports: "50000000", signalType: accepted.type } });
      }
    });
    bus.emit("signal", signal());
    bus.emit("signal", signal({ mint: OTHER_MINT, type: "smart_convergence", wallets: ["A", "B", "C"] }));
    await Promise.resolve();
    expect(hub.recentEvents().map((event) => event.kind)).toEqual(["signal", "entering", "signal"]);
    await clock.advanceTo(clock.nowMs() + 2_500);
    await waitUntil(() => hub.recentEvents().length === 4);
    expect(lookups).toEqual([OTHER_MINT]);
    expect(hub.recentEvents().at(-1)).toMatchObject({ kind: "skipped", tone: "warn", text: "Skipped $XYZ: max open positions reached" });
    expect(hub.recentEvents()[2]?.text).toBe("Signal $XYZ: smart convergence, risk 18, 3 tracked wallets, mcap 42 SOL");
  });

  it("reports trader skips the moment the trader decides, with its exact reason, and no false skip when the reservation comes late", async () => {
    const lookups: string[] = [];
    const { hub, clock, bus } = setup({
      tradingActive: () => true,
      skipReason: (skipped) => {
        lookups.push(skipped.mint);
        return Promise.resolve("max_concurrent");
      }
    });
    bus.on("signal", (seen) => {
      if (seen.mint === OTHER_MINT) {
        bus.emit("signalSkipped", { signal: seen, reason: "dev_daily_limit" });
      }
    });
    bus.emit("signal", signal({ mint: OTHER_MINT }));
    await Promise.resolve();
    expect(hub.recentEvents().map((event) => event.text)).toEqual([
      "Signal $XYZ: score momentum, risk 18, mcap 42 SOL",
      "Skipped $XYZ: dev's daily entry limit reached"
    ]);
    bus.emit("signal", signal());
    await Promise.resolve();
    await clock.advanceTo(clock.nowMs() + 1_000);
    bus.emit("risk", { runId: 7, atMs: clock.nowMs(), kind: "entry_reserved", detail: { mint: MINT, sizeLamports: "50000000", signalType: "score_momentum" } });
    await clock.advanceTo(clock.nowMs() + 5_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lookups).toEqual([]);
    expect(hub.recentEvents().map((event) => event.kind)).toEqual(["signal", "skipped", "signal", "entering"]);
  });

  it("shows rejections from the real signal engine", () => {
    const { hub, clock, bus, market } = setup();
    const engine = new SignalEngine({
      clock,
      bus,
      market,
      scores: { latest: () => null, scoreNow: () => Promise.resolve(null) },
      tracked: TrackedWalletRegistry.fromWallets(["W1"]),
      signals: { ...config.signals, enabled: ["score_momentum"] },
      convergence: config.tracker.convergence
    });
    engine.start();
    bus.emit("score", score({ score: 82 }));
    bus.emit("score", score({ mint: OTHER_MINT, score: 12, features: { unique_buyers_per_min: 4, buy_sell_count_ratio: 3 } }));
    const rejected = hub.recentEvents().filter((event) => event.kind === "rejected");
    expect(rejected.map((event) => event.text)).toEqual(["Rejected $GEN: risk 82 above 35", "Rejected $XYZ: 4 buyers a minute, needs 15"]);
    expect(rejected[0]?.data).toMatchObject({ reason: "risk_too_high", type: "score_momentum" });
    void engine.stop();
  });

  it("keeps rings per event class so frequent scores never push out trades", () => {
    const { hub, bus } = setup({ ringSizes: { trade: 2, rejected: 2, score: 3 } });
    bus.emit("signal", signal());
    for (let index = 0; index < 10; index += 1) {
      bus.emit("score", score({ score: index }));
      bus.emit("signalRejected", { signal: signal({ riskScore: 50 + index }), reason: "risk_too_high" });
    }
    const kinds = hub.recentEvents().map((event) => event.kind);
    expect(kinds.filter((kind) => kind === "signal")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "score")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "rejected")).toHaveLength(2);
    const ids = hub.recentEvents().map((event) => event.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const resumed = connectFake(hub, { "last-event-id": `${hub.streamId}:18` });
    expect(resumed.events().map((event) => event.id)).toEqual([19, 20, 21]);
    const otherStream = connectFake(hub, { "last-event-id": "someone-else:18" });
    expect(otherStream.events()).toHaveLength(6);
  });

  it("drops events for a slow client instead of buffering, then reports the gap", () => {
    const { hub, bus } = setup();
    const res = connectFake(hub);
    expect(res.messages()[0]?.event).toBe("hello");
    res.accept = false;
    bus.emit("score", score({ score: 1 }));
    const written = res.chunks.length;
    bus.emit("score", score({ score: 2 }));
    bus.emit("score", score({ score: 3 }));
    expect(res.chunks.length).toBe(written);
    res.accept = true;
    res.emit("drain");
    const gap = res.messages().find((message) => message.event === "gap");
    expect(gap?.data).toEqual({ dropped: 2 });
    bus.emit("score", score({ score: 4 }));
    expect(res.events().map((event) => (event.data as Record<string, unknown>).score)).toEqual([1, 4]);
    const stuck = connectFake(hub);
    stuck.writableLength = 10_000_000;
    bus.emit("score", score({ score: 5 }));
    expect(stuck.destroyed).toBe(true);
    expect(hub.clientCount()).toBe(1);
  });

  it("disconnects a client that stays congested, so stale connections cannot hold the stream slots", async () => {
    const { hub, bus, clock } = setup({ maxCongestedMs: 30_000, heartbeatMs: 15_000 });
    const startMs = clock.nowMs();
    const res = connectFake(hub);
    res.accept = false;
    bus.emit("score", score({ score: 1 }));
    await clock.advanceTo(startMs + 30_000);
    expect(res.destroyed).toBe(false);
    expect(hub.clientCount()).toBe(1);
    await clock.advanceTo(startMs + 45_000);
    expect(res.destroyed).toBe(true);
    expect(hub.clientCount()).toBe(0);
    expect(clock.pendingCount()).toBe(0);
  });

  it("estimates open PnL exactly like the Trades tab: fee-netted spot value, close transaction cost and rent refund", async () => {
    const { market, clock, apply } = setup();
    await clock.advanceTo(T0 + 1_000);
    apply(tradeAt(MINT, 3, T0 + 500, 1_001));
    const held = position({ tokensHeld: ENTRY_TOKENS / 2n, proceeds: 60_000_000n, takeProfitLevelsHit: 1 });
    const launch = market.get(MINT);
    const view = livePositionView(held, launch, { exits: config.exits, execution: config.execution }, T0 + 1_000);
    const defaults = sellFeeDefaultsOf(config.execution);
    expect(defaults.rentRefundLamports).toBeGreaterThan(0n);
    const fee = sellFeeBpsFor({ protocolBps: 95, creatorBps: 30, lpBps: 0 }, false, defaults);
    const price = launch?.price() ?? 0;
    const expected = held.proceeds + estimatedCloseProceeds(held.tokensHeld, price, fee, defaults) - held.entryCost;
    expect(view.price).toBe(price);
    expect(view.pnlEstimateSol).toBe(lamportsToSol(expected));
    expect(livePositionView({ ...held, status: "pending", entryTokens: 0n }, launch, { exits: config.exits, execution: config.execution }, T0 + 1_000).pnlEstimateSol).toBeNull();
  });

  it("restores open positions from the trader on connect and sends them in hello", () => {
    const { hub, open, apply, clock } = setup();
    void clock.advanceTo(T0);
    apply(tradeAt(MINT, 3, T0 - 500, 995));
    open.push(position({ peakPrice: INITIAL_PRICE * 3.2 }));
    open.push(position({ id: "7-shadow", shadowOf: POSITION_ID, mode: "shadow" }));
    const res = connectFake(hub);
    const hello = res.messages()[0];
    const positions = (hello?.data.positions ?? []) as Array<Record<string, unknown>>;
    expect(positions.map((item) => item.id)).toEqual([POSITION_ID]);
    expect(positions[0]).toMatchObject({ symbol: "GEN", name: "Genesis", migrated: false });
    expect(hub.status()).toMatchObject({ enabled: true, clients: 1, openPositions: 1 });
  });
});

describe("live position series", () => {
  it("serves recent prices since a minute before entry with exit levels, and 404s unknown or closed positions", async () => {
    const { hub, clock, open, apply } = setup();
    for (let index = 0; index < 1_000; index += 1) {
      const atMs = T0 - 120_000 + index * 400;
      apply(tradeAt(MINT, 2 + Math.sin(index / 25) * 0.3 + (index === 500 ? 2 : 0), atMs, 900 + index));
    }
    await clock.advanceTo(T0 + 280_000);
    const entryPrice = INITIAL_PRICE * 2;
    open.push(position({ entryPrice, peakPrice: entryPrice * 1.5, lastPrice: entryPrice }));
    open.push(position({ id: "7-closed", status: "closed" }));
    const port = await serve(hub, clock);
    const response = await fetch(`http://127.0.0.1:${port}/api/live/position/${POSITION_ID}/series`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fromMs: number;
      totalTrades: number;
      points: Array<{ atMs: number; price: number }>;
      position: { levels: Record<string, unknown>; migrated: boolean; peakMultiple: number; multiple: number };
    };
    expect(body.fromMs).toBe(T0 - 60_000);
    expect(body.totalTrades).toBe(850);
    expect(body.points.length).toBeLessThanOrEqual(400);
    expect(body.points[0]?.atMs).toBeGreaterThanOrEqual(T0 - 60_000);
    expect(body.points.at(-1)?.atMs).toBe(T0 - 120_000 + 999 * 400);
    expect(Math.max(...body.points.map((point) => point.price))).toBeCloseTo(INITIAL_PRICE * (4 + Math.sin(20) * 0.3), 12);
    const levels = body.position.levels;
    expect(levels.stopLossPrice).toBeCloseTo(entryPrice * 0.65, 12);
    expect(levels.trailingStopPrice).toBeCloseTo(entryPrice * 1.5 * 0.75, 12);
    expect(levels.moonbagStopPrice).toBeCloseTo(entryPrice * 1.5 * 0.55, 12);
    expect(levels.nextTakeProfit).toMatchObject({ multiple: 2, sellPctOfInitial: 50 });
    expect((levels.nextTakeProfit as { price: number }).price).toBeCloseTo(entryPrice * 2, 12);
    expect(body.position.migrated).toBe(false);
    for (const path of [`/api/live/position/unknown-id/series`, `/api/live/position/7-closed/series`]) {
      const missing = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: "position_not_open" });
    }
    const malformed = await fetch(`http://127.0.0.1:${port}/api/live/position/bad%20id!/series`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(malformed.status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/live/position/${POSITION_ID}/series`)).status).toBe(401);
  });

  it("computes exit levels from the position state and the exit config", () => {
    const entryPrice = 1e-5;
    const fresh = exitLevels(position({ entryPrice, peakPrice: entryPrice * 1.1 }), config.exits);
    expect(fresh.trailingStopPrice).toBeNull();
    expect(fresh.moonbagStopPrice).toBeNull();
    expect(fresh.nextTakeProfit?.multiple).toBe(2);
    expect(fresh.takeProfits.map((level) => level.multiple)).toEqual([2, 3, 5, 10]);
    expect(fresh.timeStopAtMs).toBe(T0 + 300_000);
    expect(fresh.maxHoldAtMs).toBe(T0 + 3_600_000);
    const afterTwo = exitLevels(position({ entryPrice, peakPrice: entryPrice * 3.5, takeProfitLevelsHit: 2, tokensHeld: (ENTRY_TOKENS * 35n) / 100n }), config.exits);
    expect(afterTwo.nextTakeProfit?.multiple).toBe(5);
    expect(afterTwo.trailingStopPrice).toBeCloseTo(entryPrice * 3.5 * 0.82, 15);
    expect(afterTwo.timeStopAtMs).toBeNull();
    const moonbagOnly = exitLevels(position({ entryPrice, peakPrice: entryPrice * 3.5, takeProfitLevelsHit: 4, tokensHeld: ENTRY_TOKENS / 10n }), config.exits);
    expect(moonbagOnly.trailingStopPrice).toBeNull();
    expect(moonbagOnly.moonbagStopPrice).toBeCloseTo(entryPrice * 3.5 * 0.55, 15);
    expect(moonbagOnly.nextTakeProfit).toBeNull();
    const migrated = exitLevels(
      position({ entryPrice, peakPrice: entryPrice * 1.2, migratedSeen: true, meta: { exit: serializeExitState({ liquidating: null, migratedSeenAtMs: T0 + 60_000 }) } }),
      config.exits
    );
    expect(migrated.trailFraction).toBe(0.3);
    expect(migrated.trailingStopPrice).toBeCloseTo(entryPrice * 1.2 * 0.7, 15);
    expect(migrated.maxHoldAtMs).toBe(T0 + 60_000 + 1_800_000);
  });

  it("downsamples long series keeping extremes and the last point", () => {
    const points = Array.from({ length: 5_000 }, (_, index) => ({ atMs: index, price: index === 1_234 ? 99 : index === 4_321 ? 0.001 : 1 + (index % 7) / 100 }));
    const sampled = downsamplePoints(points, 400);
    expect(sampled.length).toBeLessThanOrEqual(400);
    expect(sampled.some((point) => point.price === 99)).toBe(true);
    expect(sampled.some((point) => point.price === 0.001)).toBe(true);
    expect(sampled.at(-1)).toEqual(points.at(-1));
    expect(sampled.map((point) => point.atMs)).toEqual([...sampled.map((point) => point.atMs)].sort((a, b) => a - b));
    expect(downsamplePoints(points.slice(0, 10), 400)).toHaveLength(10);
  });
});
