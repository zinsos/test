import {
  decodeLogs,
  decodeRawEvent,
  normalizeQuoteMint,
  type DecodedChainEvent,
  type PoolCreatedEvent,
  type PoolTradeEvent
} from "../chain/events.js";
import { extractProgramData } from "../chain/logs.js";
import type { ParsedTransaction } from "../chain/rpc.js";
import { PUMP_PROGRAM_ID, SOL_QUOTE, WSOL_MINT } from "../core/constants.js";
import type { Pubkey, TradeEvent, TradeVenue } from "../core/types.js";

export interface TokenBalanceInput {
  accountIndex: number;
  mint: string;
  owner?: string | null;
  uiTokenAmount: { amount: string };
}

export interface TransactionInput {
  signature: string;
  slot: number;
  blockTimeMs: number | null;
  logs: readonly string[];
  preTokenBalances: readonly TokenBalanceInput[];
  postTokenBalances: readonly TokenBalanceInput[];
}

export interface HistoryTrade {
  wallet: Pubkey;
  mint: Pubkey;
  signature: string;
  eventIndex: number;
  slot: number;
  atMs: number;
  venue: TradeVenue;
  isBuy: boolean;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  quoteMint: string;
}

export type HistorySkipReason = "sol_only_pool" | "unresolved_pool" | "no_timestamp";

export interface WalletTradeExtraction {
  trades: HistoryTrade[];
  skipped: Partial<Record<HistorySkipReason, number>>;
  truncated: boolean;
}

export interface PoolMints {
  baseMint: string;
  quoteMint: string;
}

const MINT_BEARING_EVENTS: ReadonlySet<string> = new Set(["TradeEvent", "PostCompleteBuyEvent", "CreateEvent"]);

export function transactionInputFromParsed(signature: string, tx: ParsedTransaction): TransactionInput | null {
  const logs = tx.meta?.logMessages;
  if (!tx.meta || tx.meta.err !== null || !logs) {
    return null;
  }
  return {
    signature,
    slot: tx.slot,
    blockTimeMs: tx.blockTime === null ? null : tx.blockTime * 1000,
    logs,
    preTokenBalances: tx.meta.preTokenBalances ?? [],
    postTokenBalances: tx.meta.postTokenBalances ?? []
  };
}

export function tokenDeltasForOwner(
  pre: readonly TokenBalanceInput[],
  post: readonly TokenBalanceInput[],
  owner: string
): Map<string, bigint> {
  const before = new Map<number, TokenBalanceInput>();
  for (const balance of pre) {
    if (balance.owner === owner) {
      before.set(balance.accountIndex, balance);
    }
  }
  const deltas = new Map<string, bigint>();
  const add = (mint: string, amount: bigint): void => {
    deltas.set(mint, (deltas.get(mint) ?? 0n) + amount);
  };
  for (const balance of post) {
    if (balance.owner !== owner) {
      continue;
    }
    const previous = before.get(balance.accountIndex);
    before.delete(balance.accountIndex);
    add(balance.mint, BigInt(balance.uiTokenAmount.amount) - BigInt(previous?.uiTokenAmount.amount ?? "0"));
  }
  for (const balance of before.values()) {
    add(balance.mint, -BigInt(balance.uiTokenAmount.amount));
  }
  return deltas;
}

export function curveQuoteMints(logs: readonly string[]): Map<Pubkey, string> {
  const quoteMints = new Map<Pubkey, string>();
  for (const entry of extractProgramData(logs).entries) {
    if (entry.programId !== PUMP_PROGRAM_ID) {
      continue;
    }
    const raw = decodeRawEvent(entry.programId, entry.data);
    if (!raw || !MINT_BEARING_EVENTS.has(raw.name)) {
      continue;
    }
    const mint = raw.fields.mint;
    const quote = raw.fields.quote_mint;
    if (typeof mint === "string" && !quoteMints.has(mint)) {
      quoteMints.set(mint, normalizeQuoteMint(typeof quote === "string" ? quote : null));
    }
  }
  return quoteMints;
}

