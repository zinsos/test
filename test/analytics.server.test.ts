import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnalyticsServer, type AnalyticsServer } from "../src/analytics/server.js";
import { VirtualClock } from "../src/core/clock.js";
import type { LaunchScore } from "../src/core/types.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";
import { LIVE_PAIRS, mintAt, NOW_MS, PAPER_TRADES, seedAnalytics, walletAt, type SeededData } from "./analytics.db.js";

const TOKEN = "s3cret-dashboard-token";

interface JsonResponse {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, unknown>;
}

function memoryScore(mint: string): LaunchScore {
  return {
    mint,
    launchId: null,
    checkpointSec: 10,
    computedAtMs: NOW_MS - 2_000,
    slot: 1,
    score: 77,
    hardBlocked: true,
    flags: ["dev_cluster"],
    features: {},
    contributions: {},
    weightsVersion: "mem"
  };
}

describe.skipIf(!hasTestDatabase)("analytics server", () => {
  let database: TestDatabase;
  let seeded: SeededData;
  let server: AnalyticsServer;
  let base = "";

  async function get(path: string, init: RequestInit = {}): Promise<JsonResponse> {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: response.status, headers: response.headers, text, body };
  }

  function authed(path: string, init: RequestInit = {}): Promise<JsonResponse> {
    return get(path, { ...init, headers: { Authorization: `Bearer ${TOKEN}` } });
  }

  beforeAll(async () => {
    database = await createTestDatabase("analytics_server");
    seeded = await seedAnalytics(database.db);
    server = await startAnalyticsServer({
      db: database.db,
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      clock: new VirtualClock(NOW_MS),
      cacheTtlMs: 0,
      scoreLookup: (mint) => (mint === mintAt(1) ? memoryScore(mint) : null),
      extraHealth: () => ({ recorder: { written: 12_345_678_901_234_567_890n, connected: true }, ws: "open" })
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  it("serves the dashboard and health check without auth", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.text).toContain("<title>SNYPRA edge</title>");
    const health = await get("/healthz");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, db: "ok" });
  });

  it("requires the token on every api route", async () => {
    for (const path of ["/api/summary", "/api/runs", `/api/score/${mintAt(0)}`, "/api/export/trades.csv", "/api/nope"]) {
      const response = await get(path);
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("unauthorized");
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
    expect((await get("/api/summary", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await get("/api/summary", { headers: { Authorization: `Basic ${TOKEN}` } })).status).toBe(401);
    expect((await get(`/api/summary?token=${TOKEN}x`)).status).toBe(401);
    expect((await get(`/api/summary?token=${TOKEN}`)).status).toBe(200);
    expect((await authed("/api/summary")).status).toBe(200);
  });

  it("returns the summary with a verdict and narrative", async () => {
    const response = await authed("/api/summary?mode=paper");
    const summary = response.body.summary as Record<string, unknown>;
    expect(summary.n).toBe(PAPER_TRADES);
    expect(summary.verdict).toBe("edge");
    expect(summary.expectancySol).toBeCloseTo(0.02, 9);
    expect((response.body.narrative as Record<string, unknown>).headline).toBe("Edge: +0.020 SOL/trade after fees");
    expect(response.body.filter).toMatchObject({ mode: "paper", runId: null });
    const byRun = await authed(`/api/summary?runId=${seeded.liveRunId}`);
    expect((byRun.body.summary as Record<string, unknown>).n).toBe(LIVE_PAIRS);
    const all = await authed("/api/summary?mode=all&shadows=1");
    expect((all.body.summary as Record<string, unknown>).n).toBe(PAPER_TRADES + 10 + 2 * LIVE_PAIRS);
  });

  it("rejects bad parameters with JSON errors and no stack traces", async () => {
    const badMode = await authed("/api/summary?mode=moon");
    expect(badMode.status).toBe(400);
    expect(badMode.body.error).toBe("invalid_mode");
    expect(badMode.text).not.toContain("at ");
    expect((await authed("/api/summary?from=yesterday")).status).toBe(400);
    expect((await authed("/api/summary?runId=-1")).status).toBe(400);
    expect((await authed("/api/breakdown?by=planet")).body.error).toBe("invalid_by");
    expect((await authed("/api/score/not-a-mint")).status).toBe(400);
  });

  it("returns breakdowns for one or every dimension", async () => {
    const one = await authed("/api/breakdown?mode=paper&by=riskBucket");
    const rows = (one.body.breakdown as { rows: Array<{ key: string; n: number }> }).rows;
    expect(rows.map((row) => row.key)).toEqual(["0-10", "10-20", "20-30", "unscored"]);
    expect(rows.every((row) => row.n === 30)).toBe(true);
    const all = await authed("/api/breakdown?mode=paper");
    expect((all.body.breakdowns as unknown[]).length).toBe(6);
  });

  it("returns an equity series", async () => {
    const response = await authed("/api/equity?mode=paper&points=20");
    const points = response.body.points as Array<{ equitySol: number }>;
    expect(points.length).toBeLessThanOrEqual(20);
    expect(points[points.length - 1]?.equitySol).toBeCloseTo(2.4, 9);
  });

  it("compares live against paper shadows", async () => {
    const response = await authed("/api/compare");
    const comparison = response.body.comparison as Record<string, unknown>;
    expect(comparison.n).toBe(LIVE_PAIRS);
    expect(comparison.verdict).toBe("paper_too_optimistic");
    expect((response.body.narrative as Record<string, unknown>).tone).toBe("bad");
    const byMode = response.body.byMode as Array<{ mode: string; n: number }>;
    expect(byMode.map((item) => [item.mode, item.n])).toEqual([
      ["live", LIVE_PAIRS],
      ["paper", PAPER_TRADES]
    ]);
  });

  it("lists runs and modes", async () => {
    const response = await authed("/api/runs");
    expect((response.body.runs as unknown[]).length).toBe(3);
    expect((response.body.modes as Array<{ mode: string }>).map((mode) => mode.mode).sort()).toEqual(["backtest", "live", "paper"]);
  });

  it("serves scores from memory first, then the database, and 404s unknown mints", async () => {
    const fromDb = await authed(`/api/score/${mintAt(0)}`);
    expect(fromDb.status).toBe(200);
    expect(fromDb.body).toMatchObject({ source: "db", checkpointSec: 60, score: 12, hardBlocked: false, mint: mintAt(0) });
    expect(fromDb.body.ageMs).toBe(NOW_MS - (NOW_MS - 72 * 3_600_000 + 60_000));
    const fromMemory = await authed(`/api/score/${mintAt(1)}`);
    expect(fromMemory.body).toMatchObject({ source: "memory", score: 77, hardBlocked: true, ageMs: 2_000 });
    const missing = await authed(`/api/score/${mintAt(40)}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_scored");
  });

  it("lists recent signals, launches and tracked wallets", async () => {
    const signals = (await authed("/api/signals/recent?limit=2")).body.signals as Array<{ symbol: string }>;
    expect(signals.map((signal) => signal.symbol)).toEqual(["SYM2", "SYM1"]);
    const launches = (await authed("/api/launches/recent?limit=3")).body.launches as Array<{ mint: string }>;
    expect(launches).toHaveLength(3);
    expect(launches[0]?.mint).toBe(mintAt(7));
    const wallets = await authed("/api/wallets/tracked");
    expect((wallets.body.wallets as Array<{ wallet: string }>).map((wallet) => wallet.wallet)).toEqual([walletAt(1), walletAt(3), walletAt(2)]);
  });

  it("returns scorer calibration with a default checkpoint", async () => {
    const response = await authed("/api/scorer/calibration");
    expect(response.body.checkpointSec).toBe(60);
    expect(response.body.checkpoints).toEqual([30, 60]);
    expect((response.body.buckets as unknown[]).length).toBe(6);
    expect((response.body.assessment as Record<string, unknown>).verdict).toBe("insufficient_data");
    const at30 = await authed("/api/scorer/calibration?checkpoint=30&quote=SOL");
    expect(at30.body.checkpointSec).toBe(30);
    expect(at30.body.quoteMint).toBe("SOL");
  });

  it("reports recorder health with process stats and serialises bigint", async () => {
    const response = await authed("/api/recorder/health");
    expect(response.status).toBe(200);
    expect(response.body.launchesLast24h).toBe(4);
    expect(response.body.lastTradeAgeSec).toBeCloseTo(30, 6);
    expect((response.body.narrative as Record<string, unknown>).headline).toBe("Recording for 3.0 days");
    expect(response.body.process).toEqual({ recorder: { written: "12345678901234567890", connected: true }, ws: "open" });
    expect(response.text).toContain('"written":"12345678901234567890"');
  });

  it("streams CSV exports with the right content type", async () => {
    const trades = await authed("/api/export/trades.csv?mode=paper");
    expect(trades.status).toBe(200);
    expect(trades.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(trades.headers.get("content-disposition")).toBe('attachment; filename="trades.csv"');
    const lines = trades.text.trim().split("\n");
    expect(lines[0]?.startsWith("position_id,run_id,mode,mint")).toBe(true);
    expect(lines).toHaveLength(1 + PAPER_TRADES);
    const dataset = await authed("/api/export/scorer-dataset.csv?checkpoint=60");
    expect(dataset.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(dataset.text.trim().split("\n")).toHaveLength(1 + 4);
    const withYoung = await authed("/api/export/scorer-dataset.csv?checkpoint=60&all=1");
    expect(withYoung.text.trim().split("\n")).toHaveLength(1 + 7);
    expect(dataset.text.split("\n")[0]).toContain("f_age_sec,f_dev_share,f_mcap_multiple,f_z_extra");
    const head = await fetch(`${base}/api/export/trades.csv`, { method: "HEAD", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect((await authed("/api/export/scorer-dataset.csv?checkpoint=abc")).status).toBe(400);
  });

  it("returns JSON 404s and 405s", async () => {
    const unknownApi = await authed("/api/nope");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.body.error).toBe("not_found");
    const unknownPage = await get("/nope");
    expect(unknownPage.status).toBe(404);
    expect(unknownPage.headers.get("content-type")).toContain("application/json");
    const post = await get("/api/summary", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((await get("/favicon.ico")).status).toBe(204);
  });
});

describe.skipIf(!hasTestDatabase)("analytics server without a token", () => {
  let database: TestDatabase;
  let server: AnalyticsServer;

  beforeAll(async () => {
    database = await createTestDatabase("analytics_open");
    server = await startAnalyticsServer({ db: database.db, port: 0, host: "127.0.0.1", token: "", allowOpen: true, cacheTtlMs: 0 });
  });

  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  it("refuses api access without a token unless open access is allowed, and keeps a set token required", async () => {
    let ready = false;
    const closed = await startAnalyticsServer({ db: database.db, port: 0, host: "127.0.0.1", token: null, cacheTtlMs: 0, ready: () => ready });
    const guarded = await startAnalyticsServer({ db: database.db, port: 0, host: "127.0.0.1", token: "a-token-that-stays-required", allowOpen: true, cacheTtlMs: 0 });
    try {
      expect((await fetch(`http://127.0.0.1:${closed.port}/api/summary`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${guarded.port}/api/summary`)).status).toBe(401);
      const notReady = await fetch(`http://127.0.0.1:${closed.port}/healthz`);
      expect(notReady.status).toBe(503);
      expect(await notReady.json()).toMatchObject({ ok: false, db: "ok", ready: false });
      ready = true;
      const healthy = await fetch(`http://127.0.0.1:${closed.port}/healthz`);
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toMatchObject({ ok: true, ready: true });
    } finally {
      await closed.close();
      await guarded.close();
    }
  });

  it("allows api access and handles an empty database", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const summary = (await (await fetch(`${base}/api/summary`)).json()) as { summary: { n: number }; narrative: { headline: string } };
    expect(summary.summary.n).toBe(0);
    expect(summary.narrative.headline).toBe("No closed trades yet");
    const calibration = (await (await fetch(`${base}/api/scorer/calibration`)).json()) as { checkpoints: number[]; buckets: unknown[] };
    expect(calibration.checkpoints).toEqual([]);
    expect(calibration.buckets).toEqual([]);
    const health = (await (await fetch(`${base}/api/recorder/health`)).json()) as { recordingDays: number | null; process: unknown };
    expect(health.recordingDays).toBeNull();
    expect(health.process).toBeNull();
    const wallets = (await (await fetch(`${base}/api/wallets/tracked`)).json()) as { run: unknown; wallets: unknown[] };
    expect(wallets).toEqual({ run: null, wallets: [] });
    const csv = await fetch(`${base}/api/export/scorer-dataset.csv`);
    expect((await csv.text()).trim().split("\n")).toHaveLength(1);
  });
});
