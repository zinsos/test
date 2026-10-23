import { curvePrice, marketCapQuote } from "../chain/curve.js";
import { isCanonicalPumpPool } from "../chain/pda.js";
import { LAMPORTS_PER_SOL, SOL_QUOTE } from "../core/constants.js";
import type { DecodedChainEvent } from "../chain/events.js";
import type {
  ChainEvent,
  CurveView,
  LaunchCreatedEvent,
  Pubkey,
  TradeEvent,
  TradeVenue
} from "../core/types.js";

export interface TradeRecord {
  slot: number;
  seq: number;
  eventIndex: number;
  atMs: number;
  signature: string;
  wallet: Pubkey;
  isBuy: boolean;
  venue: TradeVenue;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint | null;
  realQuoteReserves: bigint | null;
  protocolFeeBps: number;
  creatorFeeBps: number;
  lpFeeBps: number;
  price: number;
  mcapQuote: bigint;
  mcapMultiple: number;
}

export interface WalletActivity {
  wallet: Pubkey;
  bought: bigint;
  sold: bigint;
  quoteIn: bigint;
  quoteOut: bigint;
  buys: number;
  sells: number;
  firstBuySlot: number | null;
  firstBuyAtMs: number | null;
  firstBuyOrder: number | null;
  lastTradeAtMs: number;
}

export interface LaunchInfo {
  mint: Pubkey;
  bondingCurve: Pubkey;
  devWallet: Pubkey;
  creator: Pubkey;
  name: string;
  symbol: string;
  uri: string;
  quoteMint: string;
  tokenProgram: Pubkey | null;
  isMayhemMode: boolean;
  isCashback: boolean;
  isHolderReward: boolean;
  creatorFeeBps: number;
  depth: number;
  createSignature: string;
  createdSlot: number;
  createdAtMs: number;
  tokenTotalSupply: bigint;
  initialVirtualTokenReserves: bigint;
  initialVirtualQuoteReserves: bigint;
  initialRealTokenReserves: bigint;
}

export interface LaunchMetadata {
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  description: string | null;
}

export function launchInfoFromEvent(event: LaunchCreatedEvent): LaunchInfo {
  return {
    mint: event.mint,
    bondingCurve: event.bondingCurve,
    devWallet: event.devWallet,
    creator: event.creator,
    name: event.name,
    symbol: event.symbol,
    uri: event.uri,
    quoteMint: event.quoteMint,
    tokenProgram: event.tokenProgram,
    isMayhemMode: event.isMayhemMode,
    isCashback: event.isCashback,
    isHolderReward: event.isHolderReward,
    creatorFeeBps: event.creatorFeeBps,
    depth: event.depth,
    createSignature: event.tx.signature,
    createdSlot: event.tx.slot,
    createdAtMs: event.timestampMs,
    tokenTotalSupply: event.tokenTotalSupply,
    initialVirtualTokenReserves: event.virtualTokenReserves,
    initialVirtualQuoteReserves: event.virtualQuoteReserves,
    initialRealTokenReserves: event.realTokenReserves
  };
}

export function lamportsToSol(value: bigint): number {
  return Number(value) / Number(LAMPORTS_PER_SOL);
}

export class LaunchState {
  launchId: number | null = null;
  readonly info: LaunchInfo;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint | null;
  realQuoteReserves: bigint | null;
  venue: TradeVenue = "curve";
  complete = false;
  completedAtMs: number | null = null;
  completedSlot: number | null = null;
  migrated = false;
  migratedAtMs: number | null = null;
  migratedSlot: number | null = null;
  pool: Pubkey | null = null;
  protocolFeeBps: number | null = null;
  creatorFeeBps: number | null = null;
  lpFeeBps: number | null = null;
  readonly trades: TradeRecord[] = [];
  readonly wallets = new Map<Pubkey, WalletActivity>();
  readonly insiders = new Set<Pubkey>();
  metadata: LaunchMetadata | null = null;
  buyCount = 0;
  sellCount = 0;
  buyVolume = 0n;
  sellVolume = 0n;
  uniqueBuyers = 0;
  peakMcapQuote: bigint;
  peakAtMs: number;
  peakSlot: number;
  lastTradeAtMs: number | null = null;
  lastSlot: number;
  droppedTrades = 0;
  dataComplete = true;
  private buyOrder = 0;

