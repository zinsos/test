import { quotePoolBuyExactQuote, quotePoolSell, type PoolReserves } from "../src/chain/amm.js";
import { quoteBuyExactQuoteIn, quoteSell, type CurveReserves } from "../src/chain/curve.js";
import type { DecodedChainEvent, DecodeResult, PoolTradeEvent } from "../src/chain/events.js";
import type { ParsedTransaction, SignatureInfo } from "../src/chain/rpc.js";
import {
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
  DEFAULT_POOL_MIGRATION_FEE,
  ONE_BILLION_SUPPLY,
  SLOT_MS,
  SOL_QUOTE,
  SYSTEM_PROGRAM_ID
} from "../src/core/constants.js";
import { createRng, type Rng } from "../src/core/rng.js";
import type { LaunchCreatedEvent, Pubkey, TradeEvent, TxRef } from "../src/core/types.js";
import type { IntelRpc } from "../src/scorer/intel.js";

export const PUMP_QUOTE_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const CURVE_FEES = { protocolFeeBps: 95, creatorFeeBps: 30 };
const POOL_FEES = { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 5 };
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MIGRATION_DELAY_SEC = 12;
const BASE_SLOT = 370_000_000;

export type LaunchKind = "runner" | "mooner" | "flop" | "bundle" | "dead" | "organic" | "lateRunner" | "pumpQuoted";

export interface PlannedAction {
  atSec: number;
  wallet: Pubkey;
  buySol?: number;
  sellFraction?: number;
  sameSlot?: boolean;
}

export interface LaunchPlan {
  mint: Pubkey;
  dev: Pubkey;
  kind: LaunchKind;
  quoteMint: string;
  createdAtMs: number;
  name: string;
  symbol: string;
  actions: PlannedAction[];
  bundleWallets: Pubkey[];
  converging: Pubkey[];
}

export interface SimTransaction {
  atMs: number;
  slot: number;
  signature: string;
  order: number;
  events: DecodedChainEvent[];
}

export interface WalletProfile {
  priorTxCount: number;
  funder: Pubkey | null;
  fundingIndex: number;
  fundedAtMs: number;
  lamports: bigint;
}

export interface Scenario {
  t0Ms: number;
  windowStartMs: number;
  windowEndMs: number;
  lastLaunchMs: number;
  smart: Pubkey[];
  late: Pubkey[];
  cex: Pubkey;
  serialRugDev: Pubkey;
  plans: LaunchPlan[];
  profiles: Map<Pubkey, WalletProfile>;
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) {
    throw new Error("empty choice");
  }
  return item;
}

function between(rng: Rng, low: number, high: number): number {
  return low + (high - low) * rng();
}

function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    const a = copy[index];
    const b = copy[other];
    if (a !== undefined && b !== undefined) {
      copy[index] = b;
      copy[other] = a;
    }
  }
  return copy;
}

export class AddressBook {
  private readonly used = new Set<string>();
  constructor(private readonly rng: Rng) {}

  next(prefix: string, length = 44): Pubkey {
    for (;;) {
      let address = prefix;
      while (address.length < length) {
        address += BASE58[Math.floor(this.rng() * BASE58.length)] ?? "1";
      }
      if (!this.used.has(address)) {
        this.used.add(address);
        return address;
      }
    }
  }
}

export function slotAt(t0Ms: number, atMs: number): number {
  return BASE_SLOT + Math.floor((atMs - t0Ms) / SLOT_MS);
}

interface BuilderContext {
  rng: Rng;
  book: AddressBook;
  retail: Pubkey[];
  smart: Pubkey[];
  late: Pubkey[];
  profiles: Map<Pubkey, WalletProfile>;
  t0Ms: number;
}

function retailBuys(ctx: BuilderContext, count: number, fromSec: number, toSec: number, minSol: number, maxSol: number): PlannedAction[] {
  const wallets = shuffled(ctx.rng, ctx.retail).slice(0, count);
  return wallets.map((wallet) => ({
    atSec: Math.round(between(ctx.rng, fromSec, toSec)),
    wallet,
    buySol: Number(between(ctx.rng, minSol, maxSol).toFixed(3))
  }));
}

function sellsFor(ctx: BuilderContext, buys: readonly PlannedAction[], share: number, fromSec: number, toSec: number): PlannedAction[] {
  return buys
    .filter(() => ctx.rng() < share)
    .map((buy) => ({ atSec: Math.max(buy.atSec + 5, Math.round(between(ctx.rng, fromSec, toSec))), wallet: buy.wallet, sellFraction: 1 }));
}

