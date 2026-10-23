export type Pubkey = string;

export interface TxRef {
  signature: string;
  slot: number;
  seq: number;
  eventIndex: number;
  receivedAtMs: number;
}

export interface LaunchCreatedEvent {
  kind: "create";
  tx: TxRef;
  mint: Pubkey;
  bondingCurve: Pubkey;
  devWallet: Pubkey;
  creator: Pubkey;
  name: string;
  symbol: string;
  uri: string;
  timestampMs: number;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  tokenProgram: Pubkey | null;
  quoteMint: string;
  isMayhemMode: boolean;
  isCashback: boolean;
  isHolderReward: boolean;
  creatorFeeBps: number;
  depth: number;
}

export type TradeVenue = "curve" | "pool" | "curve_post_complete";

export interface TradeEvent {
  kind: "trade";
  tx: TxRef;
  venue: TradeVenue;
  mint: Pubkey;
  pool: Pubkey | null;
  wallet: Pubkey;
  isBuy: boolean;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  lpFee: bigint;
  protocolFeeBps: number;
  creatorFeeBps: number;
  lpFeeBps: number;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint | null;
  realQuoteReserves: bigint | null;
  timestampMs: number;
  ixName: string | null;
}

export interface CurveCompleteEvent {
  kind: "complete";
  tx: TxRef;
  mint: Pubkey;
  bondingCurve: Pubkey;
  user: Pubkey;
  timestampMs: number;
}

export interface MigrationEvent {
  kind: "migrate";
  tx: TxRef;
  mint: Pubkey;
  pool: Pubkey;
  bondingCurve: Pubkey;
  baseAmount: bigint;
  quoteAmount: bigint;
  migrationFee: bigint;
  timestampMs: number;
}

export type ChainEvent = LaunchCreatedEvent | TradeEvent | CurveCompleteEvent | MigrationEvent;

export interface IngestGap {
  source: string;
  fromSlot: number | null;
  toSlot: number | null;
  startedAtMs: number;
  endedAtMs: number;
  reason: string;
}

export interface CurveView {
  mint: Pubkey;
  slot: number;
  atMs: number;
  venue: TradeVenue;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint | null;
  realQuoteReserves: bigint | null;
  tokenTotalSupply: bigint;
  complete: boolean;
  migrated: boolean;
  protocolFeeBps: number;
  creatorFeeBps: number;
  lpFeeBps: number;
}

export type FeatureVector = Record<string, number | null>;

export interface LaunchScore {
  mint: Pubkey;
  launchId: number | null;
  checkpointSec: number;
  computedAtMs: number;
  slot: number;
  score: number;
  hardBlocked: boolean;
  flags: string[];
  features: FeatureVector;
  contributions: Record<string, number>;
  weightsVersion: string;
}

export type SignalType = "smart_convergence" | "score_momentum";

export interface Signal {
  id: number | null;
  type: SignalType;
  mint: Pubkey;
  atMs: number;
  slot: number;
  riskScore: number | null;
  wallets: Pubkey[];
  meta: Record<string, unknown>;
}

export type TradingMode = "paper" | "live" | "backtest" | "shadow";
export type OrderSide = "buy" | "sell";
export type OrderUrgency = "normal" | "emergency";

export interface OrderRequest {
  side: OrderSide;
  mint: Pubkey;
  quoteBudget: bigint | null;
  tokenAmount: bigint | null;
  maxSlippageBps: number;
  reason: string;
  urgency: OrderUrgency;
  signalSlot: number;
  signalAtMs: number;
  referencePrice: number;
  positionId: string | null;
}

export interface FillAttempt {
  atMs: number;
  slot: number;
  success: boolean;
  error: string | null;
  networkFee: bigint;
  tip: bigint;
}

export interface FillResult {
  side: OrderSide;
  mint: Pubkey;
  success: boolean;
  venue: TradeVenue;
  requestedAtMs: number;
  requestedSlot: number;
  filledAtMs: number | null;
  filledSlot: number | null;
  tokenAmount: bigint;
  quoteAmount: bigint;
  userQuote: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  lpFee: bigint;
  extraPlatformFee: bigint;
  networkFees: bigint;
  tips: bigint;
  rentPaid: bigint;
  rentRefunded: bigint;
  referencePrice: number;
  fillPrice: number | null;
  slippageBps: number | null;
  priceImpactBps: number | null;
  attempts: FillAttempt[];
  signature: string | null;
  error: string | null;
}

export type PositionStatus = "open" | "closed";

export interface Position {
  id: string;
  runId: number;
  mode: TradingMode;
  mint: Pubkey;
  launchId: number | null;
  signalId: number | null;
  signalType: SignalType;
  riskScore: number | null;
  openedAtMs: number;
  openedSlot: number;
  entryPrice: number;
  entryTokens: bigint;
  entryCost: bigint;
  tokensHeld: bigint;
  proceeds: bigint;
  feesPaid: bigint;
  peakPrice: number;
  lastPrice: number;
  takeProfitLevelsHit: number;
  migratedSeen: boolean;
  status: PositionStatus;
  closedAtMs: number | null;
  exitReason: string | null;
  shadowOf: string | null;
  meta: Record<string, unknown>;
}

export interface ClosedTrade {
  positionId: string;
  runId: number;
  mode: TradingMode;
  mint: Pubkey;
  signalType: SignalType;
  riskScore: number | null;
  openedAtMs: number;
  closedAtMs: number;
  holdSec: number;
  cost: bigint;
  proceeds: bigint;
  pnl: bigint;
  fees: bigint;
  exitReason: string;
  peakMultiple: number;
}