function poolOwnedMints(input: TransactionInput, pool: string): Set<string> {
  const mints = new Set<string>();
  for (const balance of [...input.preTokenBalances, ...input.postTokenBalances]) {
    if (balance.owner === pool) {
      mints.add(balance.mint);
    }
  }
  return mints;
}

function signedBase(trade: PoolTradeEvent, perspective: "pool" | "user"): bigint {
  const userGetsBase = trade.isBuy;
  const sign = (perspective === "user") === userGetsBase ? 1n : -1n;
  return sign * trade.tokenAmount;
}

function signedUserQuote(trade: PoolTradeEvent): bigint {
  return trade.isBuy ? -trade.userQuote : trade.userQuote;
}

function uniqueMatch(deltas: ReadonlyMap<string, bigint>, expected: bigint, exclude: ReadonlySet<string>): string | null {
  const matches = [...deltas.entries()].filter(([mint, delta]) => delta === expected && !exclude.has(mint));
  return matches.length === 1 ? (matches[0]?.[0] ?? null) : null;
}

export function resolvePoolFromVaults(input: TransactionInput, pool: string, poolTrades: readonly PoolTradeEvent[]): PoolMints | null {
  const expected = poolTrades.reduce((total, trade) => total + signedBase(trade, "pool"), 0n);
  if (expected === 0n) {
    return null;
  }
  const deltas = tokenDeltasForOwner(input.preTokenBalances, input.postTokenBalances, pool);
  const baseMint = uniqueMatch(deltas, expected, new Set());
  if (!baseMint) {
    return null;
  }
  const others = [...poolOwnedMints(input, pool)].filter((mint) => mint !== baseMint);
  if (others.length !== 1 || !others[0]) {
    return null;
  }
  return { baseMint, quoteMint: others[0] };
}

export function resolvePoolFromWallet(
  input: TransactionInput,
  wallet: string,
  walletTrades: readonly PoolTradeEvent[]
): PoolMints | null {
  const expectedBase = walletTrades.reduce((total, trade) => total + signedBase(trade, "user"), 0n);
  if (expectedBase === 0n) {
    return null;
  }
  const deltas = tokenDeltasForOwner(input.preTokenBalances, input.postTokenBalances, wallet);
  const baseMint = uniqueMatch(deltas, expectedBase, new Set([WSOL_MINT]));
  if (!baseMint) {
    return null;
  }
  const expectedQuote = walletTrades.reduce((total, trade) => total + signedUserQuote(trade), 0n);
  const quoteMint = uniqueMatch(deltas, expectedQuote, new Set([WSOL_MINT, baseMint]));
  return { baseMint, quoteMint: quoteMint ?? WSOL_MINT };
}

function groupPoolTrades(events: readonly DecodedChainEvent[]): Map<string, PoolTradeEvent[]> {
  const byPool = new Map<string, PoolTradeEvent[]>();
  for (const event of events) {
    if (event.kind !== "poolTrade") {
      continue;
    }
    const list = byPool.get(event.pool) ?? [];
    list.push(event);
    byPool.set(event.pool, list);
  }
  return byPool;
}

export function resolvePools(
  input: TransactionInput,
  events: readonly DecodedChainEvent[],
  wallet: string
): Map<string, PoolMints | null> {
  const created = new Map<string, PoolCreatedEvent>();
  for (const event of events) {
    if (event.kind === "poolCreated") {
      created.set(event.pool, event);
    }
  }
  const resolved = new Map<string, PoolMints | null>();
  for (const [pool, trades] of groupPoolTrades(events)) {
    const creation = created.get(pool);
    if (creation) {
      resolved.set(pool, { baseMint: creation.baseMint, quoteMint: creation.quoteMint });
      continue;
    }
    const walletTrades = trades.filter((trade) => trade.wallet === wallet);
    resolved.set(
      pool,
      resolvePoolFromVaults(input, pool, trades) ?? (walletTrades.length > 0 ? resolvePoolFromWallet(input, wallet, walletTrades) : null)
    );
  }
  return resolved;
}

