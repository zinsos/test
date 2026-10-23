import { describe, expect, it, vi } from "vitest";
import { VirtualClock } from "../src/core/clock.js";
import { dayKeyFor, nextDayResetMs, tradingDayStartMs } from "../src/risk/day.js";
import { RiskManager, type RiskManagerOptions } from "../src/risk/manager.js";
import { scaleLamports, solToLamports } from "../src/risk/money.js";
import { riskStateRow } from "../src/risk/persistence.js";
import { NOON_UTC, SOL, closedTrade, entry, openPosition, recordingStore, riskConfig } from "./risk.fixtures.js";

const HOUR = 3_600_000;
const DEV_A = "DevA111111111111111111111111111111111111111";
const DEV_B = "DevB111111111111111111111111111111111111111";

function manager(options: Partial<RiskManagerOptions> = {}, startMs = NOON_UTC) {
  const clock = new VirtualClock(startMs);
  const store = recordingStore();
  const risk = new RiskManager({ runId: 1, config: riskConfig(), clock, store, ...options });
  return { clock, store, risk };
}

describe("risk day helpers", () => {
  it("rolls the day key at the configured UTC hour", () => {
    const fiveAm = Date.UTC(2026, 9, 23, 5, 59, 59, 999);
    const sixAm = Date.UTC(2026, 9, 23, 6, 0, 0);
    expect(dayKeyFor(fiveAm, 0)).toBe("2026-10-23");
    expect(dayKeyFor(fiveAm, 6)).toBe("2026-10-22");
    expect(dayKeyFor(sixAm, 6)).toBe("2026-10-23");
    expect(tradingDayStartMs(fiveAm, 6)).toBe(Date.UTC(2026, 9, 22, 6));
    expect(nextDayResetMs(fiveAm, 6)).toBe(sixAm);
    expect(nextDayResetMs(sixAm, 6)).toBe(Date.UTC(2026, 9, 24, 6));
    expect(dayKeyFor(Date.UTC(2026, 11, 31, 23), 23)).toBe("2026-12-31");
    expect(dayKeyFor(Date.UTC(2027, 0, 1, 22), 23)).toBe("2026-12-31");
  });

  it("converts and scales lamports", () => {
    expect(solToLamports(0.075)).toBe(75_000_000n);
    expect(solToLamports(-1)).toBe(0n);
    expect(solToLamports(Number.NaN)).toBe(0n);
    expect(scaleLamports(5n * SOL, 0.015)).toBe(75_000_000n);
    expect(scaleLamports(-5n, 0.5)).toBe(0n);
  });
});

describe("risk manager sizing", () => {
  it("sizes at the fixed fraction of the bankroll", () => {
    const { risk } = manager();
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC))).toEqual({ allowed: true, reason: null, sizeLamports: 75_000_000n });
  });

  it("clamps to the maximum position", () => {
    const { risk } = manager({ config: riskConfig({ startingBankrollSol: 100 }) });
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC)).sizeLamports).toBe(500_000_000n);
  });

  it("rejects instead of sizing up past the fraction when below the minimum", () => {
    const { risk } = manager({ config: riskConfig({ startingBankrollSol: 1 }) });
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC))).toEqual({ allowed: false, reason: "size_below_min", sizeLamports: 0n });
  });

  it("compounds realized profit into the bankroll", () => {
    const { risk } = manager();
    risk.onPositionClosed(closedTrade("p1", "MintZ", SOL, NOON_UTC));
    expect(risk.sizing().sizeLamports).toBe(90_000_000n);
    expect(risk.status().bankrollLamports).toBe(6n * SOL);
  });

  it("caps the live bankroll by the wallet balance minus the fee reserve", () => {
    const { risk } = manager({ mode: "live" });
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC)).reason).toBe("insufficient_balance");
    risk.setAvailableBalance(2n * SOL);
    expect(risk.sizing()).toEqual({ sizeLamports: 29_250_000n, bankrollLamports: 1_950_000_000n, rejection: null });
    expect(risk.status().bankrollLamports).toBe(1_950_000_000n);
    risk.setAvailableBalance(100n * SOL);
    expect(risk.sizing().sizeLamports).toBe(75_000_000n);
    risk.setAvailableBalance(SOL);
    expect(risk.sizing().rejection).toBe("insufficient_balance");
    risk.setAvailableBalance(10_000_000n);
    expect(risk.sizing().rejection).toBe("insufficient_balance");
    expect(risk.status().bankrollLamports).toBe(0n);
  });

  it("ignores the wallet balance in paper mode", () => {
    const { risk } = manager();
    risk.setAvailableBalance(0n);
    expect(risk.sizing().sizeLamports).toBe(75_000_000n);
  });
});

