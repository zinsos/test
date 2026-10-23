import { Connection } from "@solana/web3.js";
import { requireEnv } from "../../config/env.js";
import { SystemClock } from "../../core/clock.js";
import type { TradingMode } from "../../core/types.js";
import { runMigrations } from "../../db/migrate.js";
import { loadKeypair } from "../../execution/keys.js";
import { recomputeOutcomes } from "../../recorder/outcomes.js";
import { RiskManager } from "../../risk/manager.js";
import { loadRiskState, RiskStateDbWriter } from "../../risk/persistence.js";
import { HotColdSweeper, type SweepResult } from "../../risk/sweeper.js";
import { countOpenPositions, requestKillReset, runExists } from "../../trader/runs.js";
import { dateOption, flagOption, numberOption, stringOption } from "../args.js";
import { commandConfig, EXIT_FAILURE, EXIT_OK, isoDay, withDatabase, type CommandContext } from "../commandContext.js";
import { openDatabase } from "../context.js";

const DAY_MS = 86_400_000;
const SWEEP_FAILURES: ReadonlySet<SweepResult["status"]> = new Set(["failed", "error"]);

export async function migrateCommand(ctx: CommandContext): Promise<number> {
  const db = openDatabase(ctx.env, "snypra-edge:migrate");
  try {
    const applied = await runMigrations(db);
    ctx.io.out(applied.length === 0 ? "database is up to date" : `applied ${applied.join(", ")}`);
    return EXIT_OK;
  } finally {
    await db.end().catch(() => undefined);
  }
}

function lamportsText(value: bigint | null): string {
  return value === null ? "n/a" : `${(Number(value) / 1e9).toFixed(4)} SOL`;
}

export async function sweepCommand(ctx: CommandContext): Promise<number> {
  const config = await commandConfig(ctx);
  const rpcUrl = requireEnv(ctx.env, "RPC_HTTP_URL");
  const secret = requireEnv(ctx.env, "HOT_WALLET_SECRET_KEY");
  const coldAddress = requireEnv(ctx.env, "COLD_WALLET_ADDRESS");
  const dryRun = flagOption(ctx.options, "dry-run") || ctx.env.LIVE_DRY_RUN;
  return withDatabase(ctx, "sweep", async (db) => {
    const openLive = await countOpenPositions(db, "live");
    const sweeper = new HotColdSweeper({
      connection: new Connection(rpcUrl, { commitment: "confirmed" }),
      hotKeypair: loadKeypair(secret),
      coldAddress,
      config: { ...config.sweeper, enabled: true },
      db,
      clock: new SystemClock(),
      dryRun,
      isBusy: () => openLive > 0
    });
    const result = await sweeper.tick();
    ctx.io.out(
      [
        `== sweep ${sweeper.hot.toBase58()} -> ${sweeper.cold.toBase58()} ==`,
        `status           ${result.status}${dryRun ? " (dry run)" : ""}`,
        `hot balance      ${lamportsText(result.balanceLamports)}`,
        `swept            ${lamportsText(result.sweepLamports)}`,
        `signature        ${result.signature ?? "none"}`,
        ...(result.error ? [`error            ${result.error}`] : []),
        ...(openLive > 0 ? [`skipped          ${openLive} live positions are open`] : [])
      ].join("\n")
    );
    return SWEEP_FAILURES.has(result.status) ? EXIT_FAILURE : EXIT_OK;
  });
}

function tradingModeOf(value: unknown): TradingMode {
  return value === "live" || value === "backtest" || value === "shadow" ? value : "paper";
}

export async function resetKillCommand(ctx: CommandContext): Promise<number> {
  const config = await commandConfig(ctx);
  const runId = Math.floor(numberOption(ctx.options, "run") ?? 0);
  const reason = stringOption(ctx.options, "reason") ?? "manual reset";
  return withDatabase(ctx, "reset-kill", async (db) => {
    if (!(await runExists(db, runId))) {
      ctx.io.err(`strategy run ${runId} does not exist`);
      return EXIT_FAILURE;
    }
    const persisted = await loadRiskState(db, runId);
    if (!persisted) {
      ctx.io.err(`strategy run ${runId} has no risk state yet`);
      return EXIT_FAILURE;
    }
    if (!persisted.killed) {
      ctx.io.out(`run ${runId} is not killed; nothing to reset`);
      return EXIT_OK;
    }
    const writer = new RiskStateDbWriter({ db });
    const risk = new RiskManager({
      runId,
      config: config.risk,
      clock: new SystemClock(),
      mode: tradingModeOf(persisted.state.mode),
      store: writer,
      persisted
    });
    risk.resetKill(reason);
    await writer.flush();
    await requestKillReset(db, runId, reason);
    ctx.io.out(`kill switch reset for run ${runId} (previous reason: ${persisted.killReason ?? "unknown"}); a running trader picks it up within 30s`);
    return EXIT_OK;
  });
}

export async function recomputeOutcomesCommand(ctx: CommandContext): Promise<number> {
  const config = await commandConfig(ctx);
  const nowMs = new SystemClock().nowMs();
  const to = dateOption(ctx.options, "to") ?? new Date(nowMs);
  const from = dateOption(ctx.options, "from") ?? new Date(to.getTime() - 30 * DAY_MS);
  return withDatabase(ctx, "recompute-outcomes", async (db) => {
    const result = await recomputeOutcomes(db, { from, to, config, nowMs });
    ctx.io.out(`relabelled ${result.launches} launches created ${isoDay(from.getTime())} to ${isoDay(to.getTime())} (${result.finalized} already finalized)`);
    return EXIT_OK;
  });
}
