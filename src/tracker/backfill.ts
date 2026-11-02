import type { ParsedTransaction, RpcPriority, SignatureInfo } from "../chain/rpc.js";
import { moduleLogger } from "../core/logger.js";
import type { Pubkey } from "../core/types.js";
import type { Db } from "../db/pool.js";
import { VENUE_CODES } from "../recorder/recorder.js";
import { extractWalletTrades, transactionInputFromParsed, type HistorySkipReason, type HistoryTrade } from "./txParse.js";

const log = moduleLogger("tracker-backfill");

export interface BackfillRpc {
  getSignaturesForAddress(
    address: string,
    options: { before?: string; until?: string; limit?: number },
    priority?: RpcPriority
  ): Promise<SignatureInfo[]>;
  getParsedTransaction(signature: string, priority?: RpcPriority): Promise<ParsedTransaction | null>;
}

export interface BackfillOptions {
  sinceMs: number;
  maxSignatures: number;
  concurrency: number;
  txConcurrency?: number;
  pageSize?: number;
  maxConsecutiveErrors?: number;
  shouldStop?: () => boolean;
}

export type BackfillSkipReason = HistorySkipReason | "failed_tx" | "not_found" | "already_stored" | "fetch_error";

export interface WalletBackfillResult {
  wallet: Pubkey;
  signaturesSeen: number;
  transactionsFetched: number;
  tradesFound: number;
  tradesWritten: number;
  skipped: Partial<Record<BackfillSkipReason, number>>;
  reachedSince: boolean;
  exhausted: boolean;
  forwardGap: boolean;
  error: string | null;
}

export interface BackfillSummary {
  wallets: WalletBackfillResult[];
  transactionsFetched: number;
  tradesWritten: number;
  errors: number;
}

interface BackfillState {
  oldestSignature: string | null;
  newestSignature: string | null;
  coveredFromMs: number | null;
  coveredToMs: number | null;
  exhausted: boolean;
  retryOnce: Set<string>;
}

interface StateRow {
  oldest_signature: string | null;
  newest_signature: string | null;
  covered_from: Date | null;
  covered_to: Date | null;
  exhausted: boolean;
  last_error: string | null;
}

type FetchFailure = "fetch_error" | "not_found";

interface FetchOutcome {
  trades: HistoryTrade[];
  failure: FetchFailure | null;
}

const RETRY_MARKER = "retry:";

function retryMarker(signatures: ReadonlySet<string>): string | null {
  return signatures.size > 0 ? `${RETRY_MARKER}${[...signatures].join(",")}` : null;
}

function parseRetryMarker(lastError: string | null): Set<string> {
  if (!lastError?.startsWith(RETRY_MARKER)) {
    return new Set();
  }
  return new Set(lastError.slice(RETRY_MARKER.length).split(",").filter((signature) => signature.length > 0));
}

function emptyState(): BackfillState {
  return { oldestSignature: null, newestSignature: null, coveredFromMs: null, coveredToMs: null, exhausted: false, retryOnce: new Set() };
}

interface WalletRun {
  db: Db;
  rpc: BackfillRpc;
  wallet: Pubkey;
  options: Required<Omit<BackfillOptions, "shouldStop">> & { shouldStop: () => boolean };
  result: WalletBackfillResult;
  budget: number;
  consecutiveErrors: number;
  savedScanned: number;
  savedFound: number;
}

const HISTORY_COLUMNS = [
  "wallet",
  "mint",
  "signature",
  "event_index",
  "slot",
  "block_time",
  "venue",
  "is_buy",
  "token_amount",
  "quote_amount",
  "user_quote",
  "quote_mint"
] as const;

export async function loadBackfillState(db: Db, wallet: Pubkey): Promise<BackfillState | null> {
  const result = await db.query<StateRow>(
    `SELECT oldest_signature, newest_signature, covered_from, covered_to, exhausted, last_error
     FROM wallet_backfill_state WHERE wallet = $1`,
    [wallet]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    oldestSignature: row.oldest_signature,
    newestSignature: row.newest_signature,
    coveredFromMs: row.covered_from?.getTime() ?? null,
    coveredToMs: row.covered_to?.getTime() ?? null,
    exhausted: row.exhausted,
    retryOnce: parseRetryMarker(row.last_error)
  };
}