  constructor(info: LaunchInfo) {
    this.info = info;
    this.virtualTokenReserves = info.initialVirtualTokenReserves;
    this.virtualQuoteReserves = info.initialVirtualQuoteReserves;
    this.realTokenReserves = info.initialRealTokenReserves;
    this.realQuoteReserves = 0n;
    this.peakMcapQuote = this.mcapQuote();
    this.peakAtMs = info.createdAtMs;
    this.peakSlot = info.createdSlot;
    this.lastSlot = info.createdSlot;
  }

  get mint(): Pubkey {
    return this.info.mint;
  }

  price(): number {
    return curvePrice(this);
  }

  mcapQuote(): bigint {
    return marketCapQuote(this, this.info.tokenTotalSupply);
  }

  get isSolQuoted(): boolean {
    return this.info.quoteMint === SOL_QUOTE;
  }

  initialMcapQuote(): bigint {
    return marketCapQuote(
      {
        virtualTokenReserves: this.info.initialVirtualTokenReserves,
        virtualQuoteReserves: this.info.initialVirtualQuoteReserves
      },
      this.info.tokenTotalSupply
    );
  }

  multipleOfInitial(mcapQuote: bigint): number {
    const initial = this.initialMcapQuote();
    return initial > 0n ? Number(mcapQuote) / Number(initial) : 0;
  }

  mcapMultiple(): number {
    return this.multipleOfInitial(this.mcapQuote());
  }

  mcapSol(): number | null {
    return this.isSolQuoted ? lamportsToSol(this.mcapQuote()) : null;
  }

  quoteToSol(amount: bigint): number | null {
    return this.isSolQuoted ? lamportsToSol(amount) : null;
  }

  ageMs(nowMs: number): number {
    return nowMs - this.info.createdAtMs;
  }

  applyTrade(event: TradeEvent, maxTrades: number): TradeRecord {
    if (event.venue === "pool") {
      this.migrated = true;
      this.complete = true;
      if (event.pool && !this.pool) {
        this.pool = event.pool;
      }
    }
    this.venue = event.venue;
    this.virtualTokenReserves = event.virtualTokenReserves;
    this.virtualQuoteReserves = event.virtualQuoteReserves;
    this.realTokenReserves = event.realTokenReserves;
    this.realQuoteReserves = event.realQuoteReserves;
    if (event.venue === "pool") {
      this.lpFeeBps = event.lpFeeBps;
    }
    this.protocolFeeBps = event.protocolFeeBps;
    this.creatorFeeBps = event.creatorFeeBps;
    const atMs = event.timestampMs > 0 ? event.timestampMs : event.tx.receivedAtMs;
    const price = this.price();
    const mcap = this.mcapQuote();
    const record: TradeRecord = {
      slot: event.tx.slot,
      seq: event.tx.seq,
      eventIndex: event.tx.eventIndex,
      atMs,
      signature: event.tx.signature,
      wallet: event.wallet,
      isBuy: event.isBuy,
      venue: event.venue,
      tokenAmount: event.tokenAmount,
      quoteAmount: event.quoteAmount,
      userQuote: event.userQuote,
      virtualTokenReserves: event.virtualTokenReserves,
      virtualQuoteReserves: event.virtualQuoteReserves,
      realTokenReserves: event.realTokenReserves,
      realQuoteReserves: event.realQuoteReserves,
      protocolFeeBps: event.protocolFeeBps,
      creatorFeeBps: event.creatorFeeBps,
      lpFeeBps: event.lpFeeBps,
      price,
      mcapQuote: mcap,
      mcapMultiple: this.multipleOfInitial(mcap)
    };
    if (this.trades.length < maxTrades) {
      this.trades.push(record);
    } else {
      this.droppedTrades += 1;
    }
    let activity = this.wallets.get(event.wallet);
    if (!activity) {
      activity = {
        wallet: event.wallet,
        bought: 0n,
        sold: 0n,
        quoteIn: 0n,
        quoteOut: 0n,
        buys: 0,
        sells: 0,
        firstBuySlot: null,
        firstBuyAtMs: null,
        firstBuyOrder: null,
        lastTradeAtMs: atMs
      };
      this.wallets.set(event.wallet, activity);
    }
    activity.lastTradeAtMs = atMs;
    if (event.isBuy) {
      if (activity.buys === 0) {
        this.uniqueBuyers += 1;
        activity.firstBuySlot = event.tx.slot;
        activity.firstBuyAtMs = atMs;
        activity.firstBuyOrder = this.buyOrder;
        this.buyOrder += 1;
      }
      activity.buys += 1;
      activity.bought += event.tokenAmount;
      activity.quoteIn += event.userQuote;
      this.buyCount += 1;
      this.buyVolume += event.userQuote;
    } else {
      activity.sells += 1;
      activity.sold += event.tokenAmount;
      activity.quoteOut += event.userQuote;
      this.sellCount += 1;
      this.sellVolume += event.userQuote;
    }
    if (mcap > this.peakMcapQuote) {
      this.peakMcapQuote = mcap;
      this.peakAtMs = atMs;
      this.peakSlot = event.tx.slot;
    }
    this.lastTradeAtMs = atMs;
    this.lastSlot = Math.max(this.lastSlot, event.tx.slot);
    return record;
  }

