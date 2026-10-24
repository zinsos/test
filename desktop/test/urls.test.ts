import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  externalHttpsUrl,
  isBlobOfOrigin,
  isSameOrigin,
  isValidToken,
  parseDashboardUrl,
  requestOriginOf,
  webVersionUrl,
  withDashboardAuthorization
} from "../src/urls.js";

describe("parseDashboardUrl", () => {
  it("keeps only the origin of an https address", () => {
    assert.deepEqual(parseDashboardUrl("  https://Alpha-Beta.trycloudflare.com/some/path#trades "), {
      ok: true,
      origin: "https://alpha-beta.trycloudflare.com",
      tokenFromUrl: null
    });
  });

  it("adds https to a bare host", () => {
    const parsed = parseDashboardUrl("alpha.example.com");
    assert.equal(parsed.ok && parsed.origin, "https://alpha.example.com");
  });

  it("pulls a token out of a pasted ?token= link", () => {
    const parsed = parseDashboardUrl("https://alpha.example.com/?token=abc-123");
    assert.equal(parsed.ok && parsed.tokenFromUrl, "abc-123");
  });

  it("allows plain http only on loopback", () => {
    assert.equal(parseDashboardUrl("http://127.0.0.1:8790").ok, true);
    assert.equal(parseDashboardUrl("http://localhost:8790").ok, true);
    assert.equal(parseDashboardUrl("http://[::1]:8790").ok, true);
    assert.equal(parseDashboardUrl("http://alpha.example.com").ok, false);
    assert.equal(parseDashboardUrl("http://192.168.1.5:8790").ok, false);
  });

  it("refuses other schemes, credentials and empty input", () => {
    assert.equal(parseDashboardUrl("").ok, false);
    assert.equal(parseDashboardUrl("file:///etc/passwd").ok, false);
    assert.equal(parseDashboardUrl("javascript:alert(1)").ok, false);
    assert.equal(parseDashboardUrl("https://user:pass@alpha.example.com").ok, false);
    assert.equal(parseDashboardUrl(`https://${"a".repeat(3000)}.com`).ok, false);
  });
});

describe("tokens", () => {
  it("accepts printable tokens and refuses whitespace or control characters", () => {
    assert.equal(isValidToken("test-token-0123456789"), true);
    assert.equal(isValidToken(""), false);
    assert.equal(isValidToken("has space"), false);
    assert.equal(isValidToken("line\nbreak"), false);
    assert.equal(isValidToken("x".repeat(513)), false);
  });
});

describe("dashboard authorization header", () => {
  const origin = "https://alpha.example.com";
  const token = "test-token-0123456789";

  it("adds the bearer token to requests for the dashboard origin and replaces any page header", () => {
    const headers = withDashboardAuthorization(`${origin}/api/live/stream`, { Accept: "text/event-stream", authorization: "Bearer page-token" }, origin, token);
    assert.deepEqual(headers, { Accept: "text/event-stream", Authorization: `Bearer ${token}` });
  });

  it("never sends the token to another origin or scheme", () => {
    const page = { Accept: "application/json" };
    assert.deepEqual(withDashboardAuthorization("https://evil.example.com/api/rpc", page, origin, token), page);
    assert.deepEqual(withDashboardAuthorization("http://alpha.example.com/api/rpc", page, origin, token), page);
    assert.deepEqual(withDashboardAuthorization("https://alpha.example.com.evil.example/api", page, origin, token), page);
    assert.deepEqual(withDashboardAuthorization("data:text/plain,hi", page, origin, token), page);
  });

  it("leaves headers alone without a usable token", () => {
    const page = { Authorization: "Bearer page-token" };
    assert.deepEqual(withDashboardAuthorization(`${origin}/api/rpc`, page, origin, null), page);
    assert.deepEqual(withDashboardAuthorization(`${origin}/api/rpc`, page, origin, "bad\r\nX-Injected: 1"), page);
  });

  it("maps websocket urls to their http origin", () => {
    assert.equal(requestOriginOf("wss://alpha.example.com/socket"), origin);
    assert.equal(requestOriginOf("ws://127.0.0.1:8790/socket"), "http://127.0.0.1:8790");
    assert.equal(requestOriginOf("blob:https://alpha.example.com/2f0c"), null);
  });
});

describe("navigation rules", () => {
  const origin = "https://alpha.example.com";

  it("matches same-origin urls only", () => {
    assert.equal(isSameOrigin("https://alpha.example.com/#lab", origin), true);
    assert.equal(isSameOrigin("https://alpha.example.com:443/api", origin), true);
    assert.equal(isSameOrigin("http://alpha.example.com/", origin), false);
    assert.equal(isSameOrigin("https://evil.example.com/", origin), false);
    assert.equal(isSameOrigin("not a url", origin), false);
  });

  it("recognises blob downloads made by the dashboard", () => {
    assert.equal(isBlobOfOrigin("blob:https://alpha.example.com/2f0c", origin), true);
    assert.equal(isBlobOfOrigin("blob:https://evil.example.com/2f0c", origin), false);
    assert.equal(isBlobOfOrigin("https://alpha.example.com/x", origin), false);
  });

  it("opens only https links externally and never forwards a token", () => {
    assert.equal(externalHttpsUrl("https://pump.fun/coin/abc"), "https://pump.fun/coin/abc");
    assert.equal(externalHttpsUrl("https://alpha.example.com/?token=secret&tab=lab"), "https://alpha.example.com/?tab=lab");
    assert.equal(externalHttpsUrl("http://pump.fun/"), null);
    assert.equal(externalHttpsUrl("file:///C:/Windows/system32/calc.exe"), null);
    assert.equal(externalHttpsUrl("ms-settings:"), null);
  });

  it("offers a web version only for https dashboards", () => {
    assert.equal(webVersionUrl(origin), "https://alpha.example.com/");
    assert.equal(webVersionUrl("http://127.0.0.1:8790"), null);
  });
});
