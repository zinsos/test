export const OVERVIEW_SCRIPT = String.raw`
  var CLOSED_PREVIEW = 12;
  var overview = { showAllClosed: false, showPnlNote: false, badgeSlot: null, data: null };

  function coinLabel(item) { return item.symbol || item.name || shortAddr(item.mint); }
  function pumpLink(mint, compact) {
    if (typeof mint !== "string" || !MINT_PATTERN.test(mint)) { return null; }
    return el("a", { class: "ext-link", href: PUMP_COIN_URL + encodeURIComponent(mint), target: "_blank", rel: "noopener noreferrer", "aria-label": "Open on pump.fun", title: "Open on pump.fun" },
      compact ? null : "pump.fun", icon("external"));
  }
  function modeWord(mode) { return mode === "live" ? "Live" : mode === "paper" ? "Paper" : sentence(readable(mode)); }
  function sinceRead(data, ms) { return isNum(ms) ? fmtDur((data.readAtMs - ms) / 1000) + " ago" : DASH; }
  function dayLabel(key) {
    var parts = String(key || "").split("-").map(Number);
    return parts.length === 3 && parts.every(isNum) ? fmtDay(Date.UTC(parts[0], parts[1] - 1, parts[2], 12)) : String(key || DASH);
  }
  function tradesRunOptions() {
    var runs = meta.runs.filter(function (run) { return run.mode === "paper" || run.mode === "live"; });
    if (runs.length < 2) { return null; }
    return [["", "Latest run (auto)"]].concat(runs.map(function (run) {
      return [String(run.id), "#" + run.id + " " + modeWord(run.mode) + (run.label ? DOT + run.label : "") + (run.endedAtMs ? " (ended)" : "")];
    }));
  }
  function tradesRunParam() {
    if (!state.tradesRun) { return ""; }
    var known = meta.runs.some(function (run) { return String(run.id) === state.tradesRun; });
    return known ? state.tradesRun : "";
  }
  function runPicker() {
    var options = tradesRunOptions();
    return options ? el("div", { class: "run-pick" }, selectBox(options, state.tradesRun, function (value) { state.tradesRun = value; savePrefs(); render(); }, "Run")) : null;
  }
  function viewingTraderRun(data) {
    var w = wallet.data;
    return !!(w && w.enabled && data.run && data.run.active && data.run.mode === w.mode);
  }
  function riskBadge(data) {
    var b = data.bankroll;
    if (!data.run.active) { return badge("Run ended", ""); }
    if (viewingTraderRun(data)) { var s = botState(); return badge(s.text, s.tone); }
    if (b && b.killed) { return badge("Kill switch on", "bad"); }
    if (b && b.haltedForDay) { return badge("Halted for today", "warn"); }
    return badge(data.run.mode === "live" ? "Trading live" : "Trading", "good");
  }
  function runBadgeSlot(data) {
    overview.data = data;
    overview.badgeSlot = el("span", { class: "run-badge" + (viewingTraderRun(data) ? " same-as-header" : "") }, riskBadge(data));
    return overview.badgeSlot;
  }
  function syncRunBadge() {
    if (overview.badgeSlot && overview.data && overview.data.run && state.tab === "trades") {
      fill(overview.badgeSlot, riskBadge(overview.data));
      overview.badgeSlot.className = "run-badge" + (viewingTraderRun(overview.data) ? " same-as-header" : "");
    }
  }
  function runHead(data) {
    var run = data.run;
    var age = run.active ? fmtDur((data.readAtMs - run.startedAtMs) / 1000) + " running" : "ended " + fmtTime(run.endedAtMs);
    return el("div", { class: "run-head" },
      el("div", { class: "run-title" },
        el("h2", { text: modeWord(run.mode) + " run #" + run.id + (run.label ? DOT + run.label : "") }),
        runBadgeSlot(data),
        el("p", { class: "run-meta", text: "Started " + fmtTime(run.startedAtMs) + DOT + age })),
      runPicker());
  }
  function statusBanner(data) {
    var b = data.bankroll;
    if (b && b.killed) {
      return banner("bad", "alert", el("span", { text: "Kill switch on. " + killText(b.killReason) + " Resume buying is on the wallet card." }));
    }
    if (b && b.haltedForDay) {
      return banner("warn", "alert", el("span", { text: "Daily loss limit reached. Entries resume " + fmtTime(b.haltedUntilMs) + "." }));
    }
    if (!b) {
      return banner("", "inbox", el("span", { text: "No bankroll saved for this run yet. It appears with the first trade, or within a minute while positions are open." }));
    }
    return null;
  }
  function learningNote(data) {
    var p = data.recentPromotion;
    if (!p || !isNum(p.appliedAtMs)) { return null; }
    var what = p.kind === "revert" ? "Auto-learn undid the last learned change (" + sentence(readable(p.name)) + ")" : "Auto-learn switched the paper settings to " + sentence(readable(p.name));
    var gain = p.kind !== "revert" && isNum(p.gain) ? ": " + (p.gain > 0 ? "+" : "") + minus(p.gain.toFixed(2)) + " bets per window over the old settings on fresh replays" : "";
    return banner("good", "lab", el("span", { class: "learn-note", text: what + " " + fmtAgo(p.appliedAtMs) + gain + ". A new paper run continues the same bankroll; the evidence is in Lab." }));
  }
  function traderFigure(data, key, fallback) {
    var w = wallet.data;
    return viewingTraderRun(data) && w && isNum(w[key]) ? w[key] : fallback;
  }
  function todayKpi(data) {
    var value = traderFigure(data, "todayPnlSol", data.todayPnlEstimateSol);
    if (isNum(value)) { return kpi("Today", fmtSol(value), "SOL", dayLabel(data.todayKey) + DOT + "UTC day", signClass(value)); }
    var idle = data.bankroll && !data.open.length;
    return kpi("Today", idle ? fmtSol(0) : DASH, "SOL", idle ? "no trades yet" : "starts with the trader");
  }
  function kpiRow(data) {
    var b = data.bankroll || {};
    var c = data.counts;
    var equity = traderFigure(data, "equitySol", data.equityEstimateSol);
    var start = b.startingSol;
    var growth = isNum(equity) && isNum(start) && start > 0 ? ((equity - start) / start) * 100 : null;
    var closed = isNum(c.closed) ? c.closed : 0;
    var wins = isNum(c.wins) ? c.wins : null;
    var expectancy = closed > 0 && isNum(c.realizedSol) ? c.realizedSol / closed : null;
    var onCost = isNum(c.realizedSol) && isNum(c.closedCostSol) && c.closedCostSol > 0 ? (c.realizedSol / c.closedCostSol) * 100 : null;
    var openSub = c.open ? "est. " + fmtSol(data.openPnlEstimateSol) : "none open";
    if (c.pending) { openSub = fmtInt(c.pending) + " pending" + DOT + openSub; }
    return el("div", { class: "kpis", role: "group", "aria-label": "Run key figures" },
      kpi(data.run.mode === "live" ? "Run equity" : "Equity", isNum(equity) ? fmtSolAmount(equity) : DASH, "SOL", isNum(growth) ? fmtSignedPct(growth) + " vs start" : "open at exit value", "", signClass(growth)),
      todayKpi(data),
      kpi("Open", fmtInt(c.open), "", openSub, "", c.open ? signClass(data.openPnlEstimateSol) : ""),
      kpi("Win rate", closed > 0 && isNum(wins) ? fmtPct(wins / closed, 0) : DASH, "", closed > 0 && isNum(wins) ? fmtInt(wins) + " of " + fmtInt(closed) + " won" : "no closed trades"),
      kpi("Expectancy", isNum(expectancy) ? fmtSol(expectancy) : DASH, "SOL", isNum(onCost) ? fmtSignedPct(onCost) + " on cost" : "per closed trade", signClass(expectancy), signClass(onCost)),
      kpi("Trades", fmtInt(closed), "", fmtInt(c.closedLast24h) + " in 24h"));
  }
  function coinMeta(item, timing) {
    var named = item.symbol || item.name;
    return (item.name && item.symbol ? item.name + DOT : "") + (named ? shortAddr(item.mint) + DOT : "") + timing;
  }
  function chartButton() {
    return el("button", { class: "link-btn", type: "button", onclick: function () { selectTab("live"); } }, icon("live"), "Live chart");
  }
  function pendingCard(p) {
    return el("article", { class: "pos-row pending" },
      el("div", { class: "pos-head" },
        el("div", { class: "pos-name" }, mintButton(p.mint, coinLabel(p)), el("div", { class: "meta", text: coinMeta(p, "sent " + fmtDur(p.ageSec) + " ago") })),
        el("div", { class: "pos-right" }, badge("Awaiting fill", "info"))),
      el("div", { class: "pos-foot" },
        el("span", { class: "meta", text: humanize(p.signalType) + DOT + "risk " + fmtNum(p.riskScore, 0) + DOT + "budget " + fmtSol(p.budgetSol, false) + " SOL" + DOT + "the buy is being confirmed" }),
        el("div", { class: "pos-links" }, pumpLink(p.mint))));
  }
  function positionCard(p, data) {
    if (p.status === "pending") { return pendingCard(p); }
    var badges = [];
    if (p.exiting) { badges.push(badge("Selling" + DOT + humanize(p.exiting), "warn")); }
    if (p.migrated) { badges.push(badge("Migrated", "info")); }
    return el("article", { class: "pos-row" },
      el("div", { class: "pos-head" },
        el("div", { class: "pos-name" }, mintButton(p.mint, coinLabel(p)), el("div", { class: "meta", text: coinMeta(p, humanize(p.signalType) + DOT + "risk " + fmtNum(p.riskScore, 0)) })),
        el("div", { class: "pos-right" },
          el("span", { class: "pos-mult " + multipleClass(p.multiple), text: fmtMult(p.multiple) }),
          p.takeProfitLevelsHit > 0 ? badge(p.takeProfitLevelsHit === 1 ? "1 TP hit" : p.takeProfitLevelsHit + " TPs hit", "good") : null)),
      sparkline(p.spark, p.entryPrice),
      el("div", { class: "mini-stats" },
        miniStat("PnL SOL", fmtSol(p.estimatedPnlSol), fmtSignedPct(p.estimatedPnlPct), signClass(p.estimatedPnlSol), signClass(p.estimatedPnlPct)),
        miniStat("Value SOL", fmtSolAmount(p.estimatedValueSol), "cost " + fmtSolAmount(p.entryCostSol)),
        miniStat("Peak", fmtMult(p.peakMultiple), "sold " + fmtPlainPct(p.soldPct)),
        miniStat("Held", fmtDur(p.ageSec), "since " + fmtClockTime(p.openedAtMs))),
      el("div", { class: "pos-foot" },
        el("span", { class: "meta", text: (p.proceedsSol > 0 ? "sold for " + fmtSolAmount(p.proceedsSol) + " SOL" + DOT : "") + "last trade " + sinceRead(data, p.lastTradeAtMs) }),
        el("div", { class: "pos-links" }, chartButton(), pumpLink(p.mint))),
      badges.length ? el("div", { class: "badges" }, badges) : null);
  }
  function entryRulesText(data) {
    var rules = data.entryRules;
    var word = data.run && data.run.mode === "live" ? "Live trades" : "Paper trades";
    if (!rules) {
      return word + " open when a launch passes the risk scorer and an entry filter: score momentum (low risk with strong early buying) or smart-wallet convergence (several tracked wallets buying the same launch).";
    }
    var parts = [];
    if (rules.enabled.indexOf("score_momentum") >= 0) {
      var m = rules.scoreMomentum;
      parts.push("score momentum (risk " + m.maxRiskScore + " or lower at the " + m.checkpointSec + "s checkpoint, " + m.minUniqueBuyersPerMin + "+ unique buyers a minute, buys at least " + m.minBuySellRatio + "× sells, market cap " + m.minMcapSol + " to " + m.maxMcapSol + " SOL)");
    }
    if (rules.enabled.indexOf("smart_convergence") >= 0) {
      var c = rules.convergence;
      parts.push("smart-wallet convergence (" + c.minWallets + "+ tracked wallets buy within " + c.windowSec + "s, risk " + c.maxRiskScore + " or lower; needs a wallet ranking, see Wallets)");
    }
    var filters = parts.length ? parts.join(" or ") : "no entry filter is enabled in the strategy config";
    return word + " open when a launch passes the risk scorer (risk " + rules.scorerMaxRisk + " or lower, no hard block) and " + (parts.length > 1 ? "either " : "") + filters + ". At most " + rules.maxOpenPositions + " are open at once.";
  }
  function frequencyText(data) {
    var c = data.counts;
    var windowSec = Math.max(60, Math.min(86400, (data.readAtMs - data.run.startedAtMs) / 1000));
    if (c.openedLast24h > 0) {
      return "This run opened " + fmtInt(c.openedLast24h) + " in the last " + fmtDur(windowSec) + ", about one every " + fmtDur(windowSec / c.openedLast24h) + ". The last one opened " + sinceRead(data, c.lastOpenedAtMs) + ".";
    }
    var seen = 0;
    var acted = 0;
    data.activity.byType.forEach(function (item) { seen += item.total; acted += item.acted; });
    if (seen > 0) {
      var top = data.activity.skipReasons[0];
      return fmtInt(seen) + " signals in the last " + fmtDur(windowSec) + ", " + (acted ? fmtInt(acted) + " traded" : "none traded") + (top ? "; most skips: " + humanize(top.reason).toLowerCase() : "") + ". See the Signals view.";
    }
    return "Nothing passed in the last " + fmtDur(windowSec) + ". Strict filters can go hours without an entry on a quiet market; that is expected." + (isNum(c.lastOpenedAtMs) ? " The last entry was " + sinceRead(data, c.lastOpenedAtMs) + "." : "");
  }
  function pnlNote() {
    var note = el("p", { class: "footnote", hidden: !overview.showPnlNote, text: "PnL is an estimate of closing now, booked the way the trader books a close: what was already sold, plus the tokens still held at the last trade price minus the coin's latest sell fees (strategy defaults when none were recorded) and the transaction fee, plus the token account rent refunded on close. Price impact is not included." });
    var button = el("button", { class: "info-btn small", type: "button", "aria-label": "How PnL is estimated", title: "How PnL is estimated", "aria-expanded": overview.showPnlNote ? "true" : "false" }, icon("info"));
    button.addEventListener("click", function () {
      overview.showPnlNote = !overview.showPnlNote;
      note.hidden = !overview.showPnlNote;
      button.setAttribute("aria-expanded", overview.showPnlNote ? "true" : "false");
    });
    return { button: button, note: note };
  }
  function openCard(data) {
    if (!data.open.length) {
      return el("section", { class: "card empty ov-open" }, icon("inbox", "empty-icon"), el("strong", { text: "No open positions right now" }), el("span", { class: "empty-text", text: entryRulesText(data) }), el("p", { class: "subline", text: frequencyText(data) }));
    }
    var help = pnlNote();
    return el("section", { class: "card ov-open" },
      el("div", { class: "card-head" },
        el("div", { class: "card-title-row" }, el("h2", { class: "card-title", text: "Open positions" }), help.button),
        el("span", { class: "head-meta", text: fmtInt(data.counts.open) + " open" + (data.counts.pending ? DOT + fmtInt(data.counts.pending) + " pending" : "") })),
      help.note,
      el("div", { class: "pos-list" }, data.open.map(function (p) { return positionCard(p, data); })));
  }
  function closedRow(t) {
    return el("tr", null,
      cell(fmtWhen(t.closedAtMs), "t-time"),
      el("td", { class: "t-coin" }, mintButton(t.mint, coinLabel(t), "cell-btn")),
      el("td", { class: "t-exit", title: humanize(t.exitReason), text: exitShort(t.exitReason) }),
      cell(fmtDur(t.holdSec), "hide-narrow"),
      cell(fmtSol(t.pnlSol), "t-pnl " + signClass(t.pnlSol)),
      cell(fmtSignedPct(t.pnlPct), "t-pct " + signClass(t.pnlPct)));
  }
  function closedCard(data) {
    if (!data.recentClosed.length) {
      var none = empty("No closed trades yet", "Closed trades show here with their exit reason and PnL after fees.", "inbox");
      none.classList.add("ov-closed");
      return none;
    }
    var all = overview.showAllClosed;
    var shown = all ? data.recentClosed : data.recentClosed.slice(0, CLOSED_PREVIEW);
    var more = data.recentClosed.length > CLOSED_PREVIEW
      ? el("button", { class: "btn more-btn block", type: "button", text: all ? "Show fewer" : "Show all " + fmtInt(data.recentClosed.length), onclick: function () { overview.showAllClosed = !all; render(true); } })
      : null;
    var node = el("section", { class: "card ov-closed" },
      el("div", { class: "card-head" }, el("h2", { class: "card-title", text: "Closed trades" }),
        el("span", { class: "head-meta", text: "last " + fmtInt(data.recentClosed.length) + " of " + fmtInt(data.counts.closed) + DOT + "after fees" })),
      table(["Time", "Coin", "Exit", "Hold", "PnL SOL", "%"], shown.map(closedRow), { 3: true }, "blotter", { 1: true }), more);
    return node;
  }
  function runCard(data) {
    var b = data.bankroll;
    var run = data.run;
    var c = data.counts;
    var pairs = [];
    if (b) {
      pairs.push(["Starting bankroll", fmtSolAmount(b.startingSol) + " SOL"]);
      pairs.push(["Realized PnL", fmtSol(b.realizedPnlSol) + " SOL", signClass(b.realizedPnlSol)]);
    }
    pairs.push(["Open PnL (est.)", fmtSol(data.openPnlEstimateSol) + " SOL", signClass(data.openPnlEstimateSol)]);
    if (b) { pairs.push(["Peak equity", fmtSolAmount(b.peakEquitySol) + " SOL"]); }
    pairs.push(["Last 24h trades", fmtInt(c.openedLast24h) + " opened" + DOT + fmtInt(c.closedLast24h) + " closed"]);
    pairs.push(["Last 24h PnL", fmtSol(c.realizedLast24hSol) + " SOL" + DOT + fmtInt(c.winsLast24h) + " won", signClass(c.realizedLast24hSol)]);
    pairs.push([run.active ? "Started" : "Ended", fmtTime(run.active ? run.startedAtMs : run.endedAtMs)]);
    var node = card("Run ledger", null, kv(pairs));
    node.classList.add("ov-run");
    return node;
  }
  function activityCard(data) {
    var a = data.activity;
    if (!a.byType.length) { return null; }
    var pairs = a.byType.map(function (item) { return [humanize(item.type), fmtInt(item.total) + " seen" + DOT + fmtInt(item.acted) + " traded"]; });
    a.skipReasons.forEach(function (item) { pairs.push(["Skipped: " + humanize(item.reason).toLowerCase(), fmtInt(item.count)]); });
    var node = card("Entry signals, last " + a.windowHours + "h", null, kv(pairs));
    node.classList.add("ov-activity");
    return node;
  }

  var wallet = { data: null, lastMs: 0, loading: false, busy: false, armed: null, armedUntil: 0, note: "", card: null, armBar: null };
  function walletLive() { return !!(wallet.data && wallet.data.mode === "live"); }
  function addressLink(address) {
    if (!MINT_PATTERN.test(address || "")) { return null; }
    return el("a", { class: "ext-link", href: SOLSCAN_ACCOUNT_URL + encodeURIComponent(address), target: "_blank", rel: "noopener noreferrer" }, "View on Solscan", icon("external"));
  }
  function walletArmed(action) { return wallet.armed === action && Date.now() < wallet.armedUntil; }
  function syncArmBar() {
    if (!wallet.armBar) { return; }
    var left = wallet.armed ? Math.max(0, wallet.armedUntil - Date.now()) / ARM_MS : 0;
    wallet.armBar.style.width = (left * 100).toFixed(1) + "%";
  }
  function walletControls(w) {
    var paused = w.entriesPaused;
    var holding = isNum(w.openPositions) && w.openPositions > 0;
    var action = paused ? "resume" : "close";
    var armed = walletArmed(action);
    var label = paused ? (armed ? "Tap again to resume buying" : "Resume buying")
      : holding ? (armed ? "Tap again: sell everything now" : "Close all & pause buying") : (armed ? "Tap again to pause buying" : "Pause buying");
    var tone = paused ? "primary" : holding ? "danger" : "";
    wallet.armBar = armed ? el("span", { class: "arm-bar", "aria-hidden": "true" }) : null;
    var button = el("button", { type: "button", class: "btn block " + tone + (armed ? " armed" : ""), disabled: wallet.busy, onclick: function () { walletAction(action); } }, el("span", { text: label }), wallet.armBar);
    syncArmBar();
    return el("div", { class: "actions" }, button);
  }
  function renderWalletCard() {
    var node = wallet.card;
    if (!node) { return; }
    var w = wallet.data;
    if (!w || !w.enabled) { node.hidden = true; node.replaceChildren(); return; }
    node.hidden = false;
    var live = walletLive();
    var pairs = [];
    if (live) { pairs.push(["In wallet", fmtSolAmount(w.walletSol) + " SOL" + (isNum(w.walletUsd) ? DOT + fmtUsd(w.walletUsd) : "")]); }
    pairs.push(["In open trades", fmtSolAmount(w.openValueSol) + " SOL" + DOT + fmtInt(w.openPositions) + " open"]);
    if (isNum(w.todayPnlSol)) { pairs.push(["Today", fmtSol(w.todayPnlSol) + " SOL" + (isNum(w.todayPnlUsd) ? DOT + fmtUsd(w.todayPnlUsd) : ""), signClass(w.todayPnlSol)]); }
    pairs.push(["SOL price", isNum(w.solUsd) ? fmtUsd(w.solUsd) + (w.priceSource ? DOT + w.priceSource + " " + fmtAgo(w.priceAtMs) : "") : "unavailable"]);
    if (live) { pairs.push(["Address", w.address ? shortAddr(w.address) : DASH]); }
    fill(node,
      el("div", { class: "card-head" },
        el("div", null,
          el("p", { class: "eyebrow", text: live ? "Hot wallet" : "Paper bankroll" }),
          el("div", { class: "wallet-figure" }, el("span", { class: "figure", text: fmtSolAmount(w.totalSol) }), el("span", { class: "figure-unit", text: "SOL" }),
            isNum(w.totalUsd) ? el("span", { class: "figure-usd", text: fmtUsd(w.totalUsd) }) : null),
          el("p", { class: "wallet-sub", text: live ? "Wallet SOL plus open trades at exit value" : "Run ledger with open trades at exit value" }))),
      kv(pairs),
      live ? addressLink(w.address) : null,
      w.entriesPaused ? banner("bad", "alert", el("span", { text: killText(w.killReason) })) : null,
      w.canControl ? walletControls(w) : null,
      wallet.note ? el("p", { class: "wallet-note", role: "status", text: wallet.note }) : null);
  }
  function walletCardNode() {
    if (!wallet.card) { wallet.card = el("section", { class: "card wallet-card ov-wallet", hidden: true }); }
    renderWalletCard();
    return wallet.card;
  }
  function loadWallet(force) {
    if (wallet.loading) { return Promise.resolve(wallet.data); }
    if (!force && (!autoRefreshAllowed() || Date.now() - wallet.lastMs < WALLET_MS)) { return Promise.resolve(wallet.data); }
    wallet.loading = true;
    wallet.lastMs = Date.now();
    return api("/api/wallet").then(function (data) {
      var first = wallet.data === null;
      wallet.data = data;
      renderChrome();
      renderWalletCard();
      if (first && data && data.enabled && state.tab === "trades" && lastRenderMs > 0) { render(true); }
      return data;
    }).catch(function () { return wallet.data; }).then(function (data) {
      wallet.loading = false;
      return data;
    });
  }
  function walletAction(action) {
    if (wallet.busy) { return; }
    var holding = !!(wallet.data && isNum(wallet.data.openPositions) && wallet.data.openPositions > 0);
    if (!walletArmed(action)) {
      wallet.armed = action;
      wallet.armedUntil = Date.now() + ARM_MS;
      wallet.note = action === "resume" ? "Buying starts again on the next signal." : holding ? "This sells every open position at market and pauses new buys until you resume." : "This pauses new buys until you resume.";
      renderWalletCard();
      return;
    }
    wallet.armed = null;
    wallet.busy = true;
    wallet.note = action === "close" ? (holding ? "Closing all positions…" : "Pausing…") : "Resuming…";
    renderWalletCard();
    apiPost(action === "close" ? "/api/actions/close-all" : "/api/actions/resume").then(function (result) {
      var closing = result && isNum(result.closing) ? result.closing : 0;
      wallet.note = action === "close" ? (closing ? "Selling " + fmtInt(closing) + (closing === 1 ? " position" : " positions") + ". " : "") + "New buys are paused." : (result && result.resumed ? "Buying resumed." : "Buying was not paused.");
    }).catch(function (error) {
      wallet.note = "Failed: " + (error && error.message ? error.message : "request failed");
    }).then(function () {
      wallet.busy = false;
      return loadWallet(true);
    }).then(function () {
      if (state.tab === "trades") { render(true); }
    });
  }

  var TIPS_PREVIEW = 3;
  var tips = { data: null, lastMs: 0, loading: false, card: null, runKey: "", expanded: false };
  function tipsStageText(d) {
    if (d.stage === "waiting") { return d.trades === 0 ? "Waiting for the first closed trade" : "Too early to tell"; }
    if (d.stage === "early") { return "Early hints, not results yet"; }
    if (d.stage === "building") { return "Patterns are forming"; }
    return "Enough trades to act on";
  }
  function tipItem(t) {
    var tone = TIP_TONES[t.tone] || TIP_TONES.info;
    return el("li", { class: "item tip tone-" + t.tone },
      el("div", { class: "row" }, el("strong", { class: "tip-title", text: t.title }), badge(tone[0], tone[1])),
      el("p", { class: "tip-detail", text: t.detail }),
      el("p", { class: "tip-meta", text: "Based on " + tradesWord(t.basedOn) + DOT + t.confidence + " confidence" }));
  }
  function sizingTableNode(d) {
    return table(["Bet size", "Per trade", "Result", "Worst dip"], d.sizing.map(function (row) {
      return el("tr", { class: row.multiplier === 1 ? "current-size" : null },
        cell(row.multiplier + "×" + (row.multiplier === 1 ? " (now)" : "") + (row.allowed ? "" : " *")),
        cell(fmtSolAmount(row.betSol)),
        cell(fmtSol(row.pnlSol), signClass(row.pnlSol)),
        cell(fmtSolAmount(row.worstDipSol)));
    }));
  }
  function renderTipsCard() {
    var node = tips.card;
    if (!node) { return; }
    var d = tips.data;
    if (!d || !d.run || !(d.trades > 0)) { node.hidden = true; node.replaceChildren(); return; }
    node.hidden = false;
    var all = d.tips || [];
    var shown = tips.expanded ? all : all.slice(0, TIPS_PREVIEW);
    var toggle = all.length > TIPS_PREVIEW
      ? el("button", { class: "btn more-btn block", type: "button", text: tips.expanded ? "Show fewer tips" : "Show all " + fmtInt(all.length) + " tips", onclick: function () { tips.expanded = !tips.expanded; renderTipsCard(); } })
      : null;
    fill(node,
      el("div", { class: "card-head" }, el("div", null, el("p", { class: "eyebrow", text: "Tips from your stats" }), el("h2", { class: "card-title", text: tipsStageText(d) }))),
      el("ul", { class: "list tips" }, shown.map(tipItem)),
      toggle,
      d.sizing && d.sizing.length ? [el("h3", { text: "What other bet sizes would have done" }), sizingTableNode(d),
        el("p", { class: "subline", text: "Same trades replayed at each size: results and dips scale together; fixed network fees do not." + (d.sizing.some(function (row) { return !row.allowed; }) ? " * outside the allowed bet range." : "") })] : null);
  }
  function tipsCardNode() {
    var runKey = String(tradesRunParam() || "");
    if (runKey !== tips.runKey) { tips.data = null; }
    if (!tips.card) { tips.card = el("section", { class: "card tips-card ov-tips", hidden: true }); }
    renderTipsCard();
    return tips.card;
  }
  function loadTips() {
    if (tips.loading || state.tab !== "trades") { return; }
    var runKey = String(tradesRunParam() || "");
    var fresh = runKey === tips.runKey && tips.data !== null && Date.now() - tips.lastMs < TIPS_MS;
    if (fresh || !autoRefreshAllowed()) { return; }
    tips.loading = true;
    tips.lastMs = Date.now();
    tips.runKey = runKey;
    api("/api/tips", { runId: tradesRunParam() }).then(function (d) {
      if (String(tradesRunParam() || "") === runKey && d && Array.isArray(d.tips) && typeof d.stage === "string") { tips.data = d; renderTipsCard(); }
    }).catch(function () { return null; }).then(function () { tips.loading = false; });
  }
  function walletTick() {
    loadTips();
    if (wallet.armed && Date.now() >= wallet.armedUntil) {
      wallet.armed = null;
      wallet.note = "";
      renderWalletCard();
    }
    syncArmBar();
    loadWallet(false);
  }
  function tradesView() {
    return api("/api/positions", { runId: tradesRunParam() }).then(function (data) {
      if (!data.run) {
        var options = tradesRunOptions();
        return [
          options ? el("div", { class: "controls" }, field("Run", selectBox(options, state.tradesRun, function (value) { state.tradesRun = value; savePrefs(); render(); }, "Run"))) : null,
          walletCardNode(), tipsCardNode(),
          empty("No trading run yet", "Start the service with the trader module (MODULES includes trader) and TRADING_MODE=paper. " + entryRulesText(data), "inbox")
        ];
      }
      return [
        runHead(data),
        statusBanner(data),
        learningNote(data),
        kpiRow(data),
        el("div", { class: "ov-grid" },
          el("div", { class: "ov-col" }, openCard(data), closedCard(data)),
          el("div", { class: "ov-col" }, walletCardNode(), tipsCardNode(), runCard(data), activityCard(data)))
      ];
    });
  }
`;
