import { SOL_QUOTE } from "../core/constants.js";
import type { Pubkey, TradeVenue } from "../core/types.js";
import { toNumber, type Db } from "../db/pool.js";
import { VENUE_CODES } from "../recorder/recorder.js";
import { LINKING_ENTITY_KINDS } from "../scorer/intel.js";
import type { MintContext, WalletFacts, WalletTrade } from "./types.js";

export interface CandidateRow {
  wallet: Pubkey;
  mints: number;
  trades: number;
  netFlowSol: number;
}

export interface CandidateQuery {
  fromMs: number;
  asOfMs: number;
  minDistinctMints: number;
  limit: number;
  historyKnownBeforeMs: number | null;
}

function historyCutoff(knownBeforeMs: number | null): Date | null {
  return knownBeforeMs === null ? null : new Date(knownBeforeMs);
}

const VENUE_BY_CODE: ReadonlyMap<number, TradeVenue> = new Map(
  (Object.entries(VENUE_CODES) as Array<[TradeVenue, number]>).map(([venue, code]) => [code, venue])
);

export function venueFromCode(code: unknown): TradeVenue {
  return VENUE_BY_CODE.get(toNumber(code)) ?? "curve";
}

export async function selectCandidates(db: Db, query: CandidateQuery): Promise<CandidateRow[]> {
  const result = await db.query<{ wallet: string; mints: number; trades: number; net: number | null }>(
    `WITH recorded AS (
       SELECT t.wallet, l.mint, count(*) AS n,
              sum(CASE WHEN t.is_buy THEN -t.user_quote ELSE t.user_quote END) AS net
       FROM trades t
       JOIN launches l ON l.id = t.launch_id
       WHERE t.block_time >= $1 AND t.block_time < $2 AND l.quote_mint = $3
       GROUP BY t.wallet, l.mint
     ), history AS (
       SELECT h.wallet, h.mint, count(*) AS n,
              sum(CASE WHEN h.is_buy THEN -h.user_quote ELSE h.user_quote END) AS net
       FROM wallet_history_trades h
       WHERE h.block_time >= $1 AND h.block_time < $2 AND h.quote_mint = $3
         AND ($6::timestamptz IS NULL OR h.fetched_at < $6::timestamptz)
       GROUP BY h.wallet, h.mint
     ), combined AS (
       SELECT wallet, mint, max(n) AS n, (array_agg(net ORDER BY n DESC))[1] AS net
       FROM (SELECT wallet, mint, n, net FROM recorded UNION ALL SELECT wallet, mint, n, net FROM history) unioned
       GROUP BY wallet, mint
     )
     SELECT wallet, count(*)::int AS mints, sum(n)::int AS trades, sum(net)::float8 AS net
     FROM combined
     GROUP BY wallet
     HAVING count(*) >= $4
     ORDER BY sum(net) DESC, wallet
     LIMIT $5`,
    [
      new Date(query.fromMs),
      new Date(query.asOfMs),
      SOL_QUOTE,
      query.minDistinctMints,
      query.limit,
      historyCutoff(query.historyKnownBeforeMs)
    ]
  );
  return result.rows.map((row) => ({
    wallet: row.wallet,
    mints: toNumber(row.mints),
    trades: toNumber(row.trades),
    netFlowSol: toNumber(row.net) / 1e9
  }));
}

interface TradeRow {
  wallet: string;
  mint: string;
  signature: string;
  event_index: unknown;
  slot: unknown;
  seq: unknown;
  block_time: Date;
  venue: unknown;
  is_buy: boolean;
  token_amount: bigint;
  user_quote: bigint;
  quote_mint: string;
}

function walletTradeFromRow(row: TradeRow): WalletTrade {
  return {
    wallet: row.wallet,
    mint: row.mint,
    signature: row.signature,
    eventIndex: toNumber(row.event_index),
    slot: toNumber(row.slot),
    seq: toNumber(row.seq),
    atMs: row.block_time.getTime(),
    venue: venueFromCode(row.venue),
    isBuy: row.is_buy,
    tokenAmount: BigInt(row.token_amount),
    userQuote: BigInt(row.user_quote),
    quoteMint: row.quote_mint
  };
}

