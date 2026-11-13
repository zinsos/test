import pumpIdlJson from "../../idl/pump.json" with { type: "json" };
import ammIdlJson from "../../idl/pump_amm.json" with { type: "json" };
import { DEFAULT_PUBKEY, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, SOL_QUOTE, WSOL_MINT } from "../core/constants.js";
import type {
  ChainEvent,
  CurveCompleteEvent,
  LaunchCreatedEvent,
  MigrationEvent,
  TradeEvent,
  TxRef
} from "../core/types.js";
import { createEventDecoder, type DecodedValue, type Idl } from "./idl.js";
import { extractProgramData } from "./logs.js";

const pumpDecoder = createEventDecoder(pumpIdlJson as unknown as Idl);
const ammDecoder = createEventDecoder(ammIdlJson as unknown as Idl);

export const POOL_EVENT_RESERVES_ARE_PRE_TRADE = true;

export interface PoolTradeEvent extends Omit<TradeEvent, "kind" | "mint" | "venue"> {
  kind: "poolTrade";
  venue: "pool";
  pool: string;
}

export interface PoolCreatedEvent {
  kind: "poolCreated";
  tx: TxRef;
  pool: string;
  baseMint: string;
  quoteMint: string;
  coinCreator: string | null;
  timestampMs: number;
}

export type DecodedChainEvent = ChainEvent | PoolTradeEvent | PoolCreatedEvent;

export interface DecodeBase {
  signature: string;
  slot: number;
  seq: number;
  receivedAtMs: number;
}

export interface DecodeResult {
  events: DecodedChainEvent[];
  truncated: boolean;
  incomplete: number;
  unknown: number;
}

type Fields = Record<string, DecodedValue>;

export function normalizeQuoteMint(mint: string | null | undefined): string {
  if (!mint || mint === DEFAULT_PUBKEY || mint === WSOL_MINT) {
    return SOL_QUOTE;
  }
  return mint;
}

function big(fields: Fields, name: string): bigint {
  const value = fields[name];
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  return 0n;
}

function optBig(fields: Fields, name: string): bigint | null {
  const value = fields[name];
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  return null;
}

function str(fields: Fields, name: string): string | null {
  const value = fields[name];
  return typeof value === "string" ? value : null;
}

function bool(fields: Fields, name: string): boolean {
  return fields[name] === true;
}

function toNumber(value: bigint): number {
  return Number(value);
}

function preferQuote(fields: Fields, solName: string, quoteName: string, isSol: boolean): bigint {
  const solValue = optBig(fields, solName);
  const quoteValue = optBig(fields, quoteName);
  if (isSol) {
    if (solValue !== null && solValue > 0n) {
      return solValue;
    }
    return quoteValue ?? solValue ?? 0n;
  }
  if (quoteValue !== null && quoteValue > 0n) {
    return quoteValue;
  }
  return solValue ?? quoteValue ?? 0n;
}

function preferQuoteNullable(fields: Fields, solName: string, quoteName: string, isSol: boolean): bigint | null {
  if (optBig(fields, solName) === null && optBig(fields, quoteName) === null) {
    return null;
  }
  return preferQuote(fields, solName, quoteName, isSol);
}

function mapCreate(fields: Fields, tx: TxRef): LaunchCreatedEvent | null {
  const mint = str(fields, "mint");
  const user = str(fields, "user");
  const bondingCurve = str(fields, "bonding_curve");
  if (!mint || !user || !bondingCurve) {
    return null;
  }
  const quoteMint = normalizeQuoteMint(str(fields, "quote_mint"));
  const isSol = quoteMint === SOL_QUOTE;
  return {
    kind: "create",
    tx,
    mint,
    bondingCurve,
    devWallet: user,
    creator: str(fields, "creator") ?? user,
    name: str(fields, "name") ?? "",
    symbol: str(fields, "symbol") ?? "",
    uri: str(fields, "uri") ?? "",
    timestampMs: toNumber(big(fields, "timestamp")) * 1000,
    virtualTokenReserves: big(fields, "virtual_token_reserves"),
    virtualQuoteReserves: preferQuote(fields, "virtual_sol_reserves", "virtual_quote_reserves", isSol),
    realTokenReserves: big(fields, "real_token_reserves"),
    tokenTotalSupply: big(fields, "token_total_supply"),
    tokenProgram: str(fields, "token_program"),
    quoteMint,
    isMayhemMode: bool(fields, "is_mayhem_mode"),
    isCashback: bool(fields, "is_cashback_enabled"),
    isHolderReward: bool(fields, "is_holder_reward"),
    creatorFeeBps: toNumber(big(fields, "creator_fee_bps")),
    depth: typeof fields.depth === "number" ? fields.depth : 0
  };
}

