import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { decodeLogs, decodeRawEvent, normalizeQuoteMint, type DecodedChainEvent } from "../chain/events.js";
import { extractProgramData } from "../chain/logs.js";
import type { ParsedTransaction } from "../chain/rpc.js";
import { PUMP_PROGRAM_ID, SOL_QUOTE, WSOL_MINT } from "../core/constants.js";
import type { OrderSide, TradeVenue } from "../core/types.js";

export interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner: string | null;
  amount: bigint;
}

export interface ConfirmedTransaction {
  signature: string;
  slot: number;
  blockTimeMs: number | null;
  err: unknown;
  fee: bigint;
  logMessages: readonly string[];
  accountKeys: readonly string[];
  preBalances: readonly bigint[];
  postBalances: readonly bigint[];
  preTokenBalances: readonly TokenBalanceEntry[];
  postTokenBalances: readonly TokenBalanceEntry[];
  computeUnitsConsumed: number | null;
}

export interface FillTarget {
  user: string;
  mint: string;
  pool: string | null;
}

export interface ParsedFill {
  signature: string;
  slot: number;
  blockTimeMs: number | null;
  failed: boolean;
  err: unknown;
  venue: TradeVenue | null;
  side: OrderSide | null;
  tradeEvents: number;
  quoteMint: string | null;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  lpFee: bigint;
  networkFee: bigint;
  solDelta: bigint;
  wrappedSolDelta: bigint;
  tokenDelta: bigint;
  rentPaid: bigint;
  rentRefunded: bigint;
  unexplainedLamports: bigint;
}

interface MatchedTrade {
  venue: TradeVenue;
  isBuy: boolean;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  lpFee: bigint;
  pool: string | null;
}

interface TradeTotals {
  venue: TradeVenue | null;
  side: OrderSide | null;
  count: number;
  pool: string | null;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  lpFee: bigint;
}

function toBigint(value: number | string | bigint | null | undefined): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  }
  return /^-?\d+$/.test(value) ? BigInt(value) : 0n;
}

function matchTrade(event: DecodedChainEvent, target: FillTarget): MatchedTrade | null {
  if (event.kind === "trade") {
    if (event.mint !== target.mint || event.wallet !== target.user) {
      return null;
    }
    return { ...event, pool: event.pool };
  }
  if (event.kind === "poolTrade") {
    if (event.wallet !== target.user || (target.pool !== null && event.pool !== target.pool)) {
      return null;
    }
    return { ...event, venue: "pool", pool: event.pool };
  }
  return null;
}

function emptyTotals(): TradeTotals {
  return {
    venue: null,
    side: null,
    count: 0,
    pool: null,
    tokenAmount: 0n,
    quoteAmount: 0n,
    userQuote: 0n,
    protocolFee: 0n,
    creatorFee: 0n,
    lpFee: 0n
  };
}

function venueAfter(current: TradeVenue | null, next: TradeVenue): TradeVenue {
  if (current === "curve" || next === "curve") {
    return "curve";
  }
  return current ?? next;
}

export function sumTargetTrades(tx: Pick<ConfirmedTransaction, "logMessages" | "signature" | "slot">, target: FillTarget): TradeTotals {
  const decoded = decodeLogs(tx.logMessages, { signature: tx.signature, slot: tx.slot, seq: 0, receivedAtMs: 0 });
  const totals = emptyTotals();
  for (const event of decoded.events) {
    const trade = matchTrade(event, target);
    if (!trade) {
      continue;
    }
    const side: OrderSide = trade.isBuy ? "buy" : "sell";
    if (totals.side !== null && totals.side !== side) {
      continue;
    }
    totals.side = side;
    totals.venue = venueAfter(totals.venue, trade.venue);
    totals.pool = totals.pool ?? trade.pool;
    totals.count += 1;
    totals.tokenAmount += trade.tokenAmount;
    totals.quoteAmount += trade.quoteAmount;
    totals.userQuote += trade.userQuote;
    totals.protocolFee += trade.protocolFee;
    totals.creatorFee += trade.creatorFee;
    totals.lpFee += trade.lpFee;
  }
  return totals;
}

