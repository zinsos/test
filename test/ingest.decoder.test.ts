import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TransactionDecoder } from "../src/ingest/decoder.js";
import { BoundedSet } from "../src/ingest/lru.js";
import { backoffDelayMs, DEFAULT_BACKOFF } from "../src/ingest/wsSource.js";
import { websocketUrlFromEnv } from "../src/ingest/index.js";

interface FixtureTx {
  signature: string;
  slot: number;
  category: string;
  logs: string[];
}

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8")) as FixtureTx[];

describe("bounded set", () => {
  it("evicts the oldest entries beyond capacity", () => {
    const set = new BoundedSet<string>(2);
    expect(set.addIfAbsent("a")).toBe(true);
    expect(set.addIfAbsent("a")).toBe(false);
    expect(set.addIfAbsent("b")).toBe(true);
    expect(set.addIfAbsent("c")).toBe(true);
    expect(set.size).toBe(2);
    expect(set.has("a")).toBe(false);
    expect(set.has("c")).toBe(true);
    expect(set.addIfAbsent("a")).toBe(true);
    set.delete("a");
    expect(set.has("a")).toBe(false);
    set.clear();
    expect(set.size).toBe(0);
  });

  it("rejects invalid capacities", () => {
    expect(() => new BoundedSet(0)).toThrow();
  });
});

describe("transaction decoder", () => {
  it("dedupes signatures, skips failures and empty transactions and tracks lag", () => {
    const decoder = new TransactionDecoder(100);
    const create = fixtures.find((tx) => tx.category === "create");
    const empty = fixtures.find((tx) => tx.category === "other");
    if (!create || !empty) {
      throw new Error("fixtures missing");
    }
    const receivedAtMs = 1_792_767_800_500;
    const first = decoder.decode({ signature: create.signature, slot: create.slot, err: null, logs: create.logs }, receivedAtMs);
    expect(first?.meta).toEqual({ signature: create.signature, slot: create.slot, seq: 1, receivedAtMs });
    expect(first?.batch.events[0]?.tx.receivedAtMs).toBe(receivedAtMs);
    expect(decoder.decode({ signature: create.signature, slot: create.slot, err: null, logs: create.logs }, receivedAtMs)).toBeNull();
    expect(decoder.decode({ signature: "failed", slot: 5, err: { x: 1 }, logs: create.logs }, receivedAtMs)).toBeNull();
    expect(decoder.decode({ signature: empty.signature, slot: empty.slot, err: null, logs: empty.logs }, receivedAtMs)).toBeNull();
    expect(decoder.decode({ signature: "nologs", slot: 6, err: null, logs: null }, receivedAtMs)).toBeNull();
    const stats = decoder.stats();
    expect(stats).toMatchObject({ received: 5, duplicates: 1, failed: 1, decoded: 1, empty: 2, lastSeq: 3 });
    expect(stats.lagMs).toBeGreaterThan(0);
    expect(stats.lastSlot).toBe(Math.max(create.slot, empty.slot, 6));
  });

  it("allows a signature again once it falls out of the dedupe window", () => {
    const decoder = new TransactionDecoder(1);
    const [a, b] = fixtures.filter((tx) => tx.category === "create");
    if (!a || !b) {
      throw new Error("fixtures missing");
    }
    expect(decoder.decode({ signature: a.signature, slot: a.slot, err: null, logs: a.logs }, 0)).not.toBeNull();
    expect(decoder.decode({ signature: b.signature, slot: b.slot, err: null, logs: b.logs }, 0)).not.toBeNull();
    expect(decoder.decode({ signature: a.signature, slot: a.slot, err: null, logs: a.logs }, 0)).not.toBeNull();
  });
});

describe("reconnect backoff", () => {
  it("grows exponentially, caps at the maximum and applies symmetric jitter", () => {
    const backoff = { initialMs: 100, maxMs: 1_000, multiplier: 2, jitter: 0.2 };
    expect(backoffDelayMs(0, backoff, () => 0.5)).toBe(100);
    expect(backoffDelayMs(3, backoff, () => 0.5)).toBe(800);
    expect(backoffDelayMs(10, backoff, () => 0.5)).toBe(1_000);
    expect(backoffDelayMs(0, backoff, () => 0)).toBe(80);
    expect(backoffDelayMs(0, backoff, () => 1)).toBe(120);
    expect(backoffDelayMs(-1, DEFAULT_BACKOFF, () => 0.5)).toBe(DEFAULT_BACKOFF.initialMs);
  });
});

describe("websocket url", () => {
  it("prefers RPC_WS_URL and otherwise derives it from the http url", () => {
    expect(websocketUrlFromEnv({ RPC_WS_URL: "wss://a", RPC_HTTP_URL: "https://b" })).toBe("wss://a");
    expect(websocketUrlFromEnv({ RPC_WS_URL: undefined, RPC_HTTP_URL: "https://rpc.example/?api-key=k" })).toBe(
      "wss://rpc.example/?api-key=k"
    );
    expect(websocketUrlFromEnv({ RPC_WS_URL: "", RPC_HTTP_URL: "http://localhost:8899" })).toBe("ws://localhost:8899");
    expect(() => websocketUrlFromEnv({ RPC_WS_URL: undefined, RPC_HTTP_URL: undefined })).toThrow();
  });
});
