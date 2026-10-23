import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/core/clock.js";
import { RiskManager } from "../../src/risk/manager.js";
import { NOON_UTC, riskConfig } from "../risk.fixtures.js";

describe("review money: a zero risk limit fraction trips on zero loss", () => {
  it("does not kill the run when equity is exactly at its peak", () => {
    const clock = new VirtualClock(NOON_UTC);
    const risk = new RiskManager({ runId: 1, config: riskConfig({ killSwitchDrawdownFraction: 0 }), clock });
    risk.markToMarket(0n, NOON_UTC);
    expect(risk.status().equityLamports).toBe(risk.status().peakEquityLamports);
    expect(risk.isKilled()).toBe(false);
  });

  it("does not halt the day when the day is flat", () => {
    const clock = new VirtualClock(NOON_UTC);
    const risk = new RiskManager({ runId: 1, config: riskConfig({ dailyLossLimitFraction: 0 }), clock });
    risk.markToMarket(0n, NOON_UTC);
    expect(risk.status().dayPnlLamports).toBe(0n);
    expect(risk.isHaltedForDay()).toBe(false);
  });
});
