export const ANALYSIS_SCRIPT = String.raw`
  function progressBlock(summary) {
    if (summary.n === 0 || summary.verdict === "edge" || summary.significance === "negative") { return null; }
    var min = summary.minTrades;
    var needed = isNum(summary.tradesNeeded) ? summary.tradesNeeded : null;
    if (summary.verdict === "insufficient_data") {
      var text = fmtInt(summary.n) + " of " + fmtInt(min) + " trades for a first verdict";
      return [meter(summary.n / Math.max(1, min)), el("p", { class: "subline", text: text })];
    }
    if (needed === null) { return null; }
    return [meter(summary.n / Math.max(1, needed)), el("p", { class: "subline", text: fmtInt(summary.n) + " of about " + fmtInt(needed) + " trades needed to know" })];
  }
  function edgeStats(s) {
    return grid([
      stat("Win rate", fmtPct(s.winRate, 0), fmtInt(s.wins) + " won" + DOT + fmtInt(s.losses) + " lost"),
      stat("Profit factor", fmtNum(s.profitFactor), "gross win / gross loss"),
      stat("Avg win", fmtSol(s.avgWinSol), "SOL", "pos"),
      stat("Avg loss", isNum(s.avgLossSol) ? fmtSol(-s.avgLossSol) : DASH, "SOL", "neg"),
      stat("Best trade", fmtSol(s.bestTradeSol), "SOL", signClass(s.bestTradeSol)),
      stat("Worst trade", fmtSol(s.worstTradeSol), "SOL", signClass(s.worstTradeSol)),
      stat("Total PnL", fmtSol(s.totalPnlSol), "SOL after fees", signClass(s.totalPnlSol)),
      stat("Fees paid", fmtSolAmount(s.totalFeesSol), "SOL"),
      stat("Max drawdown", isNum(s.maxDrawdownSol) ? fmtSol(-s.maxDrawdownSol) : DASH, "SOL from peak", s.maxDrawdownSol > 0 ? "neg" : ""),
      stat("Return per trade", fmtSignedPct(s.expectancyPctOfStake), "average, on stake", signClass(s.expectancyPctOfStake)),
      stat("Without best trade", fmtSol(s.pnlExBestSol), "SOL total", signClass(s.pnlExBestSol)),
      stat("Hold time", fmtDur(s.avgHoldSec), "average" + DOT + "median " + fmtDur(s.medianHoldSec))
    ]);
  }
  function edgeView() {
    var params = filterParams();
    return Promise.all([api("/api/summary", params), api("/api/equity", params)]).then(function (results) {
      var summary = results[0].summary;
      var points = results[1].points || [];
      var subline = summary.n > 1 ? el("p", { class: "subline", text: "95% range: t-interval " + interval(summary.expectancyCi95) + DOT + "bootstrap " + interval(summary.bootstrapCi95) }) : null;
      var out = [hero(results[0].narrative, summary.n > 0 ? fmtSol(summary.expectancySol) : null, "SOL per trade after fees (expectancy)", [subline, progressBlock(summary)])];
      if (summary.n === 0) { return out; }
      out.push(edgeStats(summary));
      out.push(card("Equity curve", null,
        points.length > 1 ? equityChart(points) : el("p", { class: "hint", text: "The curve appears after the second closed trade." })));
      if (results[0].truncated) { out.push(banner("warn", "alert", "Only the most recent trades were loaded. Narrow the filter for exact totals.")); }
      out.push(actions([downloadButton("Download trades CSV", "/api/export/trades.csv", params, "trades.csv")]));
      return out;
    });
  }

  function callBadge(action) {
    var info = ACTIONS[action] || ["", ""];
    return el("span", { class: "badge call " + info[1], title: info[0], "aria-label": info[0] }, el("span", { class: "badge-text", text: info[0] }));
  }
  function breakdownCard(item) {
    var info = DIMENSIONS[item.dimension] || [item.dimension, ""];
    if (!item.rows.length) { return card(info[0], info[1], el("p", { class: "hint", text: "No trades." })); }
    var rows = item.rows.map(function (row) {
      var rowClass = row.action === "cut" || row.action === "scale" || row.action === "insufficient" ? row.action : null;
      return el("tr", { class: rowClass },
        cell(humanize(row.label), "label-cell"), cell(fmtInt(row.n)), cell(fmtPct(row.winRate, 0)),
        cell(fmtSol(row.expectancySol), signClass(row.expectancySol)),
        cell(fmtSol(row.totalPnlSol), "hide-narrow " + signClass(row.totalPnlSol)),
        el("td", { class: "call-cell" }, callBadge(row.action)));
    });
    return card(info[0], info[1], table(["Bucket", "Trades", "Win", "Exp/trade", "Total", "Call"], rows, { 4: true }, "breakdown"));
  }
  function breakdownsView() {
    var params = filterParams();
    params.by = "all";
    return api("/api/breakdown", params).then(function (result) {
      if (!result.n) {
        return empty("No closed trades for this filter", "Breakdowns show which risk buckets, signals, hours and hold times to cut or scale once trades close.", "breakdowns");
      }
      var minimum = result.breakdowns[0] ? result.breakdowns[0].minTradesPerBucket : 30;
      var legend = el("div", { class: "call-legend" },
        ["scale", "cut", "lean_scale", "lean_cut", "insufficient"].map(function (action) { return el("span", { class: "call-key" }, callBadge(action), el("span", { text: ACTIONS[action][0] })); }));
      var out = [card("How to read this", "Cut: the 95% range of expectancy is entirely below zero. Scale: entirely above zero. Leaning: not proven yet. Buckets need " + minimum + "+ trades before they count.", legend)];
      result.breakdowns.forEach(function (item) { out.push(breakdownCard(item)); });
      return out;
    });
  }

  function modeCard(byMode) {
    var rows = byMode.map(function (item) {
      return el("tr", null, cell(sentence(item.mode)), cell(fmtInt(item.n)), cell(fmtPct(item.winRate, 0)), cell(fmtSol(item.expectancySol), signClass(item.expectancySol)), cell(sentence(readable(item.verdict)), "hide-narrow"));
    });
    return card("Expectancy by mode", "All closed trades in the period, not paired.", table(["Mode", "Trades", "Win", "Exp/trade", "Verdict"], rows, { 4: true }));
  }
  function compareView() {
    return api("/api/compare", filterParams(false)).then(function (result) {
      var c = result.comparison;
      var subline = c.n > 1 ? el("p", { class: "subline", text: "95% range " + interval(c.diffCi95) + DOT + "median " + fmtSol(c.medianDiffSol) }) : null;
      var out = [hero(result.narrative, c.n > 0 ? fmtSol(c.meanDiffSol) : null, "SOL per trade, live minus paper", subline)];
      if (c.n === 0) {
        out.push(modeCard(result.byMode));
        return out;
      }
      out.push(grid([
        stat("Pairs", fmtInt(c.n), "live trades with a paper shadow"),
        stat("Live avg", fmtSol(c.meanLiveSol), "win " + fmtPct(c.liveWinRate, 0), signClass(c.meanLiveSol)),
        stat("Paper avg", fmtSol(c.meanPaperSol), "win " + fmtPct(c.paperWinRate, 0), signClass(c.meanPaperSol)),
        stat("Paper did better", fmtPct(c.paperBetterShare, 0), "of pairs"),
        stat("Entry fill gap", fmtBps(c.entryGap.meanBps), "median " + fmtBps(c.entryGap.medianBps) + ", + is worse live"),
        stat("Exit fill gap", fmtBps(c.exitGap.meanBps), "median " + fmtBps(c.exitGap.medianBps) + ", + is worse live"),
        stat("Failed fills", fmtPct(c.fillFailureRate.live), fmtPct(c.fillFailureRate.paper) + " on paper"),
        stat("Fill latency", isNum(c.meanFillLatencyMs.live) ? Math.round(c.meanFillLatencyMs.live) + " ms" : DASH, (isNum(c.meanFillLatencyMs.paper) ? Math.round(c.meanFillLatencyMs.paper) + " ms" : DASH) + " on paper")
      ]));
      out.push(modeCard(result.byMode));
      if (c.byWeek.length) {
        out.push(card("Week by week", "A growing gap means the execution model drifted.", table(["Week", "Pairs", "Live", "Paper", "Gap"], c.byWeek.slice().reverse().map(function (week) {
          return el("tr", null, cell(fmtDay(week.weekStartMs)), cell(fmtInt(week.n)), cell(fmtSol(week.meanLiveSol), signClass(week.meanLiveSol)), cell(fmtSol(week.meanPaperSol), signClass(week.meanPaperSol)), cell(fmtSol(week.meanDiffSol), signClass(week.meanDiffSol)));
        }))));
      }
      out.push(card("Recent pairs", "Different exit: " + fmtPct(c.exitReasonMismatchShare, 0) + " of pairs. Tap a coin for its score.", table(["Coin", "Live", "Paper", "Gap", "Entry"], c.pairs.map(function (pair) {
        return el("tr", null, el("td", { class: "t-coin" }, mintButton(pair.mint, null, "cell-btn mono")), cell(fmtSol(pair.livePnlSol), signClass(pair.livePnlSol)), cell(fmtSol(pair.paperPnlSol), signClass(pair.paperPnlSol)), cell(fmtSol(pair.diffSol), signClass(pair.diffSol)), cell(fmtBps(pair.entryGapBps), "hide-narrow"));
      }), { 4: true })));
      return out;
    });
  }

  function scorerTable(result) {
    var rows = [
      ["Launches", fmtInt(result.pass.n), fmtInt(result.block.n)],
      ["Survived 15m", fmtPct(result.pass.survived15mRate), fmtPct(result.block.survived15mRate)],
      ["Migrated", fmtPct(result.pass.migratedRate), fmtPct(result.block.migratedRate)],
      ["Rugged", fmtPct(result.pass.ruggedRate), fmtPct(result.block.ruggedRate)],
      ["Died", fmtPct(result.pass.diedRate), fmtPct(result.block.diedRate)],
      ["Median peak", fmtMult(result.pass.medianPeakMultiple), fmtMult(result.block.medianPeakMultiple)],
      ["Peak from score time", fmtMult(result.pass.medianPeakFromScore), fmtMult(result.block.medianPeakFromScore)]
    ];
    return card("Passed vs blocked", "Passed: score " + result.maxRisk + " or lower and not hard-blocked. Blocked: everything else.",
      table(["", "Passed", "Blocked"], rows.map(function (row) { return el("tr", null, cell(row[0], "label-cell"), cell(row[1]), cell(row[2])); })));
  }
  function scorerView() {
    return api("/api/scorer/calibration", { checkpoint: state.checkpoint, quote: state.quote }).then(function (result) {
      var checkpoints = (result.checkpoints || []).map(function (sec) { return [String(sec), sec + "s after launch"]; });
      if (!checkpoints.length) { checkpoints = [[String(result.checkpointSec), result.checkpointSec + "s after launch"]]; }
      var controls = el("div", { class: "controls" },
        field("Checkpoint", selectBox(checkpoints, String(result.checkpointSec), function (value) { state.checkpoint = value; savePrefs(); render(); }, "Checkpoint")),
        field("Quote coin", selectBox([["", "All quotes"], ["SOL", "SOL only"], [PUMP_MINT, "PUMP only"]], state.quote, function (value) { state.quote = value; savePrefs(); render(); }, "Quote coin")));
      var out = [controls, hero(result.narrative, null, null, null)];
      if (!result.buckets.length) {
        out.push(empty("No scored launches with known outcomes", "Run the recorder for two weeks before tuning. The scorer writes a score at each checkpoint and the finaliser labels outcomes once they are known.", "scorer"));
        return out;
      }
      out.push(scorerTable(result));
      out.push(card("By score bucket", "Lower score means lower risk. A working scorer shows survival and migration falling and rugs rising as the score goes up.",
        table(["Score", "Launches", "Surv 15m", "Migr", "Rug", "Died", "Peak"], result.buckets.map(function (bucket) {
          return el("tr", null, cell(bucket.label, "label-cell"), cell(fmtInt(bucket.n)), cell(fmtPct(bucket.survived15mRate, 0)), cell(fmtPct(bucket.migratedRate, 0)), cell(fmtPct(bucket.ruggedRate, 0)), cell(fmtPct(bucket.diedRate, 0), "hide-narrow"), cell(fmtMult(bucket.medianPeakMultiple), "hide-narrow"));
        }), { 5: true, 6: true })));
      out.push(actions([downloadButton("Download scorer dataset CSV", "/api/export/scorer-dataset.csv", { checkpoint: result.checkpointSec, quote: state.quote }, "scorer-dataset.csv")]));
      return out;
    });
  }

  function flatten(value, prefix, pairs, depth) {
    Object.keys(value || {}).forEach(function (key) {
      if (pairs.length >= 80) { return; }
      var inner = value[key];
      var name = prefix ? prefix + " · " + sentence(readable(key)) : sentence(readable(key));
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner) && depth < 2) { flatten(inner, name, pairs, depth + 1); return; }
      var text = typeof inner === "number" ? fmtValue(inner) : typeof inner === "string" ? inner : JSON.stringify(inner);
      pairs.push([name, String(text).slice(0, 120)]);
    });
    return pairs;
  }
  var RECORDER_LABELS = { good: "Looks good", warn: "Collecting", bad: "Problem", neutral: "Waiting for data" };
  function recorderView() {
    return api("/api/recorder/health").then(function (h) {
      var out = [hero(h.narrative, isNum(h.recordingDays) ? h.recordingDays.toFixed(1) : null, "days recorded, target 14", isNum(h.recordingDays) ? meter(h.recordingDays / 14) : null, RECORDER_LABELS)];
      out.push(grid([
        stat("Last trade", isNum(h.lastTradeAgeSec) ? fmtDur(h.lastTradeAgeSec) + " ago" : DASH, isNum(h.lastTradeAtMs) ? fmtTime(h.lastTradeAtMs) : null, isNum(h.lastTradeAgeSec) && h.lastTradeAgeSec > 300 ? "neg" : ""),
        stat("Last launch", isNum(h.lastLaunchAgeSec) ? fmtDur(h.lastLaunchAgeSec) + " ago" : DASH, isNum(h.lastLaunchAtMs) ? fmtTime(h.lastLaunchAtMs) : null),
        stat("Launches 24h", fmtInt(h.launchesLast24h), null),
        stat("Trades last hour", fmtInt(h.tradesLastHour), null),
        stat("Tracking now", fmtInt(h.activeTracking), "launches still followed"),
        stat("Ingest gaps 24h", fmtInt(h.gaps24h.count), fmtDur(h.gaps24h.totalSec) + " total", h.gaps24h.count > 0 ? "neg" : "")
      ], "three"));
      out.push(el("div", { class: "split" },
        card("Launches per hour", "Last 24 hours.", barChart(h.launchesPerHour, function (item) { return item.count; }, function (item) { return fmtTime(item.hourStartMs); }, "launches", function (item) { return fmtClockTime(item.hourStartMs); })),
        card("Trades per minute", "Last 60 minutes.", barChart(h.tradesPerMinute, function (item) { return item.count; }, function (item) { return fmtTime(item.minuteStartMs); }, "trades", function (item) { return fmtClockTime(item.minuteStartMs); }))));
      out.push(el("div", { class: "split" },
        card("Launches by quote coin", "Last 24 hours. Trading is SOL-quoted only; the recorder stores everything.",
          h.launchesByQuoteMint.length ? table(["Quote", "Launches"], h.launchesByQuoteMint.map(function (item) { return el("tr", null, cell(item.label, "label-cell"), cell(fmtInt(item.count))); })) : el("p", { class: "hint", text: "No launches in the last 24 hours." })),
        card("Outcome labels", "Launches from the last " + Math.round(h.outcomeStatus.windowHours / 24) + " days by outcome. Pending means no label yet.",
          h.outcomeStatus.counts.length ? table(["Status", "Final", "Launches"], h.outcomeStatus.counts.map(function (item) { return el("tr", null, cell(sentence(readable(item.status)), "label-cell"), cell(item.finalized ? "Yes" : "No"), cell(fmtInt(item.count))); })) : el("p", { class: "hint", text: "No launches yet." }))));
      if (h.gaps24h.recent.length) {
        out.push(card("Recent ingest gaps", "Periods where the stream may have missed events.", table(["Started", "Length", "Source", "Reason", "Launches"], h.gaps24h.recent.map(function (gap) {
          return el("tr", null, cell(fmtTime(gap.startedAtMs), "label-cell"), cell(fmtDur(gap.durationSec)), cell(gap.source, "hide-narrow"), cell(sentence(readable(gap.reason))), cell(isNum(gap.affectedLaunches) ? fmtInt(gap.affectedLaunches) : DASH, "hide-narrow"));
        }), { 2: true, 4: true })));
      }
      if (h.process) { out.push(card("This process", "Live counters from the running service.", kv(flatten(h.process, "", [], 0)))); }
      return out;
    });
  }

  function signalResult(signal) {
    if (signal.acted) { return badge("Traded", "good"); }
    return el("span", { class: "skip-text", text: signal.skipReason ? humanize(signal.skipReason) : "Not traded" });
  }
  function signalsView() {
    return api("/api/signals/recent", { limit: 50 }).then(function (result) {
      if (!result.signals.length) {
        return empty("No signals yet", "Signals come from the entry filters enabled in the strategy. Score momentum fires on a low-risk launch with strong early buying at its checkpoint and needs only launch scores. Smart-wallet convergence fires when several tracked wallets buy the same launch and needs a wallet ranking (Wallets view). Every signal lands here, traded or with its skip reason.", "signals");
      }
      var traded = result.signals.filter(function (signal) { return signal.acted; }).length;
      return card("Recent signals", fmtInt(result.signals.length) + " newest" + DOT + fmtInt(traded) + " traded. Tap a coin for its score.",
        table(["Time", "Coin", "Signal", "Risk", "Result"], result.signals.map(function (signal) {
          return el("tr", null, cell(fmtWhen(signal.atMs), "t-time"), el("td", { class: "t-coin" }, mintButton(signal.mint, signal.symbol, "cell-btn")),
            cell(humanize(signal.type) + (signal.walletCount ? DOT + signal.walletCount + " wallets" : ""), "hide-narrow"), cell(fmtNum(signal.riskScore, 0)), el("td", { class: "t-result" }, signalResult(signal)));
        }), { 2: true }, "dense", { 1: true }));
    });
  }
  function outcomeBadge(outcome) {
    if (!outcome) { return badge("Pending", ""); }
    var tone = outcome.migrated ? "good" : outcome.rugged ? "bad" : outcome.died ? "warn" : "info";
    return badge(sentence(readable(outcome.status)) + (outcome.finalized ? "" : "?"), tone);
  }
  function riskCell(score) {
    if (!score) { return el("td", { class: "muted-cell", text: DASH }); }
    var tone = score.hardBlocked ? "bad" : score.score > 55 ? "warn" : "good";
    return el("td", null, el("span", { class: "risk-num " + tone, text: String(Math.round(score.score)) }), el("span", { class: "cell-note", text: score.hardBlocked ? "blocked" : score.checkpointSec + "s" }));
  }
  function launchesView() {
    return api("/api/launches/recent", { limit: 60 }).then(function (result) {
      if (!result.launches.length) {
        return empty("No launches recorded", "Check the Recorder view: the recorder subscribes to pump.fun logs and stores every launch.", "launches");
      }
      return card("Recent launches", "Newest first. Risk is the latest checkpoint score (lower is safer). Tap a coin for its flags.",
        table(["Age", "Coin", "Quote", "Trades", "Risk", "Outcome"], result.launches.map(function (launch) {
          return el("tr", null, cell(fmtDur((Date.now() - launch.createdAtMs) / 1000), "t-time"),
            el("td", { class: "t-coin" }, mintButton(launch.mint, launch.symbol || null, "cell-btn")),
            cell(quoteLabel(launch.quoteMint), "hide-narrow"), cell(fmtInt(launch.tradeCount), "hide-narrow"), riskCell(launch.score),
            el("td", null, outcomeBadge(launch.outcome)));
        }), { 2: true, 3: true }, "dense", { 1: true }));
    });
  }
  function copyButton(text) {
    var label = el("span", { text: shortAddr(text) });
    var mark = icon("copy");
    var button = el("button", { class: "title-btn mono cell-btn copy-btn", type: "button", "aria-label": "Copy wallet address " + shortAddr(text), title: "Copy address" }, label, mark);
    button.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { label.textContent = "Copied"; window.setTimeout(function () { label.textContent = shortAddr(text); }, 1500); }).catch(function () { return; });
      }
    });
    return button;
  }
  function walletsView() {
    return api("/api/wallets/tracked", { limit: 100 }).then(function (result) {
      if (!result.run) {
        return empty("No wallet ranking yet", "Wallets are ranked weekly from recorded trades. Run the recorder for two weeks, then backtest the tracker before trusting its picks.", "wallets");
      }
      var run = result.run;
      if (!result.wallets.length) { return empty("No wallet passed the filters", "The latest ranking excluded every candidate. Check tracker thresholds or wait for more history.", "wallets"); }
      return card("Tracked wallets", "Ranking as of " + fmtTime(run.asOfMs) + DOT + fmtInt(run.tracked) + " tracked of " + fmtInt(run.candidates) + " candidates. PnL is SOL-quoted round trips.",
        table(["#", "Wallet", "Score", "PnL 30d SOL", "Win 30d", "Trades 30d", "PnL 90d SOL", "Hold"], result.wallets.map(function (row) {
          return el("tr", null, cell(row.rank === null ? "?" : String(row.rank), "t-rank"), el("td", { class: "t-coin" }, copyButton(row.wallet)),
            cell(fmtNum(row.score, 2), "hide-narrow"), cell(fmtSol(row.pnl30dSol), signClass(row.pnl30dSol)), cell(fmtPct(row.winRate30d, 0)),
            cell(fmtInt(row.trades30d), "hide-narrow"), cell(fmtSol(row.pnl90dSol), "hide-narrow " + signClass(row.pnl90dSol)), cell(fmtDur(row.medianHoldSec), "hide-narrow"));
        }), { 2: true, 5: true, 6: true, 7: true }, "dense", { 1: true }));
    });
  }

  function scoreBody(score, mint) {
    var contributions = Object.keys(score.contributions || {}).map(function (key) { return [key, score.contributions[key]]; })
      .sort(function (a, b) { return Math.abs(b[1]) - Math.abs(a[1]); }).slice(0, 10);
    var features = Object.keys(score.features || {}).sort().map(function (key) { return [sentence(readable(key)), fmtValue(score.features[key])]; });
    return [
      el("div", { class: "score-head" },
        el("div", null, el("div", { class: "figure", text: fmtNum(score.score, 0) }), el("div", { class: "figure-unit", text: "risk out of 100 at " + score.checkpointSec + "s" + DOT + fmtDur(score.ageMs / 1000) + " ago" })),
        pumpLink(mint)),
      el("div", { class: "badges" }, score.hardBlocked ? badge("Hard-blocked", "bad") : badge("Not hard-blocked", "good"), badge("Weights " + (score.weightsVersion || DASH), "")),
      score.flags && score.flags.length ? el("div", { class: "chips" }, score.flags.map(function (flag) { return el("span", { class: "chip bad", text: sentence(readable(flag)) }); })) : el("p", { class: "hint sheet-hint", text: "No flags." }),
      contributions.length ? [el("p", { class: "section-label", text: "Biggest contributions" }), kv(contributions.map(function (pair) { return [sentence(readable(pair[0])), (pair[1] > 0 ? "+" : "") + fmtNum(pair[1], 2), pair[1] > 0 ? "neg" : "pos"]; }))] : null,
      features.length ? [el("p", { class: "section-label", text: "Features" }), kv(features)] : null
    ];
  }
  function openScore(mint, title) {
    var body = el("div", null, el("p", { class: "hint", text: "Loading score…" }));
    var close = el("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, icon("close"));
    var opener = document.activeElement;
    var panel = el("div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": "Launch score" },
      el("div", { class: "panel-head" }, el("h2", { text: title || shortAddr(mint) }), close),
      el("p", { class: "mono muted-line", text: mint }), body);
    var sheet = el("div", { class: "sheet" }, panel);
    function onKey(event) { if (event.key === "Escape") { dismiss(); } }
    function dismiss() {
      sheetOpen = false;
      document.removeEventListener("keydown", onKey);
      sheet.remove();
      if (opener && typeof opener.focus === "function") { opener.focus(); }
    }
    close.addEventListener("click", dismiss);
    sheet.addEventListener("click", function (event) { if (event.target === sheet) { dismiss(); } });
    document.addEventListener("keydown", onKey);
    document.body.append(sheet);
    sheetOpen = true;
    close.focus();
    api("/api/score/" + encodeURIComponent(mint)).then(function (score) {
      fill(body, scoreBody(score, mint));
    }).catch(function (error) {
      var text = error.status === 404 ? "Not scored yet. The scorer writes a score at its checkpoints after launch." : error.auth ? "Unlock the dashboard first." : error.message;
      body.replaceChildren(el("p", { class: "hint", text: text }), pumpLink(mint));
    });
  }

  function providerText(rpc) {
    if (rpc.provider === "helius") { return "Helius"; }
    return rpc.provider === "custom" ? "Another provider" : "Not set";
  }
  function saveRpcKey(input, note, button) {
    var key = String(input.value || "").trim();
    if (!HELIUS_KEY.test(key)) { note.textContent = "That does not look like a Helius API key. It has 5 groups of letters and numbers: 8-4-4-4-12."; return; }
    button.disabled = true;
    note.textContent = "Checking the key with Helius…";
    apiPost("/api/actions/rpc-key", { key: key }).then(function (result) {
      input.value = "";
      note.textContent = "Saved key " + result.keyHint + ". The bot is restarting with it; this page reloads in " + RELOAD_AFTER_KEY_MS / 1000 + " seconds.";
      window.setTimeout(function () { window.location.reload(); }, RELOAD_AFTER_KEY_MS);
    }).catch(function (error) {
      button.disabled = false;
      note.textContent = "Not saved: " + (error && error.message ? error.message : "request failed") + ".";
    });
  }
  function settingsView() {
    return api("/api/rpc").then(function (rpc) {
      var input = el("input", { type: "text", name: "helius-key", class: "mono-input", autocomplete: "off", autocapitalize: "off", spellcheck: "false", inputmode: "text", placeholder: "Paste the API key" });
      var note = el("p", { class: "subline", role: "status" });
      var button = el("button", { type: "button", class: "btn primary", text: "Check and save" });
      button.addEventListener("click", function () { saveRpcKey(input, note, button); });
      var current = kv([["Provider", providerText(rpc)], ["Current key", rpc.keyHint || DASH, "mono"]]);
      var body = rpc.canChange
        ? el("div", { class: "form-block" }, field("New Helius API key", input), actions([button]), note)
        : el("p", { class: "detail", text: "Changing the key from here is off on this server. Set ENV_FILE to the path of the service env file to turn it on." });
      var device = card("This device", "The dashboard token is stored in this browser only. Forget it on a shared or lost device.",
        kv([["Time zone", tzLabel()], ["Clock", "24-hour, local time"]]),
        actions([el("button", { class: "btn", type: "button", onclick: forgetToken }, icon("lock"), "Forget token on this device")]));
      return [el("div", { class: "split" }, card("Helius RPC key", "The bot reads the chain and sends trades through Helius. Copy a new API key from dashboard.helius.dev and paste it here. It is checked with Helius first, then saved, and the bot restarts in a few seconds. Open trades are picked up again after the restart.", current, body), device)];
    });
  }
`;
