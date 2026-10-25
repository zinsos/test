import { shortHash } from "./identity.js";
import { betsText, levelText, pctText, type LearnerReport, type VariantVerdict, type WeightsCandidate } from "./learner.js";
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

function verdictLine(variant: VariantVerdict, report: LearnerReport): string {
  const stats = variant.stats;
  const fewest = stats ? Math.min(stats.variantTrades, stats.baselineTrades) : 0;
  const trades = `${fewest}/${report.rule.minTrades}`;
  const windows = `${stats?.windows ?? 0}/${report.rule.minWindows}`;
  const gain = stats ? `${betsText(stats.gain)} (low ${betsText(stats.gainLow)})` : "n/a";
  const why = variant.reasons.length > 0 ? `: ${variant.reasons.join("; ")}` : "";
  return `  ${variant.name.padEnd(26)} trades ${trades.padStart(7)}  windows ${windows.padStart(5)}  gain/window ${gain.padEnd(24)} ${variant.verdict}${why}`;
}

function weightsText(candidate: WeightsCandidate): string {
  const gains = [candidate.latest.gain, candidate.previous?.gain ?? null].map((gain) => (gain === null ? "n/a" : `${gain >= 0 ? "+" : ""}${gain.toFixed(3)}`));
  return `${candidate.label}@${candidate.checkpointSec}s ${candidate.verdict} (AUC gain ${gains.join(" then ")})`;
}

function paperLine(report: LearnerReport): string {
  const paper = report.paper;
  if (paper.status === "no_run" || paper.status === "other_settings") {
    return `  paper      ${paper.status}`;
  }
  const coverage = paper.coverage === null ? "n/a" : `${Math.round(paper.coverage * 100)}%`;
  return `  paper      ${paper.status}: ${paper.matched} matched trades (${coverage} of the coins), replay minus paper ${pctText(paper.bias)}/trade [${pctText(paper.biasLow)}, ${pctText(paper.biasHigh)}] over ${paper.windows} windows`;
}

function stageLines(report: LearnerReport): string[] {
  const lines: string[] = [];
  const confirmation = report.confirmation;
  if (confirmation) {
    const result = confirmation.stats ? `; gain ${betsText(confirmation.stats.gain)} bets/window (low ${betsText(confirmation.stats.gainLow)})` : "";
    lines.push(
      `  confirming #${confirmation.promotionId} ${confirmation.name}: ${confirmation.collected}/${confirmation.needed} fresh windows, ${confirmation.variantTrades} trades, tested once at ${levelText(confirmation.confidence)}${result}`
    );
  }
  const probation = report.probation;
  if (probation) {
    const result = probation.stats ? `; old settings ${betsText(probation.stats.gain)} bets/window vs the change` : "";
    lines.push(`  probation  #${probation.promotionId} ${probation.name}: ${probation.collected}/${probation.needed} fresh windows against ${probation.undoName}${result}`);
  }
  return lines;
}

function learnerLines(result: LabResult): string[] {
  if (result.learnerError) {
    return [`learning failed: ${result.learnerError}`];
  }
  const report = result.learner;
  if (!report) {
    return [];
  }
  const rule = report.rule;
  const lines = [
    `learning (settings ${shortHash(report.identity.settingsHash)}, replay code ${report.identity.engineVersion ?? "unknown"}, ${report.windows.length} non-overlapping windows, baseline ${report.baseline.trades} trades ${betsText(report.baseline.perWindow)} bets/window${report.canPromote ? "" : "; report only"})`,
    `  rule       nominate at ${rule.minTrades}+ trades in ${rule.minWindows}+ windows with the gain per window above zero at ${levelText(rule.discoveryConfidence)} (${rule.comparisons} candidates); then confirm once on ${rule.confirmWindows}+ fresh windows at ${levelText(rule.nextConfirmConfidence)} for the next nominee`
  ];
  for (const variant of report.variants) {
    lines.push(verdictLine(variant, report));
  }
  lines.push(...stageLines(report));
  lines.push(`  decision   ${report.decision.kind}: ${report.decision.reason}`);
  if (report.promotion) {
    lines.push(`  promotion  #${report.promotion.id} ${report.promotion.status} (${report.promotion.name})${report.enabled ? "" : "; lab.autoLearn.enabled is off, so the service will not apply it"}`);
  }
  lines.push(paperLine(report));
  const weights = report.weights.candidates.map(weightsText);
  lines.push(`  weights    report only${weights.length > 0 ? `; ${weights.join(", ")}` : "; nothing trained"}`);
  return lines;
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
  const learning = learnerLines(result);
  if (learning.length > 0) {
    lines.push("", ...learning);
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