function mapCurveTrade(fields: Fields, tx: TxRef): TradeEvent | null {
  const mint = str(fields, "mint");
  const user = str(fields, "user");
  if (!mint || !user) {
    return null;
  }
  const isSol = normalizeQuoteMint(str(fields, "quote_mint")) === SOL_QUOTE;
  const isBuy = bool(fields, "is_buy");
  const quoteAmount = preferQuote(fields, "sol_amount", "quote_amount", isSol);
  const protocolFee = big(fields, "fee");
  const creatorFee = big(fields, "creator_fee");
  const fees = protocolFee + creatorFee;
  return {
    kind: "trade",
    tx,
    venue: "curve",
    mint,
    pool: null,
    wallet: user,
    isBuy,
    tokenAmount: big(fields, "token_amount"),
    quoteAmount,
    userQuote: isBuy ? quoteAmount + fees : quoteAmount - fees,
    protocolFee,
    creatorFee,
    lpFee: 0n,
    protocolFeeBps: toNumber(big(fields, "fee_basis_points")),
    creatorFeeBps: toNumber(big(fields, "creator_fee_basis_points")),
    lpFeeBps: 0,
    virtualTokenReserves: big(fields, "virtual_token_reserves"),
    virtualQuoteReserves: preferQuote(fields, "virtual_sol_reserves", "virtual_quote_reserves", isSol),
    realTokenReserves: optBig(fields, "real_token_reserves"),
    realQuoteReserves: preferQuoteNullable(fields, "real_sol_reserves", "real_quote_reserves", isSol),
    timestampMs: toNumber(big(fields, "timestamp")) * 1000,
    ixName: str(fields, "ix_name")
  };
}

function mapPostCompleteBuy(fields: Fields, tx: TxRef): TradeEvent | null {
  const mint = str(fields, "mint");
  const user = str(fields, "user");
  if (!mint || !user) {
    return null;
  }
  const quoteAmount = big(fields, "quote_in");
  const protocolFee = big(fields, "fee");
  const creatorFee = big(fields, "creator_fee");
  return {
    kind: "trade",
    tx,
    venue: "curve_post_complete",
    mint,
    pool: null,
    wallet: user,
    isBuy: true,
    tokenAmount: big(fields, "base_out"),
    quoteAmount,
    userQuote: quoteAmount + protocolFee + creatorFee,
    protocolFee,
    creatorFee,
    lpFee: 0n,
    protocolFeeBps: toNumber(big(fields, "fee_basis_points")),
    creatorFeeBps: toNumber(big(fields, "creator_fee_basis_points")),
    lpFeeBps: 0,
    virtualTokenReserves: big(fields, "pool_base_reserves_after"),
    virtualQuoteReserves: big(fields, "pool_quote_reserves_after"),
    realTokenReserves: null,
    realQuoteReserves: null,
    timestampMs: toNumber(big(fields, "timestamp")) * 1000,
    ixName: null
  };
}

function mapComplete(fields: Fields, tx: TxRef): CurveCompleteEvent | null {
  const mint = str(fields, "mint");
  if (!mint) {
    return null;
  }
  return {
    kind: "complete",
    tx,
    mint,
    bondingCurve: str(fields, "bonding_curve") ?? "",
    user: str(fields, "user") ?? "",
    timestampMs: toNumber(big(fields, "timestamp")) * 1000
  };
}

function mapMigration(fields: Fields, tx: TxRef): MigrationEvent | null {
  const mint = str(fields, "mint");
  const pool = str(fields, "pool");
  if (!mint || !pool) {
    return null;
  }
  return {
    kind: "migrate",
    tx,
    mint,
    pool,
    bondingCurve: str(fields, "bonding_curve") ?? "",
    baseAmount: big(fields, "mint_amount"),
    quoteAmount: big(fields, "sol_amount"),
    migrationFee: big(fields, "pool_migration_fee"),
    timestampMs: toNumber(big(fields, "timestamp")) * 1000
  };
}

export function poolReservesAfterTrade(
  isBuy: boolean,
  baseReserves: bigint,
  effectiveQuoteReserves: bigint,
  baseAmount: bigint,
  quoteAmount: bigint,
  lpFee: bigint
): { base: bigint; quote: bigint } {
  if (!POOL_EVENT_RESERVES_ARE_PRE_TRADE) {
    return { base: baseReserves, quote: effectiveQuoteReserves };
  }
  if (isBuy) {
    return { base: baseReserves - baseAmount, quote: effectiveQuoteReserves + quoteAmount + lpFee };
  }
  return { base: baseReserves + baseAmount, quote: effectiveQuoteReserves - (quoteAmount - lpFee) };
}

export function poolBuyNetQuote(baseReserves: bigint, quoteReserves: bigint, baseOut: bigint, reported: bigint): bigint {
  if (baseOut <= 0n || baseOut >= baseReserves) {
    return reported;
  }
  const numerator = quoteReserves * baseOut;
  const denominator = baseReserves - baseOut;
  return (numerator + denominator - 1n) / denominator;
}

