import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/analytics/cache.js";
import { dashboardContentSecurityPolicy, renderDashboardHtml } from "../src/analytics/dashboard.js";
import { DASHBOARD_SCRIPT } from "../src/analytics/dashboardScript.js";
import { DASHBOARD_CSS } from "../src/analytics/dashboardStyle.js";
import { cacheKey, HttpError, parseInteger, parseMint, parseMode, parseTime, toJson, tokensMatch } from "../src/analytics/http.js";
import { PUMP_COIN_URL } from "../src/analytics/positionQueries.js";
import { resolveRoute } from "../src/analytics/routes.js";
import { jsonResponse, MINT, neverResponds, PENDING_MINT, renderTradesView, startDashboard, tradesFixture } from "./analytics.dashboardDom.js";

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
    for (const tab of ["Trades", "Edge", "Breakdowns", "Paper vs Live", "Scorer", "Recorder", "Signals", "Launches", "Wallets"]) {
      expect(DASHBOARD_SCRIPT).toContain(`"${tab}"`);
    }
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
    await dashboard.advance(19_000);
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
    expect(innerHtmlUses).toBe(2);
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