  balanceOf(wallet: Pubkey): bigint {
    const activity = this.wallets.get(wallet);
    if (!activity) {
      return 0n;
    }
    const balance = activity.bought - activity.sold;
    return balance > 0n ? balance : 0n;
  }

  holders(): Array<{ wallet: Pubkey; balance: bigint }> {
    const result: Array<{ wallet: Pubkey; balance: bigint }> = [];
    for (const activity of this.wallets.values()) {
      const balance = activity.bought - activity.sold;
      if (balance > 0n) {
        result.push({ wallet: activity.wallet, balance });
      }
    }
    result.sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));
    return result;
  }

  supplyShare(amount: bigint): number {
    if (this.info.tokenTotalSupply <= 0n) {
      return 0;
    }
    return Number((amount * 1_000_000n) / this.info.tokenTotalSupply) / 1_000_000;
  }

  tradesUpTo(slot: number): TradeRecord[] {
    let low = 0;
    let high = this.trades.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const trade = this.trades[mid];
      if (trade && trade.slot <= slot) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return this.trades.slice(0, low);
  }

  tradesUntil(atMs: number): TradeRecord[] {
    let low = 0;
    let high = this.trades.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const trade = this.trades[mid];
      if (trade && trade.atMs <= atMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return this.trades.slice(0, low);
  }

  view(nowMs: number): CurveView {
    return {
      mint: this.info.mint,
      slot: this.lastSlot,
      atMs: this.lastTradeAtMs ?? nowMs,
      venue: this.venue,
      virtualTokenReserves: this.virtualTokenReserves,
      virtualQuoteReserves: this.virtualQuoteReserves,
      realTokenReserves: this.realTokenReserves,
      realQuoteReserves: this.realQuoteReserves,
      tokenTotalSupply: this.info.tokenTotalSupply,
      complete: this.complete,
      migrated: this.migrated,
      protocolFeeBps: this.protocolFeeBps ?? -1,
      creatorFeeBps: this.creatorFeeBps ?? -1,
      lpFeeBps: this.lpFeeBps ?? -1
    };
  }
}

export interface MarketStateOptions {
  maxTradesPerLaunch: number;
  evictInactiveMs: number;
  evictMaxAgeMs: number;
  quoteMints: readonly string[] | null;
}

export type ApplyOutcome =
  | { kind: "created"; launch: LaunchState }
  | { kind: "trade"; launch: LaunchState; trade: TradeRecord; event: TradeEvent }
  | { kind: "complete"; launch: LaunchState }
  | { kind: "migrate"; launch: LaunchState }
  | { kind: "ignored" };

export class MarketState {
  private readonly launches = new Map<Pubkey, LaunchState>();
  private readonly poolToMint = new Map<Pubkey, Pubkey>();
  latestSlot = 0;
  latestEventMs = 0;

