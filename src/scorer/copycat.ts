import type { ScorerConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Pubkey } from "../core/types.js";
import { jaroWinkler, normalizeText } from "./text.js";
import type { CopycatDetector, CopycatResult, CopycatSubject } from "./types.js";

const MINUTE_MS = 60_000;
const MIN_TICKER_LENGTH = 2;
const MIN_NAME_LENGTH = 4;
const PRUNE_EVERY_CREATES = 500;

export interface TrendingMintInfo {
  mint: Pubkey;
  name: string;
  symbol: string;
  createdAtMs: number;
  quoteMint: string;
}

export interface TrendingEntry {
  mint: Pubkey;
  ticker: string;
  normalizedName: string;
  createdAtMs: number;
  quoteMint: string;
  volume: number;
}

interface MintState {
  info: TrendingMintInfo;
  ticker: string;
  normalizedName: string;
  buckets: Array<{ minute: number; volume: number }>;
  total: number;
}

export interface TrendingTrackerOptions {
  config: ScorerConfig;
  maxMints?: number;
}

export class TrendingTracker implements CopycatDetector {
  private readonly mints = new Map<Pubkey, MintState>();
  private readonly recentTickers = new Map<string, number[]>();
  private readonly windowMinutes: number;
  private readonly topN: number;
  private readonly threshold: number;
  private readonly maxMints: number;
  private cachedMinute = Number.NaN;
  private cachedTrending: TrendingEntry[] = [];
  private createsSincePrune = 0;

  constructor(options: TrendingTrackerOptions) {
    this.windowMinutes = Math.max(1, Math.ceil(options.config.copycat.trendingWindowMinutes));
    this.topN = options.config.copycat.trendingTopN;
    this.threshold = options.config.copycat.similarityThreshold;
    this.maxMints = options.maxMints ?? 100_000;
  }

  get size(): number {
    return this.mints.size;
  }

  attach(bus: Bus): () => void {
    return bus.on("chain", (event) => {
      if (event.kind === "create") {
        this.onCreate({
          mint: event.mint,
          name: event.name,
          symbol: event.symbol,
          createdAtMs: event.timestampMs,
          quoteMint: event.quoteMint
        });
      } else if (event.kind === "trade") {
        this.onTrade(event.mint, event.quoteAmount, event.timestampMs > 0 ? event.timestampMs : event.tx.receivedAtMs);
      }
    });
  }

  onCreate(info: TrendingMintInfo): void {
    if (this.mints.has(info.mint)) {
      return;
    }
    const ticker = normalizeText(info.symbol);
    this.mints.set(info.mint, {
      info,
      ticker,
      normalizedName: normalizeText(info.name),
      buckets: [],
      total: 0
    });
    if (ticker.length >= MIN_TICKER_LENGTH) {
      const times = this.recentTickers.get(ticker) ?? [];
      times.push(info.createdAtMs);
      this.recentTickers.set(ticker, times);
    }
    this.createsSincePrune += 1;
    if (this.createsSincePrune >= PRUNE_EVERY_CREATES || this.mints.size > this.maxMints) {
      this.prune(info.createdAtMs);
    }
  }

  onTrade(mint: Pubkey, quoteAmount: bigint, atMs: number): void {
    const state = this.mints.get(mint);
    if (!state || quoteAmount <= 0n) {
      return;
    }
    const minute = Math.floor(atMs / MINUTE_MS);
    const volume = Number(quoteAmount);
    const last = state.buckets[state.buckets.length - 1];
    if (last && last.minute === minute) {
      last.volume += volume;
    } else if (last && last.minute > minute) {
      const bucket = state.buckets.find((candidate) => candidate.minute === minute);
      if (bucket) {
        bucket.volume += volume;
      } else {
        state.buckets.push({ minute, volume });
        state.buckets.sort((a, b) => a.minute - b.minute);
      }
    } else {
      state.buckets.push({ minute, volume });
    }
    state.total += volume;
  }

  rollingVolume(mint: Pubkey, nowMs: number): number {
    const state = this.mints.get(mint);
    if (!state) {
      return 0;
    }
    this.pruneBuckets(state, nowMs);
    return state.total;
  }

