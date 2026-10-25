import type { ParsedTransaction, RpcPriority, SignatureInfo } from "../chain/rpc.js";
import type { ScorerConfig } from "../config/strategy.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import type { Db } from "../db/pool.js";
import { fundingTransfer, type IncomingTransfer } from "./funding.js";
import { fundingBurstKey, loadHubFacts, loadIntelRows, markHubs, saveIntelRow, type HubFacts } from "./intelStore.js";
import { LruCache } from "./lru.js";
import type { IntelEnsureOptions, IntelRequest, WalletIntel, WalletIntelProvider } from "./types.js";

const log = moduleLogger("wallet-intel");
const HOUR_MS = 3_600_000;
const RPC_PRIORITY: RpcPriority = "high";

export const LINKING_ENTITY_KINDS: ReadonlySet<string> = new Set(["bundler", "insider", "rugger", "dev", "cluster"]);

export interface IntelRpc {
  getSignaturesForAddress(
    address: string,
    options: { before?: string; limit?: number },
    priority?: RpcPriority
  ): Promise<SignatureInfo[]>;
  getParsedTransaction(signature: string, priority?: RpcPriority): Promise<ParsedTransaction | null>;
}

export interface WalletIntelServiceOptions {
  db: Db | null;
  rpc: IntelRpc | null;
  clock: Clock;
  config: ScorerConfig;
  cacheSize?: number;
  errorRetryMs?: number;
  hubCacheMs?: number;
  maxInflight?: number;
}

export interface WalletIntelStats {
  cached: number;
  inflight: number;
  memoryHits: number;
  dbHits: number;
  lookups: number;
  failures: number;
  skipped: number;
  rpcCalls: number;
}

interface FundingHit {
  transfer: IncomingTransfer;
  signature: string;
  slot: number;
  atMs: number | null;
}

interface HubVerdict {
  isHub: boolean;
  atMs: number;
}

export function isHubFromFacts(facts: HubFacts | undefined, memoryBursts: number, threshold: number): boolean {
  const kind = facts?.entityKind ?? null;
  if (kind !== null) {
    return !LINKING_ENTITY_KINDS.has(kind);
  }
  const bursts = Math.max(facts?.fundingBursts ?? 0, memoryBursts);
  return (facts?.flagged ?? false) || bursts >= threshold;
}

const STOPPED = "wallet intel stopped";

function withKnownFunding(fetched: WalletIntel, previous: WalletIntel | null): WalletIntel {
  if (fetched.funder !== null || !previous?.funder) {
    return fetched;
  }
  return {
    ...fetched,
    funder: previous.funder,
    fundingSignature: previous.fundingSignature,
    fundingSlot: previous.fundingSlot,
    fundedAtMs: previous.fundedAtMs,
    fundingAmount: previous.fundingAmount
  };
}

export class WalletIntelService implements WalletIntelProvider {
  private readonly db: Db | null;
  private readonly rpc: IntelRpc | null;
  private readonly clock: Clock;
  private readonly deep: ScorerConfig["deepIntel"];
  private readonly ttlMs: number;
  private readonly errorRetryMs: number;
  private readonly hubCacheMs: number;
  private readonly maxInflight: number;
  private readonly bursts = new Map<Pubkey, Map<string, number>>();
  private readonly memory: LruCache<Pubkey, WalletIntel>;
  private readonly hubs: LruCache<Pubkey, HubVerdict>;
  private readonly inflight = new Map<Pubkey, Promise<WalletIntel>>();
  private readonly persisting = new Set<Promise<void>>();
  private readonly counters = { memoryHits: 0, dbHits: 0, lookups: 0, failures: 0, skipped: 0, rpcCalls: 0 };
  private stopped = false;

  constructor(options: WalletIntelServiceOptions) {
    this.db = options.db;
    this.rpc = options.rpc;
    this.clock = options.clock;
    this.deep = options.config.deepIntel;
    this.ttlMs = this.deep.cacheTtlHours * HOUR_MS;
    this.errorRetryMs = options.errorRetryMs ?? 5 * 60_000;
    this.hubCacheMs = options.hubCacheMs ?? 10 * 60_000;
    this.maxInflight = options.maxInflight ?? 400;
    this.memory = new LruCache<Pubkey, WalletIntel>(options.cacheSize ?? 100_000, (_wallet, intel) =>
      this.adjustBursts(intel, -1)
    );
    this.hubs = new LruCache<Pubkey, HubVerdict>(20_000);
  }

