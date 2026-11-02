import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "../src/core/constants.js";

export interface FixtureTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  logs: string[];
  err?: unknown;
}

export function loadFixtureTransactions(): FixtureTransaction[] {
  const raw = readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8");
  return JSON.parse(raw) as FixtureTransaction[];
}

export function mentionsProgram(tx: Pick<FixtureTransaction, "logs">, program: string): boolean {
  return tx.logs.some((line) => line.startsWith(`Program ${program} `));
}

interface Subscription {
  id: number;
  program: string;
}

interface Connection {
  socket: WebSocket;
  subscriptions: Subscription[];
  replayed: boolean;
}

export interface FakeLogsNodeOptions {
  transactions: readonly FixtureTransaction[];
  programs?: readonly string[];
}

export class FakeLogsNode {
  private readonly wss: WebSocketServer;
  private readonly transactions: readonly FixtureTransaction[];
  private readonly programs: readonly string[];
  private readonly connections = new Set<Connection>();
  private nextSubscription = 100;
  private keepaliveCount = 0;
  sent = 0;
  connectionsOpened = 0;

  private constructor(wss: WebSocketServer, options: FakeLogsNodeOptions) {
    this.wss = wss;
    this.transactions = [...options.transactions].sort((a, b) => a.slot - b.slot);
    this.programs = options.programs ?? [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID];
    wss.on("connection", (socket) => this.accept(socket));
  }

  static async start(options: FakeLogsNodeOptions): Promise<FakeLogsNode> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    return new FakeLogsNode(wss, options);
  }

  get url(): string {
    const address = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}`;
  }

  expectedReplayDeliveries(): number {
    let count = 0;
    for (const tx of this.transactions) {
      for (const program of this.programs) {
        if (mentionsProgram(tx, program)) {
          count += 1;
        }
      }
    }
    return count;
  }

  keepalive(slot: number): number {
    let delivered = 0;
    for (const connection of this.connections) {
      for (const subscription of connection.subscriptions) {
        this.keepaliveCount += 1;
        const tx: FixtureTransaction = {
          signature: `keepalive${this.keepaliveCount}`,
          slot,
          blockTime: 0,
          logs: [`Program ${subscription.program} invoke [1]`, `Program ${subscription.program} success`]
        };
        this.notify(connection.socket, subscription, tx);
        delivered += 1;
      }
    }
    return delivered;
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private accept(socket: WebSocket): void {
    const connection: Connection = { socket, subscriptions: [], replayed: false };
    this.connections.add(connection);
    this.connectionsOpened += 1;
    socket.on("close", () => this.connections.delete(connection));
    socket.on("message", (data: RawData) => this.onMessage(connection, data));
  }

  private onMessage(connection: Connection, data: RawData): void {
    const request = JSON.parse(String(data)) as { id: number; method: string; params: [{ mentions: string[] }, unknown] };
    if (request.method !== "logsSubscribe") {
      return;
    }
    const program = request.params[0].mentions[0] ?? "";
    const subscription = { id: this.nextSubscription++, program };
    connection.subscriptions.push(subscription);
    connection.socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: subscription.id }));
    if (!connection.replayed && this.programs.every((wanted) => connection.subscriptions.some((sub) => sub.program === wanted))) {
      connection.replayed = true;
      this.replay(connection);
    }
  }

  private replay(connection: Connection): void {
    for (const tx of this.transactions) {
      for (const subscription of connection.subscriptions) {
        if (mentionsProgram(tx, subscription.program)) {
          this.notify(connection.socket, subscription, tx);
        }
      }
    }
  }

  private notify(socket: WebSocket, subscription: Subscription, tx: FixtureTransaction): void {
    this.sent += 1;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: subscription.id,
          result: { context: { slot: tx.slot }, value: { signature: tx.signature, err: tx.err ?? null, logs: tx.logs } }
        }
      })
    );
  }
}

type RpcRequest = { jsonrpc: string; id: unknown; method: string; params?: unknown };

function emptyResult(method: string): unknown {
  switch (method) {
    case "getSignaturesForAddress":
      return [];
    case "getTokenLargestAccounts":
    case "getMultipleAccounts":
    case "getProgramAccounts":
      return { context: { slot: 1 }, value: [] };
    case "getAccountInfo":
    case "getBalance":
      return { context: { slot: 1 }, value: null };
    default:
      return null;
  }
}

export class StubRpcServer {
  readonly calls = new Map<string, number>();

  private constructor(private readonly server: Server) {}

  static async start(): Promise<StubRpcServer> {
    let stub: StubRpcServer | null = null;
    const server = createServer((req, res) => stub?.handle(req, res));
    stub = new StubRpcServer(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return stub;
  }

  get url(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  totalCalls(): number {
    let total = 0;
    for (const count of this.calls.values()) {
      total += count;
    }
    return total;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcRequest | RpcRequest[];
      const requests = Array.isArray(parsed) ? parsed : [parsed];
      const responses = requests.map((request) => {
        this.calls.set(request.method, (this.calls.get(request.method) ?? 0) + 1);
        return { jsonrpc: "2.0", id: request.id, result: emptyResult(request.method) };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
    });
  }
}

export async function waitUntil(condition: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
