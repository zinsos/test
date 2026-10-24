import type { RiskConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock } from "../core/clock.js";
import type { RiskDecision, RiskEntryInput, RiskGate, RiskStatus } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { ClosedTrade, Position, Pubkey, TradingMode } from "../core/types.js";
import { dayKeyFor, nextDayResetMs } from "./day.js";
import { maxLamports, minLamports, scaleLamports, solToLamports } from "./money.js";
import type { PersistedRiskState, RiskPersistence, RiskStateExtra } from "./persistence.js";

const log = moduleLogger("risk.manager");

export type RiskRejection =
  | "killed"
  | "halted_daily_loss"
  | "max_concurrent"
  | "already_holding_mint"
  | "dev_daily_limit"
  | "size_below_min"
  | "insufficient_balance";

export type RiskEventKind =
  | "day_roll"
  | "daily_loss_halt"
  | "kill_switch"
  | "kill_reset"
  | "entry_reserved"
  | "entry_released"
  | "position_closed"
  | "restored";

export interface RiskManagerOptions {
  runId: number;
  config: RiskConfig;
  clock: Clock;
  mode?: TradingMode;
  store?: RiskPersistence;
  persisted?: PersistedRiskState | null;
  bus?: Pick<Bus, "emit">;
  reservationTtlMs?: number;
  persistIntervalMs?: number;
}

export interface SizingResult {
  sizeLamports: bigint;
  bankrollLamports: bigint;
  rejection: RiskRejection | null;
}

interface Reservation {
  mint: Pubkey;
  devWallet: Pubkey;
  atMs: number;
}

