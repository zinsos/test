import { describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { SystemClock } from "../src/core/clock.js";
import type { LaunchCreatedEvent } from "../src/core/types.js";
import type { Db } from "../src/db/pool.js";
import { MarketState } from "../src/market/state.js";
import { VirtualClock } from "../src/core/clock.js";
import {
  blockedHostReason,
  isPrivateAddress,
  MetadataFetcher,
  normalizeGateway,
  parseMetadata,
  rewriteIpfsUrl,
  type FetchLike
} from "../src/recorder/metadata.js";

const GATEWAY = "https://gw.example/ipfs/";
const CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_V1 = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function fakeDb(): { db: Db; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
  } as unknown as Db;
  return { db, queries };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function createEvent(mint: string, uri: string): LaunchCreatedEvent {
  return {
    kind: "create",
    tx: { signature: `sig-${mint}`, slot: 1, seq: 1, eventIndex: 0, receivedAtMs: 0 },
    mint,
    bondingCurve: `curve-${mint}`,
    devWallet: "dev",
    creator: "dev",
    name: "Name",
    symbol: "SYM",
    uri,
    timestampMs: 1_000,
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualQuoteReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    tokenProgram: null,
    quoteMint: "SOL",
    isMayhemMode: false,
    isCashback: false,
    isHolderReward: false,
    creatorFeeBps: 0,
    depth: 1
  };
}

const metadataConfig = { ...defaultStrategyConfig().recorder.metadata, timeoutMs: 200, maxRetries: 2, concurrency: 2 };

describe("ipfs url rewriting", () => {
  it("rewrites ipfs scheme, path gateways and subdomain gateways to the configured gateway", () => {
    expect(rewriteIpfsUrl(`ipfs://${CID_V0}`, GATEWAY)).toBe(`${GATEWAY}${CID_V0}`);
    expect(rewriteIpfsUrl(`ipfs://ipfs/${CID_V0}/meta.json`, GATEWAY)).toBe(`${GATEWAY}${CID_V0}/meta.json`);
    expect(rewriteIpfsUrl(`https://ipfs.io/ipfs/${CID_V0}`, GATEWAY)).toBe(`${GATEWAY}${CID_V0}`);
    expect(rewriteIpfsUrl(`https://cf-ipfs.com/ipfs/${CID_V1}?x=1`, GATEWAY)).toBe(`${GATEWAY}${CID_V1}?x=1`);
    expect(rewriteIpfsUrl(`https://something.mypinata.cloud/ipfs/${CID_V1}`, GATEWAY)).toBe(`${GATEWAY}${CID_V1}`);
    expect(rewriteIpfsUrl(`https://${CID_V1}.ipfs.dweb.link/`, GATEWAY)).toBe(`${GATEWAY}${CID_V1}`);
    expect(rewriteIpfsUrl(`https://${CID_V1}.ipfs.w3s.link/data.json`, GATEWAY)).toBe(`${GATEWAY}${CID_V1}/data.json`);
    expect(rewriteIpfsUrl(CID_V0, GATEWAY)).toBe(`${GATEWAY}${CID_V0}`);
  });

  it("leaves non ipfs urls alone and handles arweave", () => {
    expect(rewriteIpfsUrl("https://metadata.example.com/coin.json", GATEWAY)).toBe("https://metadata.example.com/coin.json");
    expect(rewriteIpfsUrl("ar://abc123", GATEWAY)).toBe("https://arweave.net/abc123");
    expect(rewriteIpfsUrl(`${GATEWAY}${CID_V0}`, GATEWAY)).toBe(`${GATEWAY}${CID_V0}`);
    expect(rewriteIpfsUrl("  ", GATEWAY)).toBe("");
    expect(rewriteIpfsUrl("not a url", GATEWAY)).toBe("not a url");
    expect(rewriteIpfsUrl("https://notacid.ipfs.dweb.link/", GATEWAY)).toBe("https://notacid.ipfs.dweb.link/");
  });

  it("normalizes gateways with a trailing slash", () => {
    expect(normalizeGateway(" https://gw.example/ipfs ")).toBe("https://gw.example/ipfs/");
    expect(rewriteIpfsUrl(`ipfs://${CID_V0}`, "https://gw.example/ipfs")).toBe(`https://gw.example/ipfs/${CID_V0}`);
  });
});

describe("metadata parsing", () => {
  it("reads the standard pump.fun fields", () => {
    const parsed = parseMetadata({
      name: " Coin ",
      symbol: "CN",
      description: "desc",
      image: "https://ipfs.io/ipfs/x",
      twitter: "https://x.com/coin",
      telegram: "",
      website: "https://coin.example",
      showName: true
    });
    expect(parsed).toEqual({
      name: "Coin",
      symbol: "CN",
      description: "desc",
      image: "https://ipfs.io/ipfs/x",
      twitter: "https://x.com/coin",
      telegram: null,
      website: "https://coin.example"
    });
  });

  it("falls back to nested extension fields and alternative keys", () => {
    const parsed = parseMetadata({ name: "N", extensions: { x: "https://x.com/n", telegram: "t.me/n" }, external_url: "https://n.io" });
    expect(parsed.twitter).toBe("https://x.com/n");
    expect(parsed.telegram).toBe("t.me/n");
    expect(parsed.website).toBe("https://n.io");
  });

  it("strips null characters, ignores non strings and rejects non objects", () => {
    const parsed = parseMetadata({ name: `bad${String.fromCharCode(0)}name`, symbol: 5, twitter: ["x"] });
    expect(parsed.name).toBe("badname");
    expect(parsed.symbol).toBeNull();
    expect(parsed.twitter).toBeNull();
    expect(() => parseMetadata([1, 2])).toThrow();
    expect(() => parseMetadata("text")).toThrow();
    expect(() => parseMetadata(null)).toThrow();
  });
});

describe("metadata fetcher", () => {
  it("fetches through the gateway, stores parsed metadata and sets launch state metadata", async () => {
    const { db, queries } = fakeDb();
    const market = new MarketState({ maxTradesPerLaunch: 100, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    market.apply(createEvent("MintA", `ipfs://${CID_V0}`));
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return jsonResponse({ name: "A", twitter: "https://x.com/a", website: "https://a.io", description: "about" });
    };
    const fetcher = new MetadataFetcher({ db, clock: new SystemClock(), market, config: metadataConfig, gatewayOverride: GATEWAY, fetchImpl });
    fetcher.start();
    expect(fetcher.enqueue({ launchId: 11, mint: "MintA", uri: `ipfs://${CID_V0}` })).toBe(true);
    await fetcher.drain();
    expect(urls).toEqual([`${GATEWAY}${CID_V0}`]);
    expect(queries).toHaveLength(1);
    const params = queries[0]?.params ?? [];
    expect(params[0]).toBe(11);
    expect(JSON.parse(String(params[1]))).toMatchObject({ name: "A", twitter: "https://x.com/a", telegram: null });
    expect(params.slice(2, 5)).toEqual([true, false, true]);
    expect(market.get("MintA")?.metadata).toEqual({
      twitter: "https://x.com/a",
      telegram: null,
      website: "https://a.io",
      description: "about"
    });
    expect(fetcher.stats().fetched).toBe(1);
  });

  it("uses the configured gateway when no override is given", () => {
    const { db } = fakeDb();
    const fetcher = new MetadataFetcher({ db, clock: new SystemClock(), config: metadataConfig });
    expect(fetcher.gatewayUrl).toBe(metadataConfig.gateway);
    const overridden = new MetadataFetcher({ db, clock: new SystemClock(), config: metadataConfig, gatewayOverride: "https://o.example/ipfs" });
    expect(overridden.gatewayUrl).toBe("https://o.example/ipfs/");
  });

  it("retries transient failures and stores the error after exhausting retries", async () => {
    const { db, queries } = fakeDb();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse("busy", 503);
    };
    const fetcher = new MetadataFetcher({ db, clock: new SystemClock(), config: metadataConfig, fetchImpl, retryDelayMs: 1 });
    fetcher.start();
    fetcher.enqueue({ launchId: 3, mint: "M", uri: "https://meta.example/a.json" });
    await fetcher.drain();
    expect(calls).toBe(3);
    expect(queries[0]?.sql).toContain("metadata_error");
    expect(queries[0]?.params[2]).toBe("http 503");
    expect(fetcher.stats()).toMatchObject({ failed: 1, retries: 2 });
  });

  it("does not retry permanent failures", async () => {
    const { db, queries } = fakeDb();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return calls === 1 ? jsonResponse("nope", 404) : jsonResponse("{not json");
    };
    const fetcher = new MetadataFetcher({ db, clock: new SystemClock(), config: metadataConfig, fetchImpl, retryDelayMs: 1 });
    fetcher.start();
    fetcher.enqueue({ launchId: 1, mint: "M1", uri: "https://meta.example/1.json" });
    await fetcher.drain();
    fetcher.enqueue({ launchId: 2, mint: "M2", uri: "https://meta.example/2.json" });
    await fetcher.drain();
    expect(calls).toBe(2);
    expect(queries.map((query) => query.params[2])).toEqual(["http 404", "metadata is not valid json"]);
  });

  it("times out slow gateways and rejects oversized or unsupported documents", async () => {
    const { db, queries } = fakeDb();
    const fetchImpl: FetchLike = (url, init) => {
      if (url.includes("slow")) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(jsonResponse({ name: "big" }, 200, { "content-length": "999999999" }));
    };
    const config = { ...metadataConfig, timeoutMs: 30, maxRetries: 0 };
    const fetcher = new MetadataFetcher({ db, clock: new SystemClock(), config, fetchImpl });
    fetcher.start();
    fetcher.enqueue({ launchId: 1, mint: "S", uri: "https://slow.example/a.json" });
    fetcher.enqueue({ launchId: 2, mint: "B", uri: "https://big.example/a.json" });
    fetcher.enqueue({ launchId: 3, mint: "F", uri: "ftp://files.example/a.json" });
    fetcher.enqueue({ launchId: 4, mint: "E", uri: "" });
    await fetcher.drain();
    const errors = new Map(queries.map((query) => [query.params[0], query.params[2]]));
    expect(errors.get(1)).toBe("timeout");
    expect(String(errors.get(2))).toContain("too large");
    expect(String(errors.get(3))).toContain("unsupported protocol");
    expect(errors.get(4)).toBe("empty uri");
  });

  it("respects the concurrency limit and bounded queue", async () => {
    const { db } = fakeDb();
    let active = 0;
    let peak = 0;
    const fetchImpl: FetchLike = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return jsonResponse({ name: "x" });
    };
    const fetcher = new MetadataFetcher({ db, clock: new SystemClock(), config: metadataConfig, fetchImpl, maxQueue: 3 });
    fetcher.start();
    for (let index = 0; index < 10; index += 1) {
      fetcher.enqueue({ launchId: index, mint: `M${index}`, uri: "https://meta.example/x.json" });
    }
    await fetcher.drain();
    expect(peak).toBeLessThanOrEqual(metadataConfig.concurrency);
    expect(fetcher.stats().droppedQueueFull).toBe(5);
    expect(fetcher.stats().fetched).toBe(5);
  });

  it("ignores jobs when disabled or stopped", async () => {
    const { db } = fakeDb();
    const disabled = new MetadataFetcher({ db, clock: new SystemClock(), config: { ...metadataConfig, enabled: false } });
    disabled.start();
    expect(disabled.enqueue({ launchId: 1, mint: "M", uri: "https://x" })).toBe(false);
    const stopped = new MetadataFetcher({ db, clock: new SystemClock(), config: metadataConfig });
    stopped.start();
    await stopped.stop();
    expect(stopped.enqueue({ launchId: 1, mint: "M", uri: "https://x" })).toBe(false);
  });

  it("stops reading a metadata body as soon as it exceeds the size limit", async () => {
    const { db } = fakeDb();
    const chunk = new TextEncoder().encode("a".repeat(16 * 1024));
    let pulled = 0;
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += chunk.byteLength;
            controller.enqueue(chunk);
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetcher = new MetadataFetcher({ db, clock: new SystemClock(), config: { ...metadataConfig, maxRetries: 0 }, fetchImpl, maxBytes: 64 * 1024 });
    fetcher.start();
    await expect(fetcher.fetchWithRetries("https://meta.example/endless.json")).rejects.toThrow(/too large/);
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * chunk.byteLength);
  });

  it("refuses plain http, private addresses and internal hosts without fetching", async () => {
    const { db } = fakeDb();
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return jsonResponse({ name: "x" });
    };
    const fetcher = new MetadataFetcher({ db, clock: new SystemClock(), config: { ...metadataConfig, maxRetries: 0 }, fetchImpl });
    fetcher.start();
    for (const uri of [
      "http://meta.example/a.json",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.1.2.3/a.json",
      "https://100.64.0.9/a.json",
      "https://[::1]/a.json",
      "https://localhost/a.json",
      "https://snypra.railway.internal:8080/api/positions",
      "https://postgres/a.json"
    ]) {
      await expect(fetcher.fetchWithRetries(uri), uri).rejects.toThrow(/refused|unsupported protocol/);
    }
    expect(urls).toEqual([]);
    expect(blockedHostReason("ipfs.io")).toBeNull();
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("172.20.1.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("refuses hosts that resolve to private addresses and redirects to internal hosts", async () => {
    const { db } = fakeDb();
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes("redirect-internal")) {
        return new Response(null, { status: 302, headers: { location: "https://metadata.railway.internal/secret" } });
      }
      if (url.includes("redirect-public")) {
        return new Response(null, { status: 301, headers: { location: "/final.json" } });
      }
      return jsonResponse({ name: "ok", twitter: "https://x.com/ok" });
    };
    const resolveHost = async (host: string): Promise<string[]> => (host === "rebind.example" ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]);
    const fetcher = new MetadataFetcher({ db, clock: new SystemClock(), config: { ...metadataConfig, maxRetries: 0 }, fetchImpl, resolveHost });
    fetcher.start();
    await expect(fetcher.fetchWithRetries("https://rebind.example/a.json")).rejects.toThrow(/refused host/);
    await expect(fetcher.fetchWithRetries("https://cdn.example/redirect-internal.json")).rejects.toThrow(/refused internal host/);
    expect((await fetcher.fetchWithRetries("https://cdn.example/redirect-public.json")).twitter).toBe("https://x.com/ok");
    expect(urls).toEqual([
      "https://cdn.example/redirect-internal.json",
      "https://cdn.example/redirect-public.json",
      "https://cdn.example/final.json"
    ]);
  });

  it("sweeps launches whose metadata was never fetched and skips jobs already queued", async () => {
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("metadata_fetched_at IS NULL")) {
          return { rows: [{ id: "7", mint: "SweptMint", uri: "https://meta.example/7.json" }, { id: "8", mint: "QueuedMint", uri: "https://meta.example/8.json" }], rowCount: 2 };
        }
        return { rows: [], rowCount: 1 };
      }
    } as unknown as Db;
    const fetched: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl: FetchLike = async (url) => {
      fetched.push(url);
      await gate;
      return jsonResponse({ name: "x" });
    };
    const clock = new VirtualClock(0);
    const fetcher = new MetadataFetcher({ db, clock, config: { ...metadataConfig, concurrency: 1 }, fetchImpl, sweepIntervalMs: 60_000 });
    fetcher.start();
    fetcher.enqueue({ launchId: 8, mint: "QueuedMint", uri: "https://meta.example/8.json" });
    await clock.advanceTo(0);
    expect(fetcher.stats()).toMatchObject({ swept: 1, queued: 1, active: 1 });
    release();
    await fetcher.drain();
    expect(fetched.sort()).toEqual(["https://meta.example/7.json", "https://meta.example/8.json"]);
    await fetcher.stop();
  });
});