export async function loadRecordedTrades(db: Db, wallets: readonly Pubkey[], fromMs: number, asOfMs: number): Promise<WalletTrade[]> {
  const result = await db.query<TradeRow>(
    `SELECT t.wallet, l.mint, t.signature, t.event_index, t.slot, t.seq, t.block_time, t.venue, t.is_buy,
            t.token_amount, t.user_quote, l.quote_mint
     FROM trades t
     JOIN launches l ON l.id = t.launch_id
     WHERE t.wallet = ANY($1::text[]) AND t.block_time >= $2 AND t.block_time < $3 AND l.quote_mint = $4`,
    [wallets, new Date(fromMs), new Date(asOfMs), SOL_QUOTE]
  );
  return result.rows.map(walletTradeFromRow);
}

export async function loadHistoryTrades(
  db: Db,
  wallets: readonly Pubkey[],
  fromMs: number,
  asOfMs: number,
  historyKnownBeforeMs: number | null
): Promise<WalletTrade[]> {
  const result = await db.query<TradeRow>(
    `SELECT wallet, mint, signature, event_index, slot, 0 AS seq, block_time, venue, is_buy, token_amount, user_quote, quote_mint
     FROM wallet_history_trades
     WHERE wallet = ANY($1::text[]) AND block_time >= $2 AND block_time < $3 AND quote_mint = $4
       AND ($5::timestamptz IS NULL OR fetched_at < $5::timestamptz)`,
    [wallets, new Date(fromMs), new Date(asOfMs), SOL_QUOTE, historyCutoff(historyKnownBeforeMs)]
  );
  return result.rows.map(walletTradeFromRow);
}

export function tradeIdentityKeys(trade: WalletTrade): [string, string] {
  return [`${trade.signature}:${trade.eventIndex}`, `${trade.signature}:${trade.mint}:${trade.isBuy}:${trade.tokenAmount}`];
}

export function mergeTradeSources(recorded: readonly WalletTrade[], history: readonly WalletTrade[]): WalletTrade[] {
  const seen = new Set<string>();
  for (const trade of recorded) {
    for (const key of tradeIdentityKeys(trade)) {
      seen.add(key);
    }
  }
  const merged = [...recorded];
  for (const trade of history) {
    const [byIndex, byContent] = tradeIdentityKeys(trade);
    if (!seen.has(byIndex) && !seen.has(byContent)) {
      merged.push(trade);
    }
  }
  return merged;
}

interface MintContextRow {
  mint: string;
  create_slot: unknown;
  created_at: Date;
  outcome_known_at: Date | null;
  dead: boolean | null;
}

const MINT_LOOKUP_CHUNK = 5_000;

export async function loadMintContexts(db: Db, mints: readonly Pubkey[], asOfMs: number): Promise<Map<Pubkey, MintContext>> {
  const contexts = new Map<Pubkey, MintContext>();
  for (let start = 0; start < mints.length; start += MINT_LOOKUP_CHUNK) {
    const result = await db.query<MintContextRow>(
      `SELECT l.mint, l.create_slot, l.created_at, lo.outcome_known_at,
              (lo.rugged OR lo.died OR lo.status IN ('rugged', 'died')) AS dead
       FROM launches l
       LEFT JOIN launch_outcomes lo ON lo.launch_id = l.id
       WHERE l.mint = ANY($1::text[]) AND l.created_at < $2`,
      [mints.slice(start, start + MINT_LOOKUP_CHUNK), new Date(asOfMs)]
    );
    for (const row of result.rows) {
      const knownAt = row.outcome_known_at?.getTime() ?? null;
      contexts.set(row.mint, {
        createdAtMs: row.created_at.getTime(),
        createdSlot: toNumber(row.create_slot),
        deadAtMs: row.dead === true && knownAt !== null && knownAt < asOfMs ? knownAt : null
      });
    }
  }
  return contexts;
}

async function walletSet(db: Db, sql: string, params: unknown[]): Promise<Set<Pubkey>> {
  const result = await db.query<{ wallet: string }>(sql, params);
  return new Set(result.rows.map((row) => row.wallet));
}

export function devLinkedWallets(db: Db, wallets: readonly Pubkey[], asOfMs: number, creationSlotWindow = 1): Promise<Set<Pubkey>> {
  return walletSet(
    db,
    `SELECT w AS wallet FROM unnest($1::text[]) AS w
     WHERE EXISTS (SELECT 1 FROM launches l WHERE l.dev_wallet = w AND l.created_at < $2)
        OR EXISTS (SELECT 1 FROM launches l JOIN trades t ON t.launch_id = l.id
                    WHERE l.creator = w AND l.created_at < $2 AND t.wallet = w AND t.is_buy
                      AND t.slot <= l.create_slot + $3 AND t.block_time < $2)`,
    [wallets, new Date(asOfMs), creationSlotWindow]
  );
}