export function curveQuoteMint(logMessages: readonly string[], target: Pick<FillTarget, "mint" | "user">): string | null {
  for (const entry of extractProgramData(logMessages).entries) {
    if (entry.programId !== PUMP_PROGRAM_ID) {
      continue;
    }
    const raw = decodeRawEvent(entry.programId, entry.data);
    if (raw?.name !== "TradeEvent" || raw.fields.mint !== target.mint || raw.fields.user !== target.user) {
      continue;
    }
    const quoteMint = raw.fields.quote_mint;
    return normalizeQuoteMint(typeof quoteMint === "string" ? quoteMint : null);
  }
  return null;
}

export function poolQuoteMint(tx: Pick<ConfirmedTransaction, "preTokenBalances" | "postTokenBalances">, pool: string, baseMint: string): string | null {
  for (const entry of [...tx.preTokenBalances, ...tx.postTokenBalances]) {
    if (entry.owner === pool && entry.mint !== baseMint) {
      return normalizeQuoteMint(entry.mint);
    }
  }
  return null;
}

function lamportsAt(balances: readonly bigint[], index: number): bigint {
  return balances[index] ?? 0n;
}

function rentPortion(entry: TokenBalanceEntry, lamports: bigint): bigint {
  const rent = entry.mint === WSOL_MINT ? lamports - entry.amount : lamports;
  return rent > 0n ? rent : 0n;
}

export function tokenAccountRent(tx: ConfirmedTransaction, owner: string): { rentPaid: bigint; rentRefunded: bigint } {
  let rentPaid = 0n;
  let rentRefunded = 0n;
  for (const entry of tx.postTokenBalances) {
    if (entry.owner !== owner) {
      continue;
    }
    const before = lamportsAt(tx.preBalances, entry.accountIndex);
    const after = lamportsAt(tx.postBalances, entry.accountIndex);
    if (before === 0n && after > 0n) {
      rentPaid += rentPortion(entry, after);
    }
  }
  for (const entry of tx.preTokenBalances) {
    if (entry.owner !== owner) {
      continue;
    }
    const before = lamportsAt(tx.preBalances, entry.accountIndex);
    const after = lamportsAt(tx.postBalances, entry.accountIndex);
    if (before > 0n && after === 0n) {
      rentRefunded += rentPortion(entry, before);
    }
  }
  return { rentPaid, rentRefunded };
}

export function tokenBalanceDelta(tx: ConfirmedTransaction, owner: string, mint: string): bigint {
  const sum = (entries: readonly TokenBalanceEntry[]): bigint =>
    entries.filter((entry) => entry.owner === owner && entry.mint === mint).reduce((total, entry) => total + entry.amount, 0n);
  return sum(tx.postTokenBalances) - sum(tx.preTokenBalances);
}

export function lamportDelta(tx: ConfirmedTransaction, account: string): bigint {
  const index = tx.accountKeys.indexOf(account);
  if (index < 0) {
    return 0n;
  }
  return lamportsAt(tx.postBalances, index) - lamportsAt(tx.preBalances, index);
}

function resolveQuoteMint(tx: ConfirmedTransaction, target: FillTarget, totals: TradeTotals): string | null {
  if (totals.venue === "pool") {
    const pool = target.pool ?? totals.pool;
    return pool ? poolQuoteMint(tx, pool, target.mint) : null;
  }
  if (totals.venue === null) {
    return null;
  }
  return curveQuoteMint(tx.logMessages, target);
}

