import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkHealth, probeDashboard, type ProbeFetch } from "../src/probe.js";

interface Reply {
  status: number;
  body: string;
}

type Route = Reply | Error | ((headers: Record<string, string>) => Reply);

function fakeFetch(routes: Record<string, Route>, seen: Array<{ url: string; headers: Record<string, string> }> = []): ProbeFetch {
  return async (url, init) => {
    seen.push({ url, headers: init.headers });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (route === undefined) {
      return { status: 404, text: async () => '{"error":"not_found"}' };
    }
    if (route instanceof Error) {
      throw route;
    }
    const reply = typeof route === "function" ? route(init.headers) : route;
    return { status: reply.status, text: async () => reply.body };
  };
}

const HEALTHY: Reply = { status: 200, body: '{"ok":true,"db":"ok","ready":true,"uptimeSec":12}' };
const TOKEN = "test-token-0123456789";
const authorized = (headers: Record<string, string>): Reply =>
  headers.Authorization === `Bearer ${TOKEN}` ? { status: 200, body: '{"configured":true}' } : { status: 401, body: '{"error":"unauthorized"}' };

describe("probeDashboard", () => {
  it("passes with a healthy server and the right token, sending the token only as a bearer header", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const result = await probeDashboard(fakeFetch({ "/healthz": HEALTHY, "/api/rpc": authorized }, seen), "https://alpha.example.com", TOKEN, 1000);
    assert.deepEqual(result, { ok: true, warning: null });
    assert.deepEqual(seen.map((entry) => entry.url), ["https://alpha.example.com/healthz", "https://alpha.example.com/api/rpc"]);
    assert.equal(seen[0]?.headers.Authorization, undefined);
    assert.ok(seen.every((entry) => !entry.url.includes(TOKEN)));
  });

  it("reports a wrong token against the token field", async () => {
    const result = await probeDashboard(fakeFetch({ "/healthz": HEALTHY, "/api/rpc": authorized }), "https://alpha.example.com", "wrong", 1000);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.field, "token");
    assert.equal(!result.ok && result.code, "token_rejected");
  });

  it("asks for a token when none was given and the server requires one", async () => {
    const result = await probeDashboard(fakeFetch({ "/healthz": HEALTHY, "/api/rpc": authorized }), "https://alpha.example.com", null, 1000);
    assert.equal(!result.ok && result.code, "token_required");
  });

  it("treats an authorised 404 from an older server as success", async () => {
    const result = await probeDashboard(fakeFetch({ "/healthz": HEALTHY }), "https://alpha.example.com", TOKEN, 1000);
    assert.deepEqual(result, { ok: true, warning: null });
  });

  it("explains a dead quick tunnel", async () => {
    const dns = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
    const gone = await probeDashboard(fakeFetch({ "/healthz": dns }), "https://old-name.trycloudflare.com", TOKEN, 1000);
    assert.equal(!gone.ok && gone.code, "tunnel_gone");
    assert.equal(!gone.ok && gone.field, "url");
    const cloudflare = await probeDashboard(fakeFetch({ "/healthz": { status: 530, body: "<html>error 1033</html>" } }), "https://old-name.trycloudflare.com", TOKEN, 1000);
    assert.equal(!cloudflare.ok && cloudflare.code, "tunnel_gone");
    const electronDns = await probeDashboard(fakeFetch({ "/healthz": new Error("net::ERR_NAME_NOT_RESOLVED") }), "https://old-name.trycloudflare.com", TOKEN, 1000);
    assert.equal(!electronDns.ok && electronDns.code, "tunnel_gone");
  });

  it("names refused connections, timeouts and foreign servers", async () => {
    const refused = await probeDashboard(fakeFetch({ "/healthz": new Error("net::ERR_CONNECTION_REFUSED") }), "http://127.0.0.1:8790", TOKEN, 1000);
    assert.equal(!refused.ok && refused.code, "refused");
    const slow: ProbeFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const timeout = await probeDashboard(slow, "https://alpha.example.com", TOKEN, 20);
    assert.equal(!timeout.ok && timeout.code, "timeout");
    const foreign = await probeDashboard(fakeFetch({ "/healthz": { status: 200, body: "<html>hello</html>" } }), "https://alpha.example.com", TOKEN, 1000);
    assert.equal(!foreign.ok && foreign.code, "not_dashboard");
  });

  it("saves with a warning when the server is up but its database is not", async () => {
    const result = await probeDashboard(
      fakeFetch({ "/healthz": { status: 503, body: '{"ok":false,"db":"unreachable","ready":true}' }, "/api/rpc": authorized }),
      "https://alpha.example.com",
      TOKEN,
      1000
    );
    assert.equal(result.ok, true);
    assert.match(result.ok ? (result.warning ?? "") : "", /database/);
  });
});

describe("checkHealth", () => {
  it("maps answers to toolbar states", async () => {
    assert.equal((await checkHealth(fakeFetch({ "/healthz": HEALTHY }), "https://alpha.example.com", 1000)).state, "online");
    assert.equal(
      (await checkHealth(fakeFetch({ "/healthz": { status: 503, body: '{"ok":false,"db":"ok","ready":false}' } }), "https://alpha.example.com", 1000)).state,
      "degraded"
    );
    assert.equal((await checkHealth(fakeFetch({ "/healthz": new Error("net::ERR_INTERNET_DISCONNECTED") }), "https://alpha.example.com", 1000)).code, "offline");
  });
});
