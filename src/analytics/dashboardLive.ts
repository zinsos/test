export const LIVE_VIEW_SCRIPT = String.raw`
  var LIVE_FILTERS = [["activity", "Trades & signals"], ["trades", "Trades only"], ["signals", "Signals"], ["scores", "Scores"], ["all", "Everything"]];
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
  var LIVE_LEVEL_WIDEN = 1.4;
  var LIVE_MIN_RANGE = 0.08;
  var LIVE_STALE_MS = 20000;
  var LIVE_X_MAX = 975;
  var LIVE_MARK_NEAR = 0.025;
  var LIVE_KIND_LABELS = {
    score: "Score", signal: "Signal", rejected: "Rejected", skipped: "Skipped", entering: "Buying",
    opened: "Bought", partial: "Sold", closed: "Closed", risk: "Risk"
  };
  var LIVE_STATUS = {
    idle: ["Not connected", ""], connecting: ["Connecting…", "info"], live: ["Streaming", "good"],
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
  function liveCoin(symbol, mint) { return symbol ? "$" + symbol : shortAddr(mint); }
  function liveShows(event) {
    var filter = state.liveFilter || "activity";
    if (filter === "activity") { return event.category === "trade" || event.category === "system" || event.category === "signal"; }
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
  }

  function liveFeedItem(event) {
    var label = LIVE_KIND_LABELS[event.kind] || sentence(readable(event.kind));
    var row = el("button", { class: "feed-row", type: "button", "aria-label": label + ": " + event.text },
      el("span", { class: "feed-time", text: fmtSeconds(event.atMs) }),
      el("span", { class: "feed-kind", text: label }),
      el("span", { class: "feed-text", text: event.text }));
    if (event.mint) { row.addEventListener("click", function () { openScore(event.mint, event.symbol ? "$" + event.symbol : null); }); }
    return el("li", { class: "feed-item tone-" + (event.tone || "neutral") + " cat-" + (event.category || "other") }, row);
  }
  function liveNote() {
    if (!live.note) { return; }
    var shown = live.list && live.list.children.length > 0;
    var text = "";
    if (!shown) {
      text = live.feed.length ? "Nothing in this filter yet. Trades are rare by design; pick Everything to watch scores stream past."
        : "Waiting for the first event. Scores arrive every few seconds while launches are scored; signals and trades are much rarer.";
    }
    live.note.textContent = text;
    live.note.hidden = !text;
    if (live.gapNote) { live.gapNote.textContent = live.dropped ? "Skipped " + fmtInt(live.dropped) + " events while the connection was slow." : ""; live.gapNote.hidden = !live.dropped; }
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
    var lastReal = visible[visible.length - 1];
    var current = isNum(view.price) && view.price > 0 ? view.price : lastReal.price;
    var tradeAtMs = isNum(view.lastTradeAtMs) ? Math.max(view.lastTradeAtMs, lastReal.atMs) : lastReal.atMs;
    var line = visible.concat([{ atMs: endMs, price: current }]);
    var marks = (fills || []).filter(function (mark) { return mark && isNum(mark.price) && mark.price > 0 && isNum(mark.atMs) && mark.atMs >= startMs && mark.atMs <= endMs; });
    var lo = 1;
    var hi = 1;
    function include(mult) { if (isNum(mult) && mult > 0) { lo = Math.min(lo, mult); hi = Math.max(hi, mult); } }
    line.forEach(function (point) { include(point.price / entryPrice); });
    marks.forEach(function (mark) { include(mark.price / entryPrice); });
    var levels = liveLevelLines(view).map(function (level) { return { cls: level[0], name: level[2], price: level[1], mult: level[1] / entryPrice, inside: false }; });
    levels.forEach(function (level) { if (level.cls === "lv-entry" || level.cls === "lv-stop") { level.inside = true; include(level.mult); } });
    var limit = Math.max(LIVE_MIN_RANGE, Math.log(hi / lo)) * LIVE_LEVEL_WIDEN;
    function outside(level) { return level.mult > hi ? Math.log(level.mult / hi) : level.mult < lo ? Math.log(lo / level.mult) : 0; }
    levels.filter(function (level) { return !level.inside; }).sort(function (a, b) { return outside(a) - outside(b); }).forEach(function (level) {
      level.inside = Math.log(Math.max(hi, level.mult) / Math.min(lo, level.mult)) <= limit;
      if (level.inside) { include(level.mult); }
    });
    var logLo = Math.log(lo);
    var logHi = Math.log(hi);
    var pad = Math.max(0.04, (logHi - logLo) * 0.08);
    return {
      entryPrice: entryPrice, openedAtMs: view.openedAtMs, startMs: startMs, endMs: endMs, line: line, current: current, marks: marks, levels: levels,
      logLo: logLo - pad, logHi: logHi + pad, tradeAtMs: tradeAtMs, stale: endMs - tradeAtMs > LIVE_STALE_MS
    };
  }
  function liveMarkText(mark, entryPrice) {
    var at = " at " + fmtMult(mark.price / entryPrice);
    if (mark.side === "buy") { return "Bought " + fmtSol(mark.sol, false) + " SOL" + at; }
    var share = isNum(mark.pctOfEntry) ? fmtPlainPct(mark.pctOfEntry) + " " : "";
    return "Sold " + share + "for " + fmtSol(mark.sol, false) + " SOL" + at + (mark.reason ? DOT + humanize(mark.reason) : "");
  }
  function liveGridText(mult) { return (mult >= 10 ? mult.toFixed(0) : String(mult)) + "×"; }
  function liveMcapAt(view, price) {
    return isNum(view.marketCapSol) && isNum(view.price) && view.price > 0 && isNum(price) ? view.marketCapSol * (price / view.price) : null;
  }
  function liveMcapItem(view, price) {
    var mcap = liveMcapAt(view, price);
    if (!isNum(mcap)) { return null; }
    var usd = usdOf(mcap);
    return roKey("MC", fmtMcap(mcap) + (isNum(usd) ? DOT + fmtCompactUsd(usd) : ""));
  }
  function liveReadout(view, model, point, near) {
    var mult = point.price / model.entryPrice;
    var main = [roItem(fmtMult(mult), "strong " + multipleClass(mult)), roItem(fmtSignedPct((mult - 1) * 100), signClass(mult - 1)), liveMcapItem(view, point.price)];
    var since = (point.atMs - model.openedAtMs) / 1000;
    var when = fmtSeconds(point.atMs) + DOT + (since >= 0 ? fmtClock(since) + " after entry" : fmtClock(-since) + " before entry");
    return { main: main, sub: near ? liveMarkText(near, model.entryPrice) + DOT + fmtSeconds(near.atMs) : when, subTone: near ? "fill" : "" };
  }
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
      chartReadout(f, { main: [roItem("Waiting for trades", "strong")], sub: "The chart starts with the next trade on this coin." }, false);
      f.wait.textContent = "Waiting for trades on this coin…";
      f.wait.hidden = false;
      return;
    }
    f.wait.hidden = true;
    f.wait.textContent = "";
    function y(price) { return ((model.logHi - Math.log(price / model.entryPrice)) / (model.logHi - model.logLo)) * CHART_SPAN; }
    function x(atMs) { return clamp(((atMs - model.startMs) / Math.max(1, model.endMs - model.startMs)) * LIVE_X_MAX, 0, LIVE_X_MAX); }
    var gridMults = multipleTicks(Math.exp(model.logLo), Math.exp(model.logHi), 5);
    var times = timeTicks(model.startMs, model.endMs, model.openedAtMs, 5);
    var xs = model.line.map(function (point) { return x(point.atMs); });
    var ys = model.line.map(function (point) { return y(point.price); });
    var realCount = model.stale ? xs.length - 1 : xs.length;
    var realXs = xs.slice(0, realCount);
    var realYs = ys.slice(0, realCount);
    var currentMult = model.current / model.entryPrice;
    var tone = currentMult >= 1 ? "pos" : "neg";
    if (!f.gradientId) { f.gradientId = nextGradientId(); }
    var id = f.gradientId;
    var svg = [svgOpen(), gradientDefs(id, "accent", 0.26)];
    gridMults.forEach(function (mult) { svg.push(hLine("cg", y(mult * model.entryPrice))); });
    times.forEach(function (tick) { svg.push(vLine("cg cg-v", x(tick.atMs))); });
    svg.push(vLine("lv-open", x(model.openedAtMs)));
    if (realXs.length > 1) { svg.push("<path class=\"lv-area\" fill=\"url(#" + id + ")\" d=\"" + areaD(realXs, realYs) + "\"></path>"); }
    model.levels.forEach(function (level) { if (level.inside) { svg.push(hLine(level.cls, y(level.price))); } });
    svg.push("<path class=\"lv-price\" d=\"" + pathD(realXs, realYs) + "\"></path>");
    if (model.stale) { svg.push("<path class=\"lv-tail\" d=\"" + pathD(xs.slice(-2), ys.slice(-2)) + "\"></path>"); }
    svg.push("</svg>");
    svgInto(f.art, svg.join(""));
    var tags = model.levels.map(function (level) {
      if (level.inside) { return { top: y(level.price) / 10, cls: "lv-label " + level.cls, lead: level.cls, text: level.name + " " + fmtMult(level.mult) }; }
      var above = level.mult > 1;
      return { top: above ? 0 : 100, pinned: true, cls: "lv-label " + level.cls + " off", text: level.name + " " + fmtMult(level.mult) + (above ? " ↑" : " ↓") };
    });
    tags.push({ top: y(model.current) / 10, priority: 1, cls: "lv-now " + tone, lead: "lv-now-lead", text: fmtMult(currentMult) });
    chartGutter(f, gridMults.map(function (mult) { return { y: y(mult * model.entryPrice), text: liveGridText(mult) }; }), tags);
    chartXLabels(f, times.map(function (tick) { return { x: x(tick.atMs), text: fmtClock(tick.sec) }; }));
    var dots = model.marks.map(function (mark) {
      return chartMark("fill-mark " + (mark.side === "buy" ? "buy" : "sell"), x(mark.atMs), y(mark.price), mark.side === "buy" ? "B" : "S");
    });
    dots.push(chartMark("now-dot " + tone + (model.stale ? " stale" : ""), xs[xs.length - 1], ys[ys.length - 1]));
    f.marks.replaceChildren();
    append(f.marks, dots);
    var span = Math.max(1, model.endMs - model.startMs);
    var tradeAgo = Math.max(0, (liveNowMs() - model.tradeAtMs) / 1000);
    chartBind(f, {
      size: function () { return model.line.length; },
      x: function (i) { return xs[i]; },
      idle: function () {
        var content = liveReadout(view, model, { atMs: model.endMs, price: model.current }, null);
        content.sub = model.stale ? "No trades for " + fmtDur(tradeAgo) + DOT + "the dashed line holds the last price" : "Now" + DOT + "last trade " + fmtDur(tradeAgo) + " ago";
        content.subTone = model.stale ? "warn" : "";
        return content;
      },
      show: function (i) {
        var point = model.line[i];
        var near = null;
        model.marks.forEach(function (mark) { if (Math.abs(mark.atMs - point.atMs) <= span * LIVE_MARK_NEAR && (!near || Math.abs(mark.atMs - point.atMs) < Math.abs(near.atMs - point.atMs))) { near = mark; } });
        chartShowAt(f, xs[i], ys[i], liveReadout(view, model, point, near));
      }
    });
  }
  function liveExitChips(view) {
    var levels = view.levels || {};
    var entry = view.entryPrice;
    var now = liveNowMs();
    var chips = [];
    if (!(isNum(entry) && entry > 0)) { return chips; }
    if (isNum(levels.stopLossPrice)) { var stop = levels.stopLossPrice / entry; chips.push(["lv-stop", "Stop", fmtMult(stop) + " " + signedText(String(Math.round(Math.abs(stop - 1) * 100)), stop - 1) + "%"]); }
    if (isNum(levels.trailingStopPrice)) { chips.push(["lv-trail", "Trail", fmtMult(levels.trailingStopPrice / entry)]); }
    else if (isNum(levels.moonbagStopPrice)) { chips.push(["lv-trail", "Moonbag stop", fmtMult(levels.moonbagStopPrice / entry)]); }
    if (levels.nextTakeProfit) { chips.push(["lv-tp", "TP", fmtMult(levels.nextTakeProfit.multiple) + DOT + fmtPlainPct(levels.nextTakeProfit.sellPctOfInitial)]); }
    if (isNum(levels.timeStopAtMs) && levels.timeStopAtMs > now) { chips.push(["timer", "Time stop", fmtDur((levels.timeStopAtMs - now) / 1000)]); }
    if (isNum(levels.maxHoldAtMs)) { chips.push(["timer", "Max hold", levels.maxHoldAtMs > now ? fmtDur((levels.maxHoldAtMs - now) / 1000) : "reached"]); }
    return chips;
  }
  function liveCardParts() {
    var chart = chartFrame("live-chart", "Price chart");
    chart.wait = el("p", { class: "chart-wait", hidden: true });
    chart.box.append(chart.wait);
    return {
      node: el("section", { class: "card live-pos" }),
      head: el("div", { class: "live-pos-head" }),
      stats: el("div", { class: "mini-stats" }),
      chart: chart,
      levels: el("ul", { class: "exit-chips", "aria-label": "Exit rules" }),
      badges: el("div", { class: "badges" })
    };
  }
  function liveRenderCard(entry) {
    if (!entry.node) { return; }
    entry.renderedAtMs = Date.now();
    var v = entry.view;
    var badges = [];
    if (v.exiting) { badges.push(badge("Selling" + DOT + humanize(v.exiting), "warn")); }
    if (v.migrated) { badges.push(badge("Migrated", "info")); }
    var held = isNum(v.openedAtMs) ? fmtDur((liveNowMs() - v.openedAtMs) / 1000) : DASH;
    var value = isNum(v.pnlEstimateSol) ? v.pnlEstimateSol + v.costSol - v.proceedsSol : null;
    var mcap = isNum(v.marketCapSol) ? v.marketCapSol : null;
    entry.head.replaceChildren(
      el("div", { class: "pos-name" }, mintButton(v.mint, liveCoin(v.symbol, v.mint)),
        el("div", { class: "meta", text: (v.name ? v.name + DOT : "") + shortAddr(v.mint) + DOT + humanize(v.signalType) + DOT + "risk " + fmtNum(v.riskScore, 0) + DOT + "entered " + fmtSeconds(v.openedAtMs) })),
      el("div", { class: "pos-right" },
        el("span", { class: "pos-mult " + multipleClass(v.multiple), text: fmtMult(v.multiple) }),
        v.takeProfitLevelsHit > 0 ? badge(v.takeProfitLevelsHit === 1 ? "1 TP hit" : v.takeProfitLevelsHit + " TPs hit", "good") : null));
    var valueUsd = usdOf(value);
    var mcapUsd = usdOf(mcap);
    entry.stats.replaceChildren(
      miniStat("PnL SOL", fmtSol(v.pnlEstimateSol), fmtSignedPct(v.pnlEstimatePct), signClass(v.pnlEstimateSol), signClass(v.pnlEstimatePct)),
      miniStat("Value SOL", fmtSolAmount(value), isNum(valueUsd) ? fmtUsd(valueUsd) : "cost " + fmtSolAmount(v.costSol)),
      miniStat("Market cap", fmtMcap(mcap), isNum(mcapUsd) ? fmtCompactUsd(mcapUsd) : null),
      miniStat("Held", held, "peak " + fmtMult(v.peakMultiple)));
    renderLiveChart(entry);
    entry.levels.replaceChildren();
    append(entry.levels, liveExitChips(v).map(function (chip) {
      return el("li", { class: "exit-chip " + chip[0], title: chip[0] === "lv-tp" ? "Next take-profit: sells this share of the entry" : chip[1] === "Time stop" ? "Sells if the price is still flat by then" : null }, el("span", { class: "chip-key", text: chip[1] }), el("span", { class: "chip-val", text: chip[2] }));
    }));
    entry.badges.replaceChildren();
    append(entry.badges, badges);
  }
  function liveRenderCards() {
    if (!live.cards) { return; }
    var entries = Object.keys(live.positions).map(function (id) { return live.positions[id]; })
      .sort(function (a, b) { return (b.view.openedAtMs || 0) - (a.view.openedAtMs || 0); });
    if (!entries.length) {
      var idle = live.tradingActive ? "A new buy shows up here with a live price chart, its stop, trailing stop and next take-profit."
        : "No trader runs in this service, so there are no positions to chart. Scores and signals still stream in the feed.";
      live.cards.replaceChildren(empty("No open positions", idle, "live"));
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
      entry.node.append(parts.head, parts.chart.root, parts.levels, parts.stats, parts.badges);
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
    live.note = el("p", { class: "hint feed-note" });
    live.gapNote = el("p", { class: "hint feed-note", hidden: true });
    var filter = selectBox(LIVE_FILTERS, state.liveFilter || "activity", function (value) { state.liveFilter = value; savePrefs(); liveRenderFeed(); }, "Show");
    var feedCard = el("section", { class: "card feed-card" },
      el("div", { class: "feed-head" }, el("h2", { class: "card-title", text: "Activity" }), live.chip),
      el("div", { class: "feed-tools" }, filter, live.pauseButton),
      live.note, live.gapNote, live.list);
    live.root = el("div", { class: "live" }, el("div", { class: "live-layout" }, live.cards, feedCard));
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
        return empty("No live stream in this service", "The live feed comes from the service that runs the scorer, tracker and trader. Add dashboard to MODULES of that service (the VPS runs them together) to watch it here.", "live");
      }
      live.tradingActive = !!status.tradingActive;
      var root = liveRoot();
      if (!live.source && !live.retryAtMs) { liveOpen(); }
      return root;
    });
  }
`;
