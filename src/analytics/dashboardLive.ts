export const LIVE_VIEW_SCRIPT = String.raw`
  var LIVE_FILTERS = [["all", "Everything"], ["trades", "Trades only"], ["signals", "Signals"], ["scores", "Scores"]];
  var LIVE_FEED_MAX = 300;
  var LIVE_FEED_KEEP = { score: 300, rejected: 150, other: 300 };
  var LIVE_POINTS_KEEP = 600;
  var LIVE_SERIES_MS = 10000;
  var LIVE_STALL_MS = 45000;
  var LIVE_FALLBACK_MS = 6000;
  var LIVE_POLL_MS = 2000;
  var LIVE_RETRY_START_MS = 3000;
  var LIVE_RETRY_MAX_MS = 60000;
  var LIVE_LOOKBACK_MS = 60000;
  var LIVE_CARD_REDRAW_MS = 5000;
  var LIVE_LEVEL_REACH = 2.2;
  var LIVE_MARK_NEAR = 0.025;
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
    retryMs: 0, retryAtMs: 0, lastMessageMs: 0, clockOffsetMs: 0, dropped: 0, tradingActive: false,
    mode: "stream", helloSeen: false, openedAtMs: 0, polling: false, lastPollMs: 0
  };

  function liveParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  function liveNowMs() { return Date.now() + live.clockOffsetMs; }
  function liveTime(ms) {
    return isNum(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : DASH;
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
    var lines = [["lv-entry", view.entryPrice, "Entry"], ["lv-stop", levels.stopLossPrice, "Stop"]];
    var trail = isNum(levels.trailingStopPrice) ? levels.trailingStopPrice : levels.moonbagStopPrice;
    if (isNum(trail)) { lines.push(["lv-trail", trail, isNum(levels.trailingStopPrice) ? "Trail" : "Bag"]); }
    if (levels.nextTakeProfit && isNum(levels.nextTakeProfit.price)) { lines.push(["lv-tp", levels.nextTakeProfit.price, "TP"]); }
    return lines.filter(function (line) { return isNum(line[1]) && line[1] > 0; });
  }
  function liveChartModel(view, points, fills, nowMs) {
    var entryPrice = view.entryPrice;
    if (!(isNum(entryPrice) && entryPrice > 0)) { return null; }
    var clean = points.filter(function (point) { return isNum(point.price) && point.price > 0 && isNum(point.atMs); });
    if (!clean.length) { return null; }
    var startMs = view.openedAtMs - LIVE_LOOKBACK_MS;
    var lastPoint = clean[clean.length - 1];
    var endMs = Math.max(nowMs, lastPoint.atMs, view.openedAtMs + 30000);
    var visible = clean.filter(function (point) { return point.atMs >= startMs; });
    if (!visible.length) { visible = [lastPoint]; }
    var current = isNum(view.price) && view.price > 0 ? view.price : visible[visible.length - 1].price;
    var line = visible.concat([{ atMs: endMs, price: current }]);
    var marks = (fills || []).filter(function (mark) { return mark && isNum(mark.price) && mark.price > 0 && isNum(mark.atMs) && mark.atMs >= startMs && mark.atMs <= endMs; });
    var lo = 1;
    var hi = 1;
    function include(mult) { if (isNum(mult) && mult > 0) { lo = Math.min(lo, mult); hi = Math.max(hi, mult); } }
    line.forEach(function (point) { include(point.price / entryPrice); });
    marks.forEach(function (mark) { include(mark.price / entryPrice); });
    var coreLo = lo;
    var coreHi = hi;
    var levels = liveLevelLines(view).map(function (level) {
      var mult = level[1] / entryPrice;
      var inside = mult >= coreLo / LIVE_LEVEL_REACH && mult <= coreHi * LIVE_LEVEL_REACH;
      if (inside) { include(mult); }
      return { cls: level[0], name: level[2], price: level[1], mult: mult, inside: inside };
    });
    var logLo = Math.log(lo);
    var logHi = Math.log(hi);
    var pad = Math.max(0.04, (logHi - logLo) * 0.08);
    return { entryPrice: entryPrice, openedAtMs: view.openedAtMs, startMs: startMs, endMs: endMs, line: line, current: current, marks: marks, levels: levels, logLo: logLo - pad, logHi: logHi + pad };
  }
  function liveMarkText(mark, entryPrice) {
    var at = " at " + fmtMult(mark.price / entryPrice);
    if (mark.side === "buy") { return "Bought " + fmtSol(mark.sol, false) + " SOL" + at; }
    var share = isNum(mark.pctOfEntry) ? fmtPlainPct(mark.pctOfEntry) + " " : "";
    return "Sold " + share + "for " + fmtSol(mark.sol, false) + " SOL" + at + (mark.reason ? DOT + readable(mark.reason) : "");
  }
  function liveGridText(mult) { return (mult >= 10 ? mult.toFixed(0) : String(mult)) + "×"; }
  function renderLiveChart(entry) {
    var f = entry.chart;
    var view = entry.view;
    var model = liveChartModel(view, entry.points, entry.fills, liveNowMs());
    f.box.setAttribute("aria-label", "Price since 1 minute before entry, now " + fmtMult(view.multiple) + " of entry");
    if (!model) {
      svgInto(f.art, "");
      f.marks.replaceChildren();
      f.tags.replaceChildren();
      f.xaxis.replaceChildren();
      f.api = null;
      chartHide(f);
      f.wait.textContent = "Waiting for trades on this coin…";
      f.wait.hidden = false;
      return;
    }
    f.wait.hidden = true;
    f.wait.textContent = "";
    function y(price) { return ((model.logHi - Math.log(price / model.entryPrice)) / (model.logHi - model.logLo)) * CHART_SPAN; }
    function x(atMs) { return clamp(((atMs - model.startMs) / Math.max(1, model.endMs - model.startMs)) * CHART_SPAN, 0, CHART_SPAN); }
    var grid = multipleTicks(Math.exp(model.logLo), Math.exp(model.logHi), 5);
    var times = timeTicks(model.startMs, model.endMs, model.openedAtMs, 5);
    var xs = model.line.map(function (point) { return x(point.atMs); });
    var ys = model.line.map(function (point) { return y(point.price); });
    var currentMult = model.current / model.entryPrice;
    var tone = currentMult >= 1 ? "pos" : "neg";
    if (!f.gradientId) { f.gradientId = nextGradientId(); }
    var id = f.gradientId;
    var svg = [svgOpen(), gradientDefs(id, "accent", 0.28)];
    grid.forEach(function (mult) { svg.push(hLine("cg", y(mult * model.entryPrice))); });
    times.forEach(function (tick) { svg.push(vLine("cg cg-v", x(tick.atMs))); });
    svg.push(vLine("lv-open", x(model.openedAtMs)));
    svg.push("<path class=\"lv-area\" fill=\"url(#" + id + ")\" d=\"" + areaD(xs, ys) + "\"></path>");
    model.levels.forEach(function (level) { if (level.inside) { svg.push(hLine(level.cls, y(level.price))); } });
    svg.push("<path class=\"lv-price\" d=\"" + pathD(xs, ys) + "\"></path></svg>");
    svgInto(f.art, svg.join(""));
    var tags = model.levels.map(function (level) {
      if (level.inside) { return { top: y(level.price) / 10, cls: "lv-label " + level.cls, text: level.name + " " + fmtMult(level.mult) }; }
      var above = level.mult > 1;
      return { top: above ? 0 : 100, cls: "lv-label " + level.cls + " off", text: level.name + " " + fmtMult(level.mult) + (above ? " ↑" : " ↓") };
    });
    tags.push({ top: y(model.current) / 10, cls: "lv-now " + tone, text: fmtMult(currentMult) });
    chartGutter(f, grid.map(function (mult) { return { y: y(mult * model.entryPrice), text: liveGridText(mult) }; }), tags);
    chartXLabels(f, times.map(function (tick) { return { x: x(tick.atMs), text: fmtClock(tick.sec) }; }));
    var dots = model.marks.map(function (mark) {
      return chartMark("fill-mark " + (mark.side === "buy" ? "buy" : "sell"), x(mark.atMs), y(mark.price), mark.side === "buy" ? "B" : "S");
    });
    dots.push(chartMark("now-dot " + tone, xs[xs.length - 1], ys[ys.length - 1]));
    f.marks.replaceChildren();
    append(f.marks, dots);
    var span = Math.max(1, model.endMs - model.startMs);
    chartBind(f, {
      size: function () { return model.line.length; },
      x: function (i) { return xs[i]; },
      show: function (i) {
        var point = model.line[i];
        var mult = point.price / model.entryPrice;
        var since = (point.atMs - model.openedAtMs) / 1000;
        var near = null;
        model.marks.forEach(function (mark) { if (Math.abs(mark.atMs - point.atMs) <= span * LIVE_MARK_NEAR && (!near || Math.abs(mark.atMs - point.atMs) < Math.abs(near.atMs - point.atMs))) { near = mark; } });
        chartShowAt(f, xs[i], ys[i], [
          el("strong", { class: multipleClass(mult), text: fmtMult(mult) }),
          el("div", { text: fmtSignedPct((mult - 1) * 100) + " vs entry" }),
          el("div", { class: "tt-muted", text: liveTime(point.atMs) + DOT + (since >= 0 ? fmtClock(since) + " since entry" : fmtClock(-since) + " before entry") }),
          near ? el("div", { class: "tt-fill", text: liveMarkText(near, model.entryPrice) }) : null
        ], fmtMult(mult));
      }
    });
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
  function liveCardParts() {
    var chart = chartFrame("live-chart", "Price chart", true);
    chart.wait = el("p", { class: "chart-wait", hidden: true });
    chart.box.append(chart.wait);
    return {
      node: el("section", { class: "card live-pos" }),
      head: el("div", { class: "live-pos-head" }),
      stats: el("div", { class: "mini-stats" }),
      chart: chart,
      legend: el("div", { class: "legend", "aria-hidden": "true" },
        el("span", { class: "lg lg-price", text: "price" }), el("span", { class: "lg lg-entry", text: "entry" }),
        el("span", { class: "lg lg-stop", text: "stop" }), el("span", { class: "lg lg-trail", text: "trailing" }), el("span", { class: "lg lg-tp", text: "take-profit" }),
        el("span", { class: "lg lg-buy", text: "buy" }), el("span", { class: "lg lg-sell", text: "sell" })),
      levels: el("p", { class: "live-levels" }),
      badges: el("div", { class: "badges" })
    };
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
    entry.head.replaceChildren(
      el("div", { class: "pos-name" }, mintButton(v.mint, liveCoin(v.symbol, v.mint)),
        el("div", { class: "meta", text: (v.name ? v.name + DOT : "") + shortAddr(v.mint) + DOT + readable(v.signalType) + DOT + "risk " + fmtNum(v.riskScore, 0) })),
      el("span", { class: "pos-mult " + multipleClass(v.multiple), text: fmtMult(v.multiple) }));
    entry.stats.replaceChildren(
      miniStat("PnL est.", fmtSol(v.pnlEstimateSol), " SOL", signClass(v.pnlEstimateSol)),
      miniStat("Return", fmtSignedPct(v.pnlEstimatePct), "", signClass(v.pnlEstimatePct)),
      miniStat("Held", held, "", ""),
      miniStat("Peak", fmtMult(v.peakMultiple), "", ""));
    renderLiveChart(entry);
    entry.levels.textContent = liveLevelsText(v) + (liveLevelsText(v) ? DOT : "") + "cost " + fmtSol(v.costSol, false) + " SOL" + DOT + "sold " + fmtPlainPct(v.soldPct);
    entry.badges.replaceChildren();
    append(entry.badges, badges);
  }
  function liveRenderCards() {
    if (!live.cards) { return; }
    var entries = Object.keys(live.positions).map(function (id) { return live.positions[id]; })
      .sort(function (a, b) { return (b.view.openedAtMs || 0) - (a.view.openedAtMs || 0); });
    if (!entries.length) {
      var idle = live.tradingActive ? "No open positions. A new buy shows up here with a live price chart, its stop, trailing stop and next take-profit."
        : "No trader is running in this service, so there are no positions to chart. Scores and signals still stream alongside.";
      live.cards.replaceChildren(el("section", { class: "card empty slim" }, icon("live", "empty-icon"), el("span", { text: idle })));
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
      entry.fills = Array.isArray(series.fills) ? series.fills : [];
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
      var parts = liveCardParts();
      entry = { view: view, points: [], fills: [], seriesAtMs: 0, renderedAtMs: 0, node: parts.node, head: parts.head, stats: parts.stats, chart: parts.chart, levels: parts.levels, badges: parts.badges };
      entry.node.append(parts.head, parts.stats, parts.chart.box, parts.legend, parts.levels, parts.badges);
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
  function liveSyncPositions(hello) {
    live.clockOffsetMs = isNum(hello.serverTimeMs) ? hello.serverTimeMs - Date.now() : live.clockOffsetMs;
    live.tradingActive = !!hello.tradingActive;
    var keep = {};
    (hello.positions || []).forEach(function (view) { keep[view.id] = true; livePositionUpdate(view, hello.serverTimeMs); });
    Object.keys(live.positions).forEach(function (id) { if (!keep[id]) { liveRemoveCard(id); } });
  }
  function livePoll() {
    if (live.polling) { return; }
    live.polling = true;
    live.lastPollMs = Date.now();
    api("/api/live/events", { stream: live.streamId || "", after: live.lastId || 0 }).then(function (result) {
      live.polling = false;
      if (state.tab !== "live" || live.mode !== "poll" || !result) { return; }
      if (result.hello) {
        if (result.hello.streamId !== live.streamId) { liveHello(result.hello); } else { liveSyncPositions(result.hello); }
      }
      (result.events || []).forEach(liveAdd);
      live.lastMessageMs = Date.now();
      liveSetStatus("live", "updates every 2s");
    }).catch(function (error) {
      live.polling = false;
      if (error && error.auth) { liveStop(); render(); return; }
      if (live.mode === "poll") { liveSetStatus("reconnecting", "polling"); }
    });
  }
  function livePollStart() {
    liveDisconnect();
    live.mode = "poll";
    live.retryAtMs = 0;
    live.lastPollMs = 0;
    liveSetStatus("connecting", "polling every 2s");
    livePoll();
  }
  function liveOpen() {
    var Source = window.EventSource;
    if (live.mode === "poll") { livePollStart(); return; }
    liveDisconnect();
    live.retryAtMs = 0;
    live.helloSeen = false;
    live.openedAtMs = Date.now();
    if (typeof Source !== "function") { livePollStart(); return; }
    var source = new Source("/api/live/stream" + queryString({ token: token() }));
    live.source = source;
    live.lastMessageMs = Date.now();
    liveSetStatus("connecting");
    source.onopen = function () {
      if (live.source !== source) { return; }
      live.retryMs = 0;
      live.lastMessageMs = Date.now();
    };
    source.onmessage = function (message) {
      if (live.source !== source) { return; }
      liveAdd(liveParse(message.data));
    };
    source.addEventListener("hello", function (message) {
      var hello = live.source === source ? liveParse(message.data) : null;
      if (!hello) { return; }
      live.helloSeen = true;
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
    if (live.mode === "stream" && live.source && !live.helloSeen && now - live.openedAtMs > LIVE_FALLBACK_MS) { livePollStart(); }
    if (live.mode === "poll" && !live.polling && now - live.lastPollMs >= LIVE_POLL_MS) { livePoll(); }
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
    var feedCard = card("What the bot is doing", "Newest first, as it happens. Tap a line for the coin's score.", live.note, live.gapNote, live.list);
    feedCard.classList.add("feed-card");
    live.root = el("div", { class: "live" },
      el("div", { class: "live-bar" }, live.chip, filter, live.pauseButton),
      el("div", { class: "live-layout" }, live.cards, feedCard));
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