function eventTimeMs(event: { timestampMs: number }, input: TransactionInput): number | null {
  if (event.timestampMs > 0) {
    return event.timestampMs;
  }
  return input.blockTimeMs;
}

function historyFromCurve(event: TradeEvent, input: TransactionInput, atMs: number, quoteMint: string): HistoryTrade {
  return {
    wallet: event.wallet,
    mint: event.mint,
    signature: input.signature,
    eventIndex: event.tx.eventIndex,
    slot: input.slot,
    atMs,
    venue: event.venue,
    isBuy: event.isBuy,
    tokenAmount: event.tokenAmount,
    quoteAmount: event.quoteAmount,
    userQuote: event.userQuote,
    quoteMint
  };
}

function historyFromPool(event: PoolTradeEvent, input: TransactionInput, atMs: number, mints: PoolMints): HistoryTrade {
  return {
    wallet: event.wallet,
    mint: mints.baseMint,
    signature: input.signature,
    eventIndex: event.tx.eventIndex,
    slot: input.slot,
    atMs,
    venue: "pool",
    isBuy: event.isBuy,
    tokenAmount: event.tokenAmount,
    quoteAmount: event.quoteAmount,
    userQuote: event.userQuote,
    quoteMint: normalizeQuoteMint(mints.quoteMint)
  };
}

export function isReversedPool(mints: PoolMints): boolean {
  return normalizeQuoteMint(mints.baseMint) === SOL_QUOTE;
}

function historyFromReversedPool(event: PoolTradeEvent, input: TransactionInput, atMs: number, mints: PoolMints): HistoryTrade {
  return {
    wallet: event.wallet,
    mint: mints.quoteMint,
    signature: input.signature,
    eventIndex: event.tx.eventIndex,
    slot: input.slot,
    atMs,
    venue: "pool",
    isBuy: !event.isBuy,
    tokenAmount: event.userQuote,
    quoteAmount: event.tokenAmount,
    userQuote: event.tokenAmount,
    quoteMint: SOL_QUOTE
  };
}

function historyFromResolvedPool(
  event: PoolTradeEvent,
  input: TransactionInput,
  atMs: number,
  mints: PoolMints
): HistoryTrade | null {
  if (!isReversedPool(mints)) {
    return historyFromPool(event, input, atMs, mints);
  }
  if (normalizeQuoteMint(mints.quoteMint) === SOL_QUOTE) {
    return null;
  }
  return historyFromReversedPool(event, input, atMs, mints);
}

export function extractWalletTrades(input: TransactionInput, wallet: Pubkey): WalletTradeExtraction {
  const decoded = decodeLogs(input.logs, {
    signature: input.signature,
    slot: input.slot,
    seq: 0,
    receivedAtMs: input.blockTimeMs ?? 0
  });
  const extraction: WalletTradeExtraction = { trades: [], skipped: {}, truncated: decoded.truncated };
  const skip = (reason: HistorySkipReason): void => {
    extraction.skipped[reason] = (extraction.skipped[reason] ?? 0) + 1;
  };
  const quoteMints = curveQuoteMints(input.logs);
  const pools = resolvePools(input, decoded.events, wallet);
  for (const event of decoded.events) {
    if ((event.kind !== "trade" && event.kind !== "poolTrade") || event.wallet !== wallet) {
      continue;
    }
    const atMs = eventTimeMs(event, input);
    if (atMs === null) {
      skip("no_timestamp");
      continue;
    }
    if (event.kind === "trade") {
      extraction.trades.push(historyFromCurve(event, input, atMs, quoteMints.get(event.mint) ?? SOL_QUOTE));
      continue;
    }
    const mints = pools.get(event.pool) ?? null;
    const trade = mints ? historyFromResolvedPool(event, input, atMs, mints) : null;
    if (trade) {
      extraction.trades.push(trade);
    } else {
      skip(mints ? "sol_only_pool" : "unresolved_pool");
    }
  }
  return extraction;
}
