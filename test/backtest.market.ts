import { quoteBuyExactQuoteIn, quoteSell, type CurveReserves } from "../src/chain/curve.js";
import {
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
  ONE_BILLION_SUPPLY
} from "../src/core/constants.js";
import { createRng, type Rng } from "../src/core/rng.js";
import type { Db } from "../src/db/pool.js";
import { REPLAY_STORED_FEATURES } from "../src/scorer/featureNames.js";

const FEES = { protocolFeeBps: 95, creatorFeeBps: 30 };
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MINUTE_MS = 60_000;
const BASE_SLOT = 390_000_000;
const MIN_REAL_TOKENS = 50_000_000_000_000n;
const CHECKPOINTS = [10, 30, 60, 120];
const NAMES = ["Moon Cat", "Moon Cats", "Doge King", "Pepe Gold", "Frog Coin", "Moon Kat", "Wif Hat", "Based Pepe", "Cat Moon", "Gold Frog"];

export type SyntheticKind = "dead" | "active" | "smartEarly" | "smartLate" | "smartStale" | "bundle" | "serial";

export interface SyntheticMarketOptions {
  seed: string;
  fromMs: number;
  minutes: number;
  launchesPerMinute: number;
  storedShare: number;
}

export interface SyntheticMarket {
  fromMs: number;
  toMs: number;
  smart: string[];
  launches: number;
  trades: number;
  kinds: Map<string, SyntheticKind>;
  stored: Set<string>;
}

interface Plan {
  atMs: number;
  wallet: string;
  buySol?: number;
  sellFraction?: number;
  sameSlot?: boolean;
}

interface Context {
  rng: Rng;
  retail: string[];
  smart: string[];
  serialDev: string;
}

function address(rng: Rng, prefix: string): string {
  let out = prefix;
  while (out.length < 44) {
    out += BASE58[Math.floor(rng() * BASE58.length)] ?? "1";
  }
  return out;
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) {
    throw new Error("empty choice");
  }
  return item;
}

function kindOf(rng: Rng): SyntheticKind {
  const roll = rng();
  if (roll < 0.45) return "dead";
  if (roll < 0.7) return "active";
  if (roll < 0.78) return "smartEarly";
  if (roll < 0.86) return "smartLate";
  if (roll < 0.9) return "smartStale";
  if (roll < 0.95) return "bundle";
  return "serial";
}