export function devFundedWallets(db: Db, wallets: readonly Pubkey[], asOfMs: number): Promise<Set<Pubkey>> {
  return walletSet(
    db,
    `SELECT DISTINCT wi.wallet FROM wallet_intel wi
     WHERE wi.wallet = ANY($1::text[]) AND wi.funder IS NOT NULL
       AND wi.checked_at < $2 AND COALESCE(wi.funded_at, wi.checked_at) < $2
       AND NOT EXISTS (SELECT 1 FROM wallet_intel hub WHERE hub.wallet = wi.funder AND hub.is_hub)
       AND NOT EXISTS (SELECT 1 FROM known_entities k WHERE k.address = wi.funder AND k.added_at < $2 AND k.kind <> ALL($3::text[]))
       AND EXISTS (SELECT 1 FROM launches l WHERE l.dev_wallet = wi.funder AND l.created_at < $2)`,
    [wallets, new Date(asOfMs), [...LINKING_ENTITY_KINDS]]
  );
}

export function devFunderWallets(db: Db, wallets: readonly Pubkey[], asOfMs: number): Promise<Set<Pubkey>> {
  return walletSet(
    db,
    `SELECT DISTINCT wi.funder AS wallet FROM wallet_intel wi
     WHERE wi.funder = ANY($1::text[]) AND wi.checked_at < $2 AND COALESCE(wi.funded_at, wi.checked_at) < $2
       AND EXISTS (SELECT 1 FROM launches l WHERE l.dev_wallet = wi.wallet AND l.created_at < $2)`,
    [wallets, new Date(asOfMs)]
  );
}

export async function insiderLaunchCounts(
  db: Db,
  wallets: readonly Pubkey[],
  fromMs: number,
  asOfMs: number
): Promise<Map<Pubkey, number>> {
  const result = await db.query<{ wallet: string; launches: number }>(
    `SELECT w AS wallet, count(DISTINCT ls.launch_id)::int AS launches
     FROM launch_scores ls
     CROSS JOIN LATERAL unnest(ls.insiders) AS w
     WHERE ls.insiders && $1::text[] AND w = ANY($1::text[]) AND ls.computed_at >= $2 AND ls.computed_at < $3
     GROUP BY w`,
    [wallets, new Date(fromMs), new Date(asOfMs)]
  );
  return new Map(result.rows.map((row) => [row.wallet, toNumber(row.launches)]));
}

export async function knownEntityKinds(db: Db, wallets: readonly Pubkey[], asOfMs: number): Promise<Map<Pubkey, string>> {
  const result = await db.query<{ address: string; kind: string }>(
    `SELECT address, kind FROM known_entities WHERE address = ANY($1::text[]) AND added_at < $2`,
    [wallets, new Date(asOfMs)]
  );
  return new Map(result.rows.map((row) => [row.address, row.kind]));
}

export interface FactWindow {
  fromMs: number;
  asOfMs: number;
  creationSlotWindow?: number;
}

export async function loadWalletFacts(
  db: Db,
  wallets: readonly Pubkey[],
  window: FactWindow,
  tooActive: ReadonlySet<Pubkey>
): Promise<Map<Pubkey, WalletFacts>> {
  const [linked, funded, funders, insiders, entities] = await Promise.all([
    devLinkedWallets(db, wallets, window.asOfMs, window.creationSlotWindow),
    devFundedWallets(db, wallets, window.asOfMs),
    devFunderWallets(db, wallets, window.asOfMs),
    insiderLaunchCounts(db, wallets, window.fromMs, window.asOfMs),
    knownEntityKinds(db, wallets, window.asOfMs)
  ]);
  const facts = new Map<Pubkey, WalletFacts>();
  for (const wallet of wallets) {
    facts.set(wallet, {
      knownEntityKind: entities.get(wallet) ?? null,
      devLinked: linked.has(wallet),
      devFunded: funded.has(wallet),
      devFunder: funders.has(wallet),
      insiderLaunches: insiders.get(wallet) ?? 0,
      tooActive: tooActive.has(wallet)
    });
  }
  return facts;
}