function devProfile(ctx: BuilderContext, dev: Pubkey, funder: Pubkey | null, priorTxCount: number): void {
  ctx.profiles.set(dev, { priorTxCount, funder, fundingIndex: funder ? Math.max(0, priorTxCount - 1) : 0, fundedAtMs: ctx.t0Ms - 86_400_000, lamports: 3_000_000_000n });
}

function convergingBuys(ctx: BuilderContext, wallets: readonly Pubkey[], fromSec: number): PlannedAction[] {
  let at = fromSec;
  return wallets.map((wallet) => {
    at += Math.round(between(ctx.rng, 3, 9));
    return { atSec: at, wallet, buySol: Number(between(ctx.rng, 0.8, 2).toFixed(3)) };
  });
}

function runnerActions(ctx: BuilderContext, dev: Pubkey, converging: readonly Pubkey[], kind: LaunchKind, extraLate: readonly Pubkey[]): PlannedAction[] {
  const actions: PlannedAction[] = [{ atSec: 0, wallet: dev, buySol: Number(between(ctx.rng, 0.4, 1.2).toFixed(3)), sameSlot: true }];
  const openers = retailBuys(ctx, 4, 3, 11, 0.2, 0.7);
  actions.push(...openers);
  const smartBuys = convergingBuys(ctx, converging, 10);
  actions.push(...smartBuys);
  const flop = kind === "flop";
  const pump = flop ? retailBuys(ctx, 6, 45, 140, 0.1, 0.4) : retailBuys(ctx, 16, 42, 200, 1, 3.6);
  actions.push(...pump);
  for (const wallet of extraLate) {
    actions.push({ atSec: Math.round(between(ctx.rng, 50, 80)), wallet, buySol: Number(between(ctx.rng, 0.5, 1).toFixed(3)) });
    actions.push({ atSec: Math.round(between(ctx.rng, 170, 230)), wallet, sellFraction: 1 });
  }
  for (const buy of smartBuys) {
    const sellAt = flop ? between(ctx.rng, 120, 200) : between(ctx.rng, 150, 300);
    actions.push({ atSec: Math.round(sellAt), wallet: buy.wallet, sellFraction: 1 });
  }
  actions.push(...sellsFor(ctx, openers, 0.8, 200, 320));
  if (kind === "mooner") {
    const whales = shuffled(ctx.rng, ctx.retail).slice(0, 14);
    whales.forEach((wallet, index) => {
      actions.push({ atSec: 320 + index * 15, wallet, buySol: Number(between(ctx.rng, 4, 6).toFixed(3)) });
    });
    whales.slice(0, 5).forEach((wallet, index) => {
      actions.push({ atSec: 700 + index * 40, wallet, sellFraction: 0.5 });
      actions.push({ atSec: 720 + index * 40, wallet: pick(ctx.rng, ctx.retail), buySol: 1.5 });
    });
    actions.push(...sellsFor(ctx, pump, 0.6, 800, 1_500));
  } else {
    actions.push(...sellsFor(ctx, pump, 0.85, 260, 700));
  }
  actions.push({ atSec: Math.round(between(ctx.rng, 900, 1_100)), wallet: dev, sellFraction: 1 });
  return actions;
}

function bundleActions(ctx: BuilderContext, dev: Pubkey, bundle: readonly Pubkey[], bait: readonly Pubkey[], bundleSol: number): PlannedAction[] {
  const actions: PlannedAction[] = [{ atSec: 0, wallet: dev, buySol: 1.5, sameSlot: true }];
  for (const wallet of bundle) {
    actions.push({ atSec: 0, wallet, buySol: Number((bundleSol * between(ctx.rng, 0.9, 1.1)).toFixed(3)), sameSlot: true });
  }
  const retail = retailBuys(ctx, 7, 4, 50, 0.3, 1.2);
  actions.push(...retail);
  const baitBuys = convergingBuys(ctx, bait, 10);
  actions.push(...baitBuys);
  const dumpAt = Math.round(between(ctx.rng, 62, 90));
  bundle.forEach((wallet, index) => {
    actions.push({ atSec: dumpAt + index, wallet, sellFraction: 1 });
  });
  actions.push({ atSec: dumpAt + 1, wallet: dev, sellFraction: 1 });
  for (const buy of baitBuys) {
    actions.push({ atSec: Math.round(between(ctx.rng, 110, 170)), wallet: buy.wallet, sellFraction: 1 });
  }
  actions.push(...sellsFor(ctx, retail, 0.7, 100, 300));
  return actions;
}

