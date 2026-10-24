import { isQuickTunnelHost } from "./urls.js";

export interface ProbeResponse {
  status: number;
  text(): Promise<string>;
}

export type ProbeFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<ProbeResponse>;

export type ProbeCode =
  | "tunnel_gone"
  | "unreachable"
  | "refused"
  | "offline"
  | "timeout"
  | "tls"
  | "not_dashboard"
  | "token_rejected"
  | "token_required"
  | "server_error";

export type ProbeResult =
  | { ok: true; warning: string | null }
  | { ok: false; field: "url" | "token"; code: ProbeCode; message: string };

export type HealthState = "online" | "degraded" | "offline";

export interface HealthResult {
  state: HealthState;
  code: ProbeCode | null;
  message: string;
}

interface Fetched {
  status: number;
  body: unknown;
}

type FetchOutcome = { ok: true; value: Fetched } | { ok: false; code: ProbeCode; message: string };

const MAX_BODY_CHARS = 64 * 1024;
const TUNNEL_ERROR_STATUSES = new Set([502, 504, 521, 522, 523, 524, 530]);
const TUNNEL_HINT = "Quick tunnel addresses change every time the tunnel restarts: copy the current address from the server and paste it here.";

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === "string") {
        parts.push(code);
      }
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      current = null;
    }
  }
  return parts.join(" ");
}

export function classifyNetworkError(error: unknown, origin: string, timedOut: boolean, timeoutMs: number): { code: ProbeCode; message: string } {
  const text = errorText(error);
  if (timedOut || /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|TimeoutError/.test(text)) {
    const waited = timeoutMs > 0 ? `No answer within ${Math.round(timeoutMs / 1000)} seconds.` : "The server took too long to answer.";
    return { code: "timeout", message: `${waited} The server or tunnel may be down.` };
  }
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(text)) {
    return { code: "offline", message: "This computer looks offline. Check the internet connection." };
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_NAME_RESOLUTION_FAILED/.test(text)) {
    return isQuickTunnelHost(origin)
      ? { code: "tunnel_gone", message: `This tunnel address no longer exists. ${TUNNEL_HINT}` }
      : { code: "unreachable", message: "This address does not resolve. Check the spelling." };
  }
  if (/redirect/i.test(text)) {
    return { code: "not_dashboard", message: "This address redirects somewhere else. Use the dashboard's own address." };
  }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(text)) {
    return { code: "refused", message: "Nothing is listening at this address. Is the server running?" };
  }
  if (/ERR_CERT|ERR_SSL|CERT_|SSL|self[- ]signed|UNABLE_TO_VERIFY/i.test(text)) {
    return { code: "tls", message: "The HTTPS certificate is not valid for this address." };
  }
  return { code: "unreachable", message: "Could not reach the server. Check the address and that the server is running." };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function fetchJson(fetcher: ProbeFetch, url: string, origin: string, headers: Record<string, string>, timeoutMs: number): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { headers: { Accept: "application/json", "Cache-Control": "no-cache", ...headers }, signal: controller.signal });
    const text = (await response.text()).slice(0, MAX_BODY_CHARS);
    return { ok: true, value: { status: response.status, body: parseJson(text) } };
  } catch (error) {
    return { ok: false, ...classifyNetworkError(error, origin, controller.signal.aborted, timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHealthBody(body: unknown): body is { ok: boolean; db?: unknown; ready?: unknown } {
  return isRecord(body) && typeof body.ok === "boolean" && "db" in body;
}

export function classifyHttpStatus(origin: string, status: number): { code: ProbeCode; message: string } {
  if (TUNNEL_ERROR_STATUSES.has(status) && isQuickTunnelHost(origin)) {
    return { code: "tunnel_gone", message: `The tunnel answered HTTP ${status}: it is no longer connected to the server. ${TUNNEL_HINT}` };
  }
  if (TUNNEL_ERROR_STATUSES.has(status)) {
    return { code: "server_error", message: `The address answered HTTP ${status}: the server behind it is not reachable right now.` };
  }
  return { code: "not_dashboard", message: `This address answers (HTTP ${status}), but it is not a snypra-edge dashboard.` };
}

export async function checkHealth(fetcher: ProbeFetch, origin: string, timeoutMs: number): Promise<HealthResult> {
  const outcome = await fetchJson(fetcher, `${origin}/healthz`, origin, {}, timeoutMs);
  if (!outcome.ok) {
    return { state: "offline", code: outcome.code, message: outcome.message };
  }
  const { status, body } = outcome.value;
  if ((status === 200 || status === 503) && isHealthBody(body)) {
    if (body.ok) {
      return { state: "online", code: null, message: "Connected" };
    }
    const message = body.db !== "ok" ? "Connected, but the server cannot reach its database." : "Connected, the server is still starting.";
    return { state: "degraded", code: "server_error", message };
  }
  const failure = classifyHttpStatus(origin, status);
  return { state: "offline", code: failure.code, message: failure.message };
}

export async function probeDashboard(fetcher: ProbeFetch, origin: string, token: string | null, timeoutMs: number): Promise<ProbeResult> {
  const health = await checkHealth(fetcher, origin, timeoutMs);
  if (health.state === "offline") {
    return { ok: false, field: "url", code: health.code ?? "unreachable", message: health.message };
  }
  const headers: Record<string, string> = token === null ? {} : { Authorization: `Bearer ${token}` };
  const outcome = await fetchJson(fetcher, `${origin}/api/rpc`, origin, headers, timeoutMs);
  if (!outcome.ok) {
    return { ok: false, field: "url", code: outcome.code, message: outcome.message };
  }
  const { status, body } = outcome.value;
  const warning = health.state === "degraded" ? health.message : null;
  if (status === 200 && isRecord(body)) {
    return { ok: true, warning };
  }
  if (status === 404 && isRecord(body) && body.error === "not_found") {
    return { ok: true, warning };
  }
  if (status === 401 || status === 403) {
    return token === null
      ? { ok: false, field: "token", code: "token_required", message: "This dashboard needs a token. Paste the dashboard token." }
      : { ok: false, field: "token", code: "token_rejected", message: "The server rejected this token. Check it and try again." };
  }
  if (status >= 500) {
    return { ok: false, field: "url", code: "server_error", message: `The server failed to answer (HTTP ${status}). Try again in a moment.` };
  }
  return { ok: false, field: "url", ...classifyHttpStatus(origin, status) };
}