describe("risk manager entry rejections", () => {
  it("rejects when the maximum number of positions is open", () => {
    const { risk } = manager();
    const open = ["A", "B", "C", "D", "E"].map((mint, index) => openPosition(`p${index}`, mint));
    expect(risk.evaluateEntry(entry("MintF", DEV_A, NOON_UTC, open)).reason).toBe("max_concurrent");
    const closed = open.map((position) => ({ ...position, status: "closed" as const }));
    expect(risk.evaluateEntry(entry("MintF", DEV_A, NOON_UTC, closed)).allowed).toBe(true);
  });

  it("rejects a mint that is already held", () => {
    const { risk } = manager();
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC, [openPosition("p1", "MintA")])).reason).toBe("already_holding_mint");
  });

  it("counts reserved entries until they open, are released or expire", () => {
    const { risk } = manager({ config: riskConfig({ maxConcurrent: 1 }) });
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC)).allowed).toBe(true);
    expect(risk.evaluateEntry(entry("MintA", DEV_B, NOON_UTC)).reason).toBe("max_concurrent");
    expect(risk.evaluateEntry(entry("MintB", DEV_B, NOON_UTC)).reason).toBe("max_concurrent");
    risk.releaseEntry("MintA", NOON_UTC);
    expect(risk.evaluateEntry(entry("MintB", DEV_B, NOON_UTC)).allowed).toBe(true);
    expect(risk.evaluateEntry(entry("MintC", "DevC", NOON_UTC + 119_000)).reason).toBe("max_concurrent");
    expect(risk.evaluateEntry(entry("MintC", "DevC", NOON_UTC + 120_000)).allowed).toBe(true);
  });

  it("hands a reservation over to the opened position", () => {
    const { risk } = manager({ config: riskConfig({ maxConcurrent: 2 }) });
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC)).allowed).toBe(true);
    const position = openPosition("p1", "MintA");
    risk.onPositionOpened(position);
    expect(risk.evaluateEntry(entry("MintB", DEV_B, NOON_UTC, [position])).allowed).toBe(true);
    expect(risk.evaluateEntry(entry("MintC", "DevC", NOON_UTC, [position])).reason).toBe("max_concurrent");
  });

  it("limits entries per dev per day and returns the slot on release", () => {
    const { risk } = manager();
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC)).allowed).toBe(true);
    expect(risk.evaluateEntry(entry("MintB", DEV_A, NOON_UTC)).reason).toBe("dev_daily_limit");
    risk.releaseEntry("MintA", NOON_UTC);
    expect(risk.evaluateEntry(entry("MintB", DEV_A, NOON_UTC)).allowed).toBe(true);
  });

  it("keeps the dev count when a reservation expires without an outcome", () => {
    const { risk } = manager();
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC)).allowed).toBe(true);
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC + 200_000)).reason).toBe("dev_daily_limit");
  });

  it("resets dev limits when the day rolls at the configured hour", () => {
    const fiveAm = Date.UTC(2026, 9, 23, 5, 0, 0);
    const { risk, store } = manager({ config: riskConfig({ dayResetUtcHour: 6 }) }, fiveAm);
    expect(risk.status().dayKey).toBe("2026-10-22");
    expect(risk.evaluateEntry(entry("MintA", DEV_A, fiveAm)).allowed).toBe(true);
    expect(risk.evaluateEntry(entry("MintB", DEV_A, fiveAm + HOUR - 1)).reason).toBe("dev_daily_limit");
    expect(risk.evaluateEntry(entry("MintB", DEV_A, fiveAm + HOUR)).allowed).toBe(true);
    expect(risk.status().dayKey).toBe("2026-10-23");
    expect(store.kinds()).toContain("day_roll");
  });

  it("never rolls the day backwards", () => {
    const { risk } = manager();
    risk.markToMarket(0n, NOON_UTC + 24 * HOUR);
    risk.markToMarket(0n, NOON_UTC);
    expect(risk.status().dayKey).toBe("2026-10-24");
  });
});

