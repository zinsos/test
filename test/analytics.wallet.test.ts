import { afterEach, describe, expect, it } from "vitest";
import { startAnalyticsServer, type AnalyticsServer } from "../src/analytics/server.js";
import type { TradingControls, WalletSnapshot } from "../src/analytics/routes.js";
import { SolPriceFeed, type PriceSource } from "../src/analytics/solPrice.js";
import { VirtualClock } from "../src/core/clock.js";
import type { Db } from "../src/db/pool.js";

const TOKEN = "wallet-test-token";
const ADDRESS = "So11111111111111111111111111111111111111112";
const NOW_MS = Date.UTC(2026, 9, 24, 3, 0, 0);
const unusedDb = { query: () => Promise.reject(new Error("no database in this test")) } as unknown as Db;

const servers: AnalyticsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function snapshot(overrides: Partial<WalletSnapshot> = {}): WalletSnapshot {
  return {
    mode: "live",
    address: ADDRESS,
    walletLamports: 442_448_087n,
    equityLamports: 450_000_000n,
    entriesPaused: false,
    killReason: null,
    haltedForDay: false,
    ...overrides
  };
}

function recordingControls(calls: string[]): TradingControls {
  return {
    closeAll: (reason) => {
      calls.push(`close:${reason}`);
      return 2;
    },
    resume: (reason) => {
      calls.push(`resume:${reason}`);
      return true;
    }
  };
}

async function serve(options: { token?: string | null; allowOpen?: boolean; trading?: TradingControls | null }): Promise<string> {
  const server = await startAnalyticsServer({
    db: unusedDb,
    port: 0,
    host: "127.0.0.1",
    token: options.token === undefined ? TOKEN : options.token,
    allowOpen: options.allowOpen ?? false,
    clock: new VirtualClock(NOW_MS),
    wallet: () => snapshot(),
    price: { current: () => Promise.resolve({ usd: 100, source: "test", atMs: NOW_MS - 5_000 }) },
    trading: options.trading === undefined ? null : options.trading
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const bearer = { authorization: `Bearer ${TOKEN}` };

describe("wallet endpoint", () => {
  it("reports the hot wallet in SOL and USD", async () => {
    const base = await serve({ trading: recordingControls([]) });
    const response = await fetch(`${base}/api/wallet`, { headers: bearer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, mode: "live", address: ADDRESS, walletSol: 0.442448087, totalSol: 0.442448087, solUsd: 100, priceSource: "test", canControl: true, entriesPaused: false });
    expect(body.walletUsd).toBeCloseTo(44.2448087, 6);
    expect(body.equitySol).toBe(0.45);
  });
});

describe("dashboard trading actions", () => {
  it("close all and resume need a POST with the bearer token", async () => {
    const calls: string[] = [];
    const base = await serve({ trading: recordingControls(calls) });
    expect((await fetch(`${base}/api/actions/close-all`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/api/actions/close-all?token=${TOKEN}`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/api/actions/close-all`, { headers: bearer })).status).toBe(405);
    expect((await fetch(`${base}/api/wallet`, { method: "POST", headers: bearer })).status).toBe(405);
    expect(calls).toEqual([]);
    const closed = await fetch(`${base}/api/actions/close-all`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: "{}" });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ ok: true, closing: 2, entriesPaused: true });
    const resumed = await fetch(`${base}/api/actions/resume`, { method: "POST", headers: bearer });
    expect(await resumed.json()).toEqual({ ok: true, resumed: true, entriesPaused: false });
    expect(calls).toEqual(["close:dashboard: close all", "resume:dashboard: resume"]);
  });

  it("refuses actions on an open dashboard and when no trader runs", async () => {
    const calls: string[] = [];
    const open = await serve({ token: null, allowOpen: true, trading: recordingControls(calls) });
    expect((await fetch(`${open}/api/actions/close-all`, { method: "POST" })).status).toBe(403);
    expect(calls).toEqual([]);
    const idle = await serve({ trading: null });
    const response = await fetch(`${idle}/api/actions/close-all`, { method: "POST", headers: bearer });
    expect(response.status).toBe(409);
  });
});

describe("SOL price feed", () => {
  function source(name: string, results: Array<number | Error>): PriceSource & { calls: number } {
    const entry = {
      name,
      url: `https://${name}.invalid/price`,
      calls: 0,
      read: (body: unknown) => (typeof body === "number" ? body : null)
    };
    return entry;
  }

  it("falls back to the next source, caches, and keeps the last price when every source fails", async () => {
    const clock = new VirtualClock(NOW_MS);
    const answers = new Map<string, Array<number | Error>>([
      ["https://first.invalid/price", [new Error("down"), 120, new Error("down")]],
      ["https://second.invalid/price", [101.5, new Error("down")]]
    ]);
    const fetched: string[] = [];
    const feed = new SolPriceFeed({
      clock,
      sources: [source("first", []), source("second", [])],
      ttlMs: 60_000,
      retryMs: 15_000,
      fetchJson: (url) => {
        fetched.push(url);
        const next = answers.get(url)?.shift();
        return next instanceof Error || next === undefined ? Promise.reject(next ?? new Error("none")) : Promise.resolve(next);
      }
    });
    expect(await feed.current()).toEqual({ usd: 101.5, source: "second", atMs: NOW_MS });
    expect(await feed.current()).toEqual({ usd: 101.5, source: "second", atMs: NOW_MS });
    expect(fetched).toHaveLength(2);
    await clock.advanceTo(NOW_MS + 61_000);
    expect(await feed.current()).toEqual({ usd: 120, source: "first", atMs: NOW_MS + 61_000 });
    await clock.advanceTo(NOW_MS + 122_000);
    expect(await feed.current()).toEqual({ usd: 120, source: "first", atMs: NOW_MS + 61_000 });
    const attempts = fetched.length;
    await clock.advanceTo(NOW_MS + 130_000);
    expect(await feed.current()).toEqual({ usd: 120, source: "first", atMs: NOW_MS + 61_000 });
    expect(fetched).toHaveLength(attempts);
  });
});
