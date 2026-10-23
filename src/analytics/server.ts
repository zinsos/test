import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SystemClock, type Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Db } from "../db/pool.js";
import { TtlCache } from "./cache.js";
import { dashboardContentSecurityPolicy, renderDashboardHtml } from "./dashboard.js";
import { HttpError, isAuthorized, sendEmpty, sendHtml, sendJson, startCsv, writeChunk } from "./http.js";
import {
  DEFAULT_ANALYTICS_SETTINGS,
  resolveRoute,
  runJsonRoute,
  type AnalyticsContext,
  type AnalyticsSettings,
  type ApiRequest,
  type CsvRoute,
  type ExtraHealth,
  type ScoreLookup
} from "./routes.js";

const log = moduleLogger("analytics");

export const DEFAULT_CACHE_TTL_MS = 15_000;
export const DEFAULT_CACHE_MAX_ENTRIES = 64;
const HEALTH_TIMEOUT_MS = 3_000;
const API_PREFIX = "/api/";
const URL_BASE = "http://analytics.invalid";

export interface AnalyticsServerOptions {
  db: Db;
  port: number;
  host?: string;
  token?: string | null;
  scoreLookup?: ScoreLookup | null;
  extraHealth?: ExtraHealth | null;
  clock?: Clock;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  settings?: Partial<AnalyticsSettings>;
}

export interface AnalyticsServer {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

export type AnalyticsRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface PageAssets {
  html: string;
  csp: string;
}

function normalizedPath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

async function pingDatabase(db: Db): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS);
    timer.unref?.();
  });
  const ping = db
    .query("SELECT 1")
    .then(() => true)
    .catch(() => false);
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function sendHealth(ctx: AnalyticsContext, res: ServerResponse, startedAtMs: number): Promise<void> {
  const databaseUp = await pingDatabase(ctx.db);
  const uptimeSec = Math.max(0, (ctx.clock.nowMs() - startedAtMs) / 1000);
  sendJson(res, databaseUp ? 200 : 503, { ok: databaseUp, db: databaseUp ? "ok" : "unreachable", uptimeSec });
}

function sendFailure(res: ServerResponse, error: unknown, path: string): void {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.code, message: error.message });
    return;
  }
  log.error({ err: error, path }, "analytics request failed");
  sendJson(res, 500, { error: "internal_error", message: "internal error" });
}

async function streamCsv(ctx: AnalyticsContext, route: CsvRoute, request: ApiRequest, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const stream = route.handle(ctx, request);
  const first = await stream.chunks.next();
  startCsv(res, stream.filename);
  if (req.method === "HEAD") {
    await stream.chunks.return(undefined);
    res.end();
    return;
  }
  let aborted = false;
  res.once("close", () => {
    aborted = true;
  });
  if (!first.done) {
    await writeChunk(res, first.value);
  }
  try {
    for await (const chunk of stream.chunks) {
      if (aborted) {
        break;
      }
      await writeChunk(res, chunk);
    }
    res.end();
  } catch (error) {
    log.error({ err: error, path: request.url.pathname }, "csv export failed mid-stream");
    res.destroy(error instanceof Error ? error : undefined);
  }
}

async function handleApi(ctx: AnalyticsContext, token: string | null, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthorized(req, url, token)) {
    sendJson(res, 401, { error: "unauthorized", message: "send Authorization: Bearer <token> or ?token=" }, {
      "WWW-Authenticate": 'Bearer realm="snypra-edge"'
    });
    return;
  }
  const apiPath = normalizedPath(url.pathname).slice(API_PREFIX.length);
  const resolved = resolveRoute(apiPath);
  if (!resolved) {
    throw new HttpError(404, "not_found", "unknown api route");
  }
  const request: ApiRequest = { url, params: url.searchParams, segments: resolved.segments };
  if (resolved.route.kind === "csv") {
    await streamCsv(ctx, resolved.route, request, req, res);
    return;
  }
  sendJson(res, 200, await runJsonRoute(ctx, resolved.route, request));
}

function parseUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? "/", URL_BASE);
  } catch {
    return null;
  }
}

export function createAnalyticsHandler(options: Omit<AnalyticsServerOptions, "port" | "host">): AnalyticsRequestHandler {
  const clock = options.clock ?? new SystemClock();
  const ctx: AnalyticsContext = {
    db: options.db,
    clock,
    cache: new TtlCache({
      ttlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      maxEntries: options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
      now: () => clock.nowMs()
    }),
    settings: { ...DEFAULT_ANALYTICS_SETTINGS, ...options.settings },
    scoreLookup: options.scoreLookup ?? null,
    extraHealth: options.extraHealth ?? null
  };
  const token = options.token && options.token.length > 0 ? options.token : null;
  const page: PageAssets = { html: renderDashboardHtml(), csp: dashboardContentSecurityPolicy() };
  const startedAtMs = clock.nowMs();

  return async (req, res) => {
    const url = parseUrl(req.url);
    const path = url ? normalizedPath(url.pathname) : "";
    try {
      if (!url) {
        throw new HttpError(400, "bad_request", "malformed url");
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method_not_allowed", message: "only GET is supported" }, { Allow: "GET, HEAD" });
        return;
      }
      if (path === "/" || path === "/index.html") {
        sendHtml(res, page.html, page.csp);
        return;
      }
      if (path === "/healthz") {
        await sendHealth(ctx, res, startedAtMs);
        return;
      }
      if (path === "/favicon.ico") {
        sendEmpty(res, 204);
        return;
      }
      if (path.startsWith(API_PREFIX)) {
        await handleApi(ctx, token, url, req, res);
        return;
      }
      throw new HttpError(404, "not_found", "unknown route");
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendFailure(res, error, path);
    }
  };
}

function listen(server: Server, port: number, host: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startAnalyticsServer(options: AnalyticsServerOptions): Promise<AnalyticsServer> {
  const handler = createAnalyticsHandler(options);
  const server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      log.error({ err: error }, "analytics handler crashed");
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error", message: "internal error" });
      } else {
        res.destroy();
      }
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  await listen(server, options.port, options.host);
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? options.port;
  log.info({ port }, "analytics server listening");
  let closing: Promise<void> | null = null;
  return {
    port,
    server,
    close() {
      if (!closing) {
        closing = new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    }
  };
}
