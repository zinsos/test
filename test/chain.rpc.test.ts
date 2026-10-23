import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, RpcError, type RpcClientOptions } from "../src/chain/rpc.js";

interface StubServer {
  url: string;
  received: string[];
  close(): Promise<void>;
}

async function startStub(delayMs: number): Promise<StubServer> {
  const received: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; params: unknown[] };
      received.push(String(parsed.params[0]));
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: parsed.params[0] }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const servers: StubServer[] = [];

async function client(delayMs: number, options: Partial<RpcClientOptions>): Promise<{ rpc: RpcClient; stub: StubServer }> {
  const stub = await startStub(delayMs);
  servers.push(stub);
  const rpc = new RpcClient({ url: stub.url, maxRps: 100, maxConcurrency: 4, timeoutMs: 5_000, maxRetries: 0, ...options });
  return { rpc, stub };
}

afterEach(async () => {
  await Promise.all(servers.splice(0, servers.length).map((stub) => stub.close()));
});

describe("RpcClient rate limiting", () => {
  it("dispatches calls when the rate limit is below one request per second", async () => {
    const { rpc } = await client(0, { maxRps: 0.3 });
    const started = Date.now();
    await expect(rpc.call<string>("echo", ["first"])).resolves.toBe("first");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("spaces later calls by the fractional rate instead of stalling", async () => {
    const { rpc } = await client(0, { maxRps: 2 });
    const started = Date.now();
    await Promise.all([rpc.call<string>("echo", ["a"]), rpc.call<string>("echo", ["b"]), rpc.call<string>("echo", ["c"])]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe("RpcClient queue bounds", () => {
  it("rejects calls beyond the queue limit without sending them", async () => {
    const { rpc, stub } = await client(200, { maxConcurrency: 1, maxQueued: 2 });
    const results = await Promise.allSettled(
      ["one", "two", "three", "four", "five"].map((name) => rpc.call<string>("echo", [name]))
    );
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect(result.status === "rejected" && result.reason instanceof RpcError && result.reason.message).toBe("rpc queue full");
    }
    expect(stub.received).toEqual(["one", "two", "three"]);
    expect(rpc.stats().dropped).toBe(2);
  });

  it("evicts the newest lower-priority call to make room for a higher-priority one", async () => {
    const { rpc, stub } = await client(150, { maxConcurrency: 1, maxQueued: 2 });
    const running = rpc.call<string>("echo", ["running"], "low");
    const lowA = rpc.call<string>("echo", ["low-a"], "low");
    const lowB = rpc.call<string>("echo", ["low-b"], "low");
    const high = rpc.call<string>("echo", ["high"], "high");
    const settled = await Promise.allSettled([running, lowA, lowB, high]);
    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled"]);
    expect(stub.received).toEqual(["running", "high", "low-a"]);
  });

  it("drops calls that waited longer than the queue wait limit", async () => {
    const { rpc, stub } = await client(250, { maxConcurrency: 1, maxQueueWaitMs: 100 });
    const settled = await Promise.allSettled([rpc.call<string>("echo", ["first"]), rpc.call<string>("echo", ["stale"])]);
    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status === "rejected" && (settled[1].reason as RpcError).message).toBe("rpc queue wait exceeded");
    expect(stub.received).toEqual(["first"]);
  });
});
