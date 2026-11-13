import { describe, expect, it } from "vitest";
import { csvCell, csvDocument, csvRow, featureCell, featureColumnName, sortedFeatureKeys } from "../src/analytics/csv.js";
import { scorerDatasetHeader, scorerDatasetRow, TRADE_CSV_COLUMNS, tradeCsvRow } from "../src/analytics/exports.js";
import type { ScorerDatasetRecord } from "../src/analytics/scorerQueries.js";
import { closedTrade, lamports, MONDAY_MS } from "./analytics.fixtures.js";

describe("csv escaping", () => {
  it("quotes separators, quotes and line breaks", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("carriage\rreturn")).toBe('"carriage\rreturn"');
    expect(csvCell("")).toBe("");
  });

  it("neutralises spreadsheet formulas in text cells only", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell("=a,b")).toBe(`"'=a,b"`);
    expect(csvCell(-1.5)).toBe("-1.5");
  });

  it("serialises numbers, bigints, booleans, dates and empties", () => {
    expect(csvCell(0.1)).toBe("0.1");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe("");
    expect(csvCell(12345678901234567890n)).toBe("12345678901234567890");
    expect(csvCell(true)).toBe("1");
    expect(csvCell(false)).toBe("0");
    expect(csvCell(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("2026-01-02T03:04:05.000Z");
    expect(csvCell(new Date(Number.NaN))).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("builds rows and documents", () => {
    expect(csvRow(["a", 1, null, "x,y"])).toBe('a,1,,"x,y"');
    expect(csvDocument(["h1", "h2"], [["a", 1], ["b", 2]])).toBe("h1,h2\na,1\nb,2\n");
  });

  it("produces stable, prefixed feature columns", () => {
    expect(sortedFeatureKeys(["top10_share", "age_sec", "dev_share", "age_sec"])).toEqual(["age_sec", "dev_share", "top10_share"]);
    expect(featureColumnName("dev_share")).toBe("f_dev_share");
    expect(featureColumnName("odd key-1")).toBe("f_odd_key_1");
    expect(featureCell({ a: 1.5, b: null, c: "x", d: true }, "a")).toBe(1.5);
    expect(featureCell({ a: 1.5 }, "b")).toBeNull();
    expect(featureCell({ c: "x" }, "c")).toBeNull();
    expect(featureCell(null, "a")).toBeNull();
  });
});

describe("export rows", () => {
  it("writes one scorer dataset row with features in header order and outcome labels", () => {
    const record: ScorerDatasetRecord = {
      launchId: 7,
      mint: "Mint111",
      quoteMint: "SOL",
      createdAtMs: MONDAY_MS,
      checkpointSec: 60,
      computedAtMs: MONDAY_MS + 60_000,
      slot: 123,
      score: 42.5,
      hardBlocked: false,
      flags: ["dev_sold", "bundle"],
      weightsVersion: "v1",
      features: { mcap_multiple: 2, dev_share: 0.1 },
      outcome: {
        status: "migrated",
        finalized: true,
        outcomeKnownAtMs: MONDAY_MS + 3_600_000,
        survived15m: true,
        migrated: true,
        rugged: false,
        died: false,
        initialMcapQuote: 1_000n,
        peakMcapQuote: 8_000n,
        finalMcapQuote: 5_000n,
        mcap1m: 2_000n,
        mcap5m: 3_000n,
        mcap15m: 4_000n,
        timeToPeakSec: 600,
        peakMultipleFrom1m: 4,
        return15mFrom1m: 1,
        maxDrawdownFromPeak: 0.4,
        devSoldFraction: null
      }
    };
    const keys = ["dev_share", "mcap_multiple", "missing"];
    const header = scorerDatasetHeader(keys);
    const row = scorerDatasetRow(record, keys);
    expect(row).toHaveLength(header.length);
    const byColumn = new Map(header.map((name, index) => [name, csvCell(row[index])]));
    expect(byColumn.get("f_dev_share")).toBe("0.1");
    expect(byColumn.get("f_mcap_multiple")).toBe("2");
    expect(byColumn.get("f_missing")).toBe("");
    expect(byColumn.get("flags")).toBe("dev_sold|bundle");
    expect(byColumn.get("o_peak_multiple")).toBe("8");
    expect(byColumn.get("o_peak_multiple_from_score")).toBe("4");
    expect(byColumn.get("o_survived_15m")).toBe("1");
    expect(byColumn.get("o_dev_sold_fraction")).toBe("");
    expect(byColumn.get("created_at")).toBe(new Date(MONDAY_MS).toISOString());
  });

  it("writes closed trades with SOL conversions and buckets", () => {
    const trade = { ...closedTrade({ pnl: lamports(-0.025), riskScore: null, holdSec: 400 }), shadowOf: null };
    const row = tradeCsvRow(trade);
    expect(row).toHaveLength(TRADE_CSV_COLUMNS.length);
    const byColumn = new Map(TRADE_CSV_COLUMNS.map((name, index) => [name, csvCell(row[index])]));
    expect(byColumn.get("pnl_sol")).toBe("-0.025");
    expect(byColumn.get("pnl_lamports")).toBe("-25000000");
    expect(byColumn.get("return_pct")).toBe("-25");
    expect(byColumn.get("risk_bucket")).toBe("unscored");
    expect(byColumn.get("hold_bucket")).toBe("5-15m");
  });
});
