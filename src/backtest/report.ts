import type { Breakdown, Narrative, TradeSummary } from "../analytics/index.js";
import { formatDuration, formatInterval, formatPct, formatSol } from "../analytics/index.js";

export interface ReportInput {
  title: string;
  summary: TradeSummary;
  breakdowns: readonly Breakdown[];
  narrative: Narrative;
  details?: ReadonlyArray<readonly [string, string]>;
  maxRowsPerBreakdown?: number;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function ratio(value: number | null): string {
  return value === null || !Number.isFinite(value) ? (value === Number.POSITIVE_INFINITY ? "inf" : "n/a") : value.toFixed(2);
}

export function summaryLines(summary: TradeSummary): string[] {
  return [
    `trades           ${summary.n} (${summary.wins} wins, ${summary.losses} losses, win rate ${formatPct(summary.winRate)})`,
    `expectancy       ${formatSol(summary.expectancySol)} SOL/trade (${formatPct(summary.expectancyPctOfStake === null ? null : summary.expectancyPctOfStake / 100)} of stake)`,
    `95% interval     ${formatInterval(summary.decisionCi95)} SOL/trade`,
    `avg win / loss   ${formatSol(summary.avgWinSol)} / ${formatSol(summary.avgLossSol === null ? null : -summary.avgLossSol)} SOL`,
    `profit factor    ${ratio(summary.profitFactor)}`,
    `total pnl        ${formatSol(summary.totalPnlSol)} SOL (fees ${formatSol(summary.totalFeesSol, false)} SOL, ex-best ${formatSol(summary.pnlExBestSol)} SOL)`,
    `max drawdown     ${formatSol(summary.maxDrawdownSol, false)} SOL`,
    `hold             avg ${formatDuration(summary.avgHoldSec)}, median ${formatDuration(summary.medianHoldSec)}`,
    `verdict          ${summary.verdict} (${summary.significance})${summary.moreTradesNeeded ? `, ~${summary.moreTradesNeeded} more trades needed` : ""}`
  ];
}

export function breakdownLines(breakdown: Breakdown, maxRows: number): string[] {
  const lines = [`by ${breakdown.dimension}:`];
  const rows = [...breakdown.rows].sort((a, b) => b.n - a.n).slice(0, maxRows);
  for (const row of rows) {
    lines.push(
      `  ${pad(row.label, 16)} n=${padLeft(String(row.n), 5)}  win ${padLeft(formatPct(row.winRate), 6)}  exp ${padLeft(formatSol(row.expectancySol), 8)}  total ${padLeft(formatSol(row.totalPnlSol), 9)}  ${row.action}`
    );
  }
  if (breakdown.rows.length > rows.length) {
    lines.push(`  ... ${breakdown.rows.length - rows.length} more`);
  }
  return lines;
}

export function formatTradeReport(input: ReportInput): string {
  const lines: string[] = [`== ${input.title} ==`];
  for (const [label, value] of input.details ?? []) {
    lines.push(`${pad(label, 16)} ${value}`);
  }
  lines.push(...summaryLines(input.summary));
  lines.push(`${input.narrative.headline}`);
  if (input.narrative.detail) {
    lines.push(`${input.narrative.detail}`);
  }
  for (const breakdown of input.breakdowns) {
    if (breakdown.rows.length === 0) {
      continue;
    }
    lines.push(...breakdownLines(breakdown, input.maxRowsPerBreakdown ?? 8));
  }
  return lines.join("\n");
}
