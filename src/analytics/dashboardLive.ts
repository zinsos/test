export const LIVE_VIEW_SCRIPT = String.raw`
  var LIVE_FILTERS = [["all", "Everything"], ["trades", "Trades only"], ["signals", "Signals"], ["scores", "Scores"]];
  var LIVE_FEED_MAX = 300;
  var LIVE_FEED_KEEP = { score: 300, rejected: 150, other: 300 };
  var LIVE_POINTS_KEEP = 600;
  var LIVE_SERIES_MS = 10000;
  var LIVE_STALL_MS = 45000;
  var LIVE_RETRY_START_MS = 3000;
  var LIVE_RETRY_MAX_MS = 60000;
  var LIVE_LOOKBACK_MS = 60000;
  var LIVE_CARD_REDRAW_MS = 5000;
  var LIVE_LABEL_GAP_PCT = 10;
  var LIVE_LABEL_MIN_PCT = 5;
  var LIVE_LABEL_MAX_PCT = 95;
  var LIVE_KIND_LABELS = {
    score: "Score", signal: "Signal", rejected: "Rejected", skipped: "Skipped", entering: "Buying",
    opened: "Bought", partial: "Sold", closed: "Closed", risk: "Risk"
  };
  var LIVE_STATUS = {
    idle: ["Not connected", ""], connecting: ["Connecting…", "info"], live: ["Live", "good"],
    reconnecting: ["Reconnecting…", "warn"], offline: ["Offline", "bad"]
  };
  var live = {
    source: null, status: "idle", detail: "", streamId: "", lastId: 0, feed: [], held: 0, paused: false,
    positions: {}, root: null, chip: null, list: null, cards: null, pauseButton: null, note: null, gapNote: null,
    retryMs: 0, retryAtMs: 0, lastMessageMs: 0, clockOffsetMs: 0, dropped: 0, tradingActive: false
  };

  function liveParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  function liveNowMs() { return Date.now() + live.clockOffsetMs; }
  function liveTime(ms) {
    return isNum(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : DASH;
  }
  function liveCoin(symbol, mint) { return symbol ? "$" + symbol : shortAddr(mint); }
  function liveShows(event) {
    var filter = state.liveFilter || "all";
    if (filter === "trades") { return event.category === "trade" || event.category === "system"; }
    if (filter === "signals") { return event.category === "signal"; }
    if (filter === "scores") { return event.category === "score"; }
    return true;
  }
  function liveStatusText() {
    var info = LIVE_STATUS[live.status] || LIVE_STATUS.idle;
    var text = info[0];
    if (live.retryAtMs && !live.source) { text = (live.status === "offline" ? "Offline, retrying" : "Reconnecting") + " in " + Math.max(1, Math.ceil((live.retryAtMs - Date.now()) / 1000)) + "s"; }
    return live.detail ? text + DOT + live.detail : text;
  }
  function liveSetStatus(status, detail) {
    live.status = status;
    live.detail = detail || "";
    if (live.chip) {
      var info = LIVE_STATUS[status] || LIVE_STATUS.idle;
      live.chip.className = "badge live-chip " + info[1] + (status === "live" ? " pulse" : "");
      live.chip.textContent = liveStatusText();
    }
    if (dom.updated && state.tab === "live") { dom.updated.textContent = liveStatusText(); }
  }

  function liveFeedItem(event) {
    var label = LIVE_KIND_LABELS[event.kind] || readable(event.kind);
    var row = el("button", { class: "feed-row", type: "button", "aria-label": label + ": " + event.text },
      el("span", { class: "feed-time", text: liveTime(event.atMs) }),
      el("span", { class: "feed-kind", text: label }),
      el("span", { class: "feed-text", text: event.text }));
    if (event.mint) { row.addEventListener("click", function () { openScore(event.mint, event.symbol ? "$" + event.symbol : null); }); }
    return el("li", { class: "feed-item tone-" + (event.tone || "neutral") }, row);
  }
  function liveNote() {
    if (!live.note) { return; }
    var shown = live.list && live.list.children.length > 0;
    var text = "";
    if (!shown) {
      text = live.feed.length ? "Nothing in this filter yet. Scores arrive every few seconds; trades are rare by design."
        : "Waiting for the first event. Scores arrive every few seconds while launches are scored; signals and trades are much rarer.";
    }
    live.note.textContent = text;
    if (live.gapNote) { live.gapNote.textContent = live.dropped ? "Skipped " + fmtInt(live.dropped) + " events while the connection was slow." : ""; }
  }
  function liveRenderFeed() {
    if (!live.list) { return; }
    var items = [];
    for (var i = live.feed.length - 1; i >= 0 && items.length < LIVE_FEED_MAX; i -= 1) {
      if (liveShows(live.feed[i])) { items.push(liveFeedItem(live.feed[i])); }
    }
    live.list.replaceChildren.apply(live.list, items);
    liveNote();
  }
  function livePrepend(event) {
    if (!live.list || !liveShows(event)) { return; }
    live.list.insertBefore(liveFeedItem(event), live.list.firstChild);
    while (live.list.children.length > LIVE_FEED_MAX) { live.list.removeChild(live.list.lastChild); }
    liveNote();
  }
  function liveUpdatePause() {
    if (!live.pauseButton) { return; }
    live.pauseButton.textContent = live.paused ? "Resume" + (live.held ? " (" + fmtInt(live.held) + " new)" : "") : "Pause";
    live.pauseButton.setAttribute("aria-pressed", live.paused ? "true" : "false");
  }
  function liveTogglePause() {
    live.paused = !live.paused;
    if (!live.paused) { live.held = 0; liveRenderFeed(); }
    liveUpdatePause();
  }

  function liveFeedClass(event) {
    if (event.kind === "score") { return "score"; }
    return event.kind === "rejected" ? "rejected" : "other";
  }
  function liveTrimFeed() {
    var excess = { score: -LIVE_FEED_KEEP.score, rejected: -LIVE_FEED_KEEP.rejected, other: -LIVE_FEED_KEEP.other };
    live.feed.forEach(function (event) { excess[liveFeedClass(event)] += 1; });
    if (excess.score <= 0 && excess.rejected <= 0 && excess.other <= 0) { return; }
    live.feed = live.feed.filter(function (event) {
      var kind = liveFeedClass(event);
      if (excess[kind] > 0) { excess[kind] -= 1; return false; }
      return true;
    });
  }
  function liveAdd(event) {
    if (!event || !isNum(event.id) || event.id <= live.lastId) { return; }
    live.lastId = event.id;
    live.lastMessageMs = Date.now();
    if (event.kind === "position") { livePositionUpdate(event.data, event.atMs); return; }
    if (event.kind === "closed" && event.data) { liveRemoveCard(event.data.positionId); }
    live.feed.push(event);
    liveTrimFeed();
    if (live.paused) { live.held += 1; liveUpdatePause(); return; }
    livePrepend(event);
  }
  function liveHello(hello) {
    if (hello.streamId !== live.streamId) {
      live.streamId = hello.streamId;
      live.lastId = 0;
      live.feed = [];
      live.held = 0;
      live.dropped = 0;
    }
    live.clockOffsetMs = isNum(hello.serverTimeMs) ? hello.serverTimeMs - Date.now() : 0;
    live.tradingActive = !!hello.tradingActive;
    var keep = {};
    (hello.positions || []).forEach(function (view) { keep[view.id] = true; livePositionUpdate(view, hello.serverTimeMs); });
    Object.keys(live.positions).forEach(function (id) { if (!keep[id]) { liveRemoveCard(id); } });
    liveRenderCards();
    liveRenderFeed();
  }

  function liveLevelLines(view) {
    var levels = view.levels || {};
    var lines = [["lv-entry", view.entryPrice, "entry"], ["lv-stop", levels.stopLossPrice, "stop"]];
    var trail = isNum(levels.trailingStopPrice) ? levels.trailingStopPrice : levels.moonbagStopPrice;
    if (isNum(trail)) { lines.push(["lv-trail", trail, isNum(levels.trailingStopPrice) ? "trail" : "moonbag"]); }
    if (levels.nextTakeProfit && isNum(levels.nextTakeProfit.price)) { lines.push(["lv-tp", levels.nextTakeProfit.price, "TP"]); }
    return lines.filter(function (line) { return isNum(line[1]) && line[1] > 0; });
  }
  function liveChart(entry) {
    var view = entry.view;
    var entryPrice = view.entryPrice;
    var box = el("div", { class: "chart live-chart", role: "img", "aria-label": "Price since 1 minute before entry, now " + fmtMult(view.multiple) + " of entry" });
    var points = entry.points.filter(function (point) { return isNum(point.price) && point.price > 0 && isNum(point.atMs); });
    if (!(isNum(entryPrice) && entryPrice > 0) || !points.length) {
      box.append(el("p", { class: "hint chart-wait", text: "Waiting for trades on this coin…" }));
      return box;
    }
    var lines = liveLevelLines(view);
    var startMs = view.openedAtMs - LIVE_LOOKBACK_MS;
    var endMs = Math.max(liveNowMs(), points[points.length - 1].atMs, view.openedAtMs + 30000);
    var lo = Infinity;
    var hi = -Infinity;
    points.forEach(function (point) { var mult = point.price / entryPrice; lo = Math.min(lo, mult); hi = Math.max(hi, mult); });
    lines.forEach(function (line) { var mult = line[1] / entryPrice; lo = Math.min(lo, mult); hi = Math.max(hi, mult); });
    var logLo = Math.log(lo);
    var logHi = Math.log(hi);
    var pad = Math.max(0.04, (logHi - logLo) * 0.08);
    logLo -= pad;
    logHi += pad;
    function y(price) { return ((logHi - Math.log(price / entryPrice)) / (logHi - logLo)) * 180; }
    function x(atMs) { return Math.max(0, Math.min(600, ((atMs - startMs) / Math.max(1, endMs - startMs)) * 600)); }
    var visible = points.filter(function (point) { return point.atMs >= startMs; });
    if (!visible.length) { visible = [points[points.length - 1]]; }
    var path = visible.map(function (point, i) { return (i ? "L" : "M") + x(point.atMs).toFixed(1) + " " + y(point.price).toFixed(1); }).join(" ");
    path += " L" + x(endMs).toFixed(1) + " " + y(visible[visible.length - 1].price).toFixed(1);
    var markup = "<svg viewBox=\"0 0 600 180\" preserveAspectRatio=\"none\" aria-hidden=\"true\">";
    lines.forEach(function (line) {
      var ly = y(line[1]).toFixed(1);
      markup += "<line class=\"" + line[0] + "\" x1=\"0\" x2=\"600\" y1=\"" + ly + "\" y2=\"" + ly + "\"></line>";
    });
    var openX = x(view.openedAtMs).toFixed(1);
    markup += "<line class=\"lv-open\" x1=\"" + openX + "\" x2=\"" + openX + "\" y1=\"0\" y2=\"180\"></line>";
    markup += "<path class=\"lv-price\" d=\"" + path + "\"></path></svg>";
    box.innerHTML = markup;
    liveLabelSpots(lines.map(function (line) { return { line: line, top: (y(line[1]) / 180) * 100 }; })).forEach(function (spot) {
      var label = el("span", { class: "lv-label " + spot.line[0], text: spot.line[2] + " " + fmtMult(spot.line[1] / entryPrice) });
      label.style.top = spot.top.toFixed(1) + "%";
      box.append(label);
    });
    return box;
  }
  function liveLabelSpots(spots) {
    var sorted = spots.slice().sort(function (a, b) { return a.top - b.top; });
    function spread() {
      for (var i = 0; i < sorted.length; i += 1) {
        var floor = i ? sorted[i - 1].top + LIVE_LABEL_GAP_PCT : LIVE_LABEL_MIN_PCT;
        sorted[i].top = Math.max(sorted[i].top, floor);
      }
    }
    spread();
    var overflow = sorted.length ? sorted[sorted.length - 1].top - LIVE_LABEL_MAX_PCT : 0;
    if (overflow > 0) {
      sorted.forEach(function (spot) { spot.top -= overflow; });
      sorted[0].top = Math.max(sorted[0].top, LIVE_LABEL_MIN_PCT);
      spread();
    }
    return sorted;
  }
  function liveLevelsText(view) {
    var levels = view.levels || {};
    var parts = [];
    if (isNum(levels.stopLossPrice) && view.entryPrice > 0) { parts.push("stop " + fmtMult(levels.stopLossPrice / view.entryPrice)); }
    if (isNum(levels.trailingStopPrice) && view.entryPrice > 0) { parts.push("trailing stop " + fmtMult(levels.trailingStopPrice / view.entryPrice)); }
    else if (isNum(levels.moonbagStopPrice) && view.entryPrice > 0) { parts.push("moonbag stop " + fmtMult(levels.moonbagStopPrice / view.entryPrice)); }
    if (levels.nextTakeProfit) { parts.push("next take-profit " + fmtMult(levels.nextTakeProfit.multiple) + " sells " + fmtPlainPct(levels.nextTakeProfit.sellPctOfInitial)); }
    if (isNum(levels.timeStopAtMs) && levels.timeStopAtMs > liveNowMs()) { parts.push("time stop in " + fmtDur((levels.timeStopAtMs - liveNowMs()) / 1000) + " if flat"); }
    if (isNum(levels.maxHoldAtMs)) { parts.push("max hold " + (levels.maxHoldAtMs > liveNowMs() ? "in " + fmtDur((levels.maxHoldAtMs - liveNowMs()) / 1000) : "reached")); }
    return parts.length ? "Exits: " + parts.join(DOT) : "";
  }
  function liveRenderCard(entry) {
    if (!entry.node) { return; }
    entry.renderedAtMs = Date.now();
    var v = entry.view;
    var badges = [];
    if (v.exiting) { badges.push(badge("Selling: " + readable(v.exiting), "warn")); }
    if (v.takeProfitLevelsHit > 0) { badges.push(badge(v.takeProfitLevelsHit === 1 ? "1 take-profit hit" : v.takeProfitLevelsHit + " take-profits hit", "good")); }
    if (v.migrated) { badges.push(badge("Migrated", "info")); }
    var held = isNum(v.openedAtMs) ? fmtDur((liveNowMs() - v.openedAtMs) / 1000) : DASH;
    entry.node.replaceChildren();
    append(entry.node, [
      el("div", { class: "row" }, mintButton(v.mint, liveCoin(v.symbol, v.mint)), el("span", { class: "big-num " + multipleClass(v.multiple), text: fmtMult(v.multiple) })),
      el("div", { class: "row" },
        el("span", { class: "meta", text: "held " + held + DOT + "cost " + fmtSol(v.costSol, false) + " SOL" + DOT + "sold " + fmtPlainPct(v.soldPct) + DOT + "peak " + fmtMult(v.peakMultiple) }),
        el("span", { class: "num " + signClass(v.pnlEstimateSol), text: fmtSol(v.pnlEstimateSol) + " SOL" })),
      liveChart(entry),
      el("div", { class: "lv-legend", "aria-hidden": "true" },
        el("span", { class: "lg lg-price", text: "price" }), el("span", { class: "lg lg-entry", text: "entry" }),
        el("span", { class: "lg lg-stop", text: "stop" }), el("span", { class: "lg lg-trail", text: "trailing" }), el("span", { class: "lg lg-tp", text: "take-profit" })),
      el("p", { class: "subline", text: liveLevelsText(v) }),
      badges.length ? el("div", { class: "badges" }, badges) : null]);
  }
  function liveRenderCards() {
    if (!live.cards) { return; }
    var entries = Object.keys(live.positions).map(function (id) { return live.positions[id]; })
      .sort(function (a, b) { return (b.view.openedAtMs || 0) - (a.view.openedAtMs || 0); });
    if (!entries.length) {
      var idle = live.tradingActive ? "No open positions. A new buy shows up here with a live price chart, its stop, trailing stop and next take-profit."
        : "No trader is running in this service, so there are no positions to chart. Scores and signals still stream below.";
      live.cards.replaceChildren(el("section", { class: "card empty slim" }, el("span", { text: idle })));
      return;
    }
    live.cards.replaceChildren.apply(live.cards, entries.map(function (entry) { return entry.node; }));
  }
  function liveFetchSeries(entry) {
    entry.seriesAtMs = Date.now();
    var id = entry.view.id;
    api("/api/live/position/" + encodeURIComponent(id) + "/series").then(function (series) {
      if (live.positions[id] !== entry || !series) { return; }
      entry.view = series.position || entry.view;
      entry.points = (series.points || []).slice(-LIVE_POINTS_KEEP);
      liveRenderCard(entry);
    }).catch(function (error) {
      if (error && error.status === 404) { liveRemoveCard(id); }
    });
  }
  function livePositionUpdate(view, atMs) {
    if (!view || !view.id) { return; }
    var entry = live.positions[view.id];
    var created = !entry;
    if (created) {
      entry = { view: view, points: [], seriesAtMs: 0, renderedAtMs: 0, node: el("section", { class: "card live-pos" }) };
      live.positions[view.id] = entry;
    }
    entry.view = view;
    if (isNum(view.price) && view.price > 0) {
      var at = isNum(atMs) ? atMs : liveNowMs();
      var last = entry.points[entry.points.length - 1];
      if (!last || last.atMs <= at) { entry.points.push({ atMs: at, price: view.price }); }
      if (entry.points.length > LIVE_POINTS_KEEP) { entry.points.splice(0, entry.points.length - LIVE_POINTS_KEEP); }
    }
    liveRenderCard(entry);
    if (created) {
      liveRenderCards();
      liveFetchSeries(entry);
    }
  }
  function liveRemoveCard(id) {
    if (!id || !live.positions[id]) { return; }
    delete live.positions[id];
    liveRenderCards();
  }

  function liveDisconnect() {
    if (live.source) {
      var source = live.source;
      live.source = null;
      try { source.close(); } catch (e) { return; }
    }
  }
  function liveStop() {
    liveDisconnect();
    live.retryAtMs = 0;
    if (live.status !== "idle") { liveSetStatus("idle"); }
  }
  function liveScheduleRetry(status) {
    liveDisconnect();
    live.retryMs = Math.min(LIVE_RETRY_MAX_MS, live.retryMs ? live.retryMs * 2 : LIVE_RETRY_START_MS);
    live.retryAtMs = Date.now() + live.retryMs;
    liveSetStatus(status || "reconnecting");
  }
  function liveOpen() {
    var Source = window.EventSource;
    liveDisconnect();
    live.retryAtMs = 0;
    if (typeof Source !== "function") { liveSetStatus("offline", "this browser cannot open a live stream"); return; }
    var source = new Source("/api/live/stream" + queryString({ token: token() }));
    live.source = source;
    live.lastMessageMs = Date.now();
    liveSetStatus("connecting");
    source.onopen = function () {
      if (live.source !== source) { return; }
      live.retryMs = 0;
      live.lastMessageMs = Date.now();
      liveSetStatus("live");
    };
    source.onmessage = function (message) {
      if (live.source !== source) { return; }
      liveAdd(liveParse(message.data));
    };
    source.addEventListener("hello", function (message) {
      var hello = live.source === source ? liveParse(message.data) : null;
      if (!hello) { return; }
      live.lastMessageMs = Date.now();
      liveHello(hello);
      liveSetStatus("live");
    });
    source.addEventListener("heartbeat", function (message) {
      if (live.source !== source) { return; }
      live.lastMessageMs = Date.now();
      var beat = liveParse(message.data);
      if (beat && isNum(beat.atMs)) { live.clockOffsetMs = beat.atMs - Date.now(); }
      if (beat) { live.tradingActive = !!beat.tradingActive; }
      if (live.status !== "live") { liveSetStatus("live"); }
    });
    source.addEventListener("gap", function (message) {
      var gap = live.source === source ? liveParse(message.data) : null;
      if (gap && isNum(gap.dropped)) { live.dropped += gap.dropped; liveNote(); }
    });
    source.onerror = function () {
      if (live.source !== source) { return; }
      if (source.readyState === 2) { liveScheduleRetry("offline"); } else { liveSetStatus("reconnecting"); }
    };
  }
  function liveReconnect() {
    api("/api/live/status").then(function (status) {
      if (state.tab !== "live") { return; }
      if (!status || !status.enabled) { liveStop(); render(); return; }
      liveOpen();
    }).catch(function (error) {
      if (error && error.auth) { liveStop(); render(); return; }
      if (state.tab === "live") { liveScheduleRetry("offline"); }
    });
  }
  function liveTick() {
    if (state.tab !== "live" || document.visibilityState !== "visible" || !live.root) { return; }
    var now = Date.now();
    if (live.source && now - live.lastMessageMs > LIVE_STALL_MS) { liveScheduleRetry("reconnecting"); }
    if (!live.source && live.retryAtMs && now >= live.retryAtMs) { live.retryAtMs = 0; liveSetStatus("connecting"); liveReconnect(); }
    else if (live.chip) { live.chip.textContent = liveStatusText(); }
    Object.keys(live.positions).forEach(function (id) {
      var entry = live.positions[id];
      if (now - entry.seriesAtMs >= LIVE_SERIES_MS) { liveFetchSeries(entry); }
      else if (now - (entry.renderedAtMs || 0) >= LIVE_CARD_REDRAW_MS) { liveRenderCard(entry); }
    });
  }
  function liveRoot() {
    if (live.root) { liveRenderCards(); liveRenderFeed(); return live.root; }
    live.chip = el("span", { class: "badge live-chip", role: "status" });
    live.pauseButton = el("button", { class: "btn", type: "button", text: "Pause", "aria-pressed": "false", onclick: liveTogglePause });
    live.cards = el("div", { class: "live-cards" });
    live.list = el("ul", { class: "list feed" });
    live.note = el("p", { class: "hint" });
    live.gapNote = el("p", { class: "hint" });
    var filter = selectBox(LIVE_FILTERS, state.liveFilter || "all", function (value) { state.liveFilter = value; savePrefs(); liveRenderFeed(); }, "Show");
    live.root = el("div", { class: "live" },
      el("div", { class: "live-bar" }, live.chip, field("Show", filter), live.pauseButton),
      live.cards,
      card("What the bot is doing", "Newest first, as it happens. Tap a line for the coin's score.", live.note, live.gapNote, live.list));
    liveSetStatus(live.status, live.detail);
    liveUpdatePause();
    liveRenderCards();
    liveRenderFeed();
    return live.root;
  }
  function liveView() {
    return api("/api/live/status").then(function (status) {
      if (!status || !status.enabled) {
        liveStop();
        return empty("No live stream in this service", "The live feed comes from the service that runs the scorer, tracker and trader. Add dashboard to MODULES of that service (the VPS runs them together) to watch it here.");
      }
      live.tradingActive = !!status.tradingActive;
      var root = liveRoot();
      if (!live.source && !live.retryAtMs) { liveOpen(); }
      return root;
    });
  }
`;
