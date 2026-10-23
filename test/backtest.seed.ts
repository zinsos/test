import { quoteBuyExactQuoteIn, quoteSell, type CurveReserves } from "../src/chain/curve.js";
import {
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
  ONE_BILLION_SUPPLY
} from "../src/core/constants.js";
import type { Db } from "../src/db/pool.js";

export const SOL = 1_000_000_000n;
const FEES = { protocolFeeBps: 95, creatorFeeBps: 30 };

export interface SeedTrade {
  atSec: number;
  wallet: string;
  buySol?: number;
  sellFraction?: number;
}

export interface SeedLaunch {
  mint: string;
  dev: string;
  createdAtMs: number;
  slot: number;
  trades: readonly SeedTrade[];
  dataComplete?: boolean;
  quoteMint?: string;
}

let sequence = 1;

function slotFor(launch: SeedLaunch, atMs: number): number {
  return launch.slot + Math.floor((atMs - launch.createdAtMs) / 400);
}

export async function seedLaunch(db: Db, launch: SeedLaunch): Promise<number> {
  const inserted = await db.query<{ id: unknown }>(
    `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, name, symbol, uri, quote_mint, create_signature,
       create_slot, created_at, token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token, data_complete)
     VALUES ($1, $2, $3, $3, $4, $5, '', $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [
      launch.mint,
      `${launch.mint.slice(0, 16)}Curve`,
      launch.dev,
      `Coin ${launch.mint.slice(0, 6)}`,
      launch.mint.slice(0, 4).toUpperCase(),
      launch.quoteMint ?? "SOL",
      `create-${launch.mint}`,
      launch.slot,
      new Date(launch.createdAtMs),
      ONE_BILLION_SUPPLY.toString(),
      DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES.toString(),
      DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES.toString(),
      DEFAULT_INITIAL_REAL_TOKEN_RESERVES.toString(),
      launch.dataComplete ?? true
    ]
  );
  const launchId = Number(inserted.rows[0]?.id);
  let reserves: CurveReserves = {
    virtualTokenReserves: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
    virtualQuoteReserves: DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
    realTokenReserves: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
    realQuoteReserves: 0n
  };
  const holdings = new Map<string, bigint>();
  for (const trade of launch.trades) {
    const atMs = launch.createdAtMs + trade.atSec * 1000;
    sequence += 1;
    let row: unknown[];
    if (trade.buySol !== undefined) {
      const quote = quoteBuyExactQuoteIn(reserves, BigInt(Math.round(trade.buySol * 1e9)), FEES);
      reserves = quote.after;
      holdings.set(trade.wallet, (holdings.get(trade.wallet) ?? 0n) + quote.tokensOut);
      row = [true, quote.tokensOut, quote.netQuote, quote.totalCost, quote.protocolFee, quote.creatorFee];
    } else {
      const held = holdings.get(trade.wallet) ?? 0n;
      const tokens = (held * BigInt(Math.round((trade.sellFraction ?? 1) * 1_000_000))) / 1_000_000n;
      const quote = quoteSell(reserves, tokens, FEES);
      reserves = quote.after;
      holdings.set(trade.wallet, held - tokens);
      row = [false, tokens, quote.grossQuote, quote.netQuote, quote.protocolFee, quote.creatorFee];
    }
    await db.query(
      `INSERT INTO trades (launch_id, block_time, slot, seq, signature, event_index, venue, wallet, is_buy, token_amount,
         quote_amount, user_quote, protocol_fee, creator_fee, lp_fee, protocol_fee_bps, creator_fee_bps, lp_fee_bps,
         virtual_token, virtual_quote, real_token, real_quote)
       VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, $8, $9, $10, $11, $12, 0, 95, 30, 0, $13, $14, $15, $16)`,
      [
        launchId,
        new Date(atMs),
        slotFor(launch, atMs),
        sequence,
        `sig-${launch.mint}-${sequence}`,
        trade.wallet,
        ...row.map((value) => (typeof value === "bigint" ? value.toString() : value)),
        reserves.virtualTokenReserves.toString(),
        reserves.virtualQuoteReserves.toString(),
        reserves.realTokenReserves?.toString() ?? null,
        reserves.realQuoteReserves?.toString() ?? null
      ]
    );
  }
  return launchId;
}

export async function seedRankRun(db: Db, asOfMs: number, wallets: readonly string[]): Promise<number> {
  const run = await db.query<{ id: unknown }>(
    `INSERT INTO wallet_rank_runs (as_of, params, candidates, tracked) VALUES ($1, '{}', $2, $2) RETURNING id`,
    [new Date(asOfMs), wallets.length]
  );
  const runId = Number(run.rows[0]?.id);
  for (const [index, wallet] of wallets.entries()) {
    await db.query(`INSERT INTO wallet_ranks (run_id, wallet, rank, score, tracked) VALUES ($1, $2, $3, $4, TRUE)`, [
      runId,
      wallet,
      index + 1,
      10 - index
    ]);
  }
  return runId;
}

export async function seedStoredScore(
  db: Db,
  launchId: number,
  mint: string,
  checkpointSec: number,
  computedAtMs: number,
  features: Record<string, number>
): Promise<void> {
  await db.query(
    `INSERT INTO launch_scores (launch_id, checkpoint_sec, mint, computed_at, slot, score, hard_blocked, flags, features,
       contributions, weights_version, insiders)
     VALUES ($1, $2, $3, $4, 1, 10, FALSE, '{}', $5, '{}', 'live-test', '{}')`,
    [launchId, checkpointSec, mint, new Date(computedAtMs), JSON.stringify(features)]
  );
}

export function convergenceTrades(wallets: readonly string[], options: { pump?: boolean } = {}): SeedTrade[] {
  const trades: SeedTrade[] = [
    { atSec: 5, wallet: "Retail111", buySol: 0.5 },
    { atSec: 20, wallet: wallets[0] ?? "w0", buySol: 1 },
    { atSec: 25, wallet: wallets[1] ?? "w1", buySol: 1 },
    { atSec: 35, wallet: wallets[2] ?? "w2", buySol: 1 }
  ];
  if (options.pump ?? true) {
    for (let index = 0; index < 6; index += 1) {
      trades.push({ atSec: 40 + index * 5, wallet: `Pumper${index}`, buySol: 3 });
    }
    trades.push({ atSec: 100, wallet: "Pumper0", sellFraction: 1 });
    trades.push({ atSec: 110, wallet: "Pumper1", sellFraction: 1 });
    trades.push({ atSec: 120, wallet: "Pumper2", sellFraction: 1 });
    trades.push({ atSec: 200, wallet: "Pumper3", sellFraction: 1 });
    trades.push({ atSec: 210, wallet: "Pumper4", sellFraction: 1 });
  }
  return trades;
}

export const CLEAN_DEEP_FEATURES: Record<string, number> = {
  intel_coverage: 1,
  fresh_wallet_ratio: 0.1,
  largest_cluster_size: 0,
  largest_cluster_share: 0,
  cluster_count: 0,
  dev_funded_buyers: 0,
  has_twitter: 1,
  has_telegram: 1,
  has_website: 0,
  socials_count: 2,
  copycat: 0,
  copycat_similarity: 0,
  same_ticker_recent: 0
};