  stats(): WalletIntelStats {
    return { cached: this.memory.size, inflight: this.inflight.size, ...this.counters };
  }

  cached(wallets: Iterable<Pubkey>): Map<Pubkey, WalletIntel> {
    const result = new Map<Pubkey, WalletIntel>();
    for (const wallet of wallets) {
      const intel = this.fresh(wallet);
      if (intel) {
        result.set(wallet, this.withHub(intel));
      }
    }
    return result;
  }

  isHub(address: Pubkey): boolean {
    const verdict = this.hubs.peek(address);
    if (verdict && this.clock.nowMs() - verdict.atMs <= this.hubCacheMs) {
      return verdict.isHub;
    }
    return this.memoryBursts(address) >= this.deep.hubFanoutThreshold;
  }

  async ensure(entries: readonly IntelRequest[], deadlineMs: number, options: IntelEnsureOptions = {}): Promise<Map<Pubkey, WalletIntel>> {
    const requests = this.dedupe(entries);
    const ready = new Map<Pubkey, WalletIntel>();
    let missing: IntelRequest[] = [];
    for (const request of requests) {
      const intel = this.fresh(request.wallet);
      if (intel && this.answers(intel, request)) {
        this.counters.memoryHits += 1;
        ready.set(request.wallet, intel);
      } else {
        missing.push(request);
      }
    }
    if (missing.length > 0 && this.db) {
      const loaded = await this.untilDeadline(this.loadFromDb(missing.map((request) => request.wallet)), deadlineMs);
      const byWallet = new Map(missing.map((request) => [request.wallet, request]));
      for (const intel of loaded ?? []) {
        const request = byWallet.get(intel.wallet);
        if (!request) {
          continue;
        }
        if (this.answers(intel, request)) {
          this.counters.dbHits += 1;
          this.remember(intel);
          ready.set(intel.wallet, intel);
        } else if (!this.memory.has(intel.wallet)) {
          this.remember(intel);
        }
      }
      missing = missing.filter((request) => !ready.has(request.wallet));
    }
    const lookups = (options.fetch ?? true)
      ? missing.flatMap((request) => {
          const lookup = this.lookup(request);
          return lookup ? [lookup] : [];
        })
      : [];
    if (lookups.length > 0) {
      await this.untilDeadline(Promise.all(lookups), deadlineMs);
    }
    for (const request of missing) {
      const intel = this.fresh(request.wallet);
      if (intel && this.answers(intel, request)) {
        ready.set(request.wallet, intel);
      }
    }
    await this.resolveHubs(ready.values(), deadlineMs);
    const result = new Map<Pubkey, WalletIntel>();
    for (const [wallet, intel] of ready) {
      result.set(wallet, this.withHub(intel));
    }
    return result;
  }