describe("risk manager daily loss limit", () => {
  it("halts for the day at the loss limit and resumes the next day", () => {
    const { risk, store } = manager();
    risk.markToMarket(-399_999_999n, NOON_UTC);
    expect(risk.status().haltedForDay).toBe(false);
    risk.markToMarket(-400_000_000n, NOON_UTC + 1000);
    expect(risk.status().haltedForDay).toBe(true);
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC + 2000)).reason).toBe("halted_daily_loss");
    risk.markToMarket(0n, NOON_UTC + 3000);
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC + 4000)).reason).toBe("halted_daily_loss");
    expect(store.kinds().filter((kind) => kind === "daily_loss_halt")).toHaveLength(1);
    const haltSave = store.saves.find((save) => save.status.haltedForDay);
    expect(haltSave?.extra.haltedUntilMs).toBe(Date.UTC(2026, 9, 24, 0));
    risk.markToMarket(-200_000_000n, NOON_UTC + 3000);
    const nextDay = Date.UTC(2026, 9, 24, 0, 0, 1);
    expect(risk.evaluateEntry(entry("MintA", DEV_A, nextDay)).allowed).toBe(true);
    const status = risk.status();
    expect(status.haltedForDay).toBe(false);
    expect(status.dayStartEquityLamports).toBe(4_800_000_000n);
    expect(status.dayPnlLamports).toBe(0n);
  });

  it("halts on realized losses once nothing is open", () => {
    const { risk } = manager();
    risk.onPositionClosed(closedTrade("p1", "MintA", -400_000_000n, NOON_UTC));
    expect(risk.status().haltedForDay).toBe(true);
  });

  it("waits for a fresh mark before judging limits while other positions are open", () => {
    const { risk } = manager();
    risk.onPositionOpened(openPosition("p1", "MintA"));
    risk.onPositionOpened(openPosition("p2", "MintB"));
    risk.markToMarket(-300_000_000n, NOON_UTC);
    risk.onPositionClosed(closedTrade("p1", "MintA", -300_000_000n, NOON_UTC + 1000));
    expect(risk.status().haltedForDay).toBe(false);
    risk.markToMarket(0n, NOON_UTC + 2000);
    expect(risk.status().haltedForDay).toBe(false);
    expect(risk.status().equityLamports).toBe(4_700_000_000n);
    risk.onPositionClosed(closedTrade("p2", "MintB", -200_000_000n, NOON_UTC + 3000));
    expect(risk.status().unrealizedPnlLamports).toBe(0n);
    expect(risk.status().haltedForDay).toBe(true);
  });
});

describe("risk manager kill switch", () => {
  it("kills on drawdown from peak equity and asks to flatten", () => {
    const { risk, store } = manager();
    risk.markToMarket(SOL, NOON_UTC);
    expect(risk.status().peakEquityLamports).toBe(6n * SOL);
    risk.markToMarket(-499_999_999n, NOON_UTC + 1000);
    expect(risk.shouldFlattenAll()).toBe(false);
    risk.markToMarket(-500_000_000n, NOON_UTC + 2000);
    expect(risk.status().killed).toBe(true);
    expect(risk.status().killReason).toMatch(/^drawdown 0\.2500/);
    expect(risk.shouldFlattenAll()).toBe(true);
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC + 3000)).reason).toBe("killed");
    expect(store.kinds()).toContain("kill_switch");
  });

  it("stays killed across days until reset", () => {
    const { risk, store } = manager();
    risk.onPositionClosed(closedTrade("p1", "MintA", -1_250_000_000n, NOON_UTC));
    expect(risk.status().killed).toBe(true);
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC + 48 * HOUR)).reason).toBe("killed");
    risk.resetKill("operator", NOON_UTC + 48 * HOUR);
    expect(risk.status().killed).toBe(false);
    expect(risk.status().peakEquityLamports).toBe(3_750_000_000n);
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC + 48 * HOUR)).allowed).toBe(true);
    expect(store.kinds()).toContain("kill_reset");
  });

  it("does not flatten when flattening is disabled", () => {
    const { risk } = manager({ config: riskConfig({ flattenOnKill: false }) });
    risk.markToMarket(-2n * SOL, NOON_UTC);
    expect(risk.status().killed).toBe(true);
    expect(risk.shouldFlattenAll()).toBe(false);
  });
});

