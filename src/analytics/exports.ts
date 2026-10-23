import type { Db } from "../db/pool.js";
import { csvRow, featureCell, featureColumnName, sortedFeatureKeys, type CsvValue } from "./csv.js";
import { holdBucket, riskBucket } from "./dimensions.js";
import {
  iterateScorerDataset,
  peakMultipleFromScore,
  peakMultipleOf,
  scorerDatasetFeatureKeys,
  type ScorerDatasetQuery,
  type ScorerDatasetRecord
} from "./scorerQueries.js";
import { iterateClosedTrades, type ClosedTradeRecord, type TradeFilter } from "./tradeQueries.js";
import { lamportsToSol } from "./units.js";

export const SCORER_DATASET_BASE_COLUMNS: readonly string[] = [
  "launch_id",
  "mint",
  "quote_mint",
  "created_at",
  "checkpoint_sec",
  "computed_at",
  "slot",
  "score",
  "hard_blocked",
  "flags",
  "weights_version"
];

export const SCORER_DATASET_OUTCOME_COLUMNS: readonly string[] = [
  "o_status",
  "o_finalized",
  "o_outcome_known_at",
  "o_survived_15m",
  "o_migrated",
  "o_rugged",
  "o_died",
  "o_peak_multiple",
  "o_peak_multiple_from_score",
  "o_time_to_peak_sec",
  "o_peak_multiple_from_1m",
  "o_return_15m_from_1m",
  "o_max_drawdown_from_peak",
  "o_dev_sold_fraction",
  "o_initial_mcap_quote",
  "o_peak_mcap_quote",
  "o_final_mcap_quote",
  "o_mcap_1m",
  "o_mcap_5m",
  "o_mcap_15m"
];

export const TRADE_CSV_COLUMNS: readonly string[] = [
  "position_id",
  "run_id",
  "mode",
  "mint",
  "signal_type",
  "risk_score",
  "risk_bucket",
  "opened_at",
  "closed_at",
  "hold_sec",
  "hold_bucket",
  "cost_sol",
  "proceeds_sol",
  "fees_sol",
  "pnl_sol",
  "pnl_lamports",
  "return_pct",
  "peak_multiple",
  "exit_reason",
  "shadow_of"
];

function dateOrNull(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

export function scorerDatasetHeader(featureKeys: readonly string[]): string[] {
  return [...SCORER_DATASET_BASE_COLUMNS, ...featureKeys.map(featureColumnName), ...SCORER_DATASET_OUTCOME_COLUMNS];
}

export function scorerDatasetRow(record: ScorerDatasetRecord, featureKeys: readonly string[]): CsvValue[] {
  const outcome = record.outcome;
  return [
    record.launchId,
    record.mint,
    record.quoteMint,
    new Date(record.createdAtMs),
    record.checkpointSec,
    new Date(record.computedAtMs),
    record.slot,
    record.score,
    record.hardBlocked,
    record.flags.join("|"),
    record.weightsVersion,
    ...featureKeys.map((key) => featureCell(record.features, key)),
    outcome.status,
    outcome.finalized,
    dateOrNull(outcome.outcomeKnownAtMs),
    outcome.survived15m,
    outcome.migrated,
    outcome.rugged,
    outcome.died,
    peakMultipleOf(outcome),
    peakMultipleFromScore(record),
    outcome.timeToPeakSec,
    outcome.peakMultipleFrom1m,
    outcome.return15mFrom1m,
    outcome.maxDrawdownFromPeak,
    outcome.devSoldFraction,
    outcome.initialMcapQuote,
    outcome.peakMcapQuote,
    outcome.finalMcapQuote,
    outcome.mcap1m,
    outcome.mcap5m,
    outcome.mcap15m
  ];
}

export async function* scorerDatasetCsv(db: Db, query: ScorerDatasetQuery = {}): AsyncGenerator<string> {
  const featureKeys = sortedFeatureKeys(await scorerDatasetFeatureKeys(db, query));
  yield `${csvRow(scorerDatasetHeader(featureKeys))}\n`;
  for await (const page of iterateScorerDataset(db, query)) {
    yield page.map((record) => `${csvRow(scorerDatasetRow(record, featureKeys))}\n`).join("");
  }
}

export function tradeCsvRow(trade: ClosedTradeRecord): CsvValue[] {
  return [
    trade.positionId,
    trade.runId,
    trade.mode,
    trade.mint,
    trade.signalType,
    trade.riskScore,
    riskBucket(trade.riskScore).label,
    new Date(trade.openedAtMs),
    new Date(trade.closedAtMs),
    trade.holdSec,
    holdBucket(trade.holdSec).label,
    lamportsToSol(trade.cost),
    lamportsToSol(trade.proceeds),
    lamportsToSol(trade.fees),
    lamportsToSol(trade.pnl),
    trade.pnl,
    trade.cost > 0n ? (Number(trade.pnl) / Number(trade.cost)) * 100 : null,
    trade.peakMultiple,
    trade.exitReason,
    trade.shadowOf
  ];
}

export async function* closedTradesCsv(db: Db, filter: TradeFilter = {}): AsyncGenerator<string> {
  yield `${csvRow(TRADE_CSV_COLUMNS)}\n`;
  for await (const page of iterateClosedTrades(db, filter)) {
    yield page.map((trade) => `${csvRow(tradeCsvRow(trade))}\n`).join("");
  }
}
