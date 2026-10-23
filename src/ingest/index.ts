import type { Bus } from "../core/bus.js";
import type { Clock } from "../core/clock.js";
import type { Env } from "../config/env.js";
import type { MarketState } from "../market/state.js";
import { IngestPipeline, type PoolLookup } from "./pipeline.js";
import type { StreamSource } from "./source.js";
import { LogsWebsocketSource, type LogsWebsocketSourceOptions } from "./wsSource.js";

export { BoundedSet } from "./lru.js";
export { TransactionDecoder, type DecodedTransaction, type LogNotification } from "./decoder.js";
export { IngestPipeline, poolTradeToChain, type IngestPipelineOptions, type PoolLookup } from "./pipeline.js";
export { ReplayLogSource, type ReplayLogSourceOptions, type ReplayTransaction } from "./replaySource.js";
export {
  GapListeners,
  type BatchHandler,
  type GapHandler,
  type StreamMeta,
  type StreamSource
} from "./source.js";
export {
  DEFAULT_BACKOFF,
  LogsWebsocketSource,
  backoffDelayMs,
  type LogsWebsocketSourceOptions,
  type ReconnectBackoff,
  type StreamCommitment
} from "./wsSource.js";

export function websocketUrlFromEnv(env: Pick<Env, "RPC_WS_URL" | "RPC_HTTP_URL">): string {
  if (env.RPC_WS_URL && env.RPC_WS_URL.length > 0) {
    return env.RPC_WS_URL;
  }
  if (env.RPC_HTTP_URL && env.RPC_HTTP_URL.length > 0) {
    return env.RPC_HTTP_URL.replace(/^http(s?):\/\//, (_match, secure: string) => `ws${secure}://`);
  }
  throw new Error("missing RPC_WS_URL (or RPC_HTTP_URL to derive it from)");
}

export interface IngestModuleOptions {
  env: Pick<Env, "RPC_WS_URL" | "RPC_HTTP_URL" | "STREAM_COMMITMENT">;
  clock: Clock;
  market: MarketState;
  bus: Bus;
  poolLookup?: PoolLookup;
  source?: StreamSource;
  websocket?: Partial<Omit<LogsWebsocketSourceOptions, "clock">>;
}

export interface IngestModule {
  readonly pipeline: IngestPipeline;
  readonly source: StreamSource;
  start(): Promise<void>;
  stop(): Promise<void>;
  stats(): Record<string, Record<string, number>>;
}

export function createIngestModule(options: IngestModuleOptions): IngestModule {
  const pipeline = new IngestPipeline({
    market: options.market,
    bus: options.bus,
    clock: options.clock,
    poolLookup: options.poolLookup
  });
  const source =
    options.source ??
    new LogsWebsocketSource({
      commitment: options.env.STREAM_COMMITMENT,
      ...options.websocket,
      url: options.websocket?.url ?? websocketUrlFromEnv(options.env),
      clock: options.clock
    });
  let detach: (() => void) | null = null;
  return {
    pipeline,
    source,
    async start() {
      if (!detach) {
        detach = await pipeline.attach(source);
      }
    },
    async stop() {
      await source.stop();
      detach?.();
      detach = null;
    },
    stats() {
      return { source: source.stats(), pipeline: pipeline.stats() };
    }
  };
}
