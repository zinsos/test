import { describe, expect, it } from "vitest";
import {
  allBreakdowns,
  breakdown,
  bucketAction,
  conservativeInterval,
  downsampleEquity,
  edgeSignificance,
  edgeVerdict,
  equitySeries,
  summarizeTrades,
  tradesNeededFor,
  type EquityPoint
} from "../src/analytics/metrics.js";
import { holdBucket, hourUtcBucket, riskBucket, weekdayBucket } from "../src/analytics/dimensions.js";
import { lamportsToSol } from "../src/analytics/units.js";
import { createRng } from "../src/core/rng.js";
import { alternating, closedTrade, lamports, MONDAY_MS, SOL, tradesWithPnls } from "./analytics.fixtures.js";

function randomPnls(count: number, seed: string, mean: number, spread: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => Number((mean + (rng() - 0.5) * 2 * spread).toFixed(6)));
}

describe("summarizeTrades", () => {
  it("returns empty statistics without trades", () => {
    const summary = summarizeTrades([]);
    expect(summary.n).toBe(0);
    expect(summary.winRate).toBeNull();
    expect(summary.expectancySol).toBeNull();
    expect(summary.expectancyCi95).toBeNull();
    expect(summary.bootstrapCi95).toBeNull();
    expect(summary.maxDrawdownSol).toBe(0);
    expect(summary.totalPnlSol).toBe(0);
    expect(summary.verdict).toBe("insufficient_data");
    expect(summary.tradesNeeded).toBeNull();
    expect(summary.moreTradesNeeded).toBeNull();
    expect(summary.firstClosedAtMs).toBeNull();
  });

  it("satisfies the expectancy identity: mean pnl equals winRate x avgWin - lossRate x avgLoss", () => {
    const pnls = randomPnls(257, "identity", 0.002, 0.05);
    pnls.push(0, 0);
    const trades = tradesWithPnls(pnls);
    const summary = summarizeTrades(trades);
    const identity = (summary.winRate ?? 0) * (summary.avgWinSol ?? 0) - (summary.lossRate ?? 0) * (summary.avgLossSol ?? 0);
    const meanPnl = trades.reduce((acc, trade) => acc + lamportsToSol(trade.pnl), 0) / trades.length;
    expect(summary.n).toBe(259);
    expect(summary.wins + summary.losses).toBe(259);
    expect(identity).toBeCloseTo(summary.expectancySol ?? Number.NaN, 12);
    expect(summary.expectancySol).toBeCloseTo(meanPnl, 12);
    expect((summary.winRate ?? 0) + (summary.lossRate ?? 0)).toBeCloseTo(1, 12);
  });

  it("counts break-even trades as losses so a scratch never inflates the win rate", () => {
    const summary = summarizeTrades(tradesWithPnls([0.01, 0, -0.01]));
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(2);
    expect(summary.avgLossSol).toBeCloseTo(0.005, 12);
    expect(summary.expectancySol).toBeCloseTo(0, 12);
  });

  it("handles all winners without a loss average or finite profit factor", () => {
    const summary = summarizeTrades(tradesWithPnls([0.01, 0.02, 0.03]));
    expect(summary.lossRate).toBe(0);
    expect(summary.avgLossSol).toBeNull();
    expect(summary.profitFactor).toBeNull();
    expect(summary.grossWinSol).toBeCloseTo(0.06, 12);
    expect(summary.maxDrawdownSol).toBe(0);
  });

  it("computes profit factor, totals, fees, best and worst trade and pnl without the best trade", () => {
    const trades = tradesWithPnls([0.3, -0.1, 0.05, -0.05]);
    const summary = summarizeTrades(trades);
    expect(summary.profitFactor).toBeCloseTo(0.35 / 0.15, 12);
    expect(summary.totalPnlSol).toBeCloseTo(0.2, 12);
    expect(summary.totalFeesSol).toBeCloseTo(0.004, 12);
    expect(summary.totalCostSol).toBeCloseTo(0.4, 12);
    expect(summary.bestTradeSol).toBeCloseTo(0.3, 12);
    expect(summary.worstTradeSol).toBeCloseTo(-0.1, 12);
    expect(summary.pnlExBestSol).toBeCloseTo(-0.1, 12);
  });

  it("expresses expectancy as a percentage of stake and skips zero-cost trades", () => {
    const trades = [
      closedTrade({ cost: SOL, pnl: SOL / 10n }),
      closedTrade({ cost: SOL, pnl: -SOL / 20n }),
      closedTrade({ cost: 0n, pnl: SOL })
    ];
    expect(summarizeTrades(trades).expectancyPctOfStake).toBeCloseTo(2.5, 12);
  });

  it("reports average and median hold times", () => {
    const trades = [10, 20, 90, 400].map((holdSec) => closedTrade({ holdSec, pnl: lamports(0.01) }));
    const summary = summarizeTrades(trades);
    expect(summary.avgHoldSec).toBeCloseTo(130, 12);
    expect(summary.medianHoldSec).toBeCloseTo(55, 12);
  });

  it("builds the drawdown from an equity curve ordered by close time, starting at zero", () => {
    const trades = [
      closedTrade({ pnl: lamports(1), openedAtMs: MONDAY_MS, holdSec: 10 }),
      closedTrade({ pnl: lamports(-3), openedAtMs: MONDAY_MS + 100_000, holdSec: 10 }),
      closedTrade({ pnl: lamports(1), openedAtMs: MONDAY_MS + 200_000, holdSec: 10 })
    ];
    expect(summarizeTrades([...trades].reverse()).maxDrawdownSol).toBeCloseTo(3, 12);
    const initialLoss = [closedTrade({ pnl: lamports(-2), openedAtMs: MONDAY_MS }), closedTrade({ pnl: lamports(1), openedAtMs: MONDAY_MS + 1 })];
    expect(summarizeTrades(initialLoss).maxDrawdownSol).toBeCloseTo(2, 12);
  });

  it("produces confidence intervals that contain the mean and narrow with more trades", () => {
    const small = summarizeTrades(tradesWithPnls(randomPnls(100, "ci", 0.001, 0.05)));
    const large = summarizeTrades(tradesWithPnls(randomPnls(1600, "ci", 0.001, 0.05)));
    for (const summary of [small, large]) {
      const mean = summary.expectancySol ?? Number.NaN;
      expect(summary.expectancyCi95?.low).toBeLessThan(mean);
      expect(summary.expectancyCi95?.high).toBeGreaterThan(mean);
      expect(summary.bootstrapCi95?.low).toBeLessThan(mean);
      expect(summary.bootstrapCi95?.high).toBeGreaterThan(mean);
    }
    const width = (interval: { low: number; high: number } | null): number => (interval ? interval.high - interval.low : Number.NaN);
    expect(width(large.expectancyCi95)).toBeLessThan(width(small.expectancyCi95) / 3);
    expect(small.decisionCi95?.low).toBe(Math.min(small.expectancyCi95?.low ?? 0, small.bootstrapCi95?.low ?? 0));
    expect(small.decisionCi95?.high).toBe(Math.max(small.expectancyCi95?.high ?? 0, small.bootstrapCi95?.high ?? 0));
  });

  it("is deterministic for a seed and varies with the seed", () => {
    const trades = tradesWithPnls(randomPnls(150, "seeded", 0, 0.05));
    const first = summarizeTrades(trades, { seed: "a" });
    const second = summarizeTrades(trades, { seed: "a" });
    const third = summarizeTrades(trades, { seed: "b" });
    expect(first.bootstrapCi95).toEqual(second.bootstrapCi95);
    expect(first.bootstrapCi95).not.toEqual(third.bootstrapCi95);
    expect(first.expectancyCi95).toEqual(third.expectancyCi95);
  });

  it("says insufficient_data under 100 trades even with a strong edge", () => {
    const summary = summarizeTrades(tradesWithPnls(alternating(99, 0.05, 0.01)));
    expect(summary.decisionCi95?.low).toBeGreaterThan(0);
    expect(summary.verdict).toBe("insufficient_data");
    expect(summary.significance).toBe("positive");
    expect(summary.moreTradesNeeded).toBe(1);
  });

  it("says edge at 100 trades when the lower bound is above zero", () => {
    const summary = summarizeTrades(tradesWithPnls(alternating(100, 0.05, 0.01)));
    expect(summary.verdict).toBe("edge");
    expect(summary.significance).toBe("positive");
    expect(summary.moreTradesNeeded).toBe(0);
  });

  it("says no_edge when the interval straddles zero and flags significantly negative results", () => {
    const flat = summarizeTrades(tradesWithPnls(alternating(200, 0.0101, 0.01)));
    expect(flat.verdict).toBe("no_edge");
    expect(flat.significance).toBe("inconclusive");
    expect(flat.moreTradesNeeded).toBeGreaterThan(0);
    const losing = summarizeTrades(tradesWithPnls(alternating(200, 0.01, 0.03)));
    expect(losing.verdict).toBe("no_edge");
    expect(losing.significance).toBe("negative");
  });

  it("honours a custom minimum trade count", () => {
    const summary = summarizeTrades(tradesWithPnls(alternating(40, 0.05, 0.01)), { minTrades: 30 });
    expect(summary.minTrades).toBe(30);
    expect(summary.verdict).toBe("edge");
  });

  it("estimates trades needed from the current mean and standard deviation", () => {
    const pnls = randomPnls(300, "needed", 0.002, 0.04);
    const summary = summarizeTrades(tradesWithPnls(pnls));
    const expected = Math.max(100, Math.ceil(((1.96 * (summary.sdSol ?? 0)) / Math.abs(summary.expectancySol ?? 1)) ** 2));
    expect(summary.tradesNeeded).toBe(expected);
    expect(summary.moreTradesNeeded).toBe(Math.max(0, expected - 300));
  });
});

