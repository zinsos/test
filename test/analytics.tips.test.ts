import { describe, expect, it } from "vitest";
import { buildTips, sizingTable, tipSettingsOf, type TipSettings } from "../src/analytics/tips.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import type { ClosedTrade } from "../src/core/types.js";

const SOL = 1_000_000_000n;
const T0 = Date.UTC(2026, 9, 24, 20, 0, 0);
const settings: TipSettings = { ...tipSettingsOf(defaultStrategyConfig()), startingBankrollSol: 0.5, fractionPerTrade: 0.1, maxConcurrent: 2, dailyLossLimitFraction: 0.15 };

function trade(index: number, pnlSol: number, exitReason: string, riskScore = 20): ClosedTrade {
  const cost = SOL / 20n;
  const pnl = BigInt(Math.round(pnlSol * 1e9));
  return {
    positionId: `p${index}`,
    runId: 22,
    mode: "paper",
    mint: `Mint${index}`,
    signalType: "score_momentum",
    riskScore,
    openedAtMs: T0 + index * 600_000,
    closedAtMs: T0 + index * 600_000 + 300_000,
    holdSec: 300,
    cost,
    proceeds: cost + pnl,
    pnl,
    fees: 1_500_000n,
    exitReason,
    peakMultiple: 1.2
  };
}

describe("tips from paper stats", () => {
  it("only reports the sample size before any trade closes", () => {
    const report = buildTips([], settings);
    expect(report.stage).toBe("waiting");
    expect(report.tips.map((tip) => tip.id)).toEqual(["sample"]);
    expect(report.sizing).toEqual([]);
  });

  it("warns that bigger bets would lose more when the results are negative", () => {
    const trades = Array.from({ length: 20 }, (_, index) => trade(index, index % 4 === 0 ? 0.01 : -0.006, index % 4 === 0 ? "trailing_stop" : "time_stop"));
    const report = buildTips(trades, settings);
    expect(report.stage).toBe("early");
    const sizing = report.tips.find((tip) => tip.id === "sizing");
    expect(sizing?.tone).toBe("bad");
    expect(sizing?.confidence).toBe("low");
    expect(report.tips.find((tip) => tip.id === "exit-worst")?.title).toMatch(/^The 5 minute time stop cost -0\.09/);
    expect(report.tips.find((tip) => tip.id === "exit-best")?.title).toMatch(/^The trailing stop made \+0\.05/);
    expect(report.tips.find((tip) => tip.id === "limits")?.title).toMatch(/about \d+ average losing trades/);
  });

  it("scales results with bet size while fixed network fees stay the same", () => {
    const trades = [trade(0, 0.02, "moonbag_trail"), trade(1, -0.01, "stop_loss")];
    const rows = sizingTable(trades, { ...settings, fixedCostPerTradeSol: 0.001 });
    const byMultiplier = new Map(rows.map((row) => [row.multiplier, row]));
    expect(byMultiplier.get(1)?.pnlSol).toBeCloseTo(0.01, 9);
    expect(byMultiplier.get(2)?.pnlSol).toBeCloseTo(2 * (0.01 + 0.002) - 0.002, 9);
    expect(byMultiplier.get(2)?.worstDipSol).toBeCloseTo(-(2 * (-0.01 + 0.001) - 0.001), 9);
    expect(byMultiplier.get(2)?.betSol).toBeCloseTo(0.1, 9);
  });

  it("recommends larger bets only once the edge is positive even at the low end", () => {
    const trades = Array.from({ length: 120 }, (_, index) => trade(index, index % 3 === 0 ? 0.03 : 0.004, index % 3 === 0 ? "moonbag_trail" : "trailing_stop"));
    const report = buildTips(trades, settings);
    expect(report.stage).toBe("solid");
    expect(report.tips.find((tip) => tip.id === "edge")?.tone).toBe("good");
    const sizing = report.tips.find((tip) => tip.id === "sizing");
    expect(sizing?.tone).toBe("good");
    expect(sizing?.detail).toContain("from 10% to 15%");
  });

  it("points out when a few runners carry the whole result", () => {
    const trades = [trade(0, 0.2, "moonbag_trail"), ...Array.from({ length: 9 }, (_, index) => trade(index + 1, -0.004, "time_stop"))];
    const tip = buildTips(trades, settings).tips.find((item) => item.id === "runners");
    expect(tip?.title).toBe("The top 3 trades made +0.1920 SOL of the +0.1640 SOL total");
  });
});
