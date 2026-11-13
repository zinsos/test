import { SystemClock } from "../../core/clock.js";
import { backfillWallets, type BackfillSummary } from "../../tracker/backfill.js";
import { backfillTargetsFromLatestRun } from "../../tracker/index.js";
import { rankWallets, type RankRunResult } from "../../tracker/ranker.js";
import { dateOption, numberOption } from "../args.js";
import { commandConfig, EXIT_FAILURE, EXIT_OK, isoDay, withDatabase, type CommandContext } from "../commandContext.js";
import { requireRpc } from "../context.js";

const DAY_MS = 86_400_000;

function sol(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(3);
}

export function formatRankReport(result: RankRunResult, top = 15): string {
  const lines = [
    `== wallet ranking run ${result.runId ?? "(not persisted)"} as of ${isoDay(result.asOfMs)} ==`,
    `candidates       ${result.candidates}`,
    `tracked          ${result.tracked}`,
    `excluded         ${result.excluded}`
  ];
  const reasons = new Map<string, number>();
  for (const wallet of result.wallets) {
    const primary = wallet.reasons[0];
    if (primary) {
      reasons.set(primary, (reasons.get(primary) ?? 0) + 1);
    }
  }
  if (reasons.size > 0) {
    lines.push(`exclusions       ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${reason} ${count}`).join(", ")}`);
  }
  lines.push("top tracked (rank, score, 30d pnl SOL, 30d trades, 30d win rate, 90d pnl SOL):");
  for (const wallet of result.wallets.filter((entry) => entry.tracked).slice(0, top)) {
    lines.push(
      `  ${String(wallet.rank ?? "-").padStart(3)} ${wallet.wallet}  ${wallet.score.toFixed(2).padStart(7)}  ${sol(wallet.short.realizedPnlSol).padStart(8)}  ${String(wallet.short.closed).padStart(4)}  ${wallet.short.winRate === null ? "n/a" : `${(wallet.short.winRate * 100).toFixed(0)}%`}  ${sol(wallet.long.realizedPnlSol)}`
    );
  }
  return lines.join("\n");
}

export async function rankWalletsCommand(ctx: CommandContext): Promise<number> {
  const config = await commandConfig(ctx);
  const asOf = dateOption(ctx.options, "as-of");
  return withDatabase(ctx, "rank-wallets", async (db) => {
    const asOfMs = asOf?.getTime() ?? new SystemClock().nowMs();
    const result = await rankWallets(db, {
      asOfMs,
      config: config.tracker,
      bundleSlotWindow: config.scorer.bundleSlotWindow,
      historyKnownBeforeMs: asOf ? asOfMs : null,
      label: asOf ? "cli-as-of" : "cli"
    });
    ctx.io.out(formatRankReport(result));
    return EXIT_OK;
  });
}

export function formatBackfillReport(summary: BackfillSummary): string {
  const failed = summary.wallets.filter((wallet) => wallet.error !== null);
  const lines = [
    `== wallet backfill ==`,
    `wallets          ${summary.wallets.length} (${failed.length} with errors)`,
    `transactions     ${summary.transactionsFetched}`,
    `trades written   ${summary.tradesWritten}`,
    `errors           ${summary.errors}`
  ];
  for (const wallet of failed.slice(0, 10)) {
    lines.push(`  ${wallet.wallet}: ${wallet.error}`);
  }
  return lines.join("\n");
}

export async function backfillWalletsCommand(ctx: CommandContext): Promise<number> {
  const config = await commandConfig(ctx);
  const rpc = requireRpc(ctx.env);
  return withDatabase(ctx, "backfill-wallets", async (db) => {
    const top = numberOption(ctx.options, "top") ?? config.tracker.backfill.maxWallets;
    const sinceDays = numberOption(ctx.options, "since-days") ?? config.tracker.longWindowDays;
    const targets = await backfillTargetsFromLatestRun(db, Math.max(1, Math.floor(top)));
    if (targets.length === 0) {
      ctx.io.err("no ranked wallets yet: run rank-wallets first");
      return EXIT_FAILURE;
    }
    const nowMs = new SystemClock().nowMs();
    const summary = await backfillWallets(db, rpc, targets, {
      sinceMs: nowMs - sinceDays * DAY_MS,
      maxSignatures: config.tracker.backfill.maxSignaturesPerWallet,
      concurrency: config.tracker.backfill.concurrency
    });
    ctx.io.out(formatBackfillReport(summary));
    return summary.errors > 0 && summary.tradesWritten === 0 ? EXIT_FAILURE : EXIT_OK;
  });
}
