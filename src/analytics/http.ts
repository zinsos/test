import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TradingMode } from "../core/types.js";
import { isTradingMode } from "./tradeQueries.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store"
};

const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DIGITS = /^-?\d+$/;

export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toJson(body: unknown): string {
  return JSON.stringify(body, jsonReplacer);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = toJson(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

export function sendHtml(res: ServerResponse, html: string, contentSecurityPolicy: string): void {
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Content-Security-Policy": contentSecurityPolicy,
    "X-Frame-Options": "DENY"
  });
  res.end(html);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, BASE_HEADERS);
  res.end();
}

export function startCsv(res: ServerResponse, filename: string): void {
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`
  });
}

export function writeChunk(res: ServerResponse, chunk: string): Promise<void> {
  if (res.destroyed || res.write(chunk)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function tokensMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export function isAuthorized(req: IncomingMessage, url: URL, token: string | null, allowOpen = false): boolean {
  if (token === null || token.length === 0) {
    return allowOpen;
  }
  const provided = bearerToken(req) ?? url.searchParams.get("token");
  return provided !== null && tokensMatch(provided, token);
}

export function optionalText(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value === null || value.trim().length === 0 ? null : value.trim();
}

export function parseMode(params: URLSearchParams): TradingMode | null {
  const value = optionalText(params, "mode");
  if (value === null || value === "all") {
    return null;
  }
  if (!isTradingMode(value)) {
    throw new HttpError(400, "invalid_mode", "mode must be paper, live, backtest, shadow or all");
  }
  return value;
}

export function parseInteger(params: URLSearchParams, name: string, options: { min?: number; max?: number } = {}): number | null {
  const value = optionalText(params, name);
  if (value === null) {
    return null;
  }
  if (!DIGITS.test(value)) {
    throw new HttpError(400, `invalid_${name}`, `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (options.min !== undefined && parsed < options.min)) {
    throw new HttpError(400, `invalid_${name}`, `${name} is out of range`);
  }
  return options.max !== undefined ? Math.min(options.max, parsed) : parsed;
}

export function parseTime(params: URLSearchParams, name: string): number | null {
  const value = optionalText(params, name);
  if (value === null) {
    return null;
  }
  const parsed = DIGITS.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `invalid_${name}`, `${name} must be epoch milliseconds or an ISO date`);
  }
  return parsed;
}

export function parseFlag(params: URLSearchParams, name: string): boolean {
  const value = optionalText(params, name);
  return value !== null && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function parseMint(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "invalid_mint", "mint is not a valid base58 address");
  }
  if (!BASE58_MINT.test(decoded)) {
    throw new HttpError(400, "invalid_mint", "mint is not a valid base58 address");
  }
  return decoded;
}

export function cacheKey(url: URL): string {
  const entries = [...url.searchParams.entries()].filter(([name]) => name !== "token").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${url.pathname}?${new URLSearchParams(entries).toString()}`;
}
