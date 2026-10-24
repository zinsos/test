export const ANALYSIS_SCRIPT = String.raw`
  function progressBlock(summary) {
    if (summary.n === 0 || summary.verdict === "edge" || summary.significance === "negative") { return null; }
    var target = summary.tradesNeeded || summary.minTrades;
    var text = summary.verdict === "insufficient_data"
      ? fmtInt(summary.n) + " of " + fmtInt(Math.max(summary.minTrades, target)) + " trades before a verdict"
      : fmtInt(summary.n) + " of ~" + fmtInt(target) + " trades needed to know";
    return [meter(summary.n / Math.max(summary.minTrades, target)), el("p", { class: "subline", text: text })];
  }
  function edgeStats(s) {
    return grid([
      stat("Trades", fmtInt(s.n), fmtInt(s.wins) + " won" + DOT + fmtInt(s.losses) + " lost"),
      stat("Win rate", fmtPct(s.winRate), "loss rate " + fmtPct(s.lossRate)),
      stat("Avg win", fmtSol(s.avgWinSol), "SOL", "pos"),
      stat("Avg loss", isNum(s.avgLossSol) ? fmtSol(-s.avgLossSol) : DASH, "SOL", "neg"),
      stat("Profit factor", fmtNum(s.profitFactor), "gross win / gross loss"),
      stat("Max drawdown", fmtSol(-s.maxDrawdownSol), "SOL from peak", s.maxDrawdownSol > 0 ? "neg" : ""),
      stat("Total PnL", fmtSol(s.totalPnlSol), "SOL after fees", signClass(s.totalPnlSol)),
      stat("Fees paid", fmtSol(s.totalFeesSol, false), "SOL"),
      stat("Return per trade", isNum(s.expectancyPctOfStake) ? (s.expectancyPctOfStake > 0 ? "+" : "") + s.expectancyPctOfStake.toFixed(2) + "%" : DASH, "average, on stake", signClass(s.expectancyPctOfStake)),
      stat("Without best trade", fmtSol(s.pnlExBestSol), "SOL total", signClass(s.pnlExBestSol)),
      stat("Avg hold", fmtDur(s.avgHoldSec), "median " + fmtDur(s.medianHoldSec)),
      stat("Best / worst", fmtSol(s.bestTradeSol) + " / " + fmtSol(s.worstTradeSol), "SOL")
    ]);
  }
  function edgeView() {
    var params = filterParams();
    return Promise.all([api("/api/summary", params), api("/api/equity", params)]).then(function (results) {
      var summary = results[0].summary;
      var points = results[1].points || [];
      var subline = summary.n > 1 ? el("p", { class: "subline", text: "t-interval " + interval(summary.expectancyCi95) + DOT + "bootstrap " + interval(summary.bootstrapCi95) }) : null;
      var out = [hero(results[0].narrative, summary.n > 0 ? fmtSol(summary.expectancySol) : null, "SOL per trade after fees (expectancy)", [subline, progressBlock(summary)])];
      if (summary.n === 0) {
        out.push(empty("Nothing to measure yet", "Run the recorder for two weeks, backtest the scorer and wallet tracker, then paper trade 300+ trades. Expectancy appears here as trades close.", "performance"));
        return out;
      }
      out.push(edgeStats(summary));
      out.push(card("Equity curve", "Cumulative PnL in SOL after fees, by trade. Drag across the chart to inspect.",
        points.length > 1 ? equityChart(points) : el("p", { class: "hint", text: "The curve appears after the second closed trade." })));
      if (results[0].truncated) { out.push(banner("warn", "alert", "Only the most recent trades were loaded. Narrow the filter for exact totals.")); }
      out.push(el("p", { class: "footnote", text: "Expectancy after fees over hundreds of trades is the only number that proves an edge. Flat or negative results are the tooling working: they saved real money." }));
      out.push(actions([downloadButton("Download trades CSV", "/api/export/trades.csv", params, "trades.csv")]));
      return out;
    });
  }

  function breakdownCard(item) {
    var info = DIMENSIONS[item.dimension] || [item.dimension, ""];
    if (!item.rows.length) { return card(info[0], info[1], el("p", { class: "hint", text: "No trades." })); }
    var rows = item.rows.map(function (row) {
      var action = ACTIONS[row.action] || ["", ""];
      var rowClass = row.action === "cut" || row.action === "scale" || row.action === "insufficient" ? row.action : null;
      return el("tr", { class: rowClass },
        cell(readable(row.label)), cell(fmtInt(row.n)), cell(fmtPct(row.winRate, 0)),
        cell(fmtSol(row.expectancySol), signClass(row.expectancySol)),
        cell(fmtSol(row.totalPnlSol), "hide-narrow " + signClass(row.totalPnlSol)),
        el("td", null, badge(action[0], action[1])));
    });
    return card(info[0], info[1], table(["Bucket", "Trades", "Win", "Exp/trade", "Total", ""], rows, { 4: true }));
  }
  function breakdownsView() {
    var params = filterParams();
    params.by = "all";
    return api("/api/breakdown", params).then(function (result) {
      if (!result.n) {
        return empty("No closed trades for this filter", "Breakdowns show which risk buckets, signals, hours and hold times to cut or scale once trades close.", "breakdowns");
      }
      var minimum = result.breakdowns[0] ? result.breakdowns[0].minTradesPerBucket : 30;
      var out = [card("How to read this", "Cut: the 95% range of expectancy is entirely below zero. Scale: entirely above zero. Leaning: not proven yet. Buckets need " + minimum + "+ trades before they count.")];
      result.breakdowns.forEach(function (item) { out.push(breakdownCard(item)); });
      return out;
    });
  }

  function modeCard(byMode) {
    var rows = byMode.map(function (item) {
      return el("tr", null, cell(item.mode), cell(fmtInt(item.n)), cell(fmtPct(item.winRate, 0)), cell(fmtSol(item.expectancySol), signClass(item.expectancySol)), cell(readable(item.verdict), "hide-narrow"));
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
        out.push(empty("No paired trades yet", "Go live small only after 300+ paper trades show an edge. Every live entry gets a shadow paper trade, and this view shows where the simulation is too optimistic.", "compare"));
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
        stat("Fill latency", isNum(c.meanFillLatencyMs.live) ? Math.round(c.meanFillLatencyMs.live) + " ms" : DASH, (isNum(c.meanFillLatencyMs.paper) ? Math.round(c.meanFillLatencyMs.paper) + " ms" : DASH) + " on paper"),
        stat("Different exit", fmtPct(c.exitReasonMismatchShare, 0), "exit reason differs")
      ]));
      out.push(modeCard(result.byMode));
      if (c.byWeek.length) {
        out.push(card("Week by week", "Compare live against paper every week. A growing gap means the execution model drifted.", table(["Week", "Pairs", "Live", "Paper", "Gap"], c.byWeek.slice().reverse().map(function (week) {
          return el("tr", null, cell(fmtDay(week.weekStartMs)), cell(fmtInt(week.n)), cell(fmtSol(week.meanLiveSol), signClass(week.meanLiveSol)), cell(fmtSol(week.meanPaperSol), signClass(week.meanPaperSol)), cell(fmtSol(week.meanDiffSol), signClass(week.meanDiffSol)));
        }))));
      }
      out.push(card("Recent pairs", "Tap a coin to see its score.", table(["Coin", "Live", "Paper", "Gap", "Entry"], c.pairs.map(function (pair) {
        return el("tr", null, el("td", null, mintButton(pair.mint, null)), cell(fmtSol(pair.livePnlSol), signClass(pair.livePnlSol)), cell(fmtSol(pair.paperPnlSol), signClass(pair.paperPnlSol)), cell(fmtSol(pair.diffSol), signClass(pair.diffSol)), cell(fmtBps(pair.entryGapBps), "hide-narrow"));
      }), { 4: true })));
      return out;
    });
  }

  function groupCard(title, hint, group) {
    return card(title, hint, kv([
      ["Launches", fmtInt(group.n)],
      ["Survived 15m", fmtPct(group.survived15mRate)],
      ["Migrated", fmtPct(group.migratedRate)],
      ["Rugged", fmtPct(group.ruggedRate)],
      ["Died", fmtPct(group.diedRate)],
      ["Median peak", fmtMult(group.medianPeakMultiple)],
      ["Median peak from score time", fmtMult(group.medianPeakFromScore)]
    ]));
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
      out.push(el("div", { class: "split" },
        groupCard("Passed", "Score " + result.maxRisk + " or lower and not hard-blocked.", result.pass),
        groupCard("Blocked", "Score above " + result.maxRisk + " or hard-blocked.", result.block)));
      out.push(card("By score bucket", "Lower score means lower risk. A working scorer shows survival and migration falling and rugs rising as the score goes up.",
        table(["Score", "Launches", "Surv 15m", "Migr", "Rug", "Died", "Peak"], result.buckets.map(function (bucket) {
          return el("tr", null, cell(bucket.label), cell(fmtInt(bucket.n)), cell(fmtPct(bucket.survived15mRate, 0)), cell(fmtPct(bucket.migratedRate, 0)), cell(fmtPct(bucket.ruggedRate, 0)), cell(fmtPct(bucket.diedRate, 0), "hide-narrow"), cell(fmtMult(bucket.medianPeakMultiple), "hide-narrow"));
        }), { 5: true, 6: true })));
      out.push(actions([downloadButton("Download scorer dataset CSV", "/api/export/scorer-dataset.csv", { checkpoint: result.checkpointSec, quote: state.quote }, "scorer-dataset.csv")]));
      return out;
    });
  }

  function flatten(value, prefix, pairs, depth) {
    Object.keys(value || {}).forEach(function (key) {
      if (pairs.length >= 80) { return; }
      var inner = value[key];
      var name = prefix ? prefix + "." + key : key;
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner) && depth < 2) { flatten(inner, name, pairs, depth + 1); return; }
      var text = typeof inner === "number" ? fmtNum(inner, Number.isInteger(inner) ? 0 : 3) : typeof inner === "string" ? inner : JSON.stringify(inner);
      pairs.push([name, String(text).slice(0, 120)]);
    });
    return pairs;
  }
  function recorderView() {
    return api("/api/recorder/health").then(function (h) {
      var out = [hero(h.narrative, isNum(h.recordingDays) ? h.recordingDays.toFixed(1) : null, "days recorded, target 14", isNum(h.recordingDays) ? meter(h.recordingDays / 14) : null)];
      out.push(grid([
        stat("Last trade", isNum(h.lastTradeAgeSec) ? fmtDur(h.lastTradeAgeSec) + " ago" : DASH, fmtTime(h.lastTradeAtMs), isNum(h.lastTradeAgeSec) && h.lastTradeAgeSec > 300 ? "neg" : ""),
        stat("Last launch", isNum(h.lastLaunchAgeSec) ? fmtDur(h.lastLaunchAgeSec) + " ago" : DASH, fmtTime(h.lastLaunchAtMs)),
        stat("Launches 24h", fmtInt(h.launchesLast24h), null),
        stat("Trades last hour", fmtInt(h.tradesLastHour), null),
        stat("Tracking now", fmtInt(h.activeTracking), "launches still followed"),
        stat("Ingest gaps 24h", fmtInt(h.gaps24h.count), fmtDur(h.gaps24h.totalSec) + " total", h.gaps24h.count > 0 ? "neg" : "")
      ]));
      out.push(el("div", { class: "split" },
        card("Launches per hour", "Last 24 hours.", barChart(h.launchesPerHour, function (item) { return item.count; }, function (item) { return fmtTime(item.hourStartMs); }, "launches", function (item) { return fmtClockTime(item.hourStartMs); })),
        card("Trades per minute", "Last 60 minutes.", barChart(h.tradesPerMinute, function (item) { return item.count; }, function (item) { return fmtTime(item.minuteStartMs); }, "trades", function (item) { return fmtClockTime(item.minuteStartMs); }))));
      out.push(card("Launches by quote coin", "Last 24 hours. Trading is SOL-quoted only; the recorder stores everything.",
        h.launchesByQuoteMint.length ? table(["Quote", "Launches"], h.launchesByQuoteMint.map(function (item) { return el("tr", null, cell(item.label), cell(fmtInt(item.count))); })) : el("p", { class: "hint", text: "No launches in the last 24 hours." })));
      out.push(card("Outcome labels", "Launches from the last " + Math.round(h.outcomeStatus.windowHours / 24) + " days by outcome. Pending means no label yet.",
        h.outcomeStatus.counts.length ? table(["Status", "Final", "Launches"], h.outcomeStatus.counts.map(function (item) { return el("tr", null, cell(item.status), cell(item.finalized ? "yes" : "no"), cell(fmtInt(item.count))); })) : el("p", { class: "hint", text: "No launches yet." })));
      if (h.gaps24h.recent.length) {
        out.push(card("Recent ingest gaps", "Periods where the stream may have missed events.", el("ul", { class: "list" }, h.gaps24h.recent.map(function (gap) {
          return el("li", { class: "item" }, el("div", { class: "row" }, el("strong", { text: fmtDur(gap.durationSec) }), el("span", { class: "meta", text: fmtTime(gap.startedAtMs) })), el("div", { class: "meta", text: gap.source + DOT + gap.reason + (isNum(gap.affectedLaunches) ? DOT + gap.affectedLaunches + " launches affected" : "") }));
        }))));
      }
      if (h.process) { out.push(card("This process", "Live counters from the running service.", kv(flatten(h.process, "", [], 0)))); }
      return out;
    });
  }

  function mintButton(mint, label) {
    return el("button", { class: "title-btn", type: "button", text: label || shortAddr(mint), onclick: function () { openScore(mint, label); } });
  }
  function signalsView() {
    return api("/api/signals/recent", { limit: 50 }).then(function (result) {
      if (!result.signals.length) {
        return empty("No signals yet", "Signals come from the entry filters enabled in the strategy. Score momentum fires on a low-risk launch with strong early buying at its checkpoint and needs only launch scores. Smart-wallet convergence fires when several tracked wallets buy the same launch and needs a wallet ranking (Wallets view). Every signal lands here, traded or with its skip reason.", "signals");
      }
      return card("Recent signals", "Newest first. Tap a coin to see its latest score and flags.", el("ul", { class: "list" }, result.signals.map(function (signal) {
        return el("li", { class: "item" },
          el("div", { class: "row" }, mintButton(signal.mint, signal.symbol), signal.acted ? badge("Traded", "good") : badge(signal.skipReason ? "Skipped" : "Not traded", "")),
          el("div", { class: "row" }, el("span", { class: "meta", text: readable(signal.type) + DOT + "risk " + fmtNum(signal.riskScore, 0) + DOT + signal.walletCount + " wallets" }), el("span", { class: "meta", text: fmtAgo(signal.atMs) })),
          signal.skipReason ? el("div", { class: "meta", text: "Skip reason: " + signal.skipReason }) : null);
      })));
    });
  }
  function outcomeBadge(outcome) {
    if (!outcome) { return badge("pending", ""); }
    var tone = outcome.migrated ? "good" : outcome.rugged ? "bad" : outcome.died ? "warn" : "info";
    return badge(outcome.status + (outcome.finalized ? "" : "?"), tone);
  }
  function launchesView() {
    return api("/api/launches/recent", { limit: 60 }).then(function (result) {
      if (!result.launches.length) {
        return empty("No launches recorded", "Check the Recorder view: the recorder subscribes to pump.fun logs and stores every launch.", "launches");
      }
      return card("Recent launches", "Newest first. Score is the latest checkpoint (lower is safer). Tap a coin for its flags.", el("ul", { class: "list" }, result.launches.map(function (launch) {
        var score = launch.score;
        var scoreBadge = score ? badge("risk " + Math.round(score.score) + (score.hardBlocked ? " blocked" : "") + " @" + score.checkpointSec + "s", score.hardBlocked ? "bad" : score.score > 55 ? "warn" : "good") : badge("not scored", "");
        return el("li", { class: "item" },
          el("div", { class: "row" }, mintButton(launch.mint, launch.symbol || null), el("span", { class: "meta", text: fmtAgo(launch.createdAtMs) })),
          el("div", { class: "row" }, el("span", { class: "meta", text: (launch.name || "") + DOT + quoteLabel(launch.quoteMint) + DOT + fmtInt(launch.tradeCount) + " trades" + (launch.outcome && isNum(launch.outcome.peakMultiple) ? DOT + "peak " + fmtMult(launch.outcome.peakMultiple) : "") })),
          el("div", { class: "badges" }, scoreBadge, outcomeBadge(launch.outcome)));
      })));
    });
  }
  function copyButton(text) {
    var button = el("button", { class: "title-btn mono", type: "button", text: shortAddr(text), "aria-label": "Copy wallet address" });
    button.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { button.textContent = "Copied"; window.setTimeout(function () { button.textContent = shortAddr(text); }, 1500); }).catch(function () { return; });
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
      var out = [card("Tracked wallets", "Ranking as of " + fmtTime(run.asOfMs) + DOT + fmtInt(run.tracked) + " tracked of " + fmtInt(run.candidates) + " candidates. PnL is SOL-quoted round trips. Tap to copy.")];
      if (!result.wallets.length) { out.push(empty("No wallet passed the filters", "The latest ranking excluded every candidate. Check tracker thresholds or wait for more history.")); return out; }
      out.push(card(null, null, el("ul", { class: "list" }, result.wallets.map(function (wallet) {
        return el("li", { class: "item" },
          el("div", { class: "row" }, el("span", null, el("strong", { text: "#" + (wallet.rank === null ? "?" : wallet.rank) + " " }), copyButton(wallet.wallet)), el("span", { class: "meta", text: "score " + fmtNum(wallet.score, 2) })),
          el("div", { class: "row" }, el("span", { class: "meta", text: "30d " + fmtSol(wallet.pnl30dSol) + " SOL" + DOT + fmtPct(wallet.winRate30d, 0) + " win" + DOT + fmtInt(wallet.trades30d) + " trades" })),
          el("div", { class: "row" }, el("span", { class: "meta", text: "90d " + fmtSol(wallet.pnl90dSol) + " SOL" + DOT + "median hold " + fmtDur(wallet.medianHoldSec) + DOT + "entry delay " + fmtDur(wallet.medianEntryDelaySec) })));
      }))));
      return out;
    });
  }

  function scoreBody(score) {
    var contributions = Object.keys(score.contributions || {}).map(function (key) { return [key, score.contributions[key]]; })
      .sort(function (a, b) { return Math.abs(b[1]) - Math.abs(a[1]); }).slice(0, 10);
    var features = Object.keys(score.features || {}).sort().map(function (key) { var value = score.features[key]; return [key, isNum(value) ? fmtNum(value, Math.abs(value) >= 100 ? 0 : 3) : DASH]; });
    return [
      el("div", { class: "figure", text: fmtNum(score.score, 1) }),
      el("div", { class: "figure-unit", text: "risk out of 100 at the " + score.checkpointSec + "s checkpoint" + DOT + fmtDur(score.ageMs / 1000) + " ago" }),
      el("div", { class: "badges" }, score.hardBlocked ? badge("Hard-blocked", "bad") : badge("Not hard-blocked", "good"), badge("weights " + (score.weightsVersion || DASH), "")),
      score.flags && score.flags.length ? el("div", { class: "chips" }, score.flags.map(function (flag) { return el("span", { class: "chip bad", text: flag }); })) : el("p", { class: "hint sheet-hint", text: "No flags." }),
      contributions.length ? [el("p", { class: "section-label", text: "Biggest contributions" }), kv(contributions.map(function (pair) { return [pair[0], fmtNum(pair[1], 2), pair[1] > 0 ? "neg" : "pos"]; }))] : null,
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
      fill(body, scoreBody(score));
    }).catch(function (error) {
      var text = error.status === 404 ? "Not scored yet. The scorer writes a score at its checkpoints after launch." : error.auth ? "Unlock the dashboard first." : error.message;
      body.replaceChildren(el("p", { class: "hint", text: text }));
    });
  }

  function providerText(rpc) {
    if (rpc.provider === "helius") { return "Helius"; }
    return rpc.provider === "custom" ? "another provider" : "not set";
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
      var input = el("input", { type: "text", name: "helius-key", autocomplete: "off", autocapitalize: "off", spellcheck: "false", inputmode: "text", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" });
      var note = el("p", { class: "subline", role: "status" });
      var button = el("button", { type: "button", class: "btn primary", text: "Check and save" });
      button.addEventListener("click", function () { saveRpcKey(input, note, button); });
      var current = el("dl", { class: "kv" },
        el("dt", { text: "Provider" }), el("dd", { text: providerText(rpc) }),
        el("dt", { text: "Current key" }), el("dd", { class: "mono", text: rpc.keyHint || DASH }));
      var body = rpc.canChange
        ? [field("New Helius API key", input), actions([button]), note]
        : el("p", { class: "detail", text: "Changing the key from here is off on this server. Set ENV_FILE to the path of the service env file to turn it on." });
      var device = card("This device", "The dashboard token is stored in this browser only. Forget it on a shared or lost device.",
        actions([el("button", { class: "btn", type: "button", onclick: forgetToken }, icon("lock"), "Forget token on this device")]));
      return [el("div", { class: "split" }, card("Helius RPC key", "The bot reads the chain and sends trades through Helius. Copy a new API key from dashboard.helius.dev and paste it here. It is checked with Helius first, then saved, and the bot restarts in a few seconds. Open trades are picked up again after the restart.", current, body), device)];
    });
  }
`;
