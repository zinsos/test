import type { Db } from "../src/db/pool.js";

export const SOL = 1_000_000_000n;
export const BASE_SLOT = 300_000_000;
export const BASE_MS = Date.UTC(2026, 3, 1);

export function slotAt(ms: number): number {
  return BASE_SLOT + Math.floor((ms - BASE_MS) / 400);
}

export interface LaunchSpec {
  mint: string;
  createdAtMs: number;
  createSlot?: number;
  dev?: string;
  creator?: string;
  quoteMint?: string;
}

export interface TradeSpec {
  launchId: number;
  wallet: string;
  atMs: number;
  slot?: number;
  isBuy: boolean;
  tokenAmount: bigint;
  userQuote: bigint;
  signature: string;
  eventIndex?: number;
  venue?: number;
}

export interface HistorySpec {
  wallet: string;
  mint: string;
  atMs: number;
  slot?: number;
  isBuy: boolean;
  tokenAmount: bigint;
  userQuote: bigint;
  signature: string;
  eventIndex?: number;
  quoteMint?: string;
  fetchedAtMs: number;
}

async function insertRows(db: Db, sql: (tuples: string) => string, rows: readonly unknown[][], width: number): Promise<unknown[]> {
  const returned: unknown[] = [];
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(typeof value === "bigint" ? value.toString() : value);
        return `$${params.length}`;
      });
      if (placeholders.length !== width) {
        throw new Error("row width mismatch");
      }
      return `(${placeholders.join(",")})`;
    });
    const result = await db.query(sql(tuples.join(",")), params);
    returned.push(...result.rows);
  }
  return returned;
}

export async function insertLaunches(db: Db, specs: readonly LaunchSpec[]): Promise<Map<string, number>> {
  const rows = specs.map((spec) => [
    spec.mint,
    `${spec.mint}Curve`,
    spec.dev ?? `${spec.mint}Dev`,
    spec.creator ?? spec.dev ?? `${spec.mint}Dev`,
    `${spec.mint}CreateSig`,
    spec.createSlot ?? slotAt(spec.createdAtMs),
    new Date(spec.createdAtMs),
    "1000000000000000",
    "1073000000000000",
    "30000000000",
    "793100000000000",
    spec.quoteMint ?? "SOL"
  ]);
  const returned = (await insertRows(
    db,
    (tuples) => `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, create_signature, create_slot, created_at,
                   token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token, quote_mint)
                 VALUES ${tuples} RETURNING id, mint`,
    rows,
    12
  )) as Array<{ id: bigint; mint: string }>;
  return new Map(returned.map((row) => [row.mint, Number(row.id)]));
}

export async function insertTrades(db: Db, specs: readonly TradeSpec[]): Promise<void> {
  const rows = specs.map((spec) => [
    spec.launchId,
    new Date(spec.atMs),
    spec.slot ?? slotAt(spec.atMs),
    0,
    spec.signature,
    spec.eventIndex ?? 0,
    spec.venue ?? 0,
    spec.wallet,
    spec.isBuy,
    spec.tokenAmount,
    spec.userQuote,
    spec.userQuote,
    "1073000000000000",
    "30000000000"
  ]);
  await insertRows(
    db,
    (tuples) => `INSERT INTO trades (launch_id, block_time, slot, seq, signature, event_index, venue, wallet, is_buy,
                   token_amount, quote_amount, user_quote, virtual_token, virtual_quote) VALUES ${tuples}`,
    rows,
    14
  );
}

export async function insertHistory(db: Db, specs: readonly HistorySpec[]): Promise<void> {
  const rows = specs.map((spec) => [
    spec.wallet,
    spec.mint,
    spec.signature,
    spec.eventIndex ?? 0,
    spec.slot ?? slotAt(spec.atMs),
    new Date(spec.atMs),
    0,
    spec.isBuy,
    spec.tokenAmount,
    spec.userQuote,
    spec.userQuote,
    spec.quoteMint ?? "SOL",
    new Date(spec.fetchedAtMs)
  ]);
  await insertRows(
    db,
    (tuples) => `INSERT INTO wallet_history_trades (wallet, mint, signature, event_index, slot, block_time, venue, is_buy,
                   token_amount, quote_amount, user_quote, quote_mint, fetched_at) VALUES ${tuples}
                 ON CONFLICT DO NOTHING`,
    rows,
    13
  );
}

export async function insertDeadOutcome(db: Db, launchId: number, knownAtMs: number, kind: "rugged" | "died"): Promise<void> {
  await db.query(
    `INSERT INTO launch_outcomes (launch_id, status, rugged, died, outcome_known_at, finalized)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [launchId, kind, kind === "rugged", kind === "died", new Date(knownAtMs)]
  );
}

export async function insertLaunchScore(
  db: Db,
  launchId: number,
  mint: string,
  computedAtMs: number,
  insiders: readonly string[]
): Promise<void> {
  await db.query(
    `INSERT INTO launch_scores (launch_id, checkpoint_sec, mint, computed_at, slot, score, features, contributions,
                                weights_version, insiders)
     VALUES ($1, 10, $2, $3, 1, 50, '{}', '{}', 'test', $4)`,
    [launchId, mint, new Date(computedAtMs), insiders]
  );
}

export async function insertIntel(db: Db, wallet: string, funder: string, checkedAtMs: number, fundedAtMs: number): Promise<void> {
  await db.query(
    `INSERT INTO wallet_intel (wallet, funder, funded_at, checked_at) VALUES ($1, $2, $3, $4)`,
    [wallet, funder, new Date(fundedAtMs), new Date(checkedAtMs)]
  );
}

export async function insertKnownEntity(db: Db, address: string, kind: string, addedAtMs: number): Promise<void> {
  await db.query(`INSERT INTO known_entities (address, kind, added_at) VALUES ($1, $2, $3)`, [address, kind, new Date(addedAtMs)]);
}
