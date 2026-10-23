import type { LabPruneResult } from "./store.js";
import type { LabResult, LabVariantResult } from "./runner.js";

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(":00.000Z", "Z").replace(".000Z", "Z");
}

function auc(value: number | null): string {
  return value === null ? "  n/a" : value.toFixed(3);
}

function signed(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function durationText(ms: number | null): string {
  if (ms === null) {
    return "n/a";
  }
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)
    .toString()
    .padStart(2, "0")}s`;
}

function holdText(seconds: number | null): string {
  return seconds === null ? "n/a" : `${Math.round(seconds)}s`;
}

export function rankVariants(variants: readonly LabVariantResult[]): LabVariantResult[] {
  const score = (variant: LabVariantResult): number => variant.summary?.expectancySol ?? Number.NEGATIVE_INFINITY;
  return variants
    .filter((variant) => variant.summary !== null)
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        (b.summary?.totalPnlSol ?? 0) - (a.summary?.totalPnlSol ?? 0) ||
        Number(b.isBaseline) - Number(a.isBaseline) ||
        a.name.localeCompare(b.name)
    );
}

function scorerLines(result: LabResult): string[] {
  const lines = ["scorer (validation AUC on the newest 30% of matured launches; live = current scores on the same rows)"];
  if (result.scorer.length === 0 && result.scorerSkipped.length === 0) {
    lines.push("  nothing trained");
  }
  if (result.scorer.length > 0) {
    lines.push(`  ${"label".padEnd(14)} ${"cp".padStart(4)} ${"rows".padStart(7)} ${"pos".padStart(7)}  new    live   saved weights (inactive)`);
  }
  for (const entry of result.scorer) {
    const top = entry.features
      .slice(0, 3)
      .map((feature) => feature.name)
      .join(", ");
    lines.push(
      `  ${entry.label.padEnd(14)} ${`${entry.checkpointSec}s`.padStart(4)} ${String(entry.rows).padStart(7)} ${String(entry.positives).padStart(7)}  ${auc(entry.validationAuc)}  ${auc(entry.baselineAuc)}  ${entry.weightsVersion}${top ? `  top: ${top}` : ""}`
    );
  }
  for (const skip of result.scorerSkipped) {
    lines.push(`  ${skip.label.padEnd(14)} ${`${skip.checkpointSec}s`.padStart(4)} skipped: ${skip.reason}`);
  }
  return lines;
}

function leaderboardLines(result: LabResult): string[] {
  const ranked = rankVariants(result.variants);
  const baselineRun = result.variants.find((variant) => variant.isBaseline) ?? null;
  const baseline = baselineRun?.summary ?? null;
  const baselineFingerprint = baselineRun?.fingerprint ?? null;
  const lines = ["leaderboard (sorted by expectancy per trade; * = baseline)"];
  if (ranked.length === 0) {
    lines.push("  no variant finished");
  } else {
    lines.push(
      `  ${"#".padStart(2)}  ${"variant".padEnd(26)} ${"trades".padStart(6)} ${"win".padStart(6)} ${"SOL/trade".padStart(10)} ${"95% CI".padStart(21)} ${"total".padStart(9)} ${"max DD".padStart(7)} ${"hold".padStart(6)}  ${"vs base".padStart(9)}  verdict`
    );
  }
  ranked.forEach((variant, index) => {
    const summary = variant.summary;
    if (!summary) {
      return;
    }
    const ci = summary.ciLowSol === null || summary.ciHighSol === null ? "n/a" : `[${signed(summary.ciLowSol)}, ${signed(summary.ciHighSol)}]`;
    const same = !variant.isBaseline && baselineFingerprint !== null && variant.fingerprint === baselineFingerprint;
    const delta =
      variant.isBaseline || baseline?.expectancySol == null || summary.expectancySol === null ? "" : signed(summary.expectancySol - baseline.expectancySol);
    lines.push(
      `  ${String(index + 1).padStart(2)}  ${`${variant.name}${variant.isBaseline ? " *" : ""}`.padEnd(26)} ${String(summary.trades).padStart(6)} ${pct(summary.winRate).padStart(6)} ${signed(summary.expectancySol).padStart(10)} ${ci.padStart(21)} ${signed(summary.totalPnlSol, 3).padStart(9)} ${summary.maxDrawdownSol.toFixed(3).padStart(7)} ${holdText(summary.avgHoldSec).padStart(6)}  ${delta.padStart(9)}  ${summary.verdict}${same ? ", same trades as the baseline" : ""}`
    );
  });
  for (const variant of result.variants.filter((entry) => entry.summary === null)) {
    lines.push(`   -  ${variant.name.padEnd(26)} ${variant.error ?? "not run"}`);
  }
  for (const name of result.skippedVariants) {
    lines.push(`   -  ${name.padEnd(26)} skipped: over --max-variants`);
  }
  return lines;
}

function exitLines(result: LabResult): string[] {
  const lines = ["exits (count, SOL)"];
  for (const variant of result.variants) {
    const reasons = variant.summary?.exitReasons ?? [];
    if (reasons.length === 0) {
      continue;
    }
    const text = reasons
      .slice(0, 5)
      .map((reason) => `${reason.reason} ${reason.n} (${signed(reason.pnlSol, 3)})`)
      .join(", ");
    lines.push(`  ${variant.name.padEnd(26)} ${text}`);
  }
  return lines.length > 1 ? lines : [];
}

function weightsLines(result: LabResult): string[] {
  const versions = [...new Set(result.variants.map((variant) => variant.weightsVersion).filter((version): version is string => version !== null))];
  return versions.length === 0 ? [] : [`weights  backtests scored with ${versions.join(", ")} (lab weights stay inactive until you activate one)`];
}

function runtimeLines(result: LabResult): string[] {
  const parts = [`scorer ${durationText(result.scorerRuntimeMs)}`];
  for (const variant of result.variants) {
    if (variant.runtimeMs !== null) {
      parts.push(`${variant.name} ${durationText(variant.runtimeMs)}${variant.events === null ? "" : ` (${variant.events} events)`}`);
    }
  }
  return [`runtime  ${parts.join(", ")}; total ${durationText(result.runtimeMs)}`];
}

export function pruneText(pruned: LabPruneResult): string {
  return `pruned   ${pruned.strategyRuns} lab strategy runs (${pruned.positions} positions, ${pruned.fills} fills, ${pruned.signals} signals) and ${pruned.weights} inactive lab weights; kept the latest ${pruned.kept} lab runs`;
}

export function formatLabReport(result: LabResult): string {
  const hours = (result.dataToMs - result.dataFromMs) / 3_600_000;
  const lines = [
    `== lab run ${result.labRunId} (${result.status}) ==`,
    `replay   ${iso(result.dataFromMs)} to ${iso(result.dataToMs)} (${Number(hours.toFixed(2))}h, every variant through the backtest runner)`
  ];
  if (result.error) {
    lines.push(`error    ${result.error}`);
  }
  lines.push("", ...scorerLines(result), "", ...leaderboardLines(result));
  const exits = exitLines(result);
  if (exits.length > 0) {
    lines.push("", ...exits);
  }
  lines.push("", ...weightsLines(result), ...runtimeLines(result));
  if (result.pruned) {
    lines.push(pruneText(result.pruned));
  }
  lines.push(
    "note     few trades per variant means wide intervals: treat the leaderboard as a hint until a variant reaches the edge verdict."
  );
  return lines.join("\n");
}