function deadActions(ctx: BuilderContext, dev: Pubkey): PlannedAction[] {
  return [
    { atSec: 0, wallet: dev, buySol: Number(between(ctx.rng, 0.1, 0.4).toFixed(3)), sameSlot: true },
    ...retailBuys(ctx, Math.round(between(ctx.rng, 1, 4)), 4, 70, 0.05, 0.3)
  ];
}

function organicActions(ctx: BuilderContext, dev: Pubkey): PlannedAction[] {
  const buys = retailBuys(ctx, 12, 4, 400, 0.2, 1.2);
  return [
    { atSec: 0, wallet: dev, buySol: Number(between(ctx.rng, 0.3, 1).toFixed(3)), sameSlot: true },
    ...buys,
    ...sellsFor(ctx, buys, 0.5, 120, 900)
  ];
}

const SYLLABLES = ["ka", "zu", "mi", "ro", "te", "pa", "xi", "nu", "fe", "go", "ba", "qu", "vy", "do", "re", "sa", "wo", "ji", "ha", "ne"];

function coinName(rng: Rng): string {
  const word = (parts: number): string => Array.from({ length: parts }, () => pick(rng, SYLLABLES)).join("");
  const first = word(3);
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} ${word(2)}`;
}

interface PlanSpec {
  kind: LaunchKind;
  atMs: number;
  inWindow: boolean;
}

function planLaunch(ctx: BuilderContext, spec: PlanSpec, rugFunders: Pubkey[], serialRugDev: Pubkey, serialUses: { count: number }): LaunchPlan {
  const mint = ctx.book.next(spec.kind === "pumpQuoted" ? "Pq" : "Mn");
  let dev = ctx.book.next("Dv");
  let actions: PlannedAction[];
  let bundle: Pubkey[] = [];
  let converging: Pubkey[] = [];
  switch (spec.kind) {
    case "runner":
    case "mooner":
    case "flop":
    case "pumpQuoted": {
      devProfile(ctx, dev, null, 40);
      converging = shuffled(ctx.rng, ctx.smart).slice(0, ctx.rng() < 0.5 ? 3 : 4);
      const extraLate = spec.inWindow && spec.kind !== "pumpQuoted" ? ctx.late : [];
      actions = runnerActions(ctx, dev, converging, spec.kind === "pumpQuoted" ? "runner" : spec.kind, extraLate);
      break;
    }
    case "lateRunner": {
      devProfile(ctx, dev, null, 40);
      converging = [...ctx.late];
      actions = runnerActions(ctx, dev, converging, "runner", []);
      break;
    }
    case "bundle": {
      const variant = serialUses.count % 3;
      serialUses.count += 1;
      const funder = pick(ctx.rng, rugFunders);
      if (variant === 0) {
        dev = serialRugDev;
      } else {
        devProfile(ctx, dev, funder, 2);
      }
      const size = variant === 1 ? 8 : variant === 0 ? 6 : 5;
      const sol = variant === 1 ? 3.5 : 4;
      bundle = Array.from({ length: size }, () => ctx.book.next("Bn"));
      for (const wallet of bundle) {
        ctx.profiles.set(wallet, { priorTxCount: 1, funder: variant === 2 ? dev : funder, fundingIndex: 0, fundedAtMs: spec.atMs - 600_000, lamports: 2_000_000_000n });
      }
      converging = spec.inWindow || variant === 2 ? shuffled(ctx.rng, ctx.smart).slice(0, 3) : [];
      actions = bundleActions(ctx, dev, bundle, converging, sol);
      break;
    }
    case "dead":
      devProfile(ctx, dev, null, 10);
      actions = deadActions(ctx, dev);
      break;
    default:
      devProfile(ctx, dev, null, 15);
      actions = organicActions(ctx, dev);
  }
  return {
    mint,
    dev,
    kind: spec.kind,
    quoteMint: spec.kind === "pumpQuoted" ? PUMP_QUOTE_MINT : SOL_QUOTE,
    createdAtMs: spec.atMs,
    name: coinName(ctx.rng),
    symbol: mint.slice(2, 6).toUpperCase(),
    actions: actions.sort((a, b) => a.atSec - b.atSec || Number(b.sameSlot ?? false) - Number(a.sameSlot ?? false)),
    bundleWallets: bundle,
    converging
  };
}

const HISTORY_PATTERN: LaunchKind[] = ["runner", "dead", "bundle", "runner", "organic", "mooner", "runner", "dead", "flop", "bundle", "runner", "pumpQuoted"];
const WINDOW_PATTERN: LaunchKind[] = ["runner", "bundle", "lateRunner", "dead", "mooner", "bundle", "runner", "organic", "bundle", "pumpQuoted", "runner", "flop"];

export function buildScenario(seed: string): Scenario {
  const rng = createRng(seed);
  const book = new AddressBook(rng);
  const t0Ms = Date.UTC(2026, 8, 7, 12, 0, 0);
  const historyCount = 60;
  const historySpacingMs = 4 * 60_000;
  const windowStartMs = t0Ms + historyCount * historySpacingMs + 30 * 60_000;
  const windowCount = 36;
  const windowSpacingMs = 4 * 60_000;
  const lastLaunchMs = windowStartMs + 60_000 + (windowCount - 1) * windowSpacingMs;
  const windowEndMs = lastLaunchMs + 45 * 60_000;
  const cex = book.next("Cx");
  const profiles = new Map<Pubkey, WalletProfile>();
  const smart = Array.from({ length: 5 }, () => book.next("Sm"));
  const late = Array.from({ length: 3 }, () => book.next("Lt"));
  const retail = Array.from({ length: 420 }, () => book.next("Rt"));
  for (const wallet of [...smart, ...late]) {
    profiles.set(wallet, { priorTxCount: 60, funder: null, fundingIndex: 0, fundedAtMs: t0Ms - 30 * 86_400_000, lamports: 0n });
  }
  for (const wallet of retail) {
    profiles.set(wallet, { priorTxCount: 40, funder: cex, fundingIndex: 1, fundedAtMs: t0Ms - 86_400_000, lamports: 1_500_000_000n });
  }
  const rugFunders = Array.from({ length: 3 }, () => book.next("Fn"));
  const serialRugDev = book.next("Sr");
  const ctx: BuilderContext = { rng, book, retail, smart, late, profiles, t0Ms };
  devProfile(ctx, serialRugDev, rugFunders[0] ?? null, 2);
  const serialUses = { count: 0 };
  const plans: LaunchPlan[] = [];
  for (let index = 0; index < historyCount; index += 1) {
    const kind = HISTORY_PATTERN[index % HISTORY_PATTERN.length] ?? "dead";
    plans.push(planLaunch(ctx, { kind, atMs: t0Ms + index * historySpacingMs, inWindow: false }, rugFunders, serialRugDev, serialUses));
  }
  serialUses.count = 0;
  for (let index = 0; index < windowCount; index += 1) {
    const kind = WINDOW_PATTERN[index % WINDOW_PATTERN.length] ?? "dead";
    plans.push(planLaunch(ctx, { kind, atMs: windowStartMs + 60_000 + index * windowSpacingMs, inWindow: true }, rugFunders, serialRugDev, serialUses));
  }
  return { t0Ms, windowStartMs, windowEndMs, lastLaunchMs, smart, late, cex, serialRugDev, plans, profiles };
}

interface LaunchSimulation {
  plan: LaunchPlan;
  t0Ms: number;
  curve: CurveReserves;
  pool: PoolReserves | null;
  poolAddress: Pubkey;
  holdings: Map<Pubkey, bigint>;
  completedAtMs: number | null;
  migrated: boolean;
  counter: number;
  txs: SimTransaction[];
}

function txRef(sim: LaunchSimulation, signature: string, slot: number, atMs: number, eventIndex: number): TxRef {
  return { signature, slot, seq: 0, eventIndex, receivedAtMs: atMs };
}

function nextSignature(sim: LaunchSimulation): string {
  sim.counter += 1;
  return `${sim.plan.mint.slice(0, 20)}Tx${sim.counter.toString().padStart(4, "0")}`;
}

function createEvent(sim: LaunchSimulation, tx: TxRef): LaunchCreatedEvent {
  const plan = sim.plan;
  return {
    kind: "create",
    tx,
    mint: plan.mint,
    bondingCurve: `${plan.mint.slice(0, 30)}Curve`,
    devWallet: plan.dev,
    creator: plan.dev,
    name: plan.name,
    symbol: plan.symbol,
    uri: "",
    timestampMs: plan.createdAtMs,
    virtualTokenReserves: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
    virtualQuoteReserves: DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
    realTokenReserves: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
    tokenTotalSupply: ONE_BILLION_SUPPLY,
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    quoteMint: plan.quoteMint,
    isMayhemMode: false,
    isCashback: false,
    isHolderReward: false,
    creatorFeeBps: 30,
    depth: 0
  };
}

function curveTrade(sim: LaunchSimulation, tx: TxRef, wallet: Pubkey, action: PlannedAction): TradeEvent | null {
  const held = sim.holdings.get(wallet) ?? 0n;
  if (action.buySol !== undefined) {
    const quote = quoteBuyExactQuoteIn(sim.curve, BigInt(Math.round(action.buySol * 1e9)), CURVE_FEES);
    if (quote.tokensOut <= 0n) {
      return null;
    }
    sim.curve = quote.after;
    sim.holdings.set(wallet, held + quote.tokensOut);
    return tradeEvent(sim, tx, wallet, true, quote.tokensOut, quote.netQuote, quote.totalCost, quote.protocolFee, quote.creatorFee);
  }
  const tokens = (held * BigInt(Math.round((action.sellFraction ?? 1) * 1_000_000))) / 1_000_000n;
  if (tokens <= 0n) {
    return null;
  }
  const quote = quoteSell(sim.curve, tokens, CURVE_FEES);
  sim.curve = quote.after;
  sim.holdings.set(wallet, held - tokens);
  return tradeEvent(sim, tx, wallet, false, tokens, quote.grossQuote, quote.netQuote, quote.protocolFee, quote.creatorFee);
}

function tradeEvent(
  sim: LaunchSimulation,
  tx: TxRef,
  wallet: Pubkey,
  isBuy: boolean,
  tokens: bigint,
  quoteAmount: bigint,
  userQuote: bigint,
  protocolFee: bigint,
  creatorFee: bigint
): TradeEvent {
  return {
    kind: "trade",
    tx,
    venue: "curve",
    mint: sim.plan.mint,
    pool: null,
    wallet,
    isBuy,
    tokenAmount: tokens,
    quoteAmount,
    userQuote,
    protocolFee,
    creatorFee,
    lpFee: 0n,
    protocolFeeBps: CURVE_FEES.protocolFeeBps,
    creatorFeeBps: CURVE_FEES.creatorFeeBps,
    lpFeeBps: 0,
    virtualTokenReserves: sim.curve.virtualTokenReserves,
    virtualQuoteReserves: sim.curve.virtualQuoteReserves,
    realTokenReserves: sim.curve.realTokenReserves,
    realQuoteReserves: sim.curve.realQuoteReserves,
    timestampMs: tx.receivedAtMs,
    ixName: isBuy ? "buy_exact_quote_in" : "sell"
  };
}

function poolTrade(sim: LaunchSimulation, tx: TxRef, wallet: Pubkey, action: PlannedAction): PoolTradeEvent | null {
  const pool = sim.pool;
  if (!pool) {
    return null;
  }
  const held = sim.holdings.get(wallet) ?? 0n;
  const base = {
    kind: "poolTrade" as const,
    tx,
    venue: "pool" as const,
    pool: sim.poolAddress,
    wallet,
    protocolFeeBps: POOL_FEES.protocolFeeBps,
    creatorFeeBps: POOL_FEES.creatorFeeBps,
    lpFeeBps: POOL_FEES.lpFeeBps,
    timestampMs: tx.receivedAtMs,
    ixName: null
  };
  if (action.buySol !== undefined) {
    const quote = quotePoolBuyExactQuote(pool, BigInt(Math.round(action.buySol * 1e9)), POOL_FEES);
    if (quote.baseOut <= 0n) {
      return null;
    }
    sim.pool = quote.after;
    sim.holdings.set(wallet, held + quote.baseOut);
    return {
      ...base,
      isBuy: true,
      tokenAmount: quote.baseOut,
      quoteAmount: quote.quoteIn,
      userQuote: quote.totalCost,
      protocolFee: quote.protocolFee,
      creatorFee: quote.creatorFee,
      lpFee: quote.lpFee,
      virtualTokenReserves: quote.after.baseReserves,
      virtualQuoteReserves: quote.after.quoteReserves,
      realTokenReserves: quote.after.baseReserves,
      realQuoteReserves: quote.after.quoteReserves
    };
  }
  const tokens = (held * BigInt(Math.round((action.sellFraction ?? 1) * 1_000_000))) / 1_000_000n;
  if (tokens <= 0n) {
    return null;
  }
  const quote = quotePoolSell(pool, tokens, POOL_FEES);
  sim.pool = quote.after;
  sim.holdings.set(wallet, held - tokens);
  return {
    ...base,
    isBuy: false,
    tokenAmount: tokens,
    quoteAmount: quote.quoteOut,
    userQuote: quote.netQuote,
    protocolFee: quote.protocolFee,
    creatorFee: quote.creatorFee,
    lpFee: quote.lpFee,
    virtualTokenReserves: quote.after.baseReserves,
    virtualQuoteReserves: quote.after.quoteReserves,
    realTokenReserves: quote.after.baseReserves,
    realQuoteReserves: quote.after.quoteReserves
  };
}

function migrate(sim: LaunchSimulation, atMs: number): void {
  const signature = nextSignature(sim);
  const slot = slotAt(sim.t0Ms, atMs);
  const quote = (sim.curve.realQuoteReserves ?? 0n) - DEFAULT_POOL_MIGRATION_FEE;
  const baseAmount = ONE_BILLION_SUPPLY - DEFAULT_INITIAL_REAL_TOKEN_RESERVES;
  sim.pool = { baseReserves: baseAmount, quoteReserves: quote };
  sim.migrated = true;
  sim.txs.push({
    atMs,
    slot,
    signature,
    order: sim.counter,
    events: [
      {
        kind: "poolCreated",
        tx: txRef(sim, signature, slot, atMs, 0),
        pool: sim.poolAddress,
        baseMint: sim.plan.mint,
        quoteMint: SOL_QUOTE,
        coinCreator: sim.plan.dev,
        timestampMs: atMs
      },
      {
        kind: "migrate",
        tx: txRef(sim, signature, slot, atMs, 1),
        mint: sim.plan.mint,
        pool: sim.poolAddress,
        bondingCurve: `${sim.plan.mint.slice(0, 30)}Curve`,
        baseAmount,
        quoteAmount: quote,
        migrationFee: DEFAULT_POOL_MIGRATION_FEE,
        timestampMs: atMs
      }
    ]
  });
}

function applyAction(sim: LaunchSimulation, action: PlannedAction, createSlot: number): void {
  const atMs = sim.plan.createdAtMs + action.atSec * 1000;
  if (sim.completedAtMs !== null && !sim.migrated && atMs >= sim.completedAtMs + MIGRATION_DELAY_SEC * 1000) {
    migrate(sim, sim.completedAtMs + MIGRATION_DELAY_SEC * 1000);
  }
  if (sim.completedAtMs !== null && !sim.migrated) {
    return;
  }
  const signature = nextSignature(sim);
  const slot = action.sameSlot ? createSlot : Math.max(createSlot + 1, slotAt(sim.t0Ms, atMs));
  const tx = txRef(sim, signature, slot, atMs, 0);
  const event = sim.migrated ? poolTrade(sim, tx, action.wallet, action) : curveTrade(sim, tx, action.wallet, action);
  if (!event) {
    return;
  }
  const events: DecodedChainEvent[] = [event];
  if (!sim.migrated && sim.curve.realTokenReserves === 0n) {
    sim.completedAtMs = atMs;
    events.push({
      kind: "complete",
      tx: txRef(sim, signature, slot, atMs, 1),
      mint: sim.plan.mint,
      bondingCurve: `${sim.plan.mint.slice(0, 30)}Curve`,
      user: action.wallet,
      timestampMs: atMs
    });
  }
  sim.txs.push({ atMs, slot, signature, order: sim.counter, events });
}

export function simulateLaunch(plan: LaunchPlan, t0Ms: number): SimTransaction[] {
  const sim: LaunchSimulation = {
    plan,
    t0Ms,
    curve: {
      virtualTokenReserves: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
      virtualQuoteReserves: DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
      realTokenReserves: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
      realQuoteReserves: 0n
    },
    pool: null,
    poolAddress: `${plan.mint.slice(0, 30)}Pool`,
    holdings: new Map(),
    completedAtMs: null,
    migrated: false,
    counter: 0,
    txs: []
  };
  const createSlot = slotAt(t0Ms, plan.createdAtMs);
  const signature = nextSignature(sim);
  const createTx = txRef(sim, signature, createSlot, plan.createdAtMs, 0);
  const create: SimTransaction = { atMs: plan.createdAtMs, slot: createSlot, signature, order: sim.counter, events: [createEvent(sim, createTx)] };
  sim.txs.push(create);
  const [first, ...rest] = plan.actions;
  if (first && first.wallet === plan.dev && first.sameSlot) {
    const event = curveTrade(sim, txRef(sim, signature, createSlot, plan.createdAtMs, 1), first.wallet, first);
    if (event) {
      create.events.push(event);
    }
  }
  for (const action of first && first.wallet === plan.dev && first.sameSlot ? rest : plan.actions) {
    applyAction(sim, action, createSlot);
  }
  if (sim.completedAtMs !== null && !sim.migrated) {
    migrate(sim, sim.completedAtMs + MIGRATION_DELAY_SEC * 1000);
  }
  return sim.txs;
}

export function simulateScenario(scenario: Scenario): SimTransaction[] {
  const all = scenario.plans.flatMap((plan) => simulateLaunch(plan, scenario.t0Ms));
  all.sort((a, b) => a.atMs - b.atMs || a.slot - b.slot || a.signature.localeCompare(b.signature) || a.order - b.order);
  all.forEach((tx, index) => {
    for (const event of tx.events) {
      event.tx = { ...event.tx, seq: index + 1 };
    }
  });
  return all;
}

export function decodeResultOf(tx: SimTransaction, receivedAtMs?: number): DecodeResult {
  const events = receivedAtMs === undefined ? tx.events : tx.events.map((event) => ({ ...event, tx: { ...event.tx, receivedAtMs } }));
  return { events, truncated: false, incomplete: 0, unknown: 0 };
}

function signatureList(wallet: Pubkey, profile: WalletProfile, limit: number): SignatureInfo[] {
  const count = Math.min(limit, profile.priorTxCount);
  return Array.from({ length: count }, (_, index) => ({
    signature: `${wallet.slice(0, 24)}Hist${index}`,
    slot: 300_000_000 - index,
    blockTime: Math.floor((profile.fundedAtMs - index * 60_000) / 1000),
    err: null
  }));
}

function historyTransaction(wallet: Pubkey, profile: WalletProfile, index: number): ParsedTransaction {
  const funding = profile.funder !== null && index === profile.fundingIndex;
  return {
    slot: 300_000_000 - index,
    blockTime: Math.floor((profile.fundedAtMs - index * 60_000) / 1000),
    meta: { err: null, fee: 5_000, preBalances: [], postBalances: [], innerInstructions: [] },
    transaction: {
      signatures: [`${wallet.slice(0, 24)}Hist${index}`],
      message: {
        accountKeys: [],
        instructions: funding
          ? [
              {
                programId: SYSTEM_PROGRAM_ID,
                program: "system",
                parsed: { type: "transfer", info: { source: profile.funder, destination: wallet, lamports: Number(profile.lamports) } }
              }
            ]
          : []
      }
    }
  };
}

export class ScenarioIntelRpc implements IntelRpc {
  signatureCalls = 0;
  transactionCalls = 0;
  private readonly byHistorySignature = new Map<string, { wallet: Pubkey; index: number }>();

  constructor(private readonly profiles: ReadonlyMap<Pubkey, WalletProfile>) {}

  async getSignaturesForAddress(address: string, options: { before?: string; limit?: number }): Promise<SignatureInfo[]> {
    this.signatureCalls += 1;
    const profile = this.profiles.get(address);
    if (!profile) {
      return [];
    }
    const list = signatureList(address, profile, options.limit ?? 1000);
    list.forEach((info, index) => this.byHistorySignature.set(info.signature, { wallet: address, index }));
    return list;
  }

  async getParsedTransaction(signature: string): Promise<ParsedTransaction | null> {
    this.transactionCalls += 1;
    const known = this.byHistorySignature.get(signature);
    const profile = known ? this.profiles.get(known.wallet) : undefined;
    if (!known || !profile) {
      return null;
    }
    return historyTransaction(known.wallet, profile, known.index);
  }
}
