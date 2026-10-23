import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/analytics/cache.js";
import { dashboardContentSecurityPolicy, renderDashboardHtml } from "../src/analytics/dashboard.js";
import { DASHBOARD_SCRIPT } from "../src/analytics/dashboardScript.js";
import { DASHBOARD_CSS } from "../src/analytics/dashboardStyle.js";
import { cacheKey, HttpError, parseInteger, parseMint, parseMode, parseTime, toJson, tokensMatch } from "../src/analytics/http.js";
import { resolveRoute } from "../src/analytics/routes.js";

function inlineBlocks(html: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  return [...html.matchAll(pattern)].map((match) => match[1] ?? "");
}

function hashOf(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

describe("dashboard html", () => {
  const html = renderDashboardHtml();

  it("is self-contained with no external URLs, script src or stylesheet links", () => {
    expect(html).not.toMatch(/https?:/i);
    expect(html).not.toMatch(/\/\//);
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
    for (const tab of ["Edge", "Breakdowns", "Paper vs Live", "Scorer", "Recorder", "Signals", "Launches", "Wallets"]) {
      expect(DASHBOARD_SCRIPT).toContain(`"${tab}"`);
    }
    expect(DASHBOARD_SCRIPT).toContain("localStorage");
    expect(DASHBOARD_SCRIPT).toContain('"Bearer "');
    expect(DASHBOARD_SCRIPT).toContain('params.get("token")');
    expect(DASHBOARD_SCRIPT).toContain("Run the recorder for two weeks");
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