describe("risk manager persistence", () => {
  it("saves on state changes and records events with the run id", () => {
    const bus = { emit: vi.fn() };
    const { risk, store } = manager({ bus });
    risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC));
    expect(store.lastSave().extra.state).toMatchObject({ devEntries: { [DEV_A]: 1 } });
    risk.markToMarket(-2n * SOL, NOON_UTC + 1000);
    expect(store.lastSave().status.killed).toBe(true);
    expect(store.events.every((event) => event.runId === 1)).toBe(true);
    expect(bus.emit).toHaveBeenCalledWith("risk", expect.objectContaining({ runId: 1, kind: "kill_switch" }));
  });

  it("throttles plain marks but saves limit changes immediately", () => {
    const { risk, store } = manager({ persistIntervalMs: 30_000 });
    risk.markToMarket(-1n, NOON_UTC);
    const afterFirst = store.saves.length;
    risk.markToMarket(-2n, NOON_UTC + 1000);
    expect(store.saves.length).toBe(afterFirst);
    risk.markToMarket(-3n, NOON_UTC + 31_000);
    expect(store.saves.length).toBe(afterFirst + 1);
    risk.markToMarket(-500_000_000n, NOON_UTC + 32_000);
    expect(store.saves.length).toBe(afterFirst + 2);
  });

  it("restores the same day with halt, kill and dev limits intact", () => {
    const first = manager();
    first.risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC));
    first.risk.onPositionClosed(closedTrade("p1", "MintA", -500_000_000n, NOON_UTC + 1000));
    first.risk.markToMarket(0n, NOON_UTC + 2000);
    const saved = first.store.lastSave();
    const persisted = riskStateRow(saved.status, saved.extra);
    expect(persisted.startingBankrollLamports).toBe(5n * SOL);
    const restored = manager({ persisted }, NOON_UTC + 5000);
    const status = restored.risk.status();
    expect(status).toEqual({ ...first.risk.status() });
    expect(restored.risk.evaluateEntry(entry("MintB", DEV_B, NOON_UTC + 6000)).reason).toBe("halted_daily_loss");
    expect(restored.store.kinds()).toContain("restored");
  });

  it("restores dev limits on the same day", () => {
    const first = manager();
    first.risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC));
    const saved = first.store.lastSave();
    const restored = manager({ persisted: riskStateRow(saved.status, saved.extra) }, NOON_UTC + 1000);
    expect(restored.risk.evaluateEntry(entry("MintB", DEV_A, NOON_UTC + 1000)).reason).toBe("dev_daily_limit");
  });

  it("starts a fresh day on restore after the reset but keeps the kill", () => {
    const first = manager();
    first.risk.onPositionClosed(closedTrade("p1", "MintA", -1_300_000_000n, NOON_UTC));
    const saved = first.store.lastSave();
    const persisted = riskStateRow(saved.status, saved.extra);
    const restored = manager({ persisted }, NOON_UTC + 24 * HOUR);
    const status = restored.risk.status();
    expect(status.dayKey).toBe("2026-10-24");
    expect(status.haltedForDay).toBe(false);
    expect(status.killed).toBe(true);
    expect(status.realizedPnlLamports).toBe(-1_300_000_000n);
    expect(status.dayStartEquityLamports).toBe(3_700_000_000n);
    expect(status.peakEquityLamports).toBe(5n * SOL);
  });

  it("uses the persisted starting bankroll over the config", () => {
    const first = manager();
    const saved = first.risk.status();
    const persisted = riskStateRow(saved, first.risk.persistenceExtra(NOON_UTC));
    const restored = manager({ persisted, config: riskConfig({ startingBankrollSol: 50 }) });
    expect(restored.risk.equity()).toBe(5n * SOL);
  });

  it("keeps working when the store throws", () => {
    const failing = {
      saveRiskState: () => {
        throw new Error("down");
      },
      recordRiskEvent: () => {
        throw new Error("down");
      }
    };
    const { risk } = manager({ store: failing });
    expect(risk.evaluateEntry(entry("MintA", DEV_A, NOON_UTC)).allowed).toBe(true);
    risk.markToMarket(-2n * SOL, NOON_UTC);
    expect(risk.status().killed).toBe(true);
  });
});
