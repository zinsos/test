export const LAB_VIEW_SCRIPT = String.raw`
  var LAB_VERDICTS = { edge: ["Edge", "good"], no_edge: ["No edge yet", "warn"], insufficient_data: ["Too few trades", ""] };
  var LAB_DIRECTIONS = { higher_riskier: "Riskier when higher", lower_riskier: "Riskier when lower", none: "No clear direction" };
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
      el("div", { class: "row" }, el("h2", { class: "card-title", text: "Lab run #" + run.id }), labStatusBadge(run)),
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
  function labScale(variants) {
    var lo = 0;
    var hi = 0;
    variants.forEach(function (row) {
      var s = row.summary;
      if (!s || !(s.trades > 0)) { return; }
      [s.expectancySol, s.ciLowSol, s.ciHighSol].forEach(function (value) { if (isNum(value)) { lo = Math.min(lo, value); hi = Math.max(hi, value); } });
    });
    if (hi - lo < 1e-9) { return null; }
    var pad = (hi - lo) * 0.06;
    return { lo: lo - pad, hi: hi + pad };
  }
  function labAt(scale, value) { return ((value - scale.lo) / (scale.hi - scale.lo)) * 100; }
  function labScaleAxis(scale, cls) {
    if (!scale) { return null; }
    var at = labAt(scale, 0);
    var zero = el("span", { class: "lb-tick zero", text: "0" });
    zero.style.left = at.toFixed(2) + "%";
    return el("div", { class: "lb-axis-labels " + (cls || ""), "aria-hidden": "true" },
      at > 30 ? el("span", { class: "lb-tick first", text: fmtSol(scale.lo) }) : null, zero, at < 70 ? el("span", { class: "lb-tick last", text: fmtSol(scale.hi) }) : null);
  }
  function labRangeBar(s, scale) {
    if (!scale || !s || !(s.trades > 0) || !isNum(s.expectancySol)) { return null; }
    var zero = el("span", { class: "lb-zero" });
    zero.style.left = labAt(scale, 0).toFixed(2) + "%";
    var parts = [el("span", { class: "lb-axis" }), zero];
    if (isNum(s.ciLowSol) && isNum(s.ciHighSol)) {
      var ci = el("span", { class: "lb-ci " + (s.ciLowSol > 0 ? "pos" : s.ciHighSol < 0 ? "neg" : "") });
      ci.style.left = labAt(scale, s.ciLowSol).toFixed(2) + "%";
      ci.style.width = Math.max(0.5, labAt(scale, s.ciHighSol) - labAt(scale, s.ciLowSol)).toFixed(2) + "%";
      parts.push(ci);
    }
    var point = el("span", { class: "lb-pt " + signClass(s.expectancySol) });
    point.style.left = labAt(scale, s.expectancySol).toFixed(2) + "%";
    parts.push(point);
    return el("div", { class: "lb-range", role: "img", "aria-label": "Expectancy " + fmtSol(s.expectancySol) + " SOL per trade, 95% range " + labRange(s) }, parts);
  }
  function labVariantName(row) {
    var name = sentence(readable(row.name));
    if (!row.strategyRunId) { return el("strong", { class: "lab-name", text: name }); }
    return el("button", { class: "lab-name lab-open", type: "button", title: "Open in Performance", "aria-label": name + ", open in Performance", onclick: function () { openLabRun(row.strategyRunId); } },
      el("span", { text: name }), icon("performance"));
  }
  function labVariantItem(row, scale) {
    var s = row.summary;
    var traded = !!(s && s.trades > 0);
    var badges = [];
    if (row.isBaseline) { badges.push(badge("Baseline", "info")); }
    if (s && traded) {
      var verdict = LAB_VERDICTS[s.verdict] || [sentence(readable(s.verdict || "unknown")), ""];
      badges.push(badge(verdict[0], verdict[1]));
    } else if (s) {
      badges.push(badge("No trades", ""));
    }
    if (row.sameTradesAsBaseline) { badges.push(badge("Same trades as baseline", "")); }
    var skipped = !!row.error && row.error.indexOf("skipped: ") === 0;
    if (row.error) { badges.push(skipped ? badge("Not run", "") : badge("Failed", "bad")); }
    var drawdown = s && isNum(s.maxDrawdownSol) ? fmtSol(-Math.abs(s.maxDrawdownSol)) : DASH;
    var vs = isNum(row.vsBaselineSol) ? fmtSol(row.vsBaselineSol) : DASH;
    return el("li", { class: "lab-row lab-variant" + (row.isBaseline ? " baseline" : "") },
      el("div", { class: "l-name" }, labVariantName(row), row.description ? el("div", { class: "meta", text: row.description }) : null),
      el("div", { class: "l-exp big-num " + signClass(traded ? s.expectancySol : null) }, traded ? fmtSol(s.expectancySol) : DASH, traded ? el("span", { class: "unit", text: " SOL/trade" }) : null),
      el("div", { class: "l-bar" }, s ? labRangeBar(s, scale) : null),
      s ? el("div", { class: "l-meta meta", text: fmtInt(s.trades) + " trades" + DOT + "win " + fmtPct(s.winRate, 0) + DOT + "total " + fmtSol(s.totalPnlSol) + " SOL" + DOT + "max drawdown " + drawdown }) : null,
      s ? el("div", { class: "l-meta meta", text: "95% range " + labRange(s) + (isNum(row.vsBaselineSol) ? DOT + "vs baseline " + vs + " per trade" : "") + (isNum(s.avgHoldSec) ? DOT + "avg hold " + fmtDur(s.avgHoldSec) : "") }) : null,
      el("div", { class: "l-num l-trades", text: s ? fmtInt(s.trades) : DASH }),
      el("div", { class: "l-num l-win", text: s ? fmtPct(s.winRate, 0) : DASH }),
      el("div", { class: "l-num l-total " + (s ? signClass(s.totalPnlSol) : ""), text: s ? fmtSol(s.totalPnlSol) : DASH }),
      el("div", { class: "l-num l-dd", text: drawdown }),
      el("div", { class: "l-num l-vs " + signClass(row.vsBaselineSol), text: vs }),
      el("div", { class: "l-verdict badges" }, badges),
      row.error ? el("div", { class: "l-error " + (skipped ? "meta" : "error-text"), text: skipped ? "Not run: " + row.error.slice(9) : row.error }) : null);
  }
  function labLeaderboard(lab) {
    if (!lab.variants.length) { return empty("No strategies in this run", "The lab run finished without variants. Check config/lab-variants.json and the lab job's log."); }
    var scale = labScale(lab.variants);
    var header = el("li", { class: "lab-row lab-header", "aria-hidden": "true" },
      el("div", { class: "l-name", text: "Strategy" }), el("div", { class: "l-exp", text: "Exp/trade" }),
      el("div", { class: "l-bar" }, el("span", { class: "l-bar-title", text: "95% range" }), labScaleAxis(scale)),
      el("div", { class: "l-num", text: "Trades" }), el("div", { class: "l-num", text: "Win" }), el("div", { class: "l-num", text: "Total" }),
      el("div", { class: "l-num", text: "Max DD" }), el("div", { class: "l-num", text: "vs base" }), el("div", { class: "l-verdict", text: "Verdict" }));
    return card("Strategy leaderboard", "Replayed over the same recorded launches with the real trader, fills and fees, best expectancy first. Tap a name to open its trades in Performance.",
      labScaleAxis(scale, "phone-scale"),
      el("ul", { class: "lab-board" }, header, lab.variants.map(function (row) { return labVariantItem(row, scale); })));
  }
  function labImportance(feature) { return isNum(feature.auc) ? Math.min(1, Math.abs(feature.auc - 0.5) * 2) : 0; }
  function labFeatureBars(features) {
    return el("ul", { class: "list bars" }, features.map(function (feature) {
      var fill = el("span", { class: "bar-fill " + (feature.direction === "lower_riskier" ? "down" : feature.direction === "higher_riskier" ? "up" : "") });
      fill.style.width = (labImportance(feature) * 100).toFixed(1) + "%";
      var details = ["AUC " + fmtNum(feature.auc, 2), LAB_DIRECTIONS[feature.direction] || sentence(readable(feature.direction || ""))];
      if (isNum(feature.coverage)) { details.push(fmtPct(feature.coverage, 0) + " coverage"); }
      if (isNum(feature.weight)) { details.push("weight " + fmtNum(feature.weight, 2)); }
      return el("li", { class: "bar-row" },
        el("div", { class: "row" }, el("span", { class: "bar-name", text: sentence(readable(feature.name)) })),
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
      stat("Change", lift === null ? DASH : (lift > 0 ? "+" : "") + minus(lift.toFixed(3)), lift === null ? "" : lift > 0.01 ? "retrained is better" : lift < -0.01 ? "current is better" : "about the same", tone),
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
    return card("Baseline over time", "The current strategy's expectancy in each lab run, with its 95% range. A drifting number means the market changed, not the code.",
      labHistoryChart(history), table(["Run", "Trades", "Exp/trade", "95% range"], rows, { 3: true }));
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
