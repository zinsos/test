import type { FillResult, OrderRequest, Position } from "../core/types.js";
import { entrySkeleton, withEntryFill, type PositionSeed } from "./accounting.js";
import { orderKeyOf } from "./ids.js";

export const PENDING_ENTRY_META = "pendingEntry";

export interface PendingEntry {
  order: OrderRequest;
  settleAfterMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function lamportsFrom(value: unknown): bigint | null {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function pendingEntryPosition(seed: PositionSeed, order: OrderRequest, settleAfterMs: number): Position {
  const skeleton = entrySkeleton(seed, seed.nowMs, seed.slot);
  return {
    ...skeleton,
    meta: {
      ...skeleton.meta,
      [PENDING_ENTRY_META]: {
        quoteBudget: (order.quoteBudget ?? 0n).toString(),
        maxSlippageBps: order.maxSlippageBps,
        referencePrice: order.referencePrice,
        reason: order.reason,
        signalAtMs: order.signalAtMs,
        signalSlot: order.signalSlot,
        settleAfterMs
      }
    }
  };
}

export function pendingEntryOf(position: Position): PendingEntry | null {
  const raw = position.meta[PENDING_ENTRY_META];
  if (position.status !== "pending" || !isRecord(raw)) {
    return null;
  }
  const quoteBudget = lamportsFrom(raw.quoteBudget);
  const maxSlippageBps = finiteNumber(raw.maxSlippageBps);
  const referencePrice = finiteNumber(raw.referencePrice);
  const signalAtMs = finiteNumber(raw.signalAtMs);
  const signalSlot = finiteNumber(raw.signalSlot);
  const settleAfterMs = finiteNumber(raw.settleAfterMs);
  if (quoteBudget === null || quoteBudget <= 0n || maxSlippageBps === null || referencePrice === null) {
    return null;
  }
  if (signalAtMs === null || signalSlot === null || settleAfterMs === null) {
    return null;
  }
  return {
    order: {
      side: "buy",
      mint: position.mint,
      quoteBudget,
      tokenAmount: null,
      maxSlippageBps,
      reason: typeof raw.reason === "string" ? raw.reason : position.signalType,
      urgency: "normal",
      signalSlot,
      signalAtMs,
      referencePrice,
      positionId: orderKeyOf(position),
      closesPosition: false
    },
    settleAfterMs
  };
}

export function openPendingPosition(pending: Position, fill: FillResult): Position {
  const meta = Object.fromEntries(Object.entries(pending.meta).filter(([key]) => key !== PENDING_ENTRY_META));
  return withEntryFill(
    {
      ...pending,
      openedAtMs: fill.filledAtMs ?? pending.openedAtMs,
      openedSlot: fill.filledSlot ?? pending.openedSlot,
      meta
    },
    fill
  );
}
