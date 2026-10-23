export const LAB_VIEW_SCRIPT = String.raw`
  var LAB_VERDICTS = { edge: ["Edge", "good"], no_edge: ["No edge yet", "warn"], insufficient_data: ["Too few trades", ""] };
  var LAB_DIRECTIONS = { higher_riskier: "riskier when higher", lower_riskier: "riskier when lower", none: "no clear direction" };
  var LAB_TONES = { good: "good", warn: "warn", bad: "bad", neutral: "neutral" };

  function labWindow(run) {
    if (!run || !isNum(run.dataFromMs) || !isNum(run.dataToMs)) { return "unknown"; }
    return fmtTime(run.dataFromMs) + " to " + fmtTime(run.dataToMs) + " (" + fmtDur((run.dataToMs - run.dataFromMs) / 1000) + ")";
  }
  function labStatusBadge(run) {
    if (run.status === "running") { return badge("Running", "info"); }
    if (run.status === "failed") { return badge("Failed", "bad"); }
    return badge("Done", "good");
  }
  function openLabRun(runId) {
    state.runId = String(runId);
    state.mode = "backtest";
    savePrefs();
    selectTab("edge");
  }
  function labRunCard(lab) {
    var run = lab.run;
    var latest = lab.latest;
    var when = isNum(run.finishedAtMs) ? "Finished " + fmtAgo(run.finishedAtMs) + DOT + fmtTime(run.finishedAtMs) : "Started " + fmtAgo(run.startedAtMs);
    var out = [
      el("div", { class: "row" }, el("h2", { text: "Lab run #" + run.id }), labStatusBadge(run)),
      el("p", { class: "subline", text: when + DOT + fmtInt(lab.runs) + (lab.runs === 1 ? " run so far" : " runs so far") }),
      el("p", { class: "subline", text: "Data window: " + labWindow(run) })
    ];
    if (run.error) { out.push(el("p", { class: "error-text", text: run.error })); }
    if (latest && latest.id !== run.id) {
      out.push(el("p", { class: "detail", text: latest.status === "running"
        ? "Run #" + latest.id + " is running now (started " + fmtAgo(latest.startedAtMs) + "). Its results replace these when it finishes."
        : "Run #" + latest.id + " failed" + (latest.error ? ": " + latest.error : "") + ". Showing the last finished run." }));
    }
    return el("section", { class: "card" }, out);
  }
  function labTakeawayCard(takeaway) {
    if (!takeaway) { return null; }
    var tone = LAB_TONES[takeaway.tone] || "neutral";
    return el("section", { class: "card hero " + (tone === "neutral" ? "" : tone) },
      badge(TONE_LABELS[tone] || "", tone === "neutral" ? "" : tone),
      el("p", { class: "headline", text: takeaway.headline }),
      el("p", { class: "detail", text: takeaway.detail }));
  }
  function labRange(s) {
    return isNum(s.ciLowSol) && isNum(s.ciHighSol) ? fmtSol(s.ciLowSol) + " to " + fmtSol(s.ciHighSol) : DASH;
  }
  function labVariantItem(row) {
    var s = row.summary;
    var traded = !!(s && s.trades > 0);
    var badges = [];
    if (row.isBaseline) { badges.push(badge("Baseline", "info")); }
    if (s && traded) {
      var verdict = LAB_VERDICTS[s.verdict] || [readable(s.verdict || "unknown"), ""];
      badges.push(badge(verdict[0], verdict[1]));
    } else if (s) {
      badges.push(badge("No trades", ""));
    }
    if (row.error) { badges.push(badge("Failed", "bad")); }
    var out = [
      el("div", { class: "row" }, el("strong", { class: "lab-name", text: readable(row.name) }),
        el("span", { class: "big-num " + signClass(traded ? s.expectancySol : null) }, traded ? fmtSol(s.expectancySol) : DASH, traded ? el("span", { class: "unit", text: " SOL/trade" }) : null)),
      row.description ? el("div", { class: "meta", text: row.description }) : null
    ];
    if (s) {
      out.push(el("div", { class: "meta", text: fmtInt(s.trades) + " trades" + DOT + "win " + fmtPct(s.winRate, 0) + DOT + "total " + fmtSol(s.totalPnlSol) + " SOL" + DOT + "max drawdown " + (isNum(s.maxDrawdownSol) ? fmtSol(-Math.abs(s.maxDrawdownSol)) : DASH) }));
      out.push(el("div", { class: "meta", text: "95% range " + labRange(s) + (isNum(row.vsBaselineSol) ? DOT + "vs baseline " + fmtSol(row.vsBaselineSol) + " per trade" : "") + (isNum(s.avgHoldSec) ? DOT + "avg hold " + fmtDur(s.avgHoldSec) : "") }));
    }
    if (row.error) { out.push(el("div", { class: "error-text", text: row.error })); }
    out.push(el("div", { class: "row" }, el("div", { class: "badges" }, badges),
      row.strategyRunId ? el("button", { class: "link-btn", type: "button", text: "Open in Edge", onclick: function () { openLabRun(row.strategyRunId); } }) : null));
    return el("li", { class: "item lab-variant" + (row.isBaseline ? " baseline" : "") }, out);
  }
  function labLeaderboard(lab) {
    if (!lab.variants.length) { return empty("No strategies in this run", "The lab run finished without variants. Check config/lab-variants.json and the lab job's log."); }
    return card("Strategy leaderboard", "Each strategy replayed over the same recorded data with the real trader, fills and fees. Sorted by expectancy (SOL per trade after fees); the baseline is the current strategy.",
      el("ul", { class: "list" }, lab.variants.map(labVariantItem)));
  }
  function labImportance(feature) { return isNum(feature.auc) ? Math.min(1, Math.abs(feature.auc - 0.5) * 2) : 0; }
  function labFeatureBars(features) {
    return el("ul", { class: "list bars" }, features.map(function (feature) {
      var fill = el("span", { class: "bar-fill " + (feature.direction === "lower_riskier" ? "down" : feature.direction === "higher_riskier" ? "up" : "") });
      fill.style.width = (labImportance(feature) * 100).toFixed(1) + "%";
      var details = ["AUC " + fmtNum(feature.auc, 2), LAB_DIRECTIONS[feature.direction] || readable(feature.direction || "")];
      if (isNum(feature.coverage)) { details.push(fmtPct(feature.coverage, 0) + " coverage"); }
      if (isNum(feature.weight)) { details.push("weight " + fmtNum(feature.weight, 2)); }
      return el("li", { class: "bar-row" },
        el("div", { class: "row" }, el("span", { class: "bar-name", text: readable(feature.name) })),
        el("div", { class: "bar-track" }, fill),
        el("div", { class: "meta", text: details.join(DOT) }));
    }));
  }
  function labScorerCard(entry) {
    var title = "Scorer: " + readable(entry.label) + " at " + (isNum(entry.checkpointSec) ? entry.checkpointSec + "s" : "?");
    if (entry.skipReason) {
      return card(title, "Skipped: " + entry.skipReason + DOT + fmtInt(entry.rows) + " launches, " + fmtInt(entry.positives) + " positive.");
    }
    var lift = isNum(entry.validationAuc) && isNum(entry.baselineAuc) ? entry.validationAuc - entry.baselineAuc : null;
    var tone = lift === null ? "" : lift > 0.01 ? "pos" : lift < -0.01 ? "neg" : "";
    var parts = [grid([
      stat("Retrained AUC", fmtNum(entry.validationAuc, 3), "on held-out launches"),
      stat("Current AUC", fmtNum(entry.baselineAuc, 3), "weights in use now"),
      stat("Change", lift === null ? DASH : (lift > 0 ? "+" : "") + lift.toFixed(3), lift === null ? "" : lift > 0.01 ? "retrained is better" : lift < -0.01 ? "current is better" : "about the same", tone),
      stat("Launches", fmtInt(entry.rows), fmtInt(entry.positives) + " " + readable(entry.label))
    ])];
    if (entry.features.length) {
      parts.push(el("h3", { text: "Top features" }), el("p", { class: "hint", text: "Bar length is how well the feature alone separates outcomes (AUC distance from a coin flip)." }), labFeatureBars(entry.features));
    }
    if (entry.calibration.length) {
      parts.push(el("h3", { text: "Calibration" }), table(["Score", "Launches", readable(entry.label) + " rate"], entry.calibration.map(function (row) {
        return el("tr", null, cell(row.bucket), cell(fmtInt(row.n)), cell(fmtPct(row.positiveRate, 0)));
      })));
    }
    if (entry.weightsVersion) { parts.push(el("p", { class: "subline", text: "Retrained weights " + entry.weightsVersion }) ); }
    return card(title, "AUC 0.5 is a coin flip and 1.0 is perfect. Both scores are measured on the newest launches, which the retrained weights never saw.", parts);
  }
  function labHistoryCard(history) {
    if (history.length < 2) { return null; }
    var rows = history.slice().reverse().map(function (point) {
      return el("tr", null, cell("#" + point.labRunId + " " + fmtDay(point.startedAtMs)), cell(fmtInt(point.trades)),
        cell(fmtSol(point.expectancySol), signClass(point.expectancySol)),
        cell(isNum(point.ciLowSol) && isNum(point.ciHighSol) ? fmtSol(point.ciLowSol) + " to " + fmtSol(point.ciHighSol) : DASH, "hide-narrow"));
    });
    return card("Baseline over time", "The current strategy's expectancy in each lab run. A drifting number means the market changed, not the code.",
      table(["Run", "Trades", "Exp/trade", "95% range"], rows, { 3: true }));
  }
  function labView() {
    return api("/api/lab").then(function (lab) {
      if (!lab.available) {
        return empty("Lab tables are missing", "Run the database migrations (npm run migrate, or restart the service) so the lab job can store its results.");
      }
      if (!lab.run) {
        return empty("No lab run yet", "The lab replays the recorded launches through several strategy variants with the real trader, fills and fees, and retrains the scorer, so you can compare ideas in minutes instead of weeks of paper trading. The first results appear here after the lab job has run once.");
      }
      var out = [labRunCard(lab), labTakeawayCard(lab.takeaway), labLeaderboard(lab)];
      lab.scorer.forEach(function (entry) { out.push(labScorerCard(entry)); });
      if (!lab.scorer.length) { out.push(card("Scorer training", "This run did not retrain the scorer.")); }
      out.push(labHistoryCard(lab.history));
      return out;
    });
  }
`;