describe("decision helpers", () => {
  it("computes trades needed with the minimum as a floor", () => {
    expect(tradesNeededFor(1, 10)).toBe(385);
    expect(tradesNeededFor(-1, 10)).toBe(385);
    expect(tradesNeededFor(1, 1)).toBe(100);
    expect(tradesNeededFor(1, 1, 5)).toBe(5);
    expect(tradesNeededFor(1, 1, 1)).toBe(4);
    expect(tradesNeededFor(0, 1)).toBeNull();
    expect(tradesNeededFor(null, 1)).toBeNull();
    expect(tradesNeededFor(1, null)).toBeNull();
  });

  it("maps intervals to verdicts and significance", () => {
    expect(edgeVerdict(150, 100, { low: 0.001, high: 0.01 })).toBe("edge");
    expect(edgeVerdict(150, 100, { low: 0, high: 0.01 })).toBe("no_edge");
    expect(edgeVerdict(150, 100, { low: -0.01, high: -0.001 })).toBe("no_edge");
    expect(edgeVerdict(99, 100, { low: 0.001, high: 0.01 })).toBe("insufficient_data");
    expect(edgeVerdict(150, 100, null)).toBe("insufficient_data");
    expect(edgeSignificance({ low: -0.01, high: -0.001 })).toBe("negative");
    expect(edgeSignificance({ low: -0.01, high: 0.001 })).toBe("inconclusive");
    expect(edgeSignificance(null)).toBe("inconclusive");
  });

  it("combines intervals conservatively", () => {
    expect(conservativeInterval({ low: 1, high: 3 }, { low: 0.5, high: 2 })).toEqual({ low: 0.5, high: 3 });
    expect(conservativeInterval(null, { low: 0.5, high: 2 })).toEqual({ low: 0.5, high: 2 });
    expect(conservativeInterval(null, null)).toBeNull();
  });

  it("chooses bucket actions from sample size and interval", () => {
    expect(bucketAction(29, -1, { low: -2, high: -0.5 }, 30)).toBe("insufficient");
    expect(bucketAction(30, -1, { low: -2, high: -0.5 }, 30)).toBe("cut");
    expect(bucketAction(30, 1, { low: 0.5, high: 2 }, 30)).toBe("scale");
    expect(bucketAction(30, 0.1, { low: -0.5, high: 0.7 }, 30)).toBe("lean_scale");
    expect(bucketAction(30, -0.1, { low: -0.7, high: 0.5 }, 30)).toBe("lean_cut");
    expect(bucketAction(30, 0, { low: -0.7, high: 0.7 }, 30)).toBe("lean_cut");
  });
});