  constructor(private readonly options: MarketStateOptions) {}

  get size(): number {
    return this.launches.size;
  }

  get(mint: Pubkey): LaunchState | undefined {
    return this.launches.get(mint);
  }

  all(): IterableIterator<LaunchState> {
    return this.launches.values();
  }

  mintForPool(pool: Pubkey): Pubkey | undefined {
    return this.poolToMint.get(pool);
  }

  registerPool(pool: Pubkey, mint: Pubkey): void {
    this.poolToMint.set(pool, mint);
    const launch = this.launches.get(mint);
    if (launch && !launch.pool) {
      launch.pool = pool;
    }
  }

  resolve(decoded: DecodedChainEvent): ChainEvent | null {
    if (decoded.kind === "poolCreated") {
      const launch = this.launches.get(decoded.baseMint);
      if (launch && isCanonicalPumpPool(decoded.pool, decoded.baseMint, launch.info.quoteMint)) {
        this.registerPool(decoded.pool, decoded.baseMint);
      }
      return null;
    }
    if (decoded.kind === "poolTrade") {
      const mint = this.poolToMint.get(decoded.pool);
      if (!mint) {
        return null;
      }
      const { kind: _kind, ...rest } = decoded;
      return { ...rest, kind: "trade", mint, venue: "pool", pool: decoded.pool };
    }
    return decoded;
  }

  adopt(launch: LaunchState): void {
    this.launches.set(launch.mint, launch);
    if (launch.pool) {
      this.poolToMint.set(launch.pool, launch.mint);
    }
  }

  apply(event: ChainEvent): ApplyOutcome {
    this.latestSlot = Math.max(this.latestSlot, event.tx.slot);
    this.latestEventMs = Math.max(this.latestEventMs, event.timestampMs);
    switch (event.kind) {
      case "create": {
        if (this.options.quoteMints && !this.options.quoteMints.includes(event.quoteMint)) {
          return { kind: "ignored" };
        }
        const existing = this.launches.get(event.mint);
        if (existing) {
          return { kind: "ignored" };
        }
        const launch = new LaunchState(launchInfoFromEvent(event));
        this.launches.set(event.mint, launch);
        return { kind: "created", launch };
      }
      case "trade": {
        const launch = this.launches.get(event.mint);
        if (!launch) {
          return { kind: "ignored" };
        }
        const trade = launch.applyTrade(event, this.options.maxTradesPerLaunch);
        return { kind: "trade", launch, trade, event };
      }
      case "complete": {
        const launch = this.launches.get(event.mint);
        if (!launch) {
          return { kind: "ignored" };
        }
        launch.complete = true;
        launch.completedAtMs = event.timestampMs;
        launch.completedSlot = event.tx.slot;
        return { kind: "complete", launch };
      }
      case "migrate": {
        const launch = this.launches.get(event.mint);
        if (!launch) {
          return { kind: "ignored" };
        }
        launch.complete = true;
        launch.migrated = true;
        launch.migratedAtMs = event.timestampMs;
        launch.migratedSlot = event.tx.slot;
        if (launch.pool && launch.pool !== event.pool && this.poolToMint.get(launch.pool) === event.mint) {
          this.poolToMint.delete(launch.pool);
        }
        launch.pool = event.pool;
        this.poolToMint.set(event.pool, event.mint);
        return { kind: "migrate", launch };
      }
      default:
        return { kind: "ignored" };
    }
  }

  evict(nowMs: number, keep: (launch: LaunchState) => boolean = () => false): LaunchState[] {
    const evicted: LaunchState[] = [];
    for (const launch of this.launches.values()) {
      if (keep(launch)) {
        continue;
      }
      const last = launch.lastTradeAtMs ?? launch.info.createdAtMs;
      const inactive = nowMs - last > this.options.evictInactiveMs;
      const old = nowMs - launch.info.createdAtMs > this.options.evictMaxAgeMs;
      if (inactive || old) {
        evicted.push(launch);
      }
    }
    for (const launch of evicted) {
      this.launches.delete(launch.mint);
    }
    return evicted;
  }
}
