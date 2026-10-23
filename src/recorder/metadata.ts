import type { RecorderConfig } from "../config/strategy.js";
import type { Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import type { Db } from "../db/pool.js";
import type { LaunchMetadata, MarketState } from "../market/state.js";
import { cleanText, jsonText } from "./sql.js";

const log = moduleLogger("metadata");

export type MetadataConfig = RecorderConfig["metadata"];
export type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export interface ParsedMetadata {
  name: string | null;
  symbol: string | null;
  description: string | null;
  image: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

export interface MetadataJob {
  launchId: number;
  mint: Pubkey;
  uri: string;
}

export interface MetadataFetcherOptions {
  db: Db;
  clock: Clock;
  config: MetadataConfig;
  market?: MarketState;
  gatewayOverride?: string;
  fetchImpl?: FetchLike;
  maxQueue?: number;
  maxBytes?: number;
  retryDelayMs?: number;
}

export class MetadataFetchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;
const SUBDOMAIN_GATEWAY = /^([^.]+)\.ipfs\.[^/]+$/i;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "data:"]);

export function normalizeGateway(gateway: string): string {
  const trimmed = gateway.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function rewriteIpfsUrl(uri: string, gateway: string): string {
  const target = normalizeGateway(gateway);
  const trimmed = uri.trim();
  if (trimmed.length === 0 || trimmed.startsWith(target)) {
    return trimmed;
  }
  if (/^ipfs:\/\//i.test(trimmed)) {
    return target + trimmed.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
  }
  if (/^ar:\/\//i.test(trimmed)) {
    return `https://arweave.net/${trimmed.replace(/^ar:\/\//i, "")}`;
  }
  if (CID_PATTERN.test(trimmed)) {
    return target + trimmed;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return trimmed;
  }
  const pathMatch = /^\/ipfs\/(.+)$/.exec(url.pathname);
  if (pathMatch?.[1]) {
    return target + pathMatch[1] + url.search;
  }
  const subdomain = SUBDOMAIN_GATEWAY.exec(url.hostname);
  if (subdomain?.[1] && CID_PATTERN.test(subdomain[1])) {
    const rest = url.pathname === "/" ? "" : url.pathname;
    return target + subdomain[1] + rest + url.search;
  }
  return trimmed;
}

function text(value: unknown, maxLength = 1_000): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = cleanText(value.trim(), maxLength).trim();
  return cleaned.length > 0 ? cleaned : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstText(sources: ReadonlyArray<Record<string, unknown> | null>, keys: readonly string[]): string | null {
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of keys) {
      const value = text(source[key]);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

export function parseMetadata(raw: unknown): ParsedMetadata {
  const root = record(raw);
  if (!root) {
    throw new MetadataFetchError("metadata is not a json object", false);
  }
  const sources = [root, record(root.extensions), record(root.properties), record(root.links), record(root.socials)];
  return {
    name: text(root.name, 200),
    symbol: text(root.symbol, 64),
    description: text(root.description, 2_000),
    image: text(root.image),
    twitter: firstText(sources, ["twitter", "x", "twitter_url"]),
    telegram: firstText(sources, ["telegram", "telegram_url", "tg"]),
    website: firstText(sources, ["website", "web", "site", "external_url"])
  };
}

export function launchMetadataOf(parsed: ParsedMetadata): LaunchMetadata {
  return {
    twitter: parsed.twitter,
    telegram: parsed.telegram,
    website: parsed.website,
    description: parsed.description
  };
}

export class MetadataFetcher {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly config: MetadataConfig;
  private readonly market: MarketState | undefined;
  private readonly gateway: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxQueue: number;
  private readonly maxBytes: number;
  private readonly retryDelayMs: number;
  private readonly queue: MetadataJob[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private running = false;
  private readonly counters = {
    enqueued: 0,
    droppedQueueFull: 0,
    fetched: 0,
    failed: 0,
    retries: 0,
    storeErrors: 0
  };

  constructor(options: MetadataFetcherOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.config = options.config;
    this.market = options.market;
    this.gateway = normalizeGateway(
      options.gatewayOverride && options.gatewayOverride.length > 0 ? options.gatewayOverride : options.config.gateway
    );
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.maxQueue = options.maxQueue ?? 10_000;
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  get gatewayUrl(): string {
    return this.gateway;
  }

  start(): void {
    this.running = this.config.enabled;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.queue.length = 0;
    await this.drain();
  }

  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  enqueue(job: MetadataJob): boolean {
    if (!this.running) {
      return false;
    }
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.counters.droppedQueueFull += 1;
    }
    this.queue.push(job);
    this.counters.enqueued += 1;
    this.pump();
    return true;
  }

  stats(): Record<string, number> {
    return { ...this.counters, queued: this.queue.length, active: this.inflight.size };
  }

  private pump(): void {
    while (this.running && this.inflight.size < this.config.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) {
        return;
      }
      const task = this.process(job).finally(() => {
        this.inflight.delete(task);
        this.pump();
      });
      this.inflight.add(task);
    }
  }

  private async process(job: MetadataJob): Promise<void> {
    try {
      const parsed = await this.fetchWithRetries(job.uri);
      this.counters.fetched += 1;
      const launch = this.market?.get(job.mint);
      if (launch) {
        launch.metadata = launchMetadataOf(parsed);
      }
      await this.storeSuccess(job, parsed);
    } catch (error) {
      this.counters.failed += 1;
      await this.storeFailure(job, error instanceof Error ? error.message : String(error));
    }
  }

  async fetchWithRetries(uri: string): Promise<ParsedMetadata> {
    const url = rewriteIpfsUrl(uri, this.gateway);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return parseMetadata(await this.fetchJson(url));
      } catch (error) {
        const retryable = error instanceof MetadataFetchError ? error.retryable : true;
        if (!retryable || attempt >= this.config.maxRetries || !this.running) {
          throw error;
        }
        this.counters.retries += 1;
        await this.clock.sleepUntil(this.clock.nowMs() + this.retryDelayMs * 2 ** attempt);
      }
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    if (url.length === 0) {
      throw new MetadataFetchError("empty uri", false);
    }
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new MetadataFetchError(`invalid uri ${cleanText(url, 200)}`, false);
    }
    if (!ALLOWED_PROTOCOLS.has(protocol)) {
      throw new MetadataFetchError(`unsupported protocol ${protocol}`, false);
    }
    const controller = new AbortController();
    const timer = this.clock.schedule(this.clock.nowMs() + this.config.timeoutMs, () => controller.abort());
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new MetadataFetchError(`http ${response.status}`, retryable);
      }
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > this.maxBytes) {
        throw new MetadataFetchError(`metadata too large (${length} bytes)`, false);
      }
      const body = await response.text();
      if (body.length > this.maxBytes) {
        throw new MetadataFetchError(`metadata too large (${body.length} chars)`, false);
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new MetadataFetchError("metadata is not valid json", false);
      }
    } catch (error) {
      if (error instanceof MetadataFetchError) {
        throw error;
      }
      const aborted = controller.signal.aborted;
      throw new MetadataFetchError(aborted ? "timeout" : `fetch failed: ${(error as Error).message}`, true);
    } finally {
      this.clock.cancel(timer);
    }
  }

  private async storeSuccess(job: MetadataJob, parsed: ParsedMetadata): Promise<void> {
    try {
      await this.db.query(
        `UPDATE launches
            SET metadata = $2::jsonb, has_twitter = $3, has_telegram = $4, has_website = $5,
                metadata_fetched_at = $6, metadata_error = NULL
          WHERE id = $1`,
        [
          job.launchId,
          jsonText(parsed),
          parsed.twitter !== null,
          parsed.telegram !== null,
          parsed.website !== null,
          new Date(this.clock.nowMs())
        ]
      );
    } catch (error) {
      this.counters.storeErrors += 1;
      log.error({ err: error, mint: job.mint }, "failed to store metadata");
    }
  }

  private async storeFailure(job: MetadataJob, message: string): Promise<void> {
    try {
      await this.db.query("UPDATE launches SET metadata_fetched_at = $2, metadata_error = $3 WHERE id = $1", [
        job.launchId,
        new Date(this.clock.nowMs()),
        cleanText(message, 500)
      ]);
    } catch (error) {
      this.counters.storeErrors += 1;
      log.error({ err: error, mint: job.mint }, "failed to store metadata failure");
    }
  }
}