describe("dimensions", () => {
  it("buckets risk scores in tens with unscored separate", () => {
    expect(riskBucket(0).key).toBe("0-10");
    expect(riskBucket(9.99).key).toBe("0-10");
    expect(riskBucket(10).key).toBe("10-20");
    expect(riskBucket(55).key).toBe("50-60");
    expect(riskBucket(100).key).toBe("90-100");
    expect(riskBucket(150).key).toBe("90-100");
    expect(riskBucket(-5).key).toBe("0-10");
    expect(riskBucket(null).key).toBe("unscored");
    expect(riskBucket(Number.NaN).key).toBe("unscored");
    expect(riskBucket(30, 25).key).toBe("25-50");
    expect(riskBucket(100, 25).key).toBe("75-100");
    expect(riskBucket(99, 30).key).toBe("90-100");
  });

  it("buckets hold times at the minute boundaries", () => {
    expect(holdBucket(0).key).toBe("<1m");
    expect(holdBucket(59.9).key).toBe("<1m");
    expect(holdBucket(60).key).toBe("1-5m");
    expect(holdBucket(299).key).toBe("1-5m");
    expect(holdBucket(300).key).toBe("5-15m");
    expect(holdBucket(900).key).toBe("15-60m");
    expect(holdBucket(3599).key).toBe("15-60m");
    expect(holdBucket(3600).key).toBe(">60m");
    expect(holdBucket(Number.NaN).key).toBe("<1m");
  });

  it("derives the UTC hour and a Monday-first weekday", () => {
    const at = Date.UTC(2026, 9, 7, 14, 30);
    expect(hourUtcBucket(at)).toEqual({ key: "14", label: "14:00", order: 14 });
    expect(weekdayBucket(at)).toEqual({ key: "wed", label: "Wed", order: 2 });
    expect(weekdayBucket(Date.UTC(2026, 9, 11, 23, 59)).label).toBe("Sun");
    expect(weekdayBucket(MONDAY_MS).order).toBe(0);
  });
});

