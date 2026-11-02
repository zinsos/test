import type { CurveView, OrderRequest, Position } from "../core/types.js";
import type { ExitAction } from "./types.js";

export function exitOrderRequest(
  position: Pick<Position, "id" | "mint">,
  action: ExitAction,
  view: Pick<CurveView, "slot">,
  price: number,
  nowMs: number
): OrderRequest {
  return {
    side: "sell",
    mint: position.mint,
    quoteBudget: null,
    tokenAmount: action.tokenAmount,
    maxSlippageBps: action.maxSlippageBps,
    reason: action.reason,
    urgency: action.urgency,
    signalSlot: view.slot,
    signalAtMs: nowMs,
    referencePrice: price,
    positionId: position.id,
    closesPosition: action.closesPosition
  };
}