export function parseFill(tx: ConfirmedTransaction, target: FillTarget): ParsedFill {
  const failed = tx.err !== null && tx.err !== undefined;
  const totals = failed ? emptyTotals() : sumTargetTrades(tx, target);
  const quoteMint = resolveQuoteMint(tx, target, totals);
  const rent = tokenAccountRent(tx, target.user);
  const solDelta = lamportDelta(tx, target.user);
  const wrappedSolDelta = tokenBalanceDelta(tx, target.user, WSOL_MINT);
  const isSol = quoteMint === SOL_QUOTE;
  const quoteFlow = !isSol || totals.side === null ? 0n : totals.side === "buy" ? -totals.userQuote : totals.userQuote;
  return {
    signature: tx.signature,
    slot: tx.slot,
    blockTimeMs: tx.blockTimeMs,
    failed,
    err: failed ? tx.err : null,
    venue: totals.venue,
    side: totals.side,
    tradeEvents: totals.count,
    quoteMint,
    tokenAmount: totals.tokenAmount,
    quoteAmount: totals.quoteAmount,
    userQuote: totals.userQuote,
    protocolFee: totals.protocolFee,
    creatorFee: totals.creatorFee,
    lpFee: totals.lpFee,
    networkFee: tx.fee,
    solDelta,
    wrappedSolDelta,
    tokenDelta: tokenBalanceDelta(tx, target.user, target.mint),
    rentPaid: rent.rentPaid,
    rentRefunded: rent.rentRefunded,
    unexplainedLamports: quoteFlow - tx.fee - rent.rentPaid + rent.rentRefunded - (solDelta + wrappedSolDelta)
  };
}

function keyOf(key: string | { pubkey: string | { toBase58(): string } }): string {
  if (typeof key === "string") {
    return key;
  }
  return typeof key.pubkey === "string" ? key.pubkey : key.pubkey.toBase58();
}

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string | null;
  uiTokenAmount: { amount: string };
}

function tokenEntries(entries: readonly RawTokenBalance[] | null | undefined): TokenBalanceEntry[] {
  return (entries ?? []).map((entry) => ({
    accountIndex: entry.accountIndex,
    mint: entry.mint,
    owner: entry.owner ?? null,
    amount: toBigint(entry.uiTokenAmount.amount)
  }));
}

export function fromRpcTransaction(signature: string, tx: ParsedTransaction): ConfirmedTransaction | null {
  if (!tx.meta) {
    return null;
  }
  const meta = tx.meta as ParsedTransaction["meta"] & { computeUnitsConsumed?: number };
  return {
    signature,
    slot: tx.slot,
    blockTimeMs: tx.blockTime === null ? null : tx.blockTime * 1000,
    err: meta?.err ?? null,
    fee: toBigint(meta?.fee),
    logMessages: meta?.logMessages ?? [],
    accountKeys: tx.transaction.message.accountKeys.map(keyOf),
    preBalances: (meta?.preBalances ?? []).map(toBigint),
    postBalances: (meta?.postBalances ?? []).map(toBigint),
    preTokenBalances: tokenEntries(meta?.preTokenBalances),
    postTokenBalances: tokenEntries(meta?.postTokenBalances),
    computeUnitsConsumed: meta?.computeUnitsConsumed ?? null
  };
}

export function fromWeb3Transaction(signature: string, tx: ParsedTransactionWithMeta): ConfirmedTransaction | null {
  const meta = tx.meta;
  if (!meta) {
    return null;
  }
  return {
    signature,
    slot: tx.slot,
    blockTimeMs: tx.blockTime === null || tx.blockTime === undefined ? null : tx.blockTime * 1000,
    err: meta.err ?? null,
    fee: toBigint(meta.fee),
    logMessages: meta.logMessages ?? [],
    accountKeys: tx.transaction.message.accountKeys.map((key) => key.pubkey.toBase58()),
    preBalances: meta.preBalances.map(toBigint),
    postBalances: meta.postBalances.map(toBigint),
    preTokenBalances: tokenEntries(meta.preTokenBalances),
    postTokenBalances: tokenEntries(meta.postTokenBalances),
    computeUnitsConsumed: meta.computeUnitsConsumed ?? null
  };
}
