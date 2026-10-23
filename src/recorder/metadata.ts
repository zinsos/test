import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { RecorderConfig } from "../config/strategy.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import type { Db } from "../db/pool.js";
import type { LaunchMetadata, MarketState } from "../market/state.js";
import { cleanText, jsonText } from "./sql.js";

const log = moduleLogger("metadata");

export type MetadataConfig = RecorderConfig["metadata"];
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "manual" }
) => Promise<Response>;
export type HostResolver = (hostname: string) => Promise<string[]>;

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
  maxRedirects?: number;
  resolveHost?: HostResolver;
  sweepIntervalMs?: number | null;
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
const ALLOWED_PROTOCOLS = new Set(["https:", "data:"]);
const INTERNAL_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".localdomain", ".home.arpa"];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isPrivateIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateAddress(address: string): boolean {
  const unbracketed = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(unbracketed);
  if (version === 4) {
    return isPrivateIpv4(unbracketed);
  }
  if (version !== 6) {
    return true;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(unbracketed);
  if (mapped?.[1]) {
    return isPrivateIpv4(mapped[1]);
  }
  return (
    unbracketed === "::" ||
    unbracketed === "::1" ||
    unbracketed.startsWith("fc") ||
    unbracketed.startsWith("fd") ||
    /^fe[89ab]/.test(unbracketed) ||
    unbracketed.startsWith("ff")
  );
}

export function blockedHostReason(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host === "localhost" || INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) || !host.includes(".")) {
    return `internal host ${host}`;
  }
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0 && isPrivateAddress(literal)) {
    return `private address ${literal}`;
  }
  return null;
}

async function resolveAll(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

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
  private readonly maxRedirects: number;
  private readonly resolveHost: HostResolver | null;
  private readonly sweepIntervalMs: number | null;
  private readonly queue: MetadataJob[] = [];
  private readonly known = new Set<number>();
  private readonly inflight = new Set<Promise<void>>();
  private sweepTimer: TimerHandle | null = null;
  private sweeping: Promise<void> | null = null;
  private running = false;
  private readonly counters = {
    enqueued: 0,
    droppedQueueFull: 0,
    fetched: 0,
    failed: 0,
    retries: 0,
    storeErrors: 0,
    blocked: 0,
    swept: 0
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
    this.resolveHost = options.resolveHost ?? (options.fetchImpl ? null : resolveAll);
    this.maxQueue = options.maxQueue ?? 10_000;
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.sweepIntervalMs = options.sweepIntervalMs ?? null;
  }

  get gatewayUrl(): string {
    return this.gateway;
  }

  start(): void {
    this.running = this.config.enabled;
    if (this.running && this.sweepIntervalMs !== null) {
      this.scheduleSweep(this.clock.nowMs());
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.sweepTimer) {
      this.clock.cancel(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.sweeping;
    for (const job of this.queue.splice(0, this.queue.length)) {
      this.known.delete(job.launchId);
    }
    await this.drain();
  }

  async sweep(): Promise<number> {
    const room = this.maxQueue - this.queue.length;
    if (!this.running || room <= 0) {
      return 0;
    }
    const result = await this.db.query<{ id: unknown; mint: string; uri: string }>(
      `SELECT id, mint, uri FROM launches
        WHERE metadata_fetched_at IS NULL AND tracking_ended_at IS NULL
        ORDER BY created_at DESC LIMIT $1`,
      [room + this.known.size]
    );
    let added = 0;
    for (const row of result.rows) {
      const launchId = Number(row.id);
      if (added >= room || this.known.has(launchId)) {
        continue;
      }
      if (this.enqueue({ launchId, mint: row.mint, uri: row.uri })) {
        added += 1;
      }
    }
    this.counters.swept += added;
    return added;
  }

  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  enqueue(job: MetadataJob): boolean {
    if (!this.running || this.known.has(job.launchId)) {
      return false;
    }
    if (this.queue.length >= this.maxQueue) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.known.delete(dropped.launchId);
      }
      this.counters.droppedQueueFull += 1;
    }
    this.queue.push(job);
    this.known.add(job.launchId);
    this.counters.enqueued += 1;
    this.pump();
    return true;
  }

  stats(): Record<string, number> {
    return { ...this.counters, queued: this.queue.length, active: this.inflight.size };
  }

  private scheduleSweep(atMs: number): void {
    const intervalMs = this.sweepIntervalMs;
    if (intervalMs === null) {
      return;
    }
    this.sweepTimer = this.clock.schedule(atMs, async () => {
      this.sweepTimer = null;
      if (!this.running) {
        return;
      }
      const run = this.sweep()
        .then(() => undefined)
        .catch((error: unknown) => log.warn({ err: error }, "metadata sweep failed"));
      this.sweeping = run;
      await run;
      this.sweeping = null;
      if (this.running) {
        this.scheduleSweep(this.clock.nowMs() + intervalMs);
      }
    });
  }

  private pump(): void {
    while (this.running && this.inflight.size < this.config.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) {
        return;
      }
      const task = this.process(job).finally(() => {
        this.inflight.delete(task);
        this.known.delete(job.launchId);
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

  private async checkUrl(url: string): Promise<URL> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MetadataFetchError(`invalid uri ${cleanText(url, 200)}`, false);
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new MetadataFetchError(`unsupported protocol ${parsed.protocol}`, false);
    }
    if (parsed.protocol === "data:") {
      return parsed;
    }
    const blocked = blockedHostReason(parsed.hostname);
    if (blocked) {
      this.counters.blocked += 1;
      throw new MetadataFetchError(`refused ${blocked}`, false);
    }
    if (this.resolveHost && isIP(parsed.hostname.replace(/^\[|\]$/g, "")) === 0) {
      const addresses = await this.resolveHost(parsed.hostname);
      const internal = addresses.find((address) => isPrivateAddress(address));
      if (addresses.length === 0 || internal !== undefined) {
        this.counters.blocked += 1;
        throw new MetadataFetchError(`refused host ${parsed.hostname} resolving to ${internal ?? "nothing"}`, false);
      }
    }
    return parsed;
  }

  private async readLimited(response: Response, controller: AbortController): Promise<string> {
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > this.maxBytes) {
      throw new MetadataFetchError(`metadata too large (${length} bytes)`, false);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return "";
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > this.maxBytes) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new MetadataFetchError(`metadata too large (over ${this.maxBytes} bytes)`, false);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async fetchJson(url: string): Promise<unknown> {
    if (url.length === 0) {
      throw new MetadataFetchError("empty uri", false);
    }
    await this.checkUrl(url);
    const controller = new AbortController();
    const timer = this.clock.schedule(this.clock.nowMs() + this.config.timeoutMs, () => controller.abort());
    try {
      let target = url;
      let response = await this.fetchImpl(target, { signal: controller.signal, headers: { accept: "application/json" }, redirect: "manual" });
      for (let hop = 0; REDIRECT_STATUSES.has(response.status); hop += 1) {
        const location = response.headers.get("location");
        if (!location || hop >= this.maxRedirects) {
          throw new MetadataFetchError(`http ${response.status} redirect not followed`, false);
        }
        await response.body?.cancel().catch(() => undefined);
        target = new URL(location, target).toString();
        await this.checkUrl(target);
        response = await this.fetchImpl(target, { signal: controller.signal, headers: { accept: "application/json" }, redirect: "manual" });
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        await response.body?.cancel().catch(() => undefined);
        throw new MetadataFetchError(`http ${response.status}`, retryable);
      }
      const body = await this.readLimited(response, controller);
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