const DEFAULT_RESERVATION_TTL_MS = 120_000;
const DEFAULT_PERSIST_INTERVAL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bigintFrom(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

function devEntriesFrom(value: unknown): Map<Pubkey, number> {
  const entries = new Map<Pubkey, number>();
  if (!isRecord(value)) {
    return entries;
  }
  for (const [dev, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      entries.set(dev, Math.floor(count));
    }
  }
  return entries;
}

export class RiskManager implements RiskGate {
  readonly runId: number;
  private readonly config: RiskConfig;
  private readonly clock: Clock;
  private readonly mode: TradingMode;
  private readonly store: RiskPersistence | null;
  private readonly bus: Pick<Bus, "emit"> | null;
  private readonly reservationTtlMs: number;
  private readonly persistIntervalMs: number;
  private readonly startingBankroll: bigint;
  private realized: bigint;
  private unrealized: bigint;
  private unrealizedStale = false;
  private peakEquity: bigint;
  private dayKey: string;
  private dayStartEquity: bigint;
  private haltedForDay: boolean;
  private killed: boolean;
  private killReason: string | null;
  private killedAtMs: number | null;
  private forceFlatten = false;
  private availableBalance: bigint | null = null;
  private devEntries: Map<Pubkey, number>;
  private readonly reservations = new Map<Pubkey, Reservation>();
  private readonly openPositionIds = new Set<string>();
  private lastPersistMs = Number.NEGATIVE_INFINITY;

  constructor(options: RiskManagerOptions) {
    this.runId = options.runId;
    this.config = options.config;
    this.clock = options.clock;
    this.mode = options.mode ?? "paper";
    this.store = options.store ?? null;
    this.bus = options.bus ?? null;
    this.reservationTtlMs = options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this.persistIntervalMs = options.persistIntervalMs ?? DEFAULT_PERSIST_INTERVAL_MS;
    const nowMs = this.clock.nowMs();
    const persisted = options.persisted ?? null;
    const state = persisted?.state ?? {};
    this.startingBankroll = persisted ? persisted.startingBankrollLamports : solToLamports(options.config.startingBankrollSol);
    this.realized = persisted?.realizedPnlLamports ?? 0n;
    this.unrealized = bigintFrom(state.unrealizedPnlLamports) ?? 0n;
    this.killed = persisted?.killed ?? false;
    this.killReason = persisted?.killReason ?? null;
    this.killedAtMs = typeof state.killedAtMs === "number" ? state.killedAtMs : null;
    this.dayKey = dayKeyFor(nowMs, options.config.dayResetUtcHour);
    const sameDay = persisted?.dayKey === this.dayKey ? persisted : null;
    this.dayStartEquity = sameDay?.dayStartEquityLamports ?? this.equity();
    this.haltedForDay = sameDay?.haltedUntilMs !== null && sameDay?.haltedUntilMs !== undefined && nowMs < sameDay.haltedUntilMs;
    this.devEntries = sameDay ? devEntriesFrom(state.devEntries) : new Map();
    this.peakEquity = maxLamports(persisted?.peakEquityLamports ?? 0n, this.equity());
    if (persisted) {
      this.emitEvent(nowMs, "restored", { sameDay: sameDay !== null, killed: this.killed, haltedForDay: this.haltedForDay });
    }
  }

  setAvailableBalance(lamports: bigint): void {
    this.availableBalance = lamports > 0n ? lamports : 0n;
  }

  availableBalanceLamports(): bigint | null {
    return this.availableBalance;
  }

  equity(): bigint {
    return this.startingBankroll + this.realized + this.unrealized;
  }

  sizing(): SizingResult {
    const ledger = this.startingBankroll + this.realized;
    const minSize = solToLamports(this.config.minPositionSol);
    const maxSize = solToLamports(this.config.maxPositionSol);
    let bankroll = ledger;
    let walletBinding = false;
    if (this.mode === "live") {
      if (this.availableBalance === null) {
        return { sizeLamports: 0n, bankrollLamports: 0n, rejection: "insufficient_balance" };
      }
      const spendable = this.availableBalance - solToLamports(this.config.minFeeReserveSol);
      walletBinding = spendable < ledger;
      bankroll = minLamports(ledger, spendable);
    }
    const raw = scaleLamports(bankroll, this.config.fractionPerTrade);
    const size = minLamports(raw, maxSize);
    if (bankroll <= 0n || size <= 0n || size < minSize) {
      return {
        sizeLamports: 0n,
        bankrollLamports: bankroll > 0n ? bankroll : 0n,
        rejection: walletBinding ? "insufficient_balance" : "size_below_min"
      };
    }
    return { sizeLamports: size, bankrollLamports: bankroll, rejection: null };
  }

  evaluateEntry(input: RiskEntryInput): RiskDecision {
    const nowMs = input.nowMs;
    this.rollDayIfNeeded(nowMs);
    this.expireReservations(nowMs);
    const rejection = this.entryRejection(input);
    if (rejection) {
      return { allowed: false, reason: rejection.reason, sizeLamports: 0n };
    }
    const sizing = this.sizing();
    if (sizing.rejection) {
      return { allowed: false, reason: sizing.rejection, sizeLamports: 0n };
    }
    this.reserve(input, nowMs, sizing.sizeLamports);
    return { allowed: true, reason: null, sizeLamports: sizing.sizeLamports };
  }

  releaseEntry(mint: Pubkey, nowMs: number = this.clock.nowMs()): void {
    const reservation = this.reservations.get(mint);
    if (!reservation) {
      return;
    }
    this.reservations.delete(mint);
    const count = (this.devEntries.get(reservation.devWallet) ?? 0) - 1;
    if (count > 0) {
      this.devEntries.set(reservation.devWallet, count);
    } else {
      this.devEntries.delete(reservation.devWallet);
    }
    this.emitEvent(nowMs, "entry_released", { mint, devWallet: reservation.devWallet });
    this.persist(nowMs);
  }

  onPositionOpened(position: Position): void {
    this.openPositionIds.add(position.id);
    this.reservations.delete(position.mint);
  }

  onPositionClosed(trade: ClosedTrade): void {
    const nowMs = trade.closedAtMs;
    this.rollDayIfNeeded(nowMs);
    this.openPositionIds.delete(trade.positionId);
    this.reservations.delete(trade.mint);
    this.realized += trade.pnl;
    this.emitEvent(nowMs, "position_closed", {
      positionId: trade.positionId,
      mint: trade.mint,
      pnlLamports: trade.pnl.toString(),
      realizedPnlLamports: this.realized.toString()
    });
    if (this.openPositionIds.size === 0) {
      this.unrealized = 0n;
      this.unrealizedStale = false;
      this.checkLimits(nowMs);
    } else {
      this.unrealizedStale = true;
    }
    this.persist(nowMs);
  }

  markToMarket(unrealizedPnlLamports: bigint, nowMs: number): void {
    const rolled = this.rollDayIfNeeded(nowMs);
    this.unrealized = unrealizedPnlLamports;
    this.unrealizedStale = false;
    const changed = this.checkLimits(nowMs);
    if (rolled || changed || nowMs - this.lastPersistMs >= this.persistIntervalMs) {
      this.persist(nowMs);
    }
  }

  shouldFlattenAll(): boolean {
    return this.killed && (this.config.flattenOnKill || this.forceFlatten);
  }

  killNow(reason: string, nowMs: number = this.clock.nowMs()): boolean {
    this.forceFlatten = true;
    if (this.killed) {
      return false;
    }
    this.killed = true;
    this.killedAtMs = nowMs;
    this.killReason = reason;
    this.emitEvent(nowMs, "kill_switch", { manual: true, reason, equityLamports: this.equity().toString(), flatten: true });
    this.persist(nowMs);
    return true;
  }

  isKilled(): boolean {
    return this.killed;
  }

  isHaltedForDay(): boolean {
    return this.haltedForDay;
  }

  resetKill(reason = "manual", nowMs: number = this.clock.nowMs()): void {
    if (!this.killed) {
      return;
    }
    const previous = this.killReason;
    this.killed = false;
    this.forceFlatten = false;
    this.killReason = null;
    this.killedAtMs = null;
    this.peakEquity = this.equity();
    this.emitEvent(nowMs, "kill_reset", { reason, previousReason: previous, equityLamports: this.equity().toString() });
    this.persist(nowMs);
  }

  status(): RiskStatus {
    const equity = this.equity();
    return {
      runId: this.runId,
      bankrollLamports: this.sizingBankroll(),
      equityLamports: equity,
      peakEquityLamports: this.peakEquity,
      realizedPnlLamports: this.realized,
      unrealizedPnlLamports: this.unrealized,
      dayKey: this.dayKey,
      dayStartEquityLamports: this.dayStartEquity,
      dayPnlLamports: equity - this.dayStartEquity,
      haltedForDay: this.haltedForDay,
      killed: this.killed,
      killReason: this.killReason
    };
  }

  persistenceExtra(nowMs: number = this.clock.nowMs()): RiskStateExtra {
    return {
      startingBankrollLamports: this.startingBankroll.toString(),
      haltedUntilMs: this.haltedForDay ? nextDayResetMs(nowMs, this.config.dayResetUtcHour) : null,
      state: {
        mode: this.mode,
        unrealizedPnlLamports: this.unrealized.toString(),
        unrealizedStale: this.unrealizedStale,
        killedAtMs: this.killedAtMs,
        availableBalanceLamports: this.availableBalance === null ? null : this.availableBalance.toString(),
        devEntries: Object.fromEntries(this.devEntries),
        openPositions: this.openPositionIds.size,
        reservations: [...this.reservations.keys()]
      }
    };
  }

  persist(nowMs: number = this.clock.nowMs()): void {
    this.lastPersistMs = nowMs;
    if (!this.store) {
      return;
    }
    try {
      this.store.saveRiskState(this.status(), { ...this.persistenceExtra(nowMs) });
    } catch (error) {
      log.error({ err: error, runId: this.runId }, "risk state save failed");
    }
  }

  private sizingBankroll(): bigint {
    const ledger = this.startingBankroll + this.realized;
    if (this.mode !== "live" || this.availableBalance === null) {
      return ledger;
    }
    const capped = minLamports(ledger, this.availableBalance - solToLamports(this.config.minFeeReserveSol));
    return capped > 0n ? capped : 0n;
  }

  private entryRejection(input: RiskEntryInput): { reason: RiskRejection } | null {
    if (this.killed) {
      return { reason: "killed" };
    }
    if (this.haltedForDay) {
      return { reason: "halted_daily_loss" };
    }
    const held = new Set<Pubkey>();
    for (const position of input.openPositions) {
      if (position.status === "open") {
        held.add(position.mint);
      }
    }
    for (const mint of this.reservations.keys()) {
      held.add(mint);
    }
    for (const mint of input.pendingMints ?? []) {
      held.add(mint);
    }
    if (held.size >= this.config.maxConcurrent) {
      return { reason: "max_concurrent" };
    }
    if (held.has(input.mint)) {
      return { reason: "already_holding_mint" };
    }
    if ((this.devEntries.get(input.devWallet) ?? 0) >= this.config.maxEntriesPerDevPerDay) {
      return { reason: "dev_daily_limit" };
    }
    return null;
  }

  private reserve(input: RiskEntryInput, nowMs: number, sizeLamports: bigint): void {
    this.reservations.set(input.mint, { mint: input.mint, devWallet: input.devWallet, atMs: nowMs });
    this.devEntries.set(input.devWallet, (this.devEntries.get(input.devWallet) ?? 0) + 1);
    this.emitEvent(nowMs, "entry_reserved", {
      mint: input.mint,
      devWallet: input.devWallet,
      sizeLamports: sizeLamports.toString(),
      signalType: input.signal.type
    });
    this.persist(nowMs);
  }

  private expireReservations(nowMs: number): void {
    for (const [mint, reservation] of this.reservations) {
      if (nowMs - reservation.atMs >= this.reservationTtlMs) {
        this.reservations.delete(mint);
      }
    }
  }

  private rollDayIfNeeded(nowMs: number): boolean {
    const key = dayKeyFor(nowMs, this.config.dayResetUtcHour);
    if (key <= this.dayKey) {
      return false;
    }
    const previous = { dayKey: this.dayKey, dayPnlLamports: (this.equity() - this.dayStartEquity).toString(), halted: this.haltedForDay };
    this.dayKey = key;
    this.dayStartEquity = this.equity();
    this.haltedForDay = false;
    this.devEntries = new Map();
    this.emitEvent(nowMs, "day_roll", { ...previous, newDayKey: key, dayStartEquityLamports: this.dayStartEquity.toString() });
    this.persist(nowMs);
    return true;
  }

  private checkLimits(nowMs: number): boolean {
    const equity = this.equity();
    let changed = false;
    if (equity > this.peakEquity) {
      this.peakEquity = equity;
      changed = true;
    }
    if (!this.haltedForDay && this.dailyLossBreached(equity)) {
      this.haltedForDay = true;
      changed = true;
      this.emitEvent(nowMs, "daily_loss_halt", {
        dayKey: this.dayKey,
        dayStartEquityLamports: this.dayStartEquity.toString(),
        equityLamports: equity.toString(),
        limitFraction: this.config.dailyLossLimitFraction,
        resumesAtMs: nextDayResetMs(nowMs, this.config.dayResetUtcHour)
      });
    }
    if (!this.killed && this.drawdownBreached(equity)) {
      this.killed = true;
      this.killedAtMs = nowMs;
      this.killReason = `drawdown ${this.drawdownFraction(equity).toFixed(4)} >= ${this.config.killSwitchDrawdownFraction}`;
      changed = true;
      this.emitEvent(nowMs, "kill_switch", {
        peakEquityLamports: this.peakEquity.toString(),
        equityLamports: equity.toString(),
        thresholdFraction: this.config.killSwitchDrawdownFraction,
        flatten: this.config.flattenOnKill
      });
    }
    return changed;
  }

  private dailyLossBreached(equity: bigint): boolean {
    if (this.dayStartEquity <= 0n) {
      return false;
    }
    const loss = this.dayStartEquity - equity;
    return loss > 0n && loss >= scaleLamports(this.dayStartEquity, this.config.dailyLossLimitFraction);
  }

  private drawdownBreached(equity: bigint): boolean {
    if (this.peakEquity <= 0n) {
      return false;
    }
    const drawdown = this.peakEquity - equity;
    return drawdown > 0n && drawdown >= scaleLamports(this.peakEquity, this.config.killSwitchDrawdownFraction);
  }

  private drawdownFraction(equity: bigint): number {
    return this.peakEquity > 0n ? Number(this.peakEquity - equity) / Number(this.peakEquity) : 0;
  }

  private emitEvent(atMs: number, kind: RiskEventKind, detail: Record<string, unknown>): void {
    try {
      this.store?.recordRiskEvent(this.runId, atMs, kind, detail);
    } catch (error) {
      log.error({ err: error, runId: this.runId, kind }, "risk event record failed");
    }
    this.bus?.emit("risk", { runId: this.runId, atMs, kind, detail });
    if (kind === "kill_switch" || kind === "daily_loss_halt" || kind === "kill_reset") {
      log.warn({ runId: this.runId, kind, ...detail }, "risk state changed");
    }
  }
}