describe("breakdown", () => {
  it("groups trades by risk bucket in score order with unscored last", () => {
    const trades = [
      closedTrade({ riskScore: 72, pnl: lamports(0.01) }),
      closedTrade({ riskScore: null, pnl: lamports(-0.01) }),
      closedTrade({ riskScore: 3, pnl: lamports(0.02) }),
      closedTrade({ riskScore: 8, pnl: lamports(-0.01) }),
      closedTrade({ riskScore: 10, pnl: lamports(0.01) })
    ];
    const result = breakdown(trades, "riskBucket");
    expect(result.rows.map((row) => row.key)).toEqual(["0-10", "10-20", "70-80", "unscored"]);
    const first = result.rows[0];
    expect(first?.n).toBe(2);
    expect(first?.wins).toBe(1);
    expect(first?.expectancySol).toBeCloseTo(0.005, 12);
    expect(first?.shareOfTrades).toBeCloseTo(0.4, 12);
    expect(result.rows.every((row) => row.action === "insufficient")).toBe(true);
  });

  it("sorts categorical dimensions by trade count", () => {
    const trades = [
      closedTrade({ exitReason: "stop_loss" }),
      closedTrade({ exitReason: "time_stop" }),
      closedTrade({ exitReason: "time_stop" }),
      closedTrade({ exitReason: "" })
    ];
    expect(breakdown(trades, "exitReason").rows.map((row) => row.key)).toEqual(["time_stop", "stop_loss", "unknown"]);
  });

  it("orders hold buckets and hours naturally", () => {
    const trades = [3700, 30, 400, 120, 1000].map((holdSec) => closedTrade({ holdSec }));
    expect(breakdown(trades, "holdBucket").rows.map((row) => row.key)).toEqual(["<1m", "1-5m", "5-15m", "15-60m", ">60m"]);
    const hours = [23, 1, 12].map((hour) => closedTrade({ openedAtMs: Date.UTC(2026, 9, 6, hour) }));
    expect(breakdown(hours, "hourUtc").rows.map((row) => row.key)).toEqual(["01", "12", "23"]);
  });

  it("flags buckets to cut and to scale once they have enough trades", () => {
    const losers = tradesWithPnls(alternating(30, 0.01, 0.05), { signalType: "score_momentum" });
    const winners = tradesWithPnls(alternating(30, 0.05, 0.01), { signalType: "smart_convergence" });
    const result = breakdown([...losers, ...winners], "signalType");
    const byKey = new Map(result.rows.map((row) => [row.key, row]));
    expect(byKey.get("score_momentum")?.action).toBe("cut");
    expect(byKey.get("smart_convergence")?.action).toBe("scale");
    expect(breakdown(losers, "signalType", { minTradesPerBucket: 31 }).rows[0]?.action).toBe("insufficient");
  });

  it("covers every dimension", () => {
    const result = allBreakdowns([closedTrade()]);
    expect(result.map((item) => item.dimension)).toEqual(["riskBucket", "signalType", "hourUtc", "holdBucket", "exitReason", "weekday"]);
    expect(result.every((item) => item.rows.length === 1)).toBe(true);
  });
});

