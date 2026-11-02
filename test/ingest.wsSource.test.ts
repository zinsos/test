import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { DecodeResult } from "../src/chain/events.js";
import { SystemClock } from "../src/core/clock.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "../src/core/constants.js";
import type { IngestGap } from "../src/core/types.js";
import type { StreamMeta } from "../src/ingest/source.js";
import { LogsWebsocketSource, type LogsWebsocketSourceOptions } from "../src/ingest/wsSource.js";

interface FixtureTx {
  signature: string;
  slot: number;
  category: string;
  logs: string[];
}

const fixtures = (
  JSON.parse(readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8")) as FixtureTx[]
).sort((a, b) => a.slot - b.slot);
const creates = fixtures.filter((tx) => tx.category === "create");
const v3Trades = fixtures.filter((tx) => tx.category === "v3");

interface Subscription {
  id: number;
  program: string;
}

interface FakeConnection {
  socket: WebSocket;
  subscriptions: Subscription[];
  subscribed: Promise<void>;
}

class FakeRpcServer {
  readonly server: WebSocketServer;
  readonly connections: FakeConnection[] = [];
  private nextSubscription = 100;
  private readonly waiters: Array<{ count: number; resolve: (connection: FakeConnection) => void }> = [];

  constructor(options: { autoPong?: boolean; respond?: boolean } = {}) {
    this.server = new WebSocketServer({ port: 0, autoPong: options.autoPong ?? true });
    this.server.on("connection", (socket) => {
      const subscriptions: Subscription[] = [];
      let resolveSubscribed: () => void = () => undefined;
      const subscribed = new Promise<void>((resolve) => {
        resolveSubscribed = resolve;
      });
      const connection: FakeConnection = { socket, subscriptions, subscribed };
      this.connections.push(connection);
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { id: number; method: string; params: [{ mentions: string[] }, unknown] };
        if (request.method !== "logsSubscribe" || options.respond === false) {
          return;
        }
        const id = this.nextSubscription++;
        subscriptions.push({ id, program: request.params[0].mentions[0] ?? "" });
        socket.send(JSON.stringify({ jsonrpc: "2.0", result: id, id: request.id }));
        if (subscriptions.length === 2) {
          resolveSubscribed();
        }
      });
      for (const waiter of [...this.waiters]) {
        if (this.connections.length >= waiter.count) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(connection);
        }
      }
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  connection(count: number): Promise<FakeConnection> {
    const existing = this.connections[count - 1];
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  notify(connection: FakeConnection, tx: FixtureTx, options: { err?: unknown; both?: boolean } = {}): void {
    const targets = options.both ? connection.subscriptions : connection.subscriptions.slice(0, 1);
    for (const subscription of targets) {
      connection.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: subscription.id,
            result: { context: { slot: tx.slot }, value: { signature: tx.signature, err: options.err ?? null, logs: tx.logs } }
          }
        })
      );
    }
  }

  close(): Promise<void> {
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function setup(
  serverOptions: { autoPong?: boolean; respond?: boolean } = {},
  sourceOptions: Partial<LogsWebsocketSourceOptions> = {}
): {
  server: FakeRpcServer;
  source: LogsWebsocketSource;
  batches: Array<{ batch: DecodeResult; meta: StreamMeta }>;
  gaps: IngestGap[];
} {
  const server = new FakeRpcServer(serverOptions);
  const source = new LogsWebsocketSource({
    url: server.url,
    clock: new SystemClock(),
    backoff: { initialMs: 10, maxMs: 50 },
    random: () => 0.5,
    ...sourceOptions
  });
  const batches: Array<{ batch: DecodeResult; meta: StreamMeta }> = [];
  const gaps: IngestGap[] = [];
  source.onGap((gap) => gaps.push(gap));
  cleanups.push(async () => {
    await source.stop();
    await server.close();
  });
  return { server, source, batches, gaps };
}

describe("logs websocket source", () => {
  it("subscribes to both programs with the configured commitment", async () => {
    const { server, source, batches } = setup({}, { commitment: "processed" });
    const requests: unknown[] = [];
    server.server.on("connection", (socket) => socket.on("message", (data) => requests.push(JSON.parse(data.toString()))));
    await source.start((batch, meta) => batches.push({ batch, meta }));
    const connection = await server.connection(1);
    await connection.subscribed;
    expect(connection.subscriptions.map((subscription) => subscription.program).sort()).toEqual(
      [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID].sort()
    );
    expect(requests).toContainEqual(
      expect.objectContaining({ method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: "processed" }] })
    );
    await waitFor(() => source.stats().subscriptions === 2);
    expect(source.stats().connected).toBe(1);
  });

  it("decodes fixture transactions, dedupes across subscriptions, skips failed transactions and assigns monotonic seq", async () => {
    const { server, source, batches } = setup();
    await source.start((batch, meta) => batches.push({ batch, meta }));
    const connection = await server.connection(1);
    await connection.subscribed;
    for (const tx of creates) {
      server.notify(connection, tx, { both: true });
    }
    const failed = v3Trades[0];
    if (failed) {
      server.notify(connection, failed, { err: { InstructionError: [0, "Custom"] } });
    }
    await waitFor(() => source.stats().txReceived === creates.length * 2 + 1);
    expect(batches).toHaveLength(creates.length);
    expect(batches.map((entry) => entry.meta.signature)).toEqual(creates.map((tx) => tx.signature));
    const seqs = batches.map((entry) => entry.meta.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const entry of batches) {
      expect(entry.batch.events.length).toBeGreaterThan(0);
      for (const event of entry.batch.events) {
        expect(event.tx.seq).toBe(entry.meta.seq);
        expect(event.tx.signature).toBe(entry.meta.signature);
      }
    }
    const stats = source.stats();
    expect(stats.txDuplicates).toBe(creates.length);
    expect(stats.txFailed).toBe(1);
    expect(stats.lastSlot).toBe(Math.max(...creates.map((tx) => tx.slot), failed?.slot ?? 0));
    expect(stats.events).toBeGreaterThanOrEqual(creates.length);
  });

  it("reconnects after the server drops the connection and reports the gap", async () => {
    const { server, source, batches, gaps } = setup();
    await source.start((batch, meta) => batches.push({ batch, meta }));
    const first = await server.connection(1);
    await first.subscribed;
    for (const tx of creates) {
      server.notify(first, tx);
    }
    await waitFor(() => batches.length === creates.length);
    first.socket.terminate();
    const second = await server.connection(2);
    await second.subscribed;
    expect(gaps).toHaveLength(0);
    for (const tx of v3Trades) {
      server.notify(second, tx, { both: true });
    }
    await waitFor(() => batches.length === creates.length + v3Trades.length);
    expect(gaps).toHaveLength(1);
    const gap = gaps[0];
    expect(gap?.source).toBe("ws");
    expect(gap?.fromSlot).toBe(Math.max(...creates.map((tx) => tx.slot)));
    expect(gap?.toSlot).toBe(v3Trades[0]?.slot);
    expect(gap?.reason).toContain("closed");
    expect((gap?.endedAtMs ?? 0) >= (gap?.startedAtMs ?? Number.POSITIVE_INFINITY)).toBe(true);
    const seqs = batches.map((entry) => entry.meta.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(source.stats().reconnects).toBeGreaterThanOrEqual(1);
    expect(source.stats().gaps).toBe(1);
  });

  it("forces a reconnect when the stream stalls", async () => {
    const { server, source } = setup({}, { stallTimeoutMs: 120, stallCheckIntervalMs: 20 });
    await source.start(() => undefined);
    const first = await server.connection(1);
    await first.subscribed;
    await server.connection(2);
    await waitFor(() => (source.stats().stalls ?? 0) >= 1);
    expect(source.stats().reconnects).toBeGreaterThanOrEqual(1);
  });

  it("forces a reconnect when a subscription is never confirmed", async () => {
    const { server, source } = setup({ respond: false }, { subscribeTimeoutMs: 80, stallTimeoutMs: 60_000, stallCheckIntervalMs: 20 });
    await source.start(() => undefined);
    await server.connection(2);
    await waitFor(() => (source.stats().subscribeTimeouts ?? 0) >= 1);
  });

  it("forces a reconnect when one subscription goes quiet while the other keeps streaming", async () => {
    const { server, source, batches } = setup({}, { subscriptionStallMs: 150, stallTimeoutMs: 60_000, stallCheckIntervalMs: 20 });
    await source.start((batch, meta) => batches.push({ batch, meta }));
    const first = await server.connection(1);
    await first.subscribed;
    let index = 0;
    const timer = setInterval(() => {
      const tx = creates[index % creates.length];
      index += 1;
      if (tx && first.socket.readyState === first.socket.OPEN) {
        server.notify(first, tx);
      }
    }, 10);
    try {
      await server.connection(2);
      await waitFor(() => (source.stats().subscriptionStalls ?? 0) >= 1);
      expect(source.stats().stalls).toBe(0);
    } finally {
      clearInterval(timer);
    }
  });

  it("forces a reconnect when pongs stop arriving", async () => {
    const { server, source } = setup({ autoPong: false }, { pingIntervalMs: 40, stallTimeoutMs: 60_000 });
    await source.start(() => undefined);
    await server.connection(1);
    await server.connection(2);
    await waitFor(() => (source.stats().heartbeatTimeouts ?? 0) >= 1);
  });

  it("reconnects when the subscription is rejected", async () => {
    const server = new FakeRpcServer({ respond: false });
    server.server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { id: number };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "bad params" } }));
      })
    );
    const source = new LogsWebsocketSource({ url: server.url, clock: new SystemClock(), backoff: { initialMs: 10, maxMs: 20 } });
    cleanups.push(async () => {
      await source.stop();
      await server.close();
    });
    await source.start(() => undefined);
    await server.connection(2);
    await waitFor(() => (source.stats().subscribeErrors ?? 0) >= 1);
  });

  it("keeps retrying with backoff when the endpoint is unreachable and stops cleanly", async () => {
    const server = new FakeRpcServer();
    const url = server.url;
    await server.close();
    const source = new LogsWebsocketSource({ url, clock: new SystemClock(), backoff: { initialMs: 5, maxMs: 10 } });
    await source.start(() => undefined);
    await waitFor(() => (source.stats().reconnects ?? 0) >= 2);
    await source.stop();
    const after = source.stats().reconnects;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(source.stats().reconnects).toBe(after);
    expect(source.stats().connected).toBe(0);
  });

  it("reports an unresolved gap when stopped while disconnected", async () => {
    const { server, source, gaps } = setup({}, { backoff: { initialMs: 10_000, maxMs: 10_000 } });
    await source.start(() => undefined);
    const first = await server.connection(1);
    await first.subscribed;
    const tx = creates[0];
    if (tx) {
      server.notify(first, tx);
    }
    await waitFor(() => source.stats().txReceived === 1);
    first.socket.terminate();
    await waitFor(() => source.stats().disconnects === 1);
    await source.stop();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.toSlot).toBeNull();
    expect(gaps[0]?.fromSlot).toBe(tx?.slot);
  });

  it("counts malformed messages without disconnecting", async () => {
    const { server, source } = setup();
    await source.start(() => undefined);
    const connection = await server.connection(1);
    await connection.subscribed;
    connection.socket.send("not json");
    connection.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { result: {} } }));
    await waitFor(() => source.stats().badMessages === 2);
    expect(source.stats().connected).toBe(1);
  });
});