function plans(ctx: Context, kind: SyntheticKind, createdAtMs: number, dev: string): Plan[] {
  const { rng } = ctx;
  const at = (sec: number): number => createdAtMs + Math.round(sec * 1000);
  const out: Plan[] = [{ atMs: createdAtMs, wallet: dev, buySol: 0.3 + rng() * 1.2, sameSlot: true }];
  const buyers: string[] = [];
  const buys = (count: number, fromSec: number, toSec: number, minSol: number, maxSol: number): void => {
    for (let index = 0; index < count; index += 1) {
      const wallet = pick(rng, ctx.retail);
      buyers.push(wallet);
      out.push({ atMs: at(fromSec + rng() * (toSec - fromSec)), wallet, buySol: minSol + rng() * (maxSol - minSol) });
    }
  };
  const sells = (share: number, fromSec: number, toSec: number): void => {
    for (const wallet of buyers) {
      if (rng() < share) {
        out.push({ atMs: at(fromSec + rng() * (toSec - fromSec)), wallet, sellFraction: 0.4 + rng() * 0.6 });
      }
    }
  };
  const smartWave = (wallets: readonly string[], fromSec: number, stepSec: number, sellFromSec: number | null): void => {
    wallets.forEach((wallet, index) => {
      out.push({ atMs: at(fromSec + index * stepSec + rng()), wallet, buySol: 0.8 + rng() });
      if (sellFromSec !== null) {
        out.push({ atMs: at(sellFromSec + index * 20 + rng() * 10), wallet, sellFraction: 1 });
      }
    });
  };
  const smartPick = (count: number): string[] => [...ctx.smart].sort(() => rng() - 0.5).slice(0, count);
  switch (kind) {
    case "dead":
      buys(2 + Math.floor(rng() * 6), 1, 120, 0.05, 0.4);
      sells(0.5, 30, 180);
      break;
    case "active":
      buys(20 + Math.floor(rng() * 25), 2, 55, 0.3, 1.5);
      buys(15 + Math.floor(rng() * 30), 60, 900, 0.1, 1);
      sells(0.6, 90, 1200);
      if (rng() < 0.4) {
        out.push({ atMs: at(200 + rng() * 400), wallet: dev, sellFraction: 1 });
      }
      break;
    case "smartEarly":
      smartWave(smartPick(3 + Math.floor(rng() * 2)), 2, 1.5, 120 + rng() * 100);
      buys(15 + Math.floor(rng() * 15), 8, 70, 0.4, 1.8);
      sells(0.7, 100, 600);
      break;
    case "smartLate":
      buys(6 + Math.floor(rng() * 10), 2, 30, 0.2, 1);
      smartWave(smartPick(3 + Math.floor(rng() * 2)), 14, 5, rng() < 0.5 ? 150 + rng() * 150 : null);
      buys(10 + Math.floor(rng() * 20), 35, 400, 0.2, 1.4);
      sells(0.6, 120, 700);
      break;
    case "smartStale": {
      const wallets = smartPick(6);
      smartWave(wallets.slice(0, 3), 18, 4, null);
      buys(8 + Math.floor(rng() * 6), 20, 60, 0.4, 1.2);
      smartWave(wallets.slice(3, 6), 520 + rng() * 60, 6, null);
      break;
    }
    case "bundle": {
      for (let index = 0; index < 5; index += 1) {
        const wallet = address(rng, "Bd");
        buyers.push(wallet);
        out.push({ atMs: createdAtMs, wallet, buySol: 1 + rng() * 2, sameSlot: true });
      }
      smartWave(smartPick(3), 10, 3, null);
      buys(10 + Math.floor(rng() * 10), 5, 60, 0.2, 1);
      const dumpSec = 70 + rng() * 30;
      out.push({ atMs: at(dumpSec), wallet: dev, sellFraction: 1 });
      sells(0.9, dumpSec, dumpSec + 60);
      break;
    }
    case "serial":
      buys(4 + Math.floor(rng() * 6), 1, 40, 0.2, 0.8);
      smartWave(smartPick(3), 3, 1, null);
      out.push({ atMs: at(45 + rng() * 20), wallet: dev, sellFraction: 1 });
      sells(0.6, 50, 200);
      break;
  }
  return out.sort((a, b) => a.atMs - b.atMs || Number(b.sameSlot ?? false) - Number(a.sameSlot ?? false));
}

function storedFeatures(rng: Rng, kind: SyntheticKind): Record<string, number | null> {
  const features: Record<string, number | null> = {};
  for (const key of REPLAY_STORED_FEATURES) {
    features[key] = 0;
  }
  features.intel_coverage = 1;
  features.fresh_wallet_ratio = kind === "bundle" ? 0.8 : rng() * 0.4;
  features.largest_cluster_size = kind === "bundle" ? 5 : Math.floor(rng() * 3);
  features.largest_cluster_share = kind === "bundle" ? 0.35 : rng() * 0.08;
  features.cluster_count = kind === "bundle" ? 1 : Math.floor(rng() * 2);
  features.has_twitter = rng() < 0.6 ? 1 : 0;
  features.socials_count = Math.floor(rng() * 3);
  features.dev_rug_rate = kind === "serial" ? 1 : null;
  features.dev_migration_rate = null;
  features.dev_median_peak_multiple = null;
  features.dev_launch_count = kind === "serial" ? 4 : 0;
  features.dev_outcome_count = kind === "serial" ? 3 : 0;
  return features;
}