async function saveBackfillState(
  db: Db,
  wallet: Pubkey,
  state: BackfillState,
  progress: { scanned: number; found: number; error: string | null }
): Promise<void> {
  await db.query(
    `INSERT INTO wallet_backfill_state (wallet, oldest_signature, newest_signature, covered_from, covered_to, tx_scanned,
                                        trades_found, exhausted, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (wallet) DO UPDATE SET
       oldest_signature = EXCLUDED.oldest_signature,
       newest_signature = EXCLUDED.newest_signature,
       covered_from = EXCLUDED.covered_from,
       covered_to = EXCLUDED.covered_to,
       tx_scanned = wallet_backfill_state.tx_scanned + EXCLUDED.tx_scanned,
       trades_found = wallet_backfill_state.trades_found + EXCLUDED.trades_found,
       exhausted = EXCLUDED.exhausted,
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [
      wallet,
      state.oldestSignature,
      state.newestSignature,
      state.coveredFromMs === null ? null : new Date(state.coveredFromMs),
      state.coveredToMs === null ? null : new Date(state.coveredToMs),
      progress.scanned,
      progress.found,
      state.exhausted,
      progress.error ?? retryMarker(state.retryOnce)
    ]
  );
}

async function saveProgress(run: WalletRun, state: BackfillState, error: string | null): Promise<void> {
  const scanned = run.result.signaturesSeen - run.savedScanned;
  const found = run.result.tradesFound - run.savedFound;
  await saveBackfillState(run.db, run.wallet, state, { scanned, found, error });
  run.savedScanned += scanned;
  run.savedFound += found;
}

export function historyRow(trade: HistoryTrade): unknown[] {
  return [
    trade.wallet,
    trade.mint,
    trade.signature,
    trade.eventIndex,
    trade.slot,
    new Date(trade.atMs),
    VENUE_CODES[trade.venue],
    trade.isBuy,
    trade.tokenAmount.toString(),
    trade.quoteAmount.toString(),
    trade.userQuote.toString(),
    trade.quoteMint
  ];
}

export async function writeHistoryTrades(db: Db, trades: readonly HistoryTrade[]): Promise<number> {
  let written = 0;
  const chunkSize = 1_000;
  for (let start = 0; start < trades.length; start += chunkSize) {
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const trade of trades.slice(start, start + chunkSize)) {
      const placeholders = historyRow(trade).map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      tuples.push(`(${placeholders.join(",")})`);
    }
    const result = await db.query(
      `INSERT INTO wallet_history_trades (${HISTORY_COLUMNS.join(",")}) VALUES ${tuples.join(",")}
       ON CONFLICT (signature, event_index) DO NOTHING`,
      params
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

async function storedSignatures(db: Db, wallet: Pubkey, signatures: readonly string[]): Promise<Set<string>> {
  if (signatures.length === 0) {
    return new Set();
  }
  const result = await db.query<{ signature: string }>(
    `SELECT DISTINCT signature FROM wallet_history_trades WHERE wallet = $2 AND signature = ANY($1::text[])`,
    [signatures, wallet]
  );
  return new Set(result.rows.map((row) => row.signature));
}

function bump(result: WalletBackfillResult, reason: BackfillSkipReason, count = 1): void {
  result.skipped[reason] = (result.skipped[reason] ?? 0) + count;
}

async function mapLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(runners);
}

async function fetchTrades(run: WalletRun, signature: string): Promise<FetchOutcome> {
  try {
    const tx = await run.rpc.getParsedTransaction(signature, "low");
    run.consecutiveErrors = 0;
    if (!tx) {
      return { trades: [], failure: "not_found" };
    }
    run.result.transactionsFetched += 1;
    const input = transactionInputFromParsed(signature, tx);
    if (!input) {
      bump(run.result, "failed_tx");
      return { trades: [], failure: null };
    }
    const extraction = extractWalletTrades(input, run.wallet);
    for (const [reason, count] of Object.entries(extraction.skipped) as Array<[HistorySkipReason, number]>) {
      bump(run.result, reason, count);
    }
    return { trades: extraction.trades, failure: null };
  } catch (error) {
    run.consecutiveErrors += 1;
    log.debug({ err: error, wallet: run.wallet, signature }, "history transaction fetch failed");
    if (run.consecutiveErrors >= run.options.maxConsecutiveErrors) {
      bump(run.result, "fetch_error");
      throw error;
    }
    return { trades: [], failure: "fetch_error" };
  }
}

async function processSignatures(run: WalletRun, page: readonly SignatureInfo[]): Promise<Set<string>> {
  run.result.signaturesSeen += page.length;
  const succeeded = page.filter((info) => info.err === null || info.err === undefined);
  bump(run.result, "failed_tx", page.length - succeeded.length);
  const stored = await storedSignatures(run.db, run.wallet, succeeded.map((info) => info.signature));
  bump(run.result, "already_stored", stored.size);
  const pending = succeeded.filter((info) => !stored.has(info.signature));
  const found: HistoryTrade[] = [];
  const retry: string[] = [];
  await mapLimit(pending, run.options.txConcurrency, async (info) => {
    const outcome = await fetchTrades(run, info.signature);
    if (outcome.failure) {
      retry.push(info.signature);
    }
    found.push(...outcome.trades);
  });
  const failed = new Set<string>();
  for (const signature of retry) {
    const outcome = await fetchTrades(run, signature);
    if (outcome.failure) {
      bump(run.result, outcome.failure);
      failed.add(signature);
    }
    found.push(...outcome.trades);
  }
  run.result.tradesFound += found.length;
  run.result.tradesWritten += await writeHistoryTrades(run.db, found);
  return failed;
}

function newFailures(state: BackfillState, page: readonly SignatureInfo[], failed: ReadonlySet<string>): Set<string> {
  const blocking = new Set<string>();
  for (const info of page) {
    if (!failed.has(info.signature)) {
      state.retryOnce.delete(info.signature);
    } else if (state.retryOnce.has(info.signature)) {
      state.retryOnce.delete(info.signature);
      log.warn({ signature: info.signature }, "history transaction failed twice, giving up on it");
    } else {
      blocking.add(info.signature);
    }
  }
  for (const signature of blocking) {
    state.retryOnce.add(signature);
  }
  return blocking;
}

function blockTimeMs(info: SignatureInfo): number | null {
  return info.blockTime === null || info.blockTime === undefined ? null : info.blockTime * 1000;
}

async function fetchPage(run: WalletRun, options: { before?: string; until?: string }): Promise<SignatureInfo[]> {
  const limit = Math.max(1, Math.min(run.options.pageSize, run.budget));
  const query: { before?: string; until?: string; limit: number } = { limit };
  if (options.before) {
    query.before = options.before;
  }
  if (options.until) {
    query.until = options.until;
  }
  return run.rpc.getSignaturesForAddress(run.wallet, query, "low");
}

async function catchUpForward(run: WalletRun, state: BackfillState): Promise<void> {
  if (!state.newestSignature) {
    return;
  }
  let before: string | undefined;
  let newest: SignatureInfo | null = null;
  let complete = false;
  const scanned: SignatureInfo[] = [];
  const blocking = new Set<string>();
  while (run.budget > 0 && !run.options.shouldStop()) {
    const requested = Math.min(run.options.pageSize, run.budget);
    const page = await fetchPage(run, before === undefined ? { until: state.newestSignature } : { before, until: state.newestSignature });
    newest = newest ?? page[0] ?? null;
    for (const signature of newFailures(state, page, await processSignatures(run, page))) {
      blocking.add(signature);
    }
    scanned.push(...page);
    run.budget -= page.length;
    const last = page[page.length - 1];
    if (page.length < requested || !last) {
      complete = true;
      break;
    }
    before = last.signature;
  }
  if (!newest || run.options.shouldStop()) {
    return;
  }
  if (!complete) {
    run.result.forwardGap = true;
    log.warn({ wallet: run.wallet, maxSignatures: run.options.maxSignatures }, "signature budget ran out before reaching the last scanned signature");
  }
  const oldestBlocked = scanned.reduce((found, info, index) => (blocking.has(info.signature) ? index : found), -1);
  if (oldestBlocked >= 0) {
    const resumeAfter = scanned[oldestBlocked + 1];
    if (resumeAfter) {
      state.newestSignature = resumeAfter.signature;
      state.coveredToMs = blockTimeMs(resumeAfter) ?? state.coveredToMs;
    }
    return;
  }
  state.newestSignature = newest.signature;
  state.coveredToMs = blockTimeMs(newest) ?? state.coveredToMs;
}

function needsBackward(state: BackfillState, sinceMs: number): boolean {
  if (state.exhausted) {
    return false;
  }
  return state.coveredFromMs === null || state.coveredFromMs > sinceMs;
}

async function scanBackward(run: WalletRun, state: BackfillState, fresh: boolean): Promise<void> {
  let before = fresh ? undefined : (state.oldestSignature ?? undefined);
  while (run.budget > 0 && !run.options.shouldStop() && needsBackward(state, run.options.sinceMs)) {
    const requested = Math.min(run.options.pageSize, run.budget);
    const page = await fetchPage(run, before === undefined ? {} : { before });
    const first = page[0];
    if (fresh && first && state.newestSignature === null) {
      state.newestSignature = first.signature;
      state.coveredToMs = blockTimeMs(first);
    }
    const inRange = page.filter((info) => (blockTimeMs(info) ?? Number.POSITIVE_INFINITY) >= run.options.sinceMs);
    const blocking = newFailures(state, inRange, await processSignatures(run, inRange));
    run.budget -= page.length;
    if (blocking.size > 0) {
      const resumeAfter = inRange[inRange.findIndex((info) => blocking.has(info.signature)) - 1];
      if (resumeAfter) {
        state.oldestSignature = resumeAfter.signature;
        state.coveredFromMs = blockTimeMs(resumeAfter) ?? state.coveredFromMs;
      }
      await saveProgress(run, state, null);
      break;
    }
    const lastInRange = inRange[inRange.length - 1];
    if (lastInRange) {
      state.oldestSignature = lastInRange.signature;
      state.coveredFromMs = blockTimeMs(lastInRange) ?? state.coveredFromMs;
    }
    const firstOutOfRange = page[inRange.length];
    if (firstOutOfRange) {
      run.result.reachedSince = true;
      state.coveredFromMs = Math.min(blockTimeMs(firstOutOfRange) ?? run.options.sinceMs, run.options.sinceMs);
    } else if (page.length < requested) {
      state.exhausted = true;
      run.result.exhausted = true;
    }
    await saveProgress(run, state, null);
    const last = page[page.length - 1];
    if (!last || firstOutOfRange || page.length < requested) {
      break;
    }
    before = last.signature;
  }
}

export async function backfillWallet(
  db: Db,
  rpc: BackfillRpc,
  wallet: Pubkey,
  options: WalletRun["options"]
): Promise<WalletBackfillResult> {
  const result: WalletBackfillResult = {
    wallet,
    signaturesSeen: 0,
    transactionsFetched: 0,
    tradesFound: 0,
    tradesWritten: 0,
    skipped: {},
    reachedSince: false,
    exhausted: false,
    forwardGap: false,
    error: null
  };
  const run: WalletRun = {
    db,
    rpc,
    wallet,
    options,
    result,
    budget: options.maxSignatures,
    consecutiveErrors: 0,
    savedScanned: 0,
    savedFound: 0
  };
  const existing = await loadBackfillState(db, wallet);
  const fresh = existing === null || existing.newestSignature === null;
  const state: BackfillState = existing && !fresh ? existing : { ...emptyState(), retryOnce: existing?.retryOnce ?? new Set() };
  try {
    if (!fresh) {
      await catchUpForward(run, state);
    }
    await scanBackward(run, state, fresh);
    result.reachedSince = result.reachedSince || !needsBackward(state, options.sinceMs);
    result.exhausted = state.exhausted;
    await saveProgress(run, state, null);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log.warn({ err: error, wallet }, "wallet backfill failed");
    await saveProgress(run, state, result.error).catch(() => undefined);
  }
  return result;
}

function resolvedOptions(options: BackfillOptions): WalletRun["options"] {
  return {
    sinceMs: options.sinceMs,
    maxSignatures: Math.max(1, options.maxSignatures),
    concurrency: Math.max(1, options.concurrency),
    txConcurrency: Math.max(1, options.txConcurrency ?? 4),
    pageSize: Math.max(1, Math.min(1_000, options.pageSize ?? 1_000)),
    maxConsecutiveErrors: Math.max(1, options.maxConsecutiveErrors ?? 20),
    shouldStop: options.shouldStop ?? (() => false)
  };
}

export async function backfillWallets(
  db: Db,
  rpc: BackfillRpc,
  wallets: readonly Pubkey[],
  options: BackfillOptions
): Promise<BackfillSummary> {
  const resolved = resolvedOptions(options);
  const unique = [...new Set(wallets)];
  const results: WalletBackfillResult[] = [];
  await mapLimit(unique, resolved.concurrency, async (wallet) => {
    if (resolved.shouldStop()) {
      return;
    }
    results.push(await backfillWallet(db, rpc, wallet, resolved));
  });
  const summary: BackfillSummary = {
    wallets: results,
    transactionsFetched: results.reduce((total, item) => total + item.transactionsFetched, 0),
    tradesWritten: results.reduce((total, item) => total + item.tradesWritten, 0),
    errors: results.filter((item) => item.error !== null).length
  };
  log.info(
    { wallets: unique.length, fetched: summary.transactionsFetched, written: summary.tradesWritten, errors: summary.errors },
    "wallet backfill finished"
  );
  return summary;
}
