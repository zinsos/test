import type { Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";

const log = moduleLogger("analytics.price");

export const DEFAULT_PRICE_TTL_MS = 60_000;
export const DEFAULT_PRICE_RETRY_MS = 15_000;
export const DEFAULT_PRICE_TIMEOUT_MS = 5_000;

export interface SolPrice {
  usd: number;
  source: string;
  atMs: number;
}

export interface SolPriceLookup {
  current(): Promise<SolPrice | null>;
}

export interface PriceSource {
  name: string;
  url: string;
  read(body: unknown): number | null;
}

export type JsonFetcher = (url: string, timeoutMs: number) => Promise<unknown>;

function field(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function positivePrice(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export const DEFAULT_PRICE_SOURCES: readonly PriceSource[] = [
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    read: (body) => positivePrice(field(body, ["data", "amount"]))
  },
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    read: (body) => positivePrice(field(body, ["solana", "usd"]))
  }
];

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`price source answered ${response.status}`);
  }
  return response.json();
}

export interface SolPriceFeedOptions {
  clock: Clock;
  sources?: readonly PriceSource[];
  fetchJson?: JsonFetcher;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
}

export class SolPriceFeed implements SolPriceLookup {
  private readonly clock: Clock;
  private readonly sources: readonly PriceSource[];
  private readonly fetchJson: JsonFetcher;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private last: SolPrice | null = null;
  private lastAttemptMs = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<SolPrice | null> | null = null;

  constructor(options: SolPriceFeedOptions) {
    this.clock = options.clock;
    this.sources = options.sources ?? DEFAULT_PRICE_SOURCES;
    this.fetchJson = options.fetchJson ?? fetchJson;
    this.ttlMs = options.ttlMs ?? DEFAULT_PRICE_TTL_MS;
    this.retryMs = options.retryMs ?? DEFAULT_PRICE_RETRY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PRICE_TIMEOUT_MS;
  }

  current(): Promise<SolPrice | null> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const nowMs = this.clock.nowMs();
    const fresh = this.last !== null && nowMs - this.last.atMs < this.ttlMs;
    if (fresh || nowMs - this.lastAttemptMs < this.retryMs) {
      return Promise.resolve(this.last);
    }
    this.lastAttemptMs = nowMs;
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<SolPrice | null> {
    for (const source of this.sources) {
      try {
        const usd = source.read(await this.fetchJson(source.url, this.timeoutMs));
        if (usd !== null) {
          this.last = { usd, source: source.name, atMs: this.clock.nowMs() };
          return this.last;
        }
      } catch (error) {
        log.debug({ err: error, source: source.name }, "sol price source failed");
      }
    }
    return this.last;
  }
}