async function insertRows(db: Db, table: string, columns: readonly string[], rows: unknown[][]): Promise<void> {
  const chunk = Math.max(1, Math.floor(30_000 / columns.length));
  for (let start = 0; start < rows.length; start += chunk) {
    const params: unknown[] = [];
    const values = rows
      .slice(start, start + chunk)
      .map(
        (row) =>
          `(${row
            .map((value) => {
              params.push(typeof value === "bigint" ? value.toString() : value);
              return `$${params.length}`;
            })
            .join(",")})`
      )
      .join(",");
    await db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}`, params);
  }
}

const TRADE_COLUMNS = [
  "launch_id",
  "block_time",
  "slot",
  "seq",
  "signature",
  "event_index",
  "venue",
  "wallet",
  "is_buy",
  "token_amount",
  "quote_amount",
  "user_quote",
  "protocol_fee",
  "creator_fee",
  "lp_fee",
  "protocol_fee_bps",
  "creator_fee_bps",
  "lp_fee_bps",
  "virtual_token",
  "virtual_quote",
  "real_token",
  "real_quote",
  "received_at"
];

const SCORE_COLUMNS = [
  "launch_id",
  "checkpoint_sec",
  "mint",
  "computed_at",
  "slot",
  "score",
  "hard_blocked",
  "features",
  "contributions",
  "weights_version",
  "insiders"
];

const OUTCOME_COLUMNS = ["launch_id", "status", "migrated", "rugged", "died", "survived_15m", "rug_at", "outcome_known_at", "finalized", "computed_at"];

function slotOf(fromMs: number, atMs: number): number {
  return BASE_SLOT + Math.floor((atMs - fromMs + 3_600_000) / 400);
}

export async function seedSyntheticMarket(db: Db, options: SyntheticMarketOptions): Promise<SyntheticMarket> {
  const rng = createRng(options.seed);
  const ctx: Context = {
    rng,
    retail: Array.from({ length: 900 }, () => address(rng, "Rt")),
    smart: Array.from({ length: 8 }, () => address(rng, "Sm")),
    serialDev: address(rng, "Sd")
  };
  const toMs = options.fromMs + options.minutes * MINUTE_MS;
  const total = Math.round(options.minutes * options.launchesPerMinute);
  const kinds = new Map<string, SyntheticKind>();
  const stored = new Set<string>();
  const trades: unknown[][] = [];
  const scores: unknown[][] = [];
  const outcomes: unknown[][] = [];
  let seq = 0;
  let serialAtMs = options.fromMs - 30 * MINUTE_MS;
  const launches: Array<{ kind: SyntheticKind; createdAtMs: number; dev: string; history: boolean }> = [];
  for (let index = 0; index < 4; index += 1) {
    serialAtMs += 4 * MINUTE_MS;
    launches.push({ kind: "serial", createdAtMs: serialAtMs, dev: ctx.serialDev, history: true });
  }
  for (let index = 0; index < total; index += 1) {
    const kind = kindOf(rng);
    const createdAtMs = options.fromMs + 20_000 + Math.floor((index * MINUTE_MS) / options.launchesPerMinute) + Math.floor(rng() * 3_000);
    launches.push({ kind, createdAtMs, dev: kind === "serial" ? ctx.serialDev : address(rng, "Dv"), history: false });
    if (kind === "serial") {
      launches.push({ kind: "dead", createdAtMs: createdAtMs + 4_000 + Math.floor(rng() * 2_000), dev: ctx.serialDev, history: false });
    }
  }
  launches.sort((a, b) => a.createdAtMs - b.createdAtMs);
  for (const launch of launches) {
    const mint = address(rng, launch.kind === "serial" ? "Ms" : "Mn");
    kinds.set(mint, launch.kind);
    const name = pick(rng, NAMES);
    const createSlot = slotOf(options.fromMs, launch.createdAtMs);
    const inserted = await db.query<{ id: unknown }>(
      `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, name, symbol, uri, quote_mint, create_signature, create_slot, created_at,
         observed_at, token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token, data_complete)
       VALUES ($1, $2, $3, $3, $4, $5, '', 'SOL', $6, $7, $8, $9, $10, $11, $12, $13, TRUE) RETURNING id`,
      [
        mint,
        `${mint.slice(0, 20)}Curve`,
        launch.dev,
        name,
        name.replace(/[^A-Za-z]/g, "").slice(0, 6).toUpperCase(),
        `create-${mint}`,
        createSlot,
        new Date(launch.createdAtMs),
        new Date(launch.createdAtMs + 150 + Math.floor(rng() * 900)),
        ONE_BILLION_SUPPLY.toString(),
        DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES.toString(),
        DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES.toString(),
        DEFAULT_INITIAL_REAL_TOKEN_RESERVES.toString()
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
    const planned = plans(ctx, launch.kind, launch.createdAtMs, launch.dev);
    for (const plan of planned) {
      let amounts: unknown[];
      if (plan.buySol !== undefined) {
        const quote = quoteBuyExactQuoteIn(reserves, BigInt(Math.round(plan.buySol * 1e9)), FEES);
        if (quote.tokensOut <= 0n || (reserves.realTokenReserves ?? 0n) - quote.tokensOut < MIN_REAL_TOKENS) {
          continue;
        }
        reserves = quote.after;
        holdings.set(plan.wallet, (holdings.get(plan.wallet) ?? 0n) + quote.tokensOut);
        amounts = [true, quote.tokensOut, quote.netQuote, quote.totalCost, quote.protocolFee, quote.creatorFee];
      } else {
        const held = holdings.get(plan.wallet) ?? 0n;
        const tokens = (held * BigInt(Math.round((plan.sellFraction ?? 1) * 1_000_000))) / 1_000_000n;
        if (tokens <= 0n) {
          continue;
        }
        const quote = quoteSell(reserves, tokens, FEES);
        reserves = quote.after;
        holdings.set(plan.wallet, held - tokens);
        amounts = [false, tokens, quote.grossQuote, quote.netQuote, quote.protocolFee, quote.creatorFee];
      }
      seq += 1;
      trades.push([
        launchId,
        new Date(plan.atMs),
        plan.sameSlot ? createSlot : Math.max(createSlot + 1, slotOf(options.fromMs, plan.atMs)),
        seq,
        `sig${seq}${mint.slice(2, 10)}`,
        0,
        0,
        plan.wallet,
        ...amounts,
        0,
        FEES.protocolFeeBps,
        FEES.creatorFeeBps,
        0,
        reserves.virtualTokenReserves,
        reserves.virtualQuoteReserves,
        reserves.realTokenReserves,
        reserves.realQuoteReserves,
        new Date(plan.atMs + 100 + Math.floor(rng() * 1_400))
      ]);
    }
    if (launch.history || rng() < options.storedShare) {
      stored.add(mint);
      const insiders = planned.filter((plan) => plan.sameSlot && plan.wallet !== launch.dev).map((plan) => plan.wallet);
      for (const checkpointSec of CHECKPOINTS) {
        scores.push([
          launchId,
          checkpointSec,
          mint,
          new Date(launch.createdAtMs + checkpointSec * 1000 + 200 + Math.floor(rng() * 600)),
          createSlot + checkpointSec * 2,
          launch.kind === "bundle" ? 80 : 20 + rng() * 40,
          launch.kind === "bundle",
          JSON.stringify(storedFeatures(rng, launch.kind)),
          "{}",
          "synthetic-live",
          `{${[...new Set(insiders)].join(",")}}`
        ]);
      }
    }
    if (launch.dev === ctx.serialDev) {
      const knownAtMs = launch.createdAtMs + (launch.history ? 10 : 3) * MINUTE_MS;
      outcomes.push([launchId, "rugged", false, true, false, false, new Date(launch.createdAtMs + 60_000), new Date(knownAtMs), true, new Date(knownAtMs)]);
    }
  }
  await insertRows(db, "trades", TRADE_COLUMNS, trades);
  await insertRows(db, "launch_scores", SCORE_COLUMNS, scores);
  await insertRows(db, "launch_outcomes", OUTCOME_COLUMNS, outcomes);
  const run = await db.query<{ id: unknown }>(
    `INSERT INTO wallet_rank_runs (as_of, params, candidates, tracked) VALUES ($1, '{}', $2, $2) RETURNING id`,
    [new Date(options.fromMs - 86_400_000), ctx.smart.length]
  );
  for (const [index, wallet] of ctx.smart.entries()) {
    await db.query("INSERT INTO wallet_ranks (run_id, wallet, rank, score, tracked) VALUES ($1, $2, $3, $4, TRUE)", [
      Number(run.rows[0]?.id),
      wallet,
      index + 1,
      10 - index
    ]);
  }
  await db.query("ANALYZE");
  return { fromMs: options.fromMs, toMs, smart: ctx.smart, launches: launches.length, trades: trades.length, kinds, stored };
}