  trending(nowMs: number): TrendingEntry[] {
    const minute = Math.floor(nowMs / MINUTE_MS);
    if (minute === this.cachedMinute) {
      return this.cachedTrending;
    }
    const byQuote = new Map<string, TrendingEntry[]>();
    for (const state of this.mints.values()) {
      this.pruneBuckets(state, nowMs);
      if (state.total <= 0) {
        continue;
      }
      const list = byQuote.get(state.info.quoteMint) ?? [];
      list.push({
        mint: state.info.mint,
        ticker: state.ticker,
        normalizedName: state.normalizedName,
        createdAtMs: state.info.createdAtMs,
        quoteMint: state.info.quoteMint,
        volume: state.total
      });
      byQuote.set(state.info.quoteMint, list);
    }
    const result: TrendingEntry[] = [];
    for (const list of byQuote.values()) {
      list.sort((a, b) => b.volume - a.volume || a.createdAtMs - b.createdAtMs);
      result.push(...list.slice(0, this.topN));
    }
    this.cachedMinute = minute;
    this.cachedTrending = result;
    return result;
  }

  invalidate(): void {
    this.cachedMinute = Number.NaN;
  }

  isCopycat(target: CopycatSubject | { info: CopycatSubject }, nowMs: number): CopycatResult {
    const subject = "info" in target ? target.info : target;
    const ticker = normalizeText(subject.symbol);
    const name = normalizeText(subject.name);
    let similarity = 0;
    let original: TrendingEntry | null = null;
    for (const entry of this.trending(nowMs)) {
      if (entry.mint === subject.mint || entry.createdAtMs >= subject.createdAtMs) {
        continue;
      }
      const tickerMatch = ticker.length >= MIN_TICKER_LENGTH && ticker === entry.ticker;
      const nameSimilarity =
        name.length >= MIN_NAME_LENGTH && entry.normalizedName.length >= MIN_NAME_LENGTH
          ? jaroWinkler(name, entry.normalizedName)
          : 0;
      similarity = Math.max(similarity, nameSimilarity);
      if ((tickerMatch || nameSimilarity >= this.threshold) && (!original || entry.createdAtMs < original.createdAtMs)) {
        original = entry;
      }
    }
    return {
      copycat: original !== null,
      similarity: Math.round(similarity * 10_000) / 10_000,
      original: original?.mint ?? null,
      sameTickerRecent: this.sameTickerBefore(ticker, subject.createdAtMs)
    };
  }

  prune(nowMs: number): void {
    this.createsSincePrune = 0;
    const cutoffMs = nowMs - this.windowMinutes * MINUTE_MS;
    for (const [ticker, times] of this.recentTickers) {
      const kept = times.filter((time) => time >= cutoffMs);
      if (kept.length === 0) {
        this.recentTickers.delete(ticker);
      } else if (kept.length !== times.length) {
        this.recentTickers.set(ticker, kept);
      }
    }
    for (const state of this.mints.values()) {
      this.pruneBuckets(state, nowMs);
    }
    this.evictInactive(nowMs);
  }

  private sameTickerBefore(ticker: string, createdAtMs: number): number {
    if (ticker.length < MIN_TICKER_LENGTH) {
      return 0;
    }
    const cutoffMs = createdAtMs - this.windowMinutes * MINUTE_MS;
    const times = this.recentTickers.get(ticker) ?? [];
    return times.filter((time) => time < createdAtMs && time >= cutoffMs).length;
  }

  private pruneBuckets(state: MintState, nowMs: number): void {
    const oldestMinute = Math.floor(nowMs / MINUTE_MS) - this.windowMinutes + 1;
    while (state.buckets.length > 0) {
      const head = state.buckets[0];
      if (!head || head.minute >= oldestMinute) {
        break;
      }
      state.total -= head.volume;
      state.buckets.shift();
    }
    if (state.buckets.length === 0) {
      state.total = 0;
    }
  }

  private evictInactive(nowMs: number): void {
    const keepCreatedAfter = nowMs - this.windowMinutes * MINUTE_MS;
    for (const [mint, state] of this.mints) {
      if (this.mints.size <= this.maxMints) {
        break;
      }
      if (state.buckets.length === 0 && state.info.createdAtMs < keepCreatedAfter) {
        this.mints.delete(mint);
      }
    }
  }
}