function mapPoolTrade(fields: Fields, tx: TxRef, isBuy: boolean): PoolTradeEvent | null {
  const pool = str(fields, "pool");
  const user = str(fields, "user");
  if (!pool || !user) {
    return null;
  }
  const baseAmount = isBuy ? big(fields, "base_amount_out") : big(fields, "base_amount_in");
  const baseReserves = big(fields, "pool_base_token_reserves");
  const effectiveQuote = big(fields, "pool_quote_token_reserves") + big(fields, "virtual_quote_reserves");
  const quoteAmount = isBuy
    ? poolBuyNetQuote(baseReserves, effectiveQuote, baseAmount, big(fields, "quote_amount_in"))
    : big(fields, "quote_amount_out");
  const userQuote = isBuy ? big(fields, "user_quote_amount_in") : big(fields, "user_quote_amount_out");
  const lpFee = big(fields, "lp_fee");
  const after = poolReservesAfterTrade(isBuy, baseReserves, effectiveQuote, baseAmount, quoteAmount, lpFee);
  return {
    kind: "poolTrade",
    tx,
    venue: "pool",
    pool,
    wallet: user,
    isBuy,
    tokenAmount: baseAmount,
    quoteAmount,
    userQuote,
    protocolFee: big(fields, "protocol_fee"),
    creatorFee: big(fields, "coin_creator_fee"),
    lpFee,
    protocolFeeBps: toNumber(big(fields, "protocol_fee_basis_points")),
    creatorFeeBps: toNumber(big(fields, "coin_creator_fee_basis_points")),
    lpFeeBps: toNumber(big(fields, "lp_fee_basis_points")),
    virtualTokenReserves: after.base,
    virtualQuoteReserves: after.quote,
    realTokenReserves: after.base,
    realQuoteReserves: after.quote,
    timestampMs: toNumber(big(fields, "timestamp")) * 1000,
    ixName: str(fields, "ix_name")
  };
}

function mapPoolCreated(fields: Fields, tx: TxRef): PoolCreatedEvent | null {
  const pool = str(fields, "pool");
  const baseMint = str(fields, "base_mint");
  if (!pool || !baseMint) {
    return null;
  }
  return {
    kind: "poolCreated",
    tx,
    pool,
    baseMint,
    quoteMint: normalizeQuoteMint(str(fields, "quote_mint")),
    coinCreator: str(fields, "coin_creator"),
    timestampMs: toNumber(big(fields, "timestamp")) * 1000
  };
}

export function decodeLogs(logs: readonly string[], base: DecodeBase): DecodeResult {
  const { entries, truncated } = extractProgramData(logs);
  const events: DecodedChainEvent[] = [];
  let incomplete = 0;
  let unknown = 0;
  let eventIndex = 0;
  for (const entry of entries) {
    const decoder =
      entry.programId === PUMP_PROGRAM_ID ? pumpDecoder : entry.programId === PUMP_AMM_PROGRAM_ID ? ammDecoder : null;
    if (!decoder) {
      continue;
    }
    const result = decoder.decode(entry.data);
    if (!result) {
      unknown += 1;
      continue;
    }
    if (!result.decoded.complete) {
      incomplete += 1;
    }
    const tx: TxRef = {
      signature: base.signature,
      slot: base.slot,
      seq: base.seq,
      eventIndex,
      receivedAtMs: base.receivedAtMs
    };
    const fields = result.decoded.fields;
    let mapped: DecodedChainEvent | null = null;
    if (decoder === pumpDecoder) {
      switch (result.name) {
        case "CreateEvent":
          mapped = mapCreate(fields, tx);
          break;
        case "TradeEvent":
          mapped = mapCurveTrade(fields, tx);
          break;
        case "PostCompleteBuyEvent":
          mapped = mapPostCompleteBuy(fields, tx);
          break;
        case "CompleteEvent":
          mapped = mapComplete(fields, tx);
          break;
        case "CompletePumpAmmMigrationEvent":
          mapped = mapMigration(fields, tx);
          break;
        default:
          mapped = null;
      }
    } else {
      switch (result.name) {
        case "BuyEvent":
          mapped = mapPoolTrade(fields, tx, true);
          break;
        case "SellEvent":
          mapped = mapPoolTrade(fields, tx, false);
          break;
        case "CreatePoolEvent":
          mapped = mapPoolCreated(fields, tx);
          break;
        default:
          mapped = null;
      }
    }
    if (mapped) {
      events.push(mapped);
      eventIndex += 1;
    }
  }
  return { events, truncated, incomplete, unknown };
}

export function decodeRawEvent(programId: string, data: Buffer): { name: string; fields: Fields; complete: boolean } | null {
  const decoder = programId === PUMP_PROGRAM_ID ? pumpDecoder : programId === PUMP_AMM_PROGRAM_ID ? ammDecoder : null;
  const result = decoder?.decode(data);
  if (!result) {
    return null;
  }
  return { name: result.name, fields: result.decoded.fields, complete: result.decoded.complete };
}
