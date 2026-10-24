import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/analytics/cache.js";
import { dashboardContentSecurityPolicy, renderDashboardHtml } from "../src/analytics/dashboard.js";
import { DASHBOARD_SCRIPT } from "../src/analytics/dashboardScript.js";
import { DASHBOARD_CSS } from "../src/analytics/dashboardStyle.js";
import { cacheKey, HttpError, parseInteger, parseMint, parseMode, parseTime, toJson, tokensMatch } from "../src/analytics/http.js";
import { PUMP_COIN_URL } from "../src/analytics/positionQueries.js";
import { resolveRoute } from "../src/analytics/routes.js";
import {
  jsonResponse,
  MINT,
  neverResponds,
  PENDING_MINT,
  READ_AT_MS,
  renderTradesView,
  startDashboard,
  tradesFixture,
  type Responder
} from "./analytics.dashboardDom.js";

function inlineBlocks(html: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  return [...html.matchAll(pattern)].map((match) => match[1] ?? "");
}

function hashOf(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

describe("dashboard html", () => {
  const html = renderDashboardHtml();

  it("is self-contained with no external URLs except the pump.fun coin link prefix, script src or stylesheet links", () => {
    expect(html).toContain(`var PUMP_COIN_URL = "${PUMP_COIN_URL}";`);
    expect(html.split(PUMP_COIN_URL)).toHaveLength(2);
    const withoutCoinLinks = html.split(PUMP_COIN_URL).join("");
    expect(withoutCoinLinks).not.toMatch(/https?:/i);
    expect(withoutCoinLinks).not.toMatch(/\/\//);
    expect(DASHBOARD_SCRIPT).toContain('href: PUMP_COIN_URL + encodeURIComponent(mint), target: "_blank", rel: "noopener noreferrer"');
    expect(html).not.toMatch(/<script[^>]*\ssrc\s*=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(DASHBOARD_CSS).not.toMatch(/url\(/i);
    expect(html).not.toContain("${");
  });

  it("is mobile-first and themed for light and dark", () => {
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain(':root[data-theme="dark"]');
    expect(DASHBOARD_CSS).toContain("min-height: 44px");
    expect(DASHBOARD_CSS).toContain("overflow-x: hidden");
    expect(html).toContain("<title>SNYPRA edge</title>");
  });

  it("has every tab, keeps the token in localStorage and sends it as a bearer", () => {
    for (const tab of ["Trades", "Live", "Edge", "Lab", "Breakdowns", "Paper vs Live", "Scorer", "Recorder", "Signals", "Launches", "Wallets"]) {
      expect(DASHBOARD_SCRIPT).toContain(`"${tab}"`);
    }
    expect(DASHBOARD_SCRIPT).toMatch(/var TABS = \[\s*\["trades", "Trades"\], \["live", "Live"\], \["edge", "Edge"\], \["lab", "Lab"\],/);
    expect(DASHBOARD_SCRIPT).toContain("localStorage");
    expect(DASHBOARD_SCRIPT).toContain('"Bearer "');
    expect(DASHBOARD_SCRIPT).toContain('params.get("token")');
    expect(DASHBOARD_SCRIPT).toContain("Run the recorder for two weeks");
  });

  it("opens on the Trades tab and refreshes it every 10 seconds only while the page is visible", () => {
    expect(DASHBOARD_SCRIPT).toMatch(/var TABS = \[\s*\["trades", "Trades"\],/);
    expect(DASHBOARD_SCRIPT).toContain('tab: "trades"');
    expect(DASHBOARD_SCRIPT).toContain('if (prefs.v !== PREFS_VERSION) { prefs.v = PREFS_VERSION; prefs.tab = "trades"; }');
    expect(DASHBOARD_SCRIPT).toContain("var LIVE_REFRESH_MS = 10000;");
    expect(DASHBOARD_SCRIPT).toContain('var LIVE_TABS = { trades: true };');
    expect(DASHBOARD_SCRIPT).toContain('return document.visibilityState === "visible" && !sheetOpen && !locked && !editingIn(dom.main);');
    expect(DASHBOARD_SCRIPT).toContain('api("/api/positions"');
    expect(DASHBOARD_SCRIPT).toContain('"Updated " + fmtDur(');
    expect(DASHBOARD_SCRIPT).toContain("No open positions right now");
    expect(DASHBOARD_SCRIPT).toContain("Recent closed trades");
    expect(DASHBOARD_SCRIPT).not.toContain("Signals need a tracked-wallet ranking");
    expect(DASHBOARD_SCRIPT).toContain("Score momentum fires on a low-risk launch");
  });

  it("renders the Trades view from an api response in a browser-like sandbox", async () => {
    const rendered = await renderTradesView(tradesFixture());
    expect(rendered.text).toContain("Paper run #1");
    expect(rendered.text).toContain("Halted for today");
    expect(rendered.text).toContain("ALPHA");
    expect(rendered.text).toContain("4.00×");
    expect(rendered.text).toContain("+0.1473 SOL");
    expect(rendered.text).toContain("Awaiting fill");
    expect(rendered.text).toContain("Recent closed trades");
    expect(rendered.links).toEqual([`${PUMP_COIN_URL}${MINT}`, `${PUMP_COIN_URL}${PENDING_MINT}`, `${PUMP_COIN_URL}${MINT}`]);
    expect(rendered.authHeaders).toEqual(["Bearer dom-token", "Bearer dom-token"]);
    const fixture = tradesFixture();
    const counts = { ...(fixture.counts as Record<string, unknown>), open: 0, pending: 0, openedLast24h: 0 };
    const empty = await renderTradesView({ ...fixture, open: [], counts });
    expect(empty.text).toContain("No open positions right now");
    expect(empty.text).toContain("score momentum (risk 35 or lower at the 60s checkpoint");
    expect(empty.text).toContain("4 signals in the last 2h, 2 traded; most were skipped for max open positions");
    expect(empty.paths).toEqual(["/api/runs?limit=200", "/api/positions"]);
  });

  it("moves saved preferences from before the Trades tab onto it once, then keeps the chosen tab", async () => {
    const before = JSON.stringify({ tab: "edge", mode: "auto", runId: "", period: "all", checkpoint: "", quote: "" });
    const migrated = await renderTradesView(tradesFixture(), { storage: { "snypra-edge-prefs": before } });
    expect(migrated.paths).toEqual(["/api/runs?limit=200", "/api/positions"]);
    expect(migrated.text).toContain("Paper run #1");
    const chosen = JSON.stringify({ v: "2", tab: "signals", mode: "auto", runId: "", period: "all", checkpoint: "", quote: "", tradesRun: "" });
    const kept = await renderTradesView({ signals: [] }, { storage: { "snypra-edge-prefs": chosen } });
    expect(kept.paths).toEqual(["/api/runs?limit=200", "/api/signals/recent?limit=50"]);
  });

  it("links only base58 mints to pump.fun", async () => {
    const fixture = tradesFixture();
    const open = (fixture.open as Array<Record<string, unknown>>).map((item, index) => (index === 0 ? { ...item, mint: "javascript:alert(1)" } : item));
    const rendered = await renderTradesView({ ...fixture, open, recentClosed: [] });
    expect(rendered.links).toEqual([`${PUMP_COIN_URL}${PENDING_MINT}`]);
    expect(rendered.text).toContain("+0.2973");
    expect(rendered.text).toContain("held 10m");
  });

  it("refreshes the Trades tab every 10 seconds in place, only while visible and not while a control is in use", async () => {
    const fixture = tradesFixture();
    const dashboard = await startDashboard(fixture);
    const positionReads = (): number => dashboard.paths.filter((path) => path === "/api/positions").length;
    expect(positionReads()).toBe(1);
    await dashboard.advance(9_000);
    expect(positionReads()).toBe(1);
    expect(dashboard.updated()).toBe("Updated 9s ago");
    const open = (fixture.open as Array<Record<string, unknown>>).map((item, index) => (index === 0 ? { ...item, multiple: 5.5 } : item));
    dashboard.setResponder((path) => Promise.resolve(jsonResponse(path.startsWith("/api/runs") ? { runs: [], modes: [] } : { ...fixture, open })));
    await dashboard.advance(1_000);
    expect(positionReads()).toBe(2);
    expect(dashboard.view().text).toContain("5.50×");
    expect(dashboard.updated()).toBe("Updated 0s ago");

    dashboard.setVisibility("hidden");
    await dashboard.advance(40_000);
    expect(positionReads()).toBe(2);
    dashboard.setVisibility("visible");
    await dashboard.advance(1_000);
    expect(positionReads()).toBe(3);

    dashboard.setResponder(() => Promise.resolve(jsonResponse({ error: "internal_error", message: "internal error" }, 500)));
    await dashboard.advance(10_000);
    expect(positionReads()).toBe(4);
    expect(dashboard.view().text).toContain("5.50×");
    expect(dashboard.updated()).toContain("retrying");
  });

  it("does not replace a focused control and recovers when a refresh never answers", async () => {
    const fixture = tradesFixture();
    const runs = [
      { id: 2, mode: "paper", label: null, endedAtMs: null },
      { id: 1, mode: "paper", label: "old", endedAtMs: 5 }
    ];
    const respond = (path: string) => Promise.resolve(jsonResponse(path.startsWith("/api/runs") ? { runs, modes: [] } : fixture));
    const dashboard = await startDashboard(fixture);
    dashboard.setResponder(respond);
    const positionReads = (): number => dashboard.paths.filter((path) => path.startsWith("/api/positions")).length;
    await dashboard.advance(60_000);
    const settled = positionReads();
    dashboard.focus("select");
    await dashboard.advance(30_000);
    expect(positionReads()).toBe(settled);
    dashboard.focus(null);
    await dashboard.advance(1_000);
    expect(positionReads()).toBe(settled + 1);

    dashboard.setResponder((path) => (path.startsWith("/api/positions") ? neverResponds() : respond(path)));
    await dashboard.advance(10_000);
    expect(positionReads()).toBe(settled + 2);
    await dashboard.advance(29_000);
    expect(positionReads()).toBe(settled + 2);
    dashboard.setResponder(respond);
    await dashboard.advance(1_000);
    expect(positionReads()).toBe(settled + 3);
    expect(dashboard.view().text).toContain("Paper run #1");
  });

  it("stops refreshing behind the token form until a token is entered", async () => {
    const dashboard = await startDashboard(tradesFixture(), { search: "" });
    dashboard.setResponder(() => Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)));
    await dashboard.advance(10_000);
    expect(dashboard.view().text).toContain("This dashboard is locked");
    const reads = dashboard.paths.length;
    await dashboard.advance(120_000);
    expect(dashboard.paths.length).toBe(reads);
  });

  it("ships a syntactically valid script that never writes untrusted text as HTML", () => {
    expect(() => new Function(DASHBOARD_SCRIPT)).not.toThrow();
    expect(DASHBOARD_SCRIPT).not.toContain("</script");
    const innerHtmlUses = DASHBOARD_SCRIPT.split("innerHTML").length - 1;
    expect(innerHtmlUses).toBe(3);
    expect(DASHBOARD_SCRIPT).toContain("box.innerHTML = markup;");
    expect(DASHBOARD_SCRIPT).not.toMatch(/markup \+= [^;]*(text|symbol|label|name)\b/);
    expect(DASHBOARD_SCRIPT).not.toContain("outerHTML");
    expect(DASHBOARD_SCRIPT).not.toContain("insertAdjacentHTML");
    expect(DASHBOARD_SCRIPT).not.toContain("eval(");
  });

  it("pins the inline script and style in the content security policy", () => {
    const csp = dashboardContentSecurityPolicy();
    const [script] = inlineBlocks(html, "script");
    const [style] = inlineBlocks(html, "style");
    expect(csp).toContain(`script-src ${hashOf(script ?? "")}`);
    expect(csp).toContain(`style-src ${hashOf(style ?? "")}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(DASHBOARD_SCRIPT).toContain('new Source("/api/live/stream" + queryString({ token: token(), strategy: liveStrategyParam() }))');
    expect(csp).not.toContain("unsafe-inline");
    expect(html).not.toMatch(/\sstyle=/);
  });
});

describe("http helpers", () => {
  it("compares tokens by value", () => {
    expect(tokensMatch("secret", "secret")).toBe(true);
    expect(tokensMatch("secret", "secreT")).toBe(false);
    expect(tokensMatch("secret", "secret-longer")).toBe(false);
    expect(tokensMatch("", "secret")).toBe(false);
  });

  it("serialises bigint as a string", () => {
    expect(toJson({ a: 1n, b: [2n], c: 3 })).toBe('{"a":"1","b":["2"],"c":3}');
  });

  it("validates query parameters", () => {
    const params = new URLSearchParams("mode=live&runId=12&from=1700000000000&to=2026-01-01T00:00:00Z&bad=1x");
    expect(parseMode(params)).toBe("live");
    expect(parseMode(new URLSearchParams("mode=all"))).toBeNull();
    expect(() => parseMode(new URLSearchParams("mode=moon"))).toThrow(HttpError);
    expect(parseInteger(params, "runId", { min: 1 })).toBe(12);
    expect(parseInteger(params, "missing")).toBeNull();
    expect(() => parseInteger(params, "bad")).toThrow(HttpError);
    expect(() => parseInteger(new URLSearchParams("n=0"), "n", { min: 1 })).toThrow(HttpError);
    expect(parseInteger(new URLSearchParams("n=5000"), "n", { max: 100 })).toBe(100);
    expect(parseTime(params, "from")).toBe(1_700_000_000_000);
    expect(parseTime(params, "to")).toBe(Date.UTC(2026, 0, 1));
    expect(() => parseTime(new URLSearchParams("from=yesterday"), "from")).toThrow(HttpError);
  });

  it("accepts only base58 mints", () => {
    expect(parseMint("Fq3m4b8uSqVQ6WqJrxR6QAJ5TJqvkbRm5bmV6dXmpump")).toBe("Fq3m4b8uSqVQ6WqJrxR6QAJ5TJqvkbRm5bmV6dXmpump");
    expect(() => parseMint("not-a-mint")).toThrow(HttpError);
    expect(() => parseMint("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")).toThrow(HttpError);
    expect(() => parseMint("%E0%A4%A")).toThrow(HttpError);
  });

  it("builds cache keys without the token and with sorted parameters", () => {
    const a = cacheKey(new URL("http://x.invalid/api/summary?mode=live&token=abc&from=1"));
    const b = cacheKey(new URL("http://x.invalid/api/summary?from=1&mode=live"));
    expect(a).toBe(b);
    expect(a).not.toContain("abc");
  });

  it("resolves api routes including the mint parameter", () => {
    expect(resolveRoute("summary")?.route.kind).toBe("json");
    expect(resolveRoute("export/trades.csv")?.route.kind).toBe("csv");
    expect(resolveRoute("score/Abc")?.segments).toEqual(["Abc"]);
    expect(resolveRoute("score/")).toBeNull();
    expect(resolveRoute("score/a/b")).toBeNull();
    expect(resolveRoute("nope")).toBeNull();
  });
});

describe("TtlCache", () => {
  it("reuses values until they expire and evicts the oldest beyond capacity", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache({ ttlMs: 1_000, maxEntries: 2, now: () => now });
    const load = (value: string) => () => {
      loads += 1;
      return Promise.resolve(value);
    };
    expect(await cache.getOrLoad("a", load("a1"))).toBe("a1");
    expect(await cache.getOrLoad("a", load("a2"))).toBe("a1");
    now = 1_000;
    expect(await cache.getOrLoad("a", load("a3"))).toBe("a3");
    await cache.getOrLoad("b", load("b1"));
    await cache.getOrLoad("c", load("c1"));
    expect(cache.size).toBe(2);
    expect(await cache.getOrLoad("a", load("a4"))).toBe("a4");
    expect(loads).toBe(5);
  });

  it("drops failed loads and bypasses caching when disabled", async () => {
    const cache = new TtlCache({ ttlMs: 1_000, maxEntries: 4, now: () => 0 });
    await expect(cache.getOrLoad("x", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cache.size).toBe(0);
    const disabled = new TtlCache({ ttlMs: 0, maxEntries: 4, now: () => 0 });
    let calls = 0;
    await disabled.getOrLoad("y", async () => (calls += 1));
    await disabled.getOrLoad("y", async () => (calls += 1));
    expect(calls).toBe(2);
    expect(disabled.size).toBe(0);
  });
});

const POSITION = "7-1800000000000-abc";

function liveView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: POSITION,
    mint: MINT,
    symbol: "GEN",
    name: "Genesis",
    mode: "paper",
    signalType: "score_momentum",
    riskScore: 18,
    openedAtMs: READ_AT_MS - 120_000,
    ageSec: 120,
    entryPrice: 0.00005,
    price: 0.0001,
    multiple: 2,
    peakMultiple: 2.2,
    costSol: 0.075,
    proceedsSol: 0,
    pnlEstimateSol: 0.07,
    pnlEstimatePct: 93,
    soldPct: 0,
    takeProfitLevelsHit: 0,
    migrated: false,
    exiting: null,
    lastTradeAtMs: READ_AT_MS - 1_000,
    levels: {
      entryPrice: 0.00005,
      stopLossPrice: 0.0000325,
      trailingStopPrice: 0.0000858,
      moonbagStopPrice: 0.0000605,
      trailFraction: 0.22,
      nextTakeProfit: { multiple: 3, price: 0.00015, sellPctOfInitial: 15 },
      takeProfits: [{ multiple: 3, price: 0.00015, sellPctOfInitial: 15 }],
      timeStopAtMs: null,
      maxHoldAtMs: READ_AT_MS + 3_480_000
    },
    ...overrides
  };
}

function liveEvent(id: number, kind: string, category: string, text: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind, category, tone: kind === "closed" ? "good" : "info", atMs: READ_AT_MS - 1_000 + id, mint: MINT, symbol: "GEN", text, data };
}

function liveResponder(status: Record<string, unknown>): Responder {
  return (path) => {
    if (path.startsWith("/api/runs")) {
      return Promise.resolve(jsonResponse({ runs: [], modes: [] }));
    }
    if (path === "/api/live/status") {
      return Promise.resolve(jsonResponse(status));
    }
    if (path.startsWith("/api/live/events")) {
      const after = Number(new URLSearchParams(path.split("?")[1] ?? "").get("after") ?? "0");
      const events = [liveEvent(1, "score", "score", "Scored $GEN 60s: 18 (clean)"), liveEvent(2, "opened", "trade", "Bought $GEN 0.075 SOL")];
      return Promise.resolve(
        jsonResponse({
          hello: { streamId: "p1", serverTimeMs: READ_AT_MS, tradingActive: true, maxClients: 10, clients: 0, heartbeatMs: 15_000, positions: [] },
          events: events.filter((event) => Number(event.id) > after),
          lastId: 2
        })
      );
    }
    if (path.startsWith("/api/live/position/")) {
      return Promise.resolve(
        jsonResponse({
          position: liveView(),
          fromMs: READ_AT_MS - 180_000,
          totalTrades: 3,
          points: [
            { atMs: READ_AT_MS - 150_000, price: 0.00004 },
            { atMs: READ_AT_MS - 100_000, price: 0.00005 },
            { atMs: READ_AT_MS - 2_000, price: 0.0001 }
          ],
          inMemory: true
        })
      );
    }
    return Promise.resolve(jsonResponse({ error: "not_found", message: "unknown" }, 404));
  };
}

const LIVE_STATUS = { enabled: true, streamId: "s1", clients: 0, maxClients: 10, tradingActive: true, events: 0, lastEventAtMs: null, openPositions: 1, heartbeatMs: 15_000 };

describe("live tab", () => {
  it("streams a status chip, a charted card per open position and a filterable, pausable feed", async () => {
    const dashboard = await startDashboard({}, { hash: "#live", eventSource: true, responder: liveResponder(LIVE_STATUS) });
    expect(dashboard.paths).toContain("/api/live/status");
    expect(dashboard.streams).toHaveLength(1);
    const stream = dashboard.streams[0];
    if (!stream) {
      throw new Error("no stream");
    }
    expect(stream.url).toBe("/api/live/stream?token=dom-token");
    expect(dashboard.find("live-chip")[0]?.textContent).toBe("Connecting…");
    stream.open();
    stream.send("hello", { streamId: "s1", serverTimeMs: READ_AT_MS, tradingActive: true, maxClients: 10, clients: 1, heartbeatMs: 15_000, positions: [liveView()] });
    stream.send("message", liveEvent(1, "score", "score", "Scored $GEN 60s: 18 (clean)"), "s1:1");
    stream.send("message", liveEvent(2, "opened", "trade", "Bought $GEN 0.075 SOL at 2.1x latency 1.1s slippage +1.8% fees 0.0013 SOL"), "s1:2");
    stream.send("message", { ...liveEvent(3, "position", "trade", "$GEN 2.5x"), data: liveView({ multiple: 2.5, price: 0.000125 }) }, "s1:3");
    stream.send("message", liveEvent(2, "opened", "trade", "duplicate replayed event"), "s1:2");
    await dashboard.flush();
    expect(dashboard.find("live-chip")[0]?.textContent).toBe("Live");
    expect(dashboard.paths).toContain(`/api/live/position/${POSITION}/series`);
    const text = (): string => dashboard.view().text;
    expect(text()).toContain("$GEN");
    expect(text()).toContain("2.00×");
    expect(text()).toContain("Exits: stop 0.65× · trailing stop 1.72× · next take-profit 3.00× sells 15%");
    expect(text()).toContain("take-profit");
    expect(text()).not.toContain("duplicate replayed event");
    const feed = (): string[] => dashboard.find("feed-text").map((node) => node.textContent);
    expect(feed()).toEqual(["Bought $GEN 0.075 SOL at 2.1x latency 1.1s slippage +1.8% fees 0.0013 SOL", "Scored $GEN 60s: 18 (clean)"]);
    const chart = dashboard.find("live-chart")[0];
    for (const line of ["lv-price", "lv-entry", "lv-stop", "lv-trail", "lv-tp"]) {
      expect(chart?.innerHTML).toContain(`class="${line}"`);
    }
    expect(chart?.innerHTML).not.toMatch(/style=|GEN/);
    const labels = dashboard.find("lv-label");
    expect(labels.map((node) => node.textContent)).toEqual(["TP 3.00×", "trail 1.72×", "entry 1.00×", "stop 0.65×"]);
    const tops = labels.map((node) => Number.parseFloat(node.style.top ?? ""));
    expect(tops.every((top, index) => index === 0 || top - (tops[index - 1] ?? 0) >= 10)).toBe(true);
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...tops)).toBeLessThanOrEqual(95);

    await dashboard.change("Show", "scores");
    expect(feed()).toEqual(["Scored $GEN 60s: 18 (clean)"]);
    await dashboard.change("Show", "trades");
    expect(feed()).toEqual(["Bought $GEN 0.075 SOL at 2.1x latency 1.1s slippage +1.8% fees 0.0013 SOL"]);
    expect(JSON.parse(dashboard.storage.get("snypra-edge-prefs") ?? "{}")).toMatchObject({ liveFilter: "trades" });
    await dashboard.change("Show", "all");

    await dashboard.click("Pause");
    stream.send("message", { ...liveEvent(4, "rejected", "signal", "Rejected $XYZ: risk 82 above 35"), tone: "neutral" }, "s1:4");
    await dashboard.flush();
    expect(feed()).not.toContain("Rejected $XYZ: risk 82 above 35");
    expect(dashboard.bodyText()).toContain("Resume (1 new)");
    await dashboard.click("Resume");
    expect(feed()[0]).toBe("Rejected $XYZ: risk 82 above 35");

    stream.send("message", liveEvent(5, "closed", "trade", "Closed $GEN: +0.025 SOL (+33.3%), trailing stop after 5m", { positionId: POSITION }), "s1:5");
    await dashboard.flush();
    expect(feed()[0]).toBe("Closed $GEN: +0.025 SOL (+33.3%), trailing stop after 5m");
    expect(text()).not.toContain("Exits:");
    expect(text()).toContain("No open positions.");
  });

  it("keeps rare trade events in the feed while hundreds of scores stream past", async () => {
    const dashboard = await startDashboard({}, { hash: "#live", eventSource: true, responder: liveResponder(LIVE_STATUS) });
    const stream = dashboard.streams[0];
    stream?.open();
    stream?.send("hello", { streamId: "s9", serverTimeMs: READ_AT_MS, tradingActive: true, maxClients: 10, clients: 1, heartbeatMs: 15_000, positions: [] });
    stream?.send("message", liveEvent(1, "closed", "trade", "Closed $OLD: +0.010 SOL (+13.3%), take profit after 4m", { positionId: "gone" }), "s9:1");
    for (let id = 2; id <= 800; id += 1) {
      stream?.send("message", liveEvent(id, "score", "score", `Scored $S${id} 60s: 40 (clean)`), `s9:${id}`);
    }
    await dashboard.flush();
    await dashboard.change("Show", "trades");
    expect(dashboard.find("feed-text").map((node) => node.textContent)).toEqual(["Closed $OLD: +0.010 SOL (+13.3%), take profit after 4m"]);
    await dashboard.change("Show", "scores");
    const scores = dashboard.find("feed-text");
    expect(scores).toHaveLength(300);
    expect(scores[0]?.textContent).toBe("Scored $S800 60s: 40 (clean)");
  });

  it("reconnects after the stream closes or stalls", async () => {
    const dashboard = await startDashboard({}, { hash: "#live", eventSource: true, responder: liveResponder(LIVE_STATUS) });
    const first = dashboard.streams[0];
    first?.open();
    first?.fail(true);
    await dashboard.flush();
    expect(dashboard.find("live-chip")[0]?.textContent).toBe("Offline, retrying in 3s");
    expect(dashboard.updated()).toBe("Offline, retrying in 3s");
    await dashboard.advance(3_000);
    expect(dashboard.streams).toHaveLength(2);
    const second = dashboard.streams[1];
    second?.open();
    second?.send("hello", { streamId: "s2", serverTimeMs: READ_AT_MS + 3_000, tradingActive: true, maxClients: 10, clients: 1, heartbeatMs: 15_000, positions: [] });
    await dashboard.advance(30_000);
    second?.send("heartbeat", { atMs: READ_AT_MS + 33_000, clients: 1, tradingActive: true });
    await dashboard.advance(40_000);
    expect(second?.closed).toBe(false);
    await dashboard.advance(6_000);
    expect(second?.closed).toBe(true);
    await dashboard.advance(3_000);
    expect(dashboard.streams).toHaveLength(3);
  });

  it("falls back to polling when a proxy holds back the event stream", async () => {
    const dashboard = await startDashboard({}, { hash: "#live", eventSource: true, responder: liveResponder(LIVE_STATUS) });
    const stream = dashboard.streams[0];
    stream?.open();
    await dashboard.advance(5_000);
    expect(stream?.closed).toBe(false);
    expect(dashboard.paths.some((path) => path.startsWith("/api/live/events"))).toBe(false);
    await dashboard.advance(2_000);
    expect(stream?.closed).toBe(true);
    expect(dashboard.paths).toContain("/api/live/events?after=0");
    expect(dashboard.find("live-chip")[0]?.textContent).toBe("Live · updates every 2s");
    expect(dashboard.find("feed-text").map((node) => node.textContent)).toEqual(["Bought $GEN 0.075 SOL", "Scored $GEN 60s: 18 (clean)"]);
    await dashboard.advance(2_000);
    expect(dashboard.paths).toContain("/api/live/events?stream=p1&after=2");
    expect(dashboard.find("feed-text")).toHaveLength(2);
    await dashboard.advance(60_000);
    expect(dashboard.streams).toHaveLength(1);
  });

  it("explains when this service has no live stream and opens none", async () => {
    const dashboard = await startDashboard({}, { hash: "#live", eventSource: true, responder: liveResponder({ ...LIVE_STATUS, enabled: false }) });
    expect(dashboard.view().text).toContain("No live stream in this service");
    expect(dashboard.streams).toHaveLength(0);
  });
});

function labFixture(): Record<string, unknown> {
  const run = { id: 2, startedAtMs: READ_AT_MS - 7_200_000, finishedAtMs: READ_AT_MS - 6_600_000, status: "done", error: null, dataFromMs: READ_AT_MS - 266_400_000, dataToMs: READ_AT_MS - 7_200_000, notes: {} };
  const summary = (trades: number, expectancySol: number, low: number, high: number, verdict: string) => ({
    trades,
    wins: Math.round(trades * 0.4),
    winRate: 0.4,
    expectancySol,
    ciLowSol: low,
    ciHighSol: high,
    totalPnlSol: expectancySol * trades,
    maxDrawdownSol: 0.3,
    avgHoldSec: 240,
    verdict,
    exitReasons: []
  });
  return {
    available: true,
    runs: 3,
    latest: { ...run, id: 3, status: "running", finishedAtMs: null, startedAtMs: READ_AT_MS - 300_000 },
    run,
    variants: [
      { id: 6, name: "faster_exits", description: "Tighter trailing stops and an earlier first take-profit.", isBaseline: false, overrides: {}, strategyRunId: 41, summary: summary(118, 0.006, -0.001, 0.013, "no_edge"), error: null, vsBaselineSol: 0.004 },
      { id: 5, name: "baseline", description: "The strategy in config/strategy.json.", isBaseline: true, overrides: {}, strategyRunId: 40, summary: summary(120, 0.002, -0.004, 0.008, "no_edge"), error: null, vsBaselineSol: null },
      { id: 7, name: "broken", description: "", isBaseline: false, overrides: {}, strategyRunId: null, summary: null, error: "replay failed", vsBaselineSol: null }
    ],
    scorer: [
      {
        label: "rugged",
        checkpointSec: 60,
        rows: 2_400,
        positives: 610,
        validationAuc: 0.74,
        baselineAuc: 0.69,
        features: [{ name: "dev_share", auc: 0.68, direction: "higher_riskier", coverage: 1, weight: 1.4 }],
        calibration: [{ bucket: "90-100", n: 80, positiveRate: 0.81 }],
        weightsVersion: "lab-2-rugged-60",
        skipReason: null
      },
      { label: "migrated", checkpointSec: 30, rows: 40, positives: 2, validationAuc: null, baselineAuc: null, features: [], calibration: [], weightsVersion: null, skipReason: "too few positives" }
    ],
    history: [
      { labRunId: 1, startedAtMs: READ_AT_MS - 86_400_000, dataFromMs: null, dataToMs: null, trades: 90, expectancySol: 0.001, ciLowSol: -0.006, ciHighSol: 0.008, totalPnlSol: 0.09 },
      { labRunId: 2, startedAtMs: READ_AT_MS - 7_200_000, dataFromMs: null, dataToMs: null, trades: 120, expectancySol: 0.002, ciLowSol: -0.004, ciHighSol: 0.008, totalPnlSol: 0.24 }
    ],
    takeaway: {
      tone: "warn",
      headline: "Faster exits beat the baseline by +0.004 SOL per trade over 118 trades, not yet significant",
      detail: "faster exits made +0.006 SOL per trade."
    }
  };
}

describe("lab tab", () => {
  function labResponder(lab: Record<string, unknown>): Responder {
    return (path) => Promise.resolve(jsonResponse(path.startsWith("/api/runs") ? { runs: [], modes: [] } : path === "/api/lab" ? lab : { summary: { n: 0 }, points: [] }));
  }

  it("renders the run, takeaway, leaderboard with the baseline highlighted, scorer training and baseline history", async () => {
    const dashboard = await startDashboard({}, { hash: "#lab", responder: labResponder(labFixture()) });
    expect(dashboard.paths).toContain("/api/lab");
    const text = dashboard.view().text;
    for (const expected of [
      "Lab run #2",
      "Run #3 is running now",
      "Faster exits beat the baseline by +0.004 SOL per trade over 118 trades, not yet significant",
      "Strategy leaderboard",
      "faster exits",
      "Tighter trailing stops and an earlier first take-profit.",
      "+0.006",
      "118 trades · win 40% · total +0.708 SOL · max drawdown -0.300",
      "95% range -0.001 to +0.013 · vs baseline +0.004 per trade",
      "No edge yet",
      "replay failed",
      "Scorer: rugged at 60s",
      "Retrained AUC0.740",
      "dev share",
      "riskier when higher",
      "90-100",
      "Skipped: too few positives",
      "Baseline over time"
    ]) {
      expect(text).toContain(expected);
    }
    expect(dashboard.find("baseline")).toHaveLength(1);
    expect(dashboard.find("baseline")[0]?.textContent).toContain("Baseline");
    await dashboard.click("Open in Edge");
    expect(JSON.parse(dashboard.storage.get("snypra-edge-prefs") ?? "{}")).toMatchObject({ runId: "41", mode: "backtest" });
    expect(dashboard.location.hash).toBe("edge");
  });

  it("explains the empty state before the first lab run", async () => {
    const empty = { available: true, runs: 0, latest: null, run: null, variants: [], scorer: [], history: [], takeaway: null };
    const dashboard = await startDashboard({}, { hash: "#lab", responder: labResponder(empty) });
    expect(dashboard.view().text).toContain("No lab run yet");
    expect(dashboard.view().text).toContain("after the lab job has run once");
  });

  it("keeps a lab run chosen from the Lab tab selectable in the Edge run picker", async () => {
    const prefs = JSON.stringify({ v: "2", tab: "edge", mode: "backtest", runId: "41", period: "all", checkpoint: "", quote: "", tradesRun: "", liveFilter: "all" });
    const responder: Responder = (path) =>
      Promise.resolve(
        jsonResponse(
          path.startsWith("/api/runs")
            ? { runs: [{ id: 9, mode: "backtest", label: "bt", closedTrades: 3 }], modes: [] }
            : path.startsWith("/api/summary")
              ? { summary: { n: 0 }, narrative: { tone: "neutral", headline: "No closed trades yet", detail: "" } }
              : { points: [] }
        )
      );
    const dashboard = await startDashboard({}, { storage: { "snypra-edge-prefs": prefs }, responder });
    expect(dashboard.paths).toContain("/api/summary?runId=41");
    expect(dashboard.bodyText()).toContain("#41 (opened from Lab)");
    expect(dashboard.bodyText()).toContain("#9 backtest bt (3)");
  });
});
