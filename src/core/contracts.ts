import type { LaunchState } from "../market/state.js";
import type {
  ClosedTrade,
  CurveView,
  FillResult,
  LaunchScore,
  OrderRequest,
  Position,
  Pubkey,
  Signal,
  TradingMode
} from "./types.js";

export interface MarketDataSource {
  launch(mint: Pubkey): LaunchState | undefined;
  view(mint: Pubkey): CurveView | null;
  latestSlot(): number;
}

export interface Executor {
  readonly mode: TradingMode;
  execute(order: OrderRequest): Promise<FillResult>;
}

export interface ScoreProvider {
  latest(mint: Pubkey): LaunchScore | null;
  scoreNow(mint: Pubkey, reason: string): Promise<LaunchScore | null>;
}

export interface TrackedWallet {
  wallet: Pubkey;
  rank: number;
  score: number;
  runId: number;
}

export interface TrackedWalletProvider {
  isTracked(wallet: Pubkey): boolean;
  get(wallet: Pubkey): TrackedWallet | null;
  count(): number;
  version(): string;
}

export interface RiskEntryInput {
  mint: Pubkey;
  devWallet: Pubkey;
  signal: Signal;
  nowMs: number;
  openPositions: readonly Position[];
}

export interface RiskDecision {
  allowed: boolean;
  reason: string | null;
  sizeLamports: bigint;
}

export interface RiskStatus {
  runId: number;
  bankrollLamports: bigint;
  equityLamports: bigint;
  peakEquityLamports: bigint;
  realizedPnlLamports: bigint;
  unrealizedPnlLamports: bigint;
  dayKey: string;
  dayStartEquityLamports: bigint;
  dayPnlLamports: bigint;
  haltedForDay: boolean;
  killed: boolean;
  killReason: string | null;
}

export interface RiskGate {
  evaluateEntry(input: RiskEntryInput): RiskDecision;
  onPositionOpened(position: Position): void;
  onPositionClosed(trade: ClosedTrade): void;
  markToMarket(unrealizedPnlLamports: bigint, nowMs: number): void;
  shouldFlattenAll(): boolean;
  status(): RiskStatus;
}

export interface SignalRecord {
  signal: Signal;
  acted: boolean;
  skipReason: string | null;
  launchId: number | null;
}

export interface TradingStore {
  createRun(input: {
    mode: TradingMode;
    label: string | null;
    config: unknown;
    dataFrom: Date | null;
    dataTo: Date | null;
  }): Promise<number>;
  recordSignal(runId: number, record: SignalRecord): Promise<number | null>;
  savePosition(position: Position): void;
  recordFill(position: Position, order: OrderRequest, fill: FillResult): void;
  recordRiskEvent(runId: number, atMs: number, kind: string, detail: Record<string, unknown>): void;
  saveRiskState(status: RiskStatus, extra: Record<string, unknown>): void;
  finishRun(runId: number, summary: unknown): Promise<void>;
  flush(): Promise<void>;
}
