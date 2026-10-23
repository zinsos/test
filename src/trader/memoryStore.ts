import type { RiskStatus, SignalRecord, TradingStore } from "../core/contracts.js";
import type { ClosedTrade, FillResult, OrderRequest, Position } from "../core/types.js";
import { closedTradeOf } from "./accounting.js";
import type { RunInput } from "./store.js";

export interface StoredRun {
  id: number;
  input: RunInput;
  summary: unknown;
  finished: boolean;
}

export interface StoredSignal extends SignalRecord {
  id: number;
  runId: number;
}

export interface StoredFill {
  position: Position;
  order: OrderRequest;
  fill: FillResult;
}

export interface StoredRiskEvent {
  runId: number;
  atMs: number;
  kind: string;
  detail: Record<string, unknown>;
}

export class MemoryTradingStore implements TradingStore {
  readonly runs = new Map<number, StoredRun>();
  readonly signals: StoredSignal[] = [];
  readonly positions = new Map<string, Position>();
  readonly fills: StoredFill[] = [];
  readonly riskEvents: StoredRiskEvent[] = [];
  riskState: { status: RiskStatus; extra: Record<string, unknown> } | null = null;
  positionSaves = 0;
  flushes = 0;
  private nextRunId = 1;
  private nextSignalId = 1;

  async createRun(input: RunInput): Promise<number> {
    const id = this.nextRunId++;
    this.runs.set(id, { id, input, summary: null, finished: false });
    return id;
  }

  recordSignal(runId: number, record: SignalRecord): Promise<number | null> {
    const id = this.nextSignalId++;
    this.signals.push({ ...record, id, runId });
    return Promise.resolve(id);
  }

  savePosition(position: Position): void {
    this.positionSaves += 1;
    this.positions.set(position.id, position);
  }

  recordFill(position: Position, order: OrderRequest, fill: FillResult): void {
    this.fills.push({ position, order, fill });
  }

  recordRiskEvent(runId: number, atMs: number, kind: string, detail: Record<string, unknown>): void {
    this.riskEvents.push({ runId, atMs, kind, detail });
  }

  saveRiskState(status: RiskStatus, extra: Record<string, unknown>): void {
    this.riskState = { status, extra };
  }

  async finishRun(runId: number, summary: unknown): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.summary = summary;
      run.finished = true;
    }
  }

  async flush(): Promise<void> {
    this.flushes += 1;
  }

  openPositions(): Position[] {
    return [...this.positions.values()].filter((position) => position.status === "open");
  }

  closedPositions(): Position[] {
    return [...this.positions.values()].filter((position) => position.status === "closed");
  }

  closedTrades(): ClosedTrade[] {
    return this.closedPositions().map(closedTradeOf);
  }

  fillsFor(positionId: string): StoredFill[] {
    return this.fills.filter((entry) => entry.position.id === positionId);
  }
}
