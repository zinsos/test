import type { Pubkey } from "../core/types.js";
import type { TradeRecord } from "../market/state.js";

export interface WalletFlow {
  wallet: Pubkey;
  bought: bigint;
  sold: bigint;
  quoteIn: bigint;
  quoteOut: bigint;
  buys: number;
  sells: number;
  firstBuySlot: number | null;
  firstBuyAtMs: number | null;
  firstBuyOrder: number | null;
  firstBuySignature: string | null;
  boughtByCreationWindow: bigint;
  roundTrips: number;
  lastSide: "buy" | "sell" | null;
}

export interface FlowSummary {
  flows: Map<Pubkey, WalletFlow>;
  trades: readonly TradeRecord[];
  lastTrade: TradeRecord | null;
}

function emptyFlow(wallet: Pubkey): WalletFlow {
  return {
    wallet,
    bought: 0n,
    sold: 0n,
    quoteIn: 0n,
    quoteOut: 0n,
    buys: 0,
    sells: 0,
    firstBuySlot: null,
    firstBuyAtMs: null,
    firstBuyOrder: null,
    firstBuySignature: null,
    boughtByCreationWindow: 0n,
    roundTrips: 0,
    lastSide: null
  };
}

function applyBuy(flow: WalletFlow, trade: TradeRecord, order: number, creationWindowEndSlot: number): boolean {
  const first = flow.buys === 0;
  if (first) {
    flow.firstBuySlot = trade.slot;
    flow.firstBuyAtMs = trade.atMs;
    flow.firstBuyOrder = order;
    flow.firstBuySignature = trade.signature;
  }
  flow.buys += 1;
  flow.bought += trade.tokenAmount;
  flow.quoteIn += trade.quoteAmount;
  if (trade.slot <= creationWindowEndSlot) {
    flow.boughtByCreationWindow += trade.tokenAmount;
  }
  flow.lastSide = "buy";
  return first;
}

function applySell(flow: WalletFlow, trade: TradeRecord): void {
  if (flow.lastSide === "buy") {
    flow.roundTrips += 1;
  }
  flow.sells += 1;
  flow.sold += trade.tokenAmount;
  flow.quoteOut += trade.quoteAmount;
  flow.lastSide = "sell";
}

export function summarizeFlows(trades: readonly TradeRecord[], creationWindowEndSlot: number): FlowSummary {
  const flows = new Map<Pubkey, WalletFlow>();
  let order = 0;
  for (const trade of trades) {
    let flow = flows.get(trade.wallet);
    if (!flow) {
      flow = emptyFlow(trade.wallet);
      flows.set(trade.wallet, flow);
    }
    if (trade.isBuy) {
      if (applyBuy(flow, trade, order, creationWindowEndSlot)) {
        order += 1;
      }
    } else {
      applySell(flow, trade);
    }
  }
  return { flows, trades, lastTrade: trades[trades.length - 1] ?? null };
}

export function heldBy(flow: WalletFlow | undefined): bigint {
  if (!flow) {
    return 0n;
  }
  const held = flow.bought - flow.sold;
  return held > 0n ? held : 0n;
}

export function volumeOf(flow: WalletFlow): bigint {
  return flow.quoteIn + flow.quoteOut;
}
