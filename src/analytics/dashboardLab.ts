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
  var LEARN_VERDICTS = {
    candidate: ["Candidate", "good"], collecting: ["Collecting", "info"], not_better: ["Not better", ""], worse: ["Worse", "bad"],
    owner_only: ["Owner decides", "warn"], not_run: ["Not run", ""], tried: ["Tried", ""], confirming: ["Confirming", "info"], pending: ["Confirmed", "good"]
  };
  var PROMOTION_STATUS = {
    confirming: ["Confirming", "info"], pending: ["Waiting to apply", "info"], applied: ["Applied", "good"], rejected: ["Not confirmed", "bad"],
    superseded: ["Superseded", ""], reverted: ["Undone", "warn"]
  };
  var WEIGHTS_VERDICTS = { ready: ["Better twice", "good"], collecting: ["Collecting", "info"], not_better: ["Not better", ""] };
  var PAPER_CHECK = {
    no_run: "no paper run is open, so nothing is tested or changed",
    other_settings: "the open paper run started with other settings, so it is not compared",
    too_few: "too few paper trades match a replayed trade yet",
    unmatched: "the paper trader and the replay took different coins, so the replay is not trusted",
    consistent: "the replay matches the paper fills of the same coins",
    replay_optimistic: "the replay is more optimistic than the paper fills of the same coins, so nothing is changed"
  };
  var DECISION_TONE = { nominate: "info", confirm: "good", reject: "warn", withdraw: "", revert: "warn", keep: "good", hold: "" };

  function learnBets(value) { return isNum(value) ? signedText(Math.abs(value).toFixed(2), value) + " bets" : DASH; }
  function learnShare(value) { return isNum(value) ? fmtSignedPct(value * 100) : DASH; }
  function learnLevel(value) { return isNum(value) ? fmtPct(value, 2).replace(/\.?0+%$/, "%") : DASH; }
  function learnAuc(value) { return isNum(value) ? (value > 0 ? "+" : "") + minus(value.toFixed(3)) : DASH; }
  function learnScale(variants) {
    var lo = 0;
    var hi = 0;
    variants.forEach(function (v) {
      var st = v.stats;
      if (!st) { return; }
      [st.gain, st.gainLow, st.gainHigh].forEach(function (value) { if (isNum(value)) { lo = Math.min(lo, value); hi = Math.max(hi, value); } });
    });
    if (hi - lo < 1e-9) { return null; }
    var pad = (hi - lo) * 0.06;
    return { lo: lo - pad, hi: hi + pad };
  }
  function learnAxis(scale) {
    if (!scale) { return null; }
    var at = labAt(scale, 0);
    var zero = el("span", { class: "lb-tick zero", text: "0" });
    zero.style.left = at.toFixed(2) + "%";
    return el("div", { class: "lb-axis-labels learn-axis", "aria-hidden": "true" },
      at > 30 ? el("span", { class: "lb-tick first", text: learnBets(scale.lo) }) : null, zero, at < 70 ? el("span", { class: "lb-tick last", text: learnBets(scale.hi) }) : null);
  }
  function learnBar(st, scale) {
    if (!scale || !st || !isNum(st.gain)) { return null; }
    var zero = el("span", { class: "lb-zero" });
    zero.style.left = labAt(scale, 0).toFixed(2) + "%";
    var parts = [el("span", { class: "lb-axis" }), zero];
    if (isNum(st.gainLow) && isNum(st.gainHigh)) {
      var ci = el("span", { class: "lb-ci " + (st.gainLow > 0 ? "pos" : st.gainHigh < 0 ? "neg" : "") });
      ci.style.left = labAt(scale, st.gainLow).toFixed(2) + "%";
      ci.style.width = Math.max(0.5, labAt(scale, st.gainHigh) - labAt(scale, st.gainLow)).toFixed(2) + "%";
      parts.push(ci);
    }
    var point = el("span", { class: "lb-pt " + signClass(st.gain) });
    point.style.left = labAt(scale, st.gain).toFixed(2) + "%";
    parts.push(point);
    return el("div", { class: "lb-range", role: "img", "aria-label": "Gain " + learnBets(st.gain) + " per window, range " + learnBets(st.gainLow) + " to " + learnBets(st.gainHigh) }, parts);
  }
  function learnStatsLine(st) {
    if (!st) { return null; }
    return el("div", { class: "meta", text: "Better in " + fmtInt(st.positive) + " of " + fmtInt(st.windows) + " windows" + DOT + "without its best window " + learnBets(st.withoutBest) +
      DOT + "older half " + learnBets(st.older) + DOT + "newer half " + learnBets(st.newer) + DOT + "own " + learnBets(st.own) + " per window" +
      DOT + learnShare(st.variantPerTrade) + " per trade vs " + learnShare(st.baselinePerTrade) });
  }
  function learnVariantRow(v, report, scale) {
    var verdict = LEARN_VERDICTS[v.verdict] || [sentence(readable(v.verdict)), ""];
    var st = v.stats;
    var fewest = st ? Math.min(st.variantTrades, st.baselineTrades) : 0;
    return el("li", { class: "learn-row" },
      el("div", { class: "row" }, el("strong", { class: "lab-name", text: sentence(readable(v.name)) }), badge(verdict[0], verdict[1])),
      v.description ? el("div", { class: "meta learn-desc", text: v.description }) : null,
      st ? el("div", { class: "learn-figs" },
        el("span", { class: "big-num " + signClass(st.gain), text: learnBets(st.gain) }),
        el("span", { class: "meta", text: " per window vs the baseline" + DOT + learnLevel(st.confidence) + " lower bound " + learnBets(st.gainLow) })) : null,
      learnBar(st, scale),
      learnStatsLine(st),
      meter(v.tradeProgress),
      el("div", { class: "meta learn-progress", text: fmtInt(fewest) + " of " + fmtInt(report.minTrades) + " trades in both" + DOT + fmtInt(st ? st.windows : 0) + " of " + fmtInt(report.minWindows) + " windows" }),
      v.reasons.length ? el("ul", { class: "learn-reasons" }, v.reasons.map(function (reason) { return el("li", { text: reason }); })) : null,
      v.changes.length ? el("p", { class: "learn-changes", text: v.changes.join("; ") }) : null);
  }
  function learnRuleText(r) {
    var hours = isNum(r.windowHours) ? r.windowHours : 3;
    return "Step 1, nominate: with " + fmtInt(r.minTrades) + "+ trades in it and in the baseline over " + fmtInt(r.minWindows) + "+ non-overlapping " + hours + "-hour replays, a variant's extra profit per window must be above zero with " +
      learnLevel(r.discoveryConfidence) + " confidence (corrected for " + fmtInt(r.comparisons) + (r.comparisons === 1 ? " candidate" : " candidates") +
      "), it must make money on its own, be better in most windows, still be ahead without its best window and in both the older and the newer half, and the paper fills must back the replay. " +
      "Step 2, confirm: the nominee is replayed on at least " + fmtInt(r.confirmWindows) + " fresh windows that start after the nomination and is tested once, at " + learnLevel(r.nextConfirmConfidence) +
      " for the next nominee with these settings (each nominee is held to a stricter level than the one before). Only then does the paper trader switch. Step 3, probation: after the switch the old settings keep being replayed; if they do as well on fresh windows, the change is undone. " +
      "Trades opened in the last max-hold of a window are not counted, so no trade is cut off by the window end. Risk limits, bet sizing, the fill model, hard blocks and looser risk-score limits are never changed, and live mode never uses learned settings.";
  }
  function learnDecision(r) {
    var d = r.decision;
    var tone = DECISION_TONE[d.kind] || "";
    var how = "";
    if (d.kind === "confirm") {
      how = r.enabled ? " The paper trader switches once no position is open, then restarts and keeps its bankroll, peak and day." : " Auto-apply is off (lab.autoLearn.enabled), so nothing changes until it is turned on.";
    }
    var lead = { nominate: "Testing on fresh data. ", confirm: "Confirmed. ", reject: "Not confirmed. ", withdraw: "Withdrawn. ", revert: "Undoing a change. ", keep: "Change kept. " }[d.kind] || "Keeping the current settings. ";
    return banner(tone, tone === "good" ? "check" : "info", el("strong", { text: lead }), el("span", { text: d.reason + "." + how }));
  }
  function learnInEffect(inEffect) {
    if (!inEffect) { return null; }
    if (inEffect.problem) { return banner("warn", "alert", el("span", { text: inEffect.problem + "." })); }
    if (!inEffect.changes.length) {
      return el("p", { class: "subline", text: inEffect.autoLearn ? "The paper trader runs the strategy file as is; no learned change is in effect." : "Auto-learn is off, so the paper trader runs the strategy file as is." });
    }
    return banner("info", "lab", el("strong", { text: "Learned changes in effect. " }),
      el("span", { text: "The paper trader runs the strategy file plus promotion #" + inEffect.promotionId + " (" + sentence(readable(inEffect.name)) + ", " + fmtAgo(inEffect.appliedAtMs) + "): " + inEffect.changes.join("; ") + ". Live mode and the file itself are never changed." }));
  }
  function learnStage(r) {
    var out = [];
    var c = r.confirmation;
    if (c) {
      out.push(el("div", { class: "learn-stage" },
        el("div", { class: "row" }, el("strong", { text: "Confirming " + sentence(readable(c.name)) }), badge(c.complete ? "Tested" : "Collecting", c.complete ? "" : "info")),
        meter(c.needed > 0 ? c.collected / c.needed : 0),
        el("div", { class: "meta", text: fmtInt(c.collected) + " of " + fmtInt(c.needed) + " fresh windows since " + fmtTime(c.fromMs) + DOT + fmtInt(c.variantTrades) + " trades" + DOT + "tested once at " + learnLevel(c.confidence) + " (nominee #" + fmtInt(c.index) + " with these settings)" }),
        c.stats ? learnStatsLine(c.stats) : null,
        c.reasons.length ? el("ul", { class: "learn-reasons" }, c.reasons.map(function (reason) { return el("li", { text: reason }); })) : null));
    }
    var p = r.probation;
    if (p) {
      out.push(el("div", { class: "learn-stage" },
        el("div", { class: "row" }, el("strong", { text: "Probation for " + sentence(readable(p.name)) }), badge(p.result === "revert" ? "Undo" : p.result === "kept" ? "Kept" : "Running", p.result === "revert" ? "warn" : p.result === "kept" ? "good" : "info")),
        meter(p.needed > 0 ? p.collected / p.needed : 0),
        el("div", { class: "meta", text: fmtInt(p.collected) + " of " + fmtInt(p.needed) + " fresh windows replay the old settings (" + p.undoName + ") next to the new ones" + (p.stats ? DOT + "old minus new " + learnBets(p.stats.gain) + " per window" : "") })));
    }
    return out;
  }
  function learnPaperText(p) {
    var base = PAPER_CHECK[p.status] || readable(p.status);
    if (p.status === "no_run" || p.status === "other_settings") { return sentence(base); }
    return sentence(base) + DOT + fmtInt(p.matched) + " paper trades matched a replayed trade (" + (isNum(p.coverage) ? fmtPlainPct(p.coverage * 100) : DASH) + " of the coins, needs " + fmtInt(p.needed) + ")" +
      DOT + "replay minus paper " + learnShare(p.bias) + " per trade (95% range " + learnShare(p.biasLow) + " to " + learnShare(p.biasHigh) + ")";
  }
  function learnWeights(r) {
    var gain = isNum(r.weightsMinGain) ? learnAuc(r.weightsMinGain) : "+0.030";
    var rows = isNum(r.weightsMinRows) ? fmtInt(r.weightsMinRows) : "1,000";
    var hint = "Retrained weights qualify when they beat the active " + (r.weightsActive || "weights") + " by " + gain + " AUC on " + rows + "+ held-out launches in two lab runs whose validation windows do not overlap. This is a hint, not a confirmed result, and they are never activated: new weights move every risk score, and the entry thresholds were set on the current scale.";
    if (!r.weights.length) { return [el("h3", { text: "Scorer weights (reported only)" }), el("p", { class: "hint", text: hint }), el("p", { class: "subline", text: "Nothing was trained in the latest lab run." })]; }
    var body = r.weights.map(function (w) {
      var verdict = WEIGHTS_VERDICTS[w.verdict] || [sentence(readable(w.verdict)), ""];
      return el("tr", { title: w.reasons.join("; ") || null },
        cell(readable(w.label) + (isNum(w.checkpointSec) ? " at " + w.checkpointSec + "s" : ""), "t-left"),
        cell(learnAuc(w.latestGain), signClass(w.latestGain)),
        cell(learnAuc(w.previousGain), "hide-narrow " + signClass(w.previousGain)),
        cell(fmtInt(w.latestRows), "hide-narrow"),
        el("td", null, badge(verdict[0], verdict[1])));
    });
    return [el("h3", { text: "Scorer weights (reported only)" }), el("p", { class: "hint", text: hint }),
      table(["Label", "AUC gain", "Earlier run", "Rows", "Verdict"], body, { 2: true, 3: true }, null, { 0: true })];
  }
  function learnEvidence(p) {
    if (!isNum(p.gain)) { return DASH; }
    return learnBets(p.gain) + " per window (lower bound " + learnBets(p.gainLow) + ")" + (isNum(p.trades) ? " over " + fmtInt(p.trades) + " trades" : "") + (isNum(p.windows) ? " in " + fmtInt(p.windows) + " windows" : "");
  }
  function learnPromotions(list) {
    if (!list.length) { return [el("h3", { text: "Promotions" }), el("p", { class: "subline", text: "No promotion yet. A nominee needs days of replays with the same settings, then days of fresh replays to confirm." })]; }
    var last = list[0];
    var status = PROMOTION_STATUS[last.status] || [sentence(readable(last.status)), ""];
    var pairs = [
      [last.kind === "revert" ? "Undo" : "Variant", sentence(readable(last.name))],
      ["Evidence", learnEvidence(last)],
      ["Created", fmtTime(last.createdAtMs) + (isNum(last.labRunId) ? DOT + "lab run #" + last.labRunId : "")]
    ];
    if (isNum(last.confirmWindows)) { pairs.push(["Confirmation", fmtInt(last.confirmWindows) + " fresh windows" + (isNum(last.confirmIndex) ? DOT + "nominee #" + last.confirmIndex : "")]); }
    if (isNum(last.appliedAtMs)) { pairs.push(["Applied", fmtTime(last.appliedAtMs) + (isNum(last.endedRunId) ? DOT + "paper run #" + last.endedRunId + " ended, bankroll carried over" : "")]); }
    if (last.probationResult) { pairs.push(["Probation", last.probationResult === "kept" ? "passed" : "undone"]); }
    if (last.changes.length) { pairs.push(["Changes", last.changes.join("; ")]); }
    if (last.note) { pairs.push(["Note", last.note]); }
    var out = [el("div", { class: "row learn-last" }, el("h3", { text: "Last promotion #" + last.id }), badge(status[0], status[1])), kv(pairs)];
    if (list.length > 1) {
      out.push(table(["When", "Variant", "Status", "Gain"], list.map(function (p) {
        var s = PROMOTION_STATUS[p.status] || [sentence(readable(p.status)), ""];
        return el("tr", { title: p.note || null }, cell(fmtWhen(isNum(p.appliedAtMs) ? p.appliedAtMs : p.createdAtMs)), cell(sentence(readable(p.name)), "t-left"), el("td", null, badge(s[0], s[1])), cell(learnBets(p.gain), signClass(p.gain)));
      }), null, null, { 1: true }));
    }
    return out;
  }
  function learningCard(learning) {
    var hint = "Pools the replays that used exactly the paper settings and the current code, and changes the paper settings only after a nominee confirms on fresh data.";
    if (!learning) { return null; }
    if (!learning.available) { return card("Learning", "Run the database migrations so the learner can store its results."); }
    var r = learning.report;
    var failed = learning.error ? el("p", { class: "error-text", text: "The latest learner run failed: " + learning.error }) : null;
    if (!r) {
      return card("Learning", hint, failed, learnInEffect(learning.inEffect), el("p", { class: "subline", text: "The learner runs at the end of every lab run. Its first verdicts appear after the next one." }), learnPromotions(learning.promotions));
    }
    var scale = learnScale(r.variants);
    var span = isNum(r.windowsFromMs) && isNum(r.windowsToMs) ? fmtDay(r.windowsFromMs) + " to " + fmtDay(r.windowsToMs) : "none yet";
    return el("section", { class: "card learn-card" },
      el("div", { class: "card-head" },
        el("div", null, el("h2", { class: "card-title", text: "Learning" }), el("p", { class: "hint", text: hint }),
          el("div", { class: "badges" }, badge(r.enabled ? "Auto-apply on" : "Auto-apply off", r.enabled ? "good" : ""), badge("Paper only", "info"), r.canPromote ? null : badge("Report only", "warn")))),
      failed,
      learnInEffect(learning.inEffect),
      learnDecision(r),
      learnStage(r),
      grid([
        stat("Windows", fmtInt(r.windows), span),
        stat("Baseline trades", fmtInt(r.baseline.trades), "replayed with the paper settings"),
        stat("Baseline per window", learnBets(r.baseline.perWindow), learnShare(r.baseline.perTrade) + " per trade", signClass(r.baseline.perWindow)),
        stat("Settings", r.settings, "code " + (r.engine || DASH) + "; evidence restarts when either changes")
      ]),
      el("p", { class: "subline", text: learnRuleText(r) }),
      r.variants.length ? [learnAxis(scale), el("ul", { class: "learn-list" }, r.variants.map(function (v) { return learnVariantRow(v, r, scale); }))]
        : el("p", { class: "subline", text: "No variants are configured in config/lab-variants.json." }),
      el("p", { class: "subline", text: "Paper check: " + learnPaperText(r.paper) + "." }),
      learnWeights(r),
      learnPromotions(learning.promotions));
  }
  function labView() {
    return api("/api/lab").then(function (lab) {
      if (!lab.available) {
        return empty("Lab tables are missing", "Run the database migrations (npm run migrate, or restart the service) so the lab job can store its results.");
      }
      if (!lab.run) {
        return empty("No lab run yet", "The lab replays the recorded launches through several strategy variants with the real trader, fills and fees, and retrains the scorer, so you can compare ideas in minutes instead of weeks of paper trading. The first results appear here after the lab job has run once.");
      }
      var out = [labRunCard(lab), labTakeawayCard(lab.takeaway), learningCard(lab.learning), labLeaderboard(lab)];
      lab.scorer.forEach(function (entry) { out.push(labScorerCard(entry)); });
      if (!lab.scorer.length) { out.push(card("Scorer training", "This run did not retrain the scorer.")); }
      out.push(labHistoryCard(lab.history));
      return out;
    });
  }
`;