describe("equity series", () => {
  it("starts at zero and accumulates pnl in close order", () => {
    const trades = [
      closedTrade({ pnl: lamports(-0.5), openedAtMs: MONDAY_MS + 2_000, holdSec: 1 }),
      closedTrade({ pnl: lamports(1), openedAtMs: MONDAY_MS, holdSec: 1 })
    ];
    const series = equitySeries(trades);
    expect(series.map((point) => point.equitySol)).toEqual([0, 1, 0.5]);
    expect(series.map((point) => point.index)).toEqual([0, 1, 2]);
    expect(series[2]?.drawdownSol).toBeCloseTo(0.5, 12);
    expect(series[2]?.pnlSol).toBeCloseTo(-0.5, 12);
    expect(equitySeries([])).toEqual([]);
  });

  it("downsamples to the limit while keeping the endpoints and the extremes", () => {
    const pnls = randomPnls(5_000, "equity", 0, 0.05);
    pnls[2_500] = -50;
    pnls[2_501] = 80;
    const full = equitySeries(tradesWithPnls(pnls), { maxPoints: 1_000_000 });
    const reduced = downsampleEquity(full, 200);
    expect(reduced.length).toBeLessThanOrEqual(200);
    expect(reduced[0]).toEqual(full[0]);
    expect(reduced[reduced.length - 1]).toEqual(full[full.length - 1]);
    const minimum = Math.min(...full.map((point: EquityPoint) => point.equitySol));
    const maximum = Math.max(...full.map((point: EquityPoint) => point.equitySol));
    expect(Math.min(...reduced.map((point) => point.equitySol))).toBe(minimum);
    expect(Math.max(...reduced.map((point) => point.equitySol))).toBe(maximum);
    const indexes = reduced.map((point) => point.index);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(downsampleEquity(full.slice(0, 10), 200)).toHaveLength(10);
  });
});
