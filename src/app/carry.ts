import type { RiskConfig } from "../config/strategy.js";
import type { RiskStatus } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import { toBigInt, toNumber, type Db } from "../db/pool.js";
import { isPlainObject } from "../lab/variants.js";
import { loadRiskState, saveRiskStateRow, type PersistedRiskState } from "../risk/persistence.js";

const log = moduleLogger("app.carry");

export const CARRY_ENDED_BY = "auto-learn";

export interface RiskCarry {
  fromRunId: number;
  ledgerLamports: string;
  peakEquityLamports: string;
  dayKey: string;
  dayStartEquityLamports: string;
  fileBankrollSol: number;
  atMs: number;
}

export function carryOf(runId: number, status: RiskStatus, fileBankrollSol: number, atMs: number): RiskCarry {
  return {
    fromRunId: runId,
    ledgerLamports: (status.equityLamports - status.unrealizedPnlLamports).toString(),
    peakEquityLamports: status.peakEquityLamports.toString(),
    dayKey: status.dayKey,
    dayStartEquityLamports: status.dayStartEquityLamports.toString(),
    fileBankrollSol,
    atMs
  };
}

function lamportsOf(value: unknown): bigint | null {
  return typeof value === "string" && /^-?\d+$/.test(value) ? toBigInt(value) : null;
}

export function parseCarry(summary: unknown): RiskCarry | null {
  if (!isPlainObject(summary) || summary.endedBy !== CARRY_ENDED_BY || !isPlainObject(summary.carry)) {
    return null;
  }
  const carry = summary.carry;
  const ledger = lamportsOf(carry.ledgerLamports);
  const peak = lamportsOf(carry.peakEquityLamports);
  const dayStart = lamportsOf(carry.dayStartEquityLamports);
  if (ledger === null || peak === null || dayStart === null || ledger <= 0n || typeof carry.dayKey !== "string" || typeof carry.fileBankrollSol !== "number") {
    return null;
  }
  return {
    fromRunId: typeof carry.fromRunId === "number" ? carry.fromRunId : 0,
    ledgerLamports: carry.ledgerLamports as string,
    peakEquityLamports: carry.peakEquityLamports as string,
    dayKey: carry.dayKey,
    dayStartEquityLamports: carry.dayStartEquityLamports as string,
    fileBankrollSol: carry.fileBankrollSol,
    atMs: typeof carry.atMs === "number" ? carry.atMs : 0
  };
}

export function carriedState(runId: number, carry: RiskCarry): PersistedRiskState {
  return {
    runId,
    startingBankrollLamports: toBigInt(carry.ledgerLamports),
    realizedPnlLamports: 0n,
    peakEquityLamports: toBigInt(carry.peakEquityLamports),
    dayKey: carry.dayKey,
    dayStartEquityLamports: toBigInt(carry.dayStartEquityLamports),
    haltedUntilMs: null,
    killed: false,
    killReason: null,
    state: { mode: "paper", carriedFromRunId: carry.fromRunId, carriedAtMs: carry.atMs }
  };
}

export async function seedCarriedRisk(db: Db, runId: number, risk: Pick<RiskConfig, "startingBankrollSol">): Promise<PersistedRiskState | null> {
  if (await loadRiskState(db, runId)) {
    return null;
  }
  const previous = await db.query<{ id: unknown; summary: unknown }>(
    `SELECT id, summary FROM strategy_runs WHERE mode = 'paper' AND id < $1 ORDER BY id DESC LIMIT 1`,
    [runId]
  );
  const row = previous.rows[0];
  const carry = row ? parseCarry(row.summary) : null;
  if (!row || !carry) {
    return null;
  }
  if (carry.fileBankrollSol !== risk.startingBankrollSol) {
    log.warn(
      { previousRunId: toNumber(row.id), carriedFor: carry.fileBankrollSol, file: risk.startingBankrollSol },
      "risk.startingBankrollSol changed since auto-learn ended the last paper run, so the new run starts from the file bankroll"
    );
    return null;
  }
  const state = carriedState(runId, carry);
  await saveRiskStateRow(db, state);
  log.info(
    { runId, fromRunId: toNumber(row.id), bankrollLamports: carry.ledgerLamports, peakEquityLamports: carry.peakEquityLamports, dayKey: carry.dayKey },
    "paper run continues the bankroll, peak and day of the run auto-learn ended"
  );
  return state;
}
