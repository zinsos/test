import type { Position, Pubkey } from "../core/types.js";

export const ORDER_KEY_META = "orderKey";
export const FILL_SEQ_META = "fillSeq";
const SHADOW_SUFFIX = "-shadow";

export function entryKey(mint: Pubkey, signalAtMs: number): string {
  return `${Math.floor(signalAtMs)}-${mint}`;
}

export function positionIdFor(runId: number, key: string): string {
  return `${runId}-${key}`;
}

export function shadowKeyFor(key: string): string {
  return `${key}${SHADOW_SUFFIX}`;
}

export function shadowIdFor(positionId: string): string {
  return `${positionId}${SHADOW_SUFFIX}`;
}

export function orderKeyOf(position: Pick<Position, "id" | "meta">): string {
  const key = position.meta[ORDER_KEY_META];
  return typeof key === "string" && key.length > 0 ? key : position.id;
}

export function fillSeqOf(position: Pick<Position, "meta">): number | null {
  const value = position.meta[FILL_SEQ_META];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function withNextFillSeq(position: Position): Position {
  const next = (fillSeqOf(position) ?? -1) + 1;
  return { ...position, meta: { ...position.meta, [FILL_SEQ_META]: next } };
}