  async drain(): Promise<void> {
    while (this.inflight.size > 0 || this.persisting.size > 0) {
      await Promise.allSettled([...this.inflight.values(), ...this.persisting]);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    while (this.persisting.size > 0) {
      await Promise.allSettled([...this.persisting]);
    }
  }

  private answers(intel: WalletIntel, request: IntelRequest): boolean {
    return intel.checkedBeforeSignature === request.buySignature || !this.claimsFresh(intel);
  }

  private claimsFresh(intel: WalletIntel): boolean {
    return intel.priorTxCount !== null && !intel.priorTxCapped && intel.priorTxCount <= this.deep.freshMaxPriorTxs;
  }

  private dedupe(entries: readonly IntelRequest[]): IntelRequest[] {
    const byWallet = new Map<Pubkey, IntelRequest>();
    for (const entry of entries) {
      const existing = byWallet.get(entry.wallet);
      if (!existing || entry.buySlot < existing.buySlot) {
        byWallet.set(entry.wallet, entry);
      }
    }
    return [...byWallet.values()];
  }

  private fresh(wallet: Pubkey): WalletIntel | null {
    const intel = this.memory.get(wallet);
    if (!intel) {
      return null;
    }
    const ttl = intel.error ? this.errorRetryMs : this.ttlMs;
    if (this.clock.nowMs() - intel.checkedAtMs > ttl) {
      this.memory.delete(wallet);
      return null;
    }
    return intel;
  }

  private withHub(intel: WalletIntel): WalletIntel {
    const funderIsHub = intel.funder !== null && this.isHub(intel.funder);
    return funderIsHub === intel.funderIsHub ? intel : { ...intel, funderIsHub };
  }

  private remember(intel: WalletIntel): void {
    this.memory.set(intel.wallet, intel);
    this.adjustBursts(intel, 1);
  }

  private memoryBursts(funder: Pubkey): number {
    return this.bursts.get(funder)?.size ?? 0;
  }

  private adjustBursts(intel: WalletIntel, delta: number): void {
    if (!intel.funder) {
      return;
    }
    const byBurst = this.bursts.get(intel.funder) ?? new Map<string, number>();
    const key = fundingBurstKey(intel);
    const next = (byBurst.get(key) ?? 0) + delta;
    if (next <= 0) {
      byBurst.delete(key);
    } else {
      byBurst.set(key, next);
    }
    if (byBurst.size === 0) {
      this.bursts.delete(intel.funder);
    } else {
      this.bursts.set(intel.funder, byBurst);
    }
  }

  private async loadFromDb(wallets: readonly Pubkey[]): Promise<WalletIntel[]> {
    if (!this.db) {
      return [];
    }
    const now = this.clock.nowMs();
    try {
      return await loadIntelRows(this.db, wallets, now - this.ttlMs, now - this.errorRetryMs, now);
    } catch (error) {
      log.warn({ err: error }, "wallet intel cache read failed");
      return [];
    }
  }

  private async untilDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T | null> {
    if (this.clock.nowMs() >= deadlineMs) {
      return null;
    }
    let handle: TimerHandle | null = null;
    const timeout = new Promise<null>((resolve) => {
      handle = this.clock.schedule(deadlineMs, () => resolve(null));
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (handle) {
        this.clock.cancel(handle);
      }
    }
  }

  private lookup(request: IntelRequest): Promise<WalletIntel> | null {
    const existing = this.inflight.get(request.wallet);
    if (existing) {
      return existing;
    }
    if (!this.rpc || this.stopped || this.inflight.size >= this.maxInflight) {
      this.counters.skipped += 1;
      return null;
    }
    this.counters.lookups += 1;
    const previous = this.memory.peek(request.wallet) ?? null;
    const promise = this.fetchIntel(request)
      .catch((error: unknown) => this.failedIntel(request, error))
      .then((fetched) => {
        const intel = withKnownFunding(fetched, previous);
        this.remember(intel);
        if (intel.priorTxCount !== null) {
          this.persist(intel);
        }
        return intel;
      })
      .finally(() => {
        this.inflight.delete(request.wallet);
      });
    this.inflight.set(request.wallet, promise);
    return promise;
  }

  private failedIntel(request: IntelRequest, error: unknown): WalletIntel {
    this.counters.failures += 1;
    log.debug({ err: error, wallet: request.wallet }, "wallet intel lookup failed");
    return {
      wallet: request.wallet,
      funder: null,
      fundingSignature: null,
      fundingSlot: null,
      fundedAtMs: null,
      fundingAmount: null,
      priorTxCount: null,
      priorTxCapped: false,
      oldestSeenAtMs: null,
      checkedBeforeSignature: request.buySignature,
      checkedAtMs: this.clock.nowMs(),
      funderIsHub: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  private persist(intel: WalletIntel): void {
    if (!this.db || this.stopped) {
      return;
    }
    this.background(
      saveIntelRow(this.db, intel).catch((error: unknown) => {
        log.warn({ err: error, wallet: intel.wallet }, "wallet intel write failed");
      })
    );
  }

  private background(work: Promise<void>): void {
    const tracked = work.finally(() => {
      this.persisting.delete(tracked);
    });
    this.persisting.add(tracked);
  }

  private ensureRunning(): void {
    if (this.stopped) {
      throw new Error(STOPPED);
    }
  }

  private async fetchIntel(request: IntelRequest): Promise<WalletIntel> {
    const rpc = this.rpc;
    if (!rpc) {
      throw new Error("rpc unavailable");
    }
    const limit = this.deep.signatureLookback;
    this.ensureRunning();
    this.counters.rpcCalls += 1;
    const signatures = await rpc.getSignaturesForAddress(
      request.wallet,
      { before: request.buySignature, limit },
      RPC_PRIORITY
    );
    const oldest = signatures[signatures.length - 1];
    const capped = signatures.length >= limit;
    let funding = await this.findFunding(rpc, request.wallet, signatures);
    if (!funding.hit && !capped) {
      funding = await this.findFundingInBuy(rpc, request, funding.error);
    }
    return {
      wallet: request.wallet,
      funder: funding.hit?.transfer.source ?? null,
      fundingSignature: funding.hit?.signature ?? null,
      fundingSlot: funding.hit?.slot ?? null,
      fundedAtMs: funding.hit?.atMs ?? null,
      fundingAmount: funding.hit?.transfer.lamports ?? null,
      priorTxCount: signatures.length,
      priorTxCapped: capped,
      oldestSeenAtMs: oldest?.blockTime ? oldest.blockTime * 1000 : null,
      checkedBeforeSignature: request.buySignature,
      checkedAtMs: this.clock.nowMs(),
      funderIsHub: false,
      error: funding.error
    };
  }

  private async findFundingInBuy(
    rpc: IntelRpc,
    request: IntelRequest,
    historyError: string | null
  ): Promise<{ hit: FundingHit | null; error: string | null }> {
    this.ensureRunning();
    try {
      this.counters.rpcCalls += 1;
      const tx = await rpc.getParsedTransaction(request.buySignature, RPC_PRIORITY);
      const transfer = tx ? fundingTransfer(tx, request.wallet, this.minFundingLamports()) : null;
      if (!tx || !transfer) {
        return { hit: null, error: historyError };
      }
      const atMs = tx.blockTime ? tx.blockTime * 1000 : null;
      return { hit: { transfer, signature: request.buySignature, slot: tx.slot ?? request.buySlot, atMs }, error: null };
    } catch (error) {
      if (this.stopped) {
        throw error;
      }
      return { hit: null, error: `buy transaction lookup failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private minFundingLamports(): bigint {
    return BigInt(Math.trunc(this.deep.minFundingLamports));
  }

  private async findFunding(
    rpc: IntelRpc,
    wallet: Pubkey,
    signatures: readonly SignatureInfo[]
  ): Promise<{ hit: FundingHit | null; error: string | null }> {
    const minLamports = this.minFundingLamports();
    let fetched = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (const info of signatures) {
      if (fetched >= this.deep.maxFundingLookups) {
        break;
      }
      if (info.err !== null && info.err !== undefined) {
        continue;
      }
      fetched += 1;
      this.ensureRunning();
      try {
        this.counters.rpcCalls += 1;
        const tx = await rpc.getParsedTransaction(info.signature, RPC_PRIORITY);
        const transfer = tx ? fundingTransfer(tx, wallet, minLamports) : null;
        if (tx && transfer) {
          const blockTime = tx.blockTime ?? info.blockTime;
          return {
            hit: { transfer, signature: info.signature, slot: tx.slot ?? info.slot, atMs: blockTime ? blockTime * 1000 : null },
            error: null
          };
        }
      } catch (error) {
        failed += 1;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    const allFailed = fetched > 0 && failed === fetched;
    return { hit: null, error: allFailed ? `funding lookups failed: ${lastError ?? "unknown"}` : null };
  }

  private async resolveHubs(intel: Iterable<WalletIntel>, deadlineMs: number): Promise<void> {
    const now = this.clock.nowMs();
    const unresolved = new Set<Pubkey>();
    for (const entry of intel) {
      if (!entry.funder) {
        continue;
      }
      const verdict = this.hubs.peek(entry.funder);
      if (!verdict || now - verdict.atMs > this.hubCacheMs) {
        unresolved.add(entry.funder);
      }
    }
    if (unresolved.size === 0) {
      return;
    }
    const addresses = [...unresolved];
    const facts = this.db ? await this.untilDeadline(this.hubFacts(addresses), deadlineMs) : new Map<Pubkey, HubFacts>();
    if (facts === null) {
      return;
    }
    const newlyHubs: Pubkey[] = [];
    for (const address of addresses) {
      const fact = facts.get(address);
      const isHub = isHubFromFacts(fact, this.memoryBursts(address), this.deep.hubFanoutThreshold);
      this.hubs.set(address, { isHub, atMs: now });
      if (isHub && !fact?.flagged && fact?.entityKind == null) {
        newlyHubs.push(address);
      }
    }
    if (newlyHubs.length > 0 && this.db && !this.stopped) {
      this.background(
        markHubs(this.db, newlyHubs).catch((error: unknown) => {
          log.warn({ err: error }, "failed to mark hub wallets");
        })
      );
    }
  }

  private async hubFacts(addresses: readonly Pubkey[]): Promise<Map<Pubkey, HubFacts>> {
    if (!this.db) {
      return new Map();
    }
    try {
      return await loadHubFacts(this.db, addresses);
    } catch (error) {
      log.warn({ err: error }, "hub lookup failed");
      return new Map();
    }
  }
}
