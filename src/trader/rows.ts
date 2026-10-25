import type { FillResult, OrderRequest, Position, SignalType, TradingMode } from "../core/types.js";
import { jsonSafe, toBigInt, toNullableNumber, toNumber } from "../db/pool.js";
import type { SignalRecord } from "../core/contracts.js";
import { holdSecondsOf, peakMultipleOf, realizedPnlOf } from "./accounting.js";
import { fillSeqOf } from "./ids.js";

export const POSITION_COLUMNS = [
  "id",
  "run_id",
  "mode",
  "mint",
  "launch_id",
  "signal_id",
  "signal_type",
  "risk_score",
  "opened_at",
  "opened_slot",
  "entry_price",
  "entry_tokens",
  "entry_cost",
  "tokens_held",
  "proceeds",
  "fees_paid",
  "peak_price",
  "last_price",
  "take_profit_levels_hit",
  "migrated_seen",
  "status",
  "closed_at",
  "exit_reason",
  "realized_pnl",
  "hold_sec",
  "peak_multiple",
  "shadow_of",
  "meta"
] as const;

export const FILL_COLUMNS = [
  "position_id",
  "run_id",
  "fill_seq",
  "side",
  "reason",
  "urgency",
  "success",
  "venue",
  "requested_at",
  "requested_slot",
  "filled_at",
  "filled_slot",
  "token_amount",
  "quote_amount",
  "user_quote",
  "protocol_fee",
  "creator_fee",
  "lp_fee",
  "extra_platform_fee",
  "network_fees",
  "tips",
  "rent_paid",
  "rent_refunded",
  "reference_price",
  "fill_price",
  "slippage_bps",
  "price_impact_bps",
  "attempts",
  "signature",
  "error"
] as const;

export const SIGNAL_COLUMNS = [
  "id",
  "run_id",
  "type",
  "mint",
  "launch_id",
  "at",
  "slot",
  "risk_score",
  "wallets",
  "meta",
  "acted",
  "skip_reason"
] as const;

const UPDATABLE_POSITION_COLUMNS = POSITION_COLUMNS.filter(
  (column) => !["id", "run_id", "mode", "mint", "launch_id", "signal_id", "opened_at", "opened_slot"].includes(column)
);

export const POSITION_UPSERT_CONFLICT = `ON CONFLICT (id) DO UPDATE SET
  launch_id = COALESCE(EXCLUDED.launch_id, positions.launch_id),
  signal_id = COALESCE(EXCLUDED.signal_id, positions.signal_id),
  ${UPDATABLE_POSITION_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(",\n  ")}
WHERE (positions.status <> 'closed' OR EXCLUDED.status = 'closed')
  AND (EXCLUDED.status <> 'pending' OR positions.status = 'pending')`;

export const FILL_INSERT_CONFLICT = "ON CONFLICT (position_id, fill_seq) WHERE fill_seq IS NOT NULL DO NOTHING";
export const SIGNAL_INSERT_CONFLICT = "ON CONFLICT (id) DO NOTHING";

const MAX_TEXT = 2_000;

export function finiteOr(value: number | null | undefined, fallback: number): number {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : fallback;
}

export function finiteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

export function jsonText(value: unknown): string {
  return JSON.stringify(jsonSafe(value));
}

function boundedText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

function dateOrNull(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

export function positionRow(position: Position): unknown[] {
  const closed = position.status === "closed";
  return [
    position.id,
    position.runId,
    position.mode,
    position.mint,
    position.launchId,
    position.signalId,
    position.signalType,
    finiteOrNull(position.riskScore),
    new Date(position.openedAtMs),
    position.openedSlot,
    finiteOr(position.entryPrice, 0),
    position.entryTokens,
    position.entryCost,
    position.tokensHeld,
    position.proceeds,
    position.feesPaid,
    finiteOr(position.peakPrice, 0),
    finiteOr(position.lastPrice, 0),
    position.takeProfitLevelsHit,
    position.migratedSeen,
    position.status,
    dateOrNull(position.closedAtMs),
    position.exitReason,
    closed ? realizedPnlOf(position) : null,
    closed ? holdSecondsOf(position) : null,
    closed ? finiteOr(peakMultipleOf(position), 0) : null,
    position.shadowOf,
    jsonText(position.meta)
  ];
}

export function fillRow(position: Position, order: OrderRequest, fill: FillResult): unknown[] {
  return [
    position.id,
    position.runId,
    fillSeqOf(position),
    fill.side,
    order.reason,
    order.urgency,
    fill.success,
    fill.venue,
    new Date(fill.requestedAtMs),
    fill.requestedSlot,
    dateOrNull(fill.filledAtMs),
    fill.filledSlot,
    fill.tokenAmount,
    fill.quoteAmount,
    fill.userQuote,
    fill.protocolFee,
    fill.creatorFee,
    fill.lpFee,
    fill.extraPlatformFee,
    fill.networkFees,
    fill.tips,
    fill.rentPaid,
    fill.rentRefunded,
    finiteOr(fill.referencePrice, 0),
    finiteOrNull(fill.fillPrice),
    finiteOrNull(fill.slippageBps),
    finiteOrNull(fill.priceImpactBps),
    jsonText(fill.attempts),
    fill.signature,
    boundedText(fill.error)
  ];
}

export function signalRow(id: number | null, runId: number, record: SignalRecord): unknown[] {
  const signal = record.signal;
  return [
    id,
    runId > 0 ? runId : null,
    signal.type,
    signal.mint,
    record.launchId,
    new Date(signal.atMs),
    signal.slot,
    finiteOrNull(signal.riskScore),
    signal.wallets,
    jsonText(signal.meta),
    record.acted,
    record.skipReason
  ];
}

type DbRecord = Record<string, unknown>;

function msOf(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function positionFromRow(row: DbRecord): Position {
  const openedAtMs = msOf(row.opened_at) ?? 0;
  return {
    id: String(row.id),
    runId: toNumber(row.run_id),
    mode: String(row.mode) as TradingMode,
    mint: String(row.mint),
    launchId: toNullableNumber(row.launch_id),
    signalId: toNullableNumber(row.signal_id),
    signalType: String(row.signal_type) as SignalType,
    riskScore: toNullableNumber(row.risk_score),
    openedAtMs,
    openedSlot: toNumber(row.opened_slot),
    entryPrice: toNumber(row.entry_price),
    entryTokens: toBigInt(row.entry_tokens),
    entryCost: toBigInt(row.entry_cost),
    tokensHeld: toBigInt(row.tokens_held),
    proceeds: toBigInt(row.proceeds),
    feesPaid: toBigInt(row.fees_paid),
    peakPrice: toNumber(row.peak_price),
    lastPrice: toNumber(row.last_price),
    takeProfitLevelsHit: toNumber(row.take_profit_levels_hit),
    migratedSeen: row.migrated_seen === true,
    status: row.status === "closed" || row.status === "pending" ? row.status : "open",
    closedAtMs: msOf(row.closed_at),
    exitReason: typeof row.exit_reason === "string" ? row.exit_reason : null,
    shadowOf: typeof row.shadow_of === "string" ? row.shadow_of : null,
    meta: recordOf(row.meta)
  };
}
