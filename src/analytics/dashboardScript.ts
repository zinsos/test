export const DASHBOARD_SCRIPT = String.raw`
(function () {
  "use strict";
  var TOKEN_KEY = "snypra-edge-token";
  var PREFS_KEY = "snypra-edge-prefs";
  var REFRESH_MS = 60000;
  var PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  var DASH = "—";
  var DOT = " · ";
  var TABS = [
    ["edge", "Edge"], ["breakdowns", "Breakdowns"], ["compare", "Paper vs Live"], ["scorer", "Scorer"],
    ["recorder", "Recorder"], ["signals", "Signals"], ["launches", "Launches"], ["wallets", "Wallets"]
  ];
  var FILTER_TABS = { edge: true, breakdowns: true, compare: true };
  var PERIODS = [
    ["all", "All time", 0], ["1d", "Last 24h", 86400000], ["7d", "Last 7 days", 604800000],
    ["30d", "Last 30 days", 2592000000], ["90d", "Last 90 days", 7776000000]
  ];
  var DIMENSIONS = {
    riskBucket: ["Risk score at entry", "Lower score means lower launch risk. Unscored trades had no score at entry."],
    signalType: ["Signal type", "Which entry signal actually pays after fees."],
    hourUtc: ["Entry hour (UTC)", "When entries happen. Hours that bleed are candidates to cut."],
    holdBucket: ["Hold time", "How long positions were held before the exit."],
    exitReason: ["Exit reason", "Which exit rule closed the trade."],
    weekday: ["Entry weekday (UTC)", "Day of the week of the entry."]
  };
  var ACTIONS = {
    scale: ["Scale", "good"], cut: ["Cut", "bad"], lean_scale: ["Leaning +", "info"],
    lean_cut: ["Leaning −", "warn"], insufficient: ["Too few", ""]
  };
  var TONE_LABELS = { good: "Looks good", warn: "Not proven", bad: "Problem", neutral: "Waiting for data" };

  var state = loadPrefs();
  var meta = { runs: [], modes: [] };
  var dom = {};
  var renderSeq = 0;
  var sheetOpen = false;

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) { window.localStorage.removeItem(key); } else { window.localStorage.setItem(key, value); }
    } catch (e) { return; }
  }
  function loadPrefs() {
    var prefs = { tab: "edge", mode: "auto", runId: "", period: "all", checkpoint: "", quote: "" };
    var raw = storageGet(PREFS_KEY);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        Object.keys(prefs).forEach(function (key) { if (parsed && typeof parsed[key] === "string") { prefs[key] = parsed[key]; } });
      } catch (e) { return prefs; }
    }
    return prefs;
  }
  function savePrefs() { storageSet(PREFS_KEY, JSON.stringify(state)); }
  function tabFromHash() {
    var wanted = (window.location.hash || "").replace("#", "");
    for (var i = 0; i < TABS.length; i += 1) { if (TABS[i][0] === wanted) { return wanted; } }
    return "";
  }
  function captureToken() {
    var params = new URLSearchParams(window.location.search);
    var value = params.get("token");
    if (!value) { return; }
    storageSet(TOKEN_KEY, value);
    params.delete("token");
    var rest = params.toString();
    try { window.history.replaceState(null, "", window.location.pathname + (rest ? "?" + rest : "") + window.location.hash); } catch (e) { return; }
  }
  function token() { return storageGet(TOKEN_KEY) || ""; }

  function append(node, child) {
    if (child === null || child === undefined || child === false) { return; }
    if (Array.isArray(child)) { child.forEach(function (inner) { append(node, inner); }); return; }
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) { return; }
        if (key === "text") { node.textContent = String(value); }
        else if (key === "class") { node.className = value; }
        else if (key.slice(0, 2) === "on") { node.addEventListener(key.slice(2), value); }
        else { node.setAttribute(key, value === true ? "" : String(value)); }
      });
    }
    for (var i = 2; i < arguments.length; i += 1) { append(node, arguments[i]); }
    return node;
  }

  function isNum(value) { return typeof value === "number" && isFinite(value); }
  function fmtSol(value, signed) {
    if (!isNum(value)) { return DASH; }
    var magnitude = Math.abs(value);
    var digits = magnitude >= 1 ? magnitude.toFixed(3) : magnitude.toFixed(4);
    if (magnitude < 1 && digits.charAt(digits.length - 1) === "0") { digits = digits.slice(0, -1); }
    if (Number(digits) === 0) { return digits; }
    if (value < 0) { return "-" + digits; }
    return signed === false ? digits : "+" + digits;
  }
  function fmtPct(value, decimals) { return isNum(value) ? (value * 100).toFixed(decimals === undefined ? 1 : decimals) + "%" : DASH; }
  function fmtNum(value, decimals) { return isNum(value) ? value.toFixed(decimals === undefined ? 2 : decimals) : DASH; }
  function fmtInt(value) { return isNum(value) ? Math.round(value).toLocaleString("en-US") : DASH; }
  function fmtBps(value) { return isNum(value) ? Math.round(value) + " bps" : DASH; }
  function fmtMult(value) { return isNum(value) ? value.toFixed(2) + "×" : DASH; }
  function fmtDur(seconds) {
    if (!isNum(seconds)) { return DASH; }
    var safe = Math.max(0, seconds);
    if (safe < 60) { return Math.round(safe) + "s"; }
    if (safe < 3600) { var m = Math.floor(safe / 60); var s = Math.round(safe - m * 60); return s ? m + "m " + s + "s" : m + "m"; }
    if (safe < 86400) { var h = Math.floor(safe / 3600); var mm = Math.round((safe - h * 3600) / 60); return mm ? h + "h " + mm + "m" : h + "h"; }
    return (safe / 86400).toFixed(1) + "d";
  }
  function fmtAgo(ms) { return isNum(ms) ? fmtDur((Date.now() - ms) / 1000) + " ago" : DASH; }
  function fmtTime(ms) {
    return isNum(ms) ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : DASH;
  }
  function fmtDay(ms) { return isNum(ms) ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : DASH; }
  function shortAddr(value) { return value && value.length > 12 ? value.slice(0, 4) + "…" + value.slice(-4) : (value || DASH); }
  function signClass(value) { return isNum(value) ? (value > 0 ? "pos" : value < 0 ? "neg" : "") : ""; }
  function interval(range) { return range ? fmtSol(range.low) + " to " + fmtSol(range.high) : DASH; }
  function quoteLabel(mint) { return mint === "SOL" ? "SOL" : mint === PUMP_MINT ? "PUMP" : shortAddr(mint); }

  function queryString(params) {
    var query = new URLSearchParams();
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value !== null && value !== undefined && value !== "") { query.set(key, String(value)); }
    });
    var text = query.toString();
    return text ? "?" + text : "";
  }
  function authHeaders() {
    var headers = { Accept: "application/json" };
    var current = token();
    if (current) { headers.Authorization = "Bearer " + current; }
    return headers;
  }
  function api(path, params) {
    return fetch(path + queryString(params), { headers: authHeaders(), cache: "no-store", credentials: "same-origin" }).then(function (res) {
      if (res.status === 401) { var authError = new Error("unauthorized"); authError.auth = true; throw authError; }
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          var error = new Error(body && body.message ? body.message : "Request failed (" + res.status + ")");
          error.status = res.status;
          throw error;
        }
        return body;
      });
    });
  }

  function card(title, hint) {
    var node = el("section", { class: "card" }, title ? el("h2", { text: title }) : null, hint ? el("p", { class: "hint", text: hint }) : null);
    for (var i = 2; i < arguments.length; i += 1) { append(node, arguments[i]); }
    return node;
  }
  function empty(title, text) { return el("section", { class: "card empty" }, el("strong", { text: title }), el("span", { text: text })); }
  function stat(label, value, sub, cls) {
    return el("div", { class: "stat" }, el("div", { class: "label", text: label }), el("div", { class: "value " + (cls || ""), text: value }), sub ? el("div", { class: "sub", text: sub }) : null);
  }
  function grid(items) { return el("div", { class: "grid" }, items); }
  function badge(text, tone) { return el("span", { class: "badge " + (tone || ""), text: text }); }
  function meter(fraction) {
    var fill = el("span");
    fill.style.width = Math.max(0, Math.min(1, isNum(fraction) ? fraction : 0)) * 100 + "%";
    return el("div", { class: "meter", role: "presentation" }, fill);
  }
  function hero(narrative, figure, unit, extras) {
    var tone = narrative && narrative.tone !== "neutral" ? narrative.tone : "";
    return el("section", { class: "card hero " + tone },
      badge(TONE_LABELS[narrative ? narrative.tone : "neutral"] || "", tone),
      figure ? el("div", { class: "figure", text: figure }) : null,
      figure && unit ? el("div", { class: "figure-unit", text: unit }) : null,
      el("p", { class: "headline", text: narrative ? narrative.headline : "" }),
      el("p", { class: "detail", text: narrative ? narrative.detail : "" }),
      extras || null);
  }
  function table(headers, rows, narrowHidden) {
    var hidden = narrowHidden || {};
    var head = el("tr", null, headers.map(function (text, index) { return el("th", { class: hidden[index] ? "hide-narrow" : null, text: text }); }));
    return el("div", { class: "table-wrap" }, el("table", null, el("thead", null, head), el("tbody", null, rows)));
  }
  function cell(text, cls) { return el("td", { class: cls || null, text: text }); }
  function kv(pairs) {
    var list = el("dl", { class: "kv" });
    pairs.forEach(function (pair) { list.append(el("dt", { text: pair[0] }), el("dd", { class: pair[2] || null, text: pair[1] })); });
    return list;
  }
  function selectBox(options, value, onChange, label) {
    var node = el("select", { "aria-label": label, onchange: function () { onChange(node.value); } },
      options.map(function (option) { return el("option", { value: option[0], text: option[1] }); }));
    node.value = value;
    if (node.value !== value && options[0]) { node.value = options[0][0]; }
    return node;
  }
  function field(label, control, cls) { return el("label", { class: "field" + (cls ? " " + cls : "") }, label, control); }
  function readable(text) { return String(text || "").split("_").join(" "); }
  function actions(items) { return el("div", { class: "actions" }, items); }
  function downloadButton(text, path, params, filename) {
    var button = el("button", { class: "btn", type: "button", text: text });
    button.addEventListener("click", function () {
      button.disabled = true;
      button.textContent = "Preparing…";
      var headers = authHeaders();
      headers.Accept = "text/csv";
      fetch(path + queryString(params), { headers: headers, cache: "no-store", credentials: "same-origin" }).then(function (res) {
        if (!res.ok) { throw new Error("Download failed (" + res.status + ")"); }
        return res.blob();
      }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var link = el("a", { href: url, download: filename });
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        button.textContent = text;
      }).catch(function (error) {
        button.textContent = error.message || "Download failed";
      }).then(function () { button.disabled = false; });
    });
    return button;
  }

  function resolvedMode() {
    if (state.mode && state.mode !== "auto") { return state.mode === "all" ? "" : state.mode; }
    var active = meta.modes.filter(function (item) { return item.closedTrades > 0 && item.mode !== "shadow"; });
    return active[0] ? active[0].mode : "paper";
  }
  function periodSpan() {
    for (var i = 0; i < PERIODS.length; i += 1) { if (PERIODS[i][0] === state.period) { return PERIODS[i][2]; } }
    return 0;
  }
  function filterParams(includeMode) {
    var params = {};
    if (state.runId) { params.runId = state.runId; }
    else if (includeMode !== false) { var mode = resolvedMode(); if (mode) { params.mode = mode; } }
    var span = periodSpan();
    if (span > 0) { params.from = Math.floor((Date.now() - span) / 60000) * 60000; }
    return params;
  }
  function modeOptions() {
    var known = {};
    var options = [["auto", resolvedModeLabel() + " (auto)"], ["all", "All modes"]];
    meta.modes.forEach(function (item) { known[item.mode] = item.closedTrades; });
    ["live", "paper", "backtest"].forEach(function (mode) { if (!(mode in known)) { known[mode] = 0; } });
    Object.keys(known).forEach(function (mode) { options.push([mode, mode + " (" + fmtInt(known[mode]) + ")"]); });
    return options;
  }
  function resolvedModeLabel() {
    var active = meta.modes.filter(function (item) { return item.closedTrades > 0 && item.mode !== "shadow"; });
    return active[0] ? active[0].mode : "paper";
  }
  function runOptions() {
    var mode = state.mode === "auto" ? resolvedMode() : state.mode === "all" ? "" : state.mode;
    var options = [["", "All runs"]];
    meta.runs.forEach(function (run) {
      if (mode && run.mode !== mode) { return; }
      options.push([String(run.id), "#" + run.id + " " + run.mode + (run.label ? " " + run.label : "") + " (" + fmtInt(run.closedTrades) + ")"]);
    });
    return options;
  }
  function renderFilters() {
    dom.filters.replaceChildren();
    if (!FILTER_TABS[state.tab]) { return; }
    if (state.tab !== "compare") {
      dom.filters.append(field("Mode", selectBox(modeOptions(), state.mode, function (value) { state.mode = value; state.runId = ""; savePrefs(); render(); }, "Mode")));
    }
    dom.filters.append(field("Period", selectBox(PERIODS.map(function (p) { return [p[0], p[1]]; }), state.period, function (value) { state.period = value; savePrefs(); render(); }, "Period")));
    dom.filters.append(field("Run", selectBox(runOptions(), state.runId, function (value) { state.runId = value; savePrefs(); render(); }, "Run"), state.tab === "compare" ? "" : "wide"));
  }

  function placeTip(box, tip, fraction) {
    var width = box.clientWidth;
    var tipWidth = tip.offsetWidth;
    var x = fraction * width;
    var left = x + 10 + tipWidth <= width ? x + 10 : x - 10 - tipWidth;
    tip.style.right = "";
    tip.style.left = Math.max(0, Math.min(width - tipWidth, left)) + "px";
  }
  function lineChart(points) {
    var width = 600;
    var height = 200;
    var pad = 12;
    var last = points[points.length - 1].index || 1;
    var low = 0;
    var high = 0;
    points.forEach(function (point) { low = Math.min(low, point.equitySol); high = Math.max(high, point.equitySol); });
    if (high - low < 1e-9) { high += 0.001; low -= 0.001; }
    function x(point) { return (point.index / last) * width; }
    function y(value) { return pad + ((high - value) / (high - low)) * (height - 2 * pad); }
    var line = points.map(function (point, i) { return (i ? "L" : "M") + x(point).toFixed(2) + " " + y(point.equitySol).toFixed(2); }).join(" ");
    var zero = y(0).toFixed(2);
    var area = line + " L" + x(points[points.length - 1]).toFixed(2) + " " + zero + " L0 " + zero + " Z";
    var box = el("div", { class: "chart", tabindex: "0", role: "img", "aria-label": "Equity curve over " + last + " trades, ending at " + fmtSol(points[points.length - 1].equitySol) + " SOL" });
    box.innerHTML = "<svg viewBox=\"0 0 600 200\" preserveAspectRatio=\"none\" aria-hidden=\"true\">" +
      "<path class=\"eq-area\" d=\"" + area + "\"></path>" +
      "<line class=\"zero\" x1=\"0\" x2=\"600\" y1=\"" + zero + "\" y2=\"" + zero + "\"></line>" +
      "<path class=\"eq-line\" d=\"" + line + "\"></path></svg>";
    var cross = el("div", { class: "crosshair" });
    var marker = el("div", { class: "marker" });
    var tip = el("div", { class: "tooltip" });
    box.append(el("span", { class: "y-label top", text: fmtSol(high) }), el("span", { class: "y-label bottom", text: fmtSol(low) }), cross, marker, tip);
    var fractions = points.map(function (point) { return point.index / last; });
    var current = -1;
    function nearest(fraction) {
      var lo = 0;
      var hi = fractions.length - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (fractions[mid] < fraction) { lo = mid + 1; } else { hi = mid; } }
      if (lo > 0 && Math.abs(fractions[lo - 1] - fraction) <= Math.abs(fractions[lo] - fraction)) { return lo - 1; }
      return lo;
    }
    function show(index) {
      var point = points[index];
      if (!point) { return; }
      current = index;
      var left = fractions[index] * 100;
      cross.style.display = "block";
      cross.style.left = left + "%";
      marker.style.display = "block";
      marker.style.left = left + "%";
      marker.style.top = (y(point.equitySol) / height) * 100 + "%";
      tip.replaceChildren(
        el("strong", { text: fmtSol(point.equitySol) + " SOL" }),
        el("div", { text: point.index ? "Trade #" + point.index + DOT + fmtTime(point.atMs) : "Start" }),
        point.index ? el("div", { text: "This trade " + fmtSol(point.pnlSol) + DOT + "drawdown " + fmtSol(point.drawdownSol, false) }) : null);
      tip.style.display = "block";
      placeTip(box, tip, fractions[index]);
    }
    function hide() { cross.style.display = "none"; marker.style.display = "none"; tip.style.display = "none"; }
    function fromEvent(event) {
      var rect = box.getBoundingClientRect();
      return rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
    }
    box.addEventListener("pointermove", function (event) { show(nearest(fromEvent(event))); });
    box.addEventListener("pointerdown", function (event) { show(nearest(fromEvent(event))); });
    box.addEventListener("pointerleave", function (event) { if (event.pointerType === "mouse") { hide(); } });
    box.addEventListener("focus", function () { show(points.length - 1); });
    box.addEventListener("blur", hide);
    box.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") { return; }
      event.preventDefault();
      var step = event.key === "ArrowRight" ? 1 : -1;
      show(Math.max(0, Math.min(points.length - 1, (current < 0 ? points.length - 1 : current + step))));
    });
    return box;
  }

  function barChart(items, valueOf, labelOf, unit) {
    var width = 600;
    var height = 120;
    var max = 0;
    items.forEach(function (item) { max = Math.max(max, valueOf(item)); });
    var scale = max > 0 ? max : 1;
    var slot = width / Math.max(1, items.length);
    var barWidth = Math.max(1, slot - 2);
    var rects = items.map(function (item, i) {
      var value = valueOf(item);
      var barHeight = value > 0 ? Math.max(1.5, (value / scale) * (height - 4)) : 1;
      return "<rect class=\"bar-rect" + (value > 0 ? "" : " dim") + "\" x=\"" + (i * slot + 1).toFixed(2) + "\" y=\"" + (height - barHeight).toFixed(2) +
        "\" width=\"" + barWidth.toFixed(2) + "\" height=\"" + barHeight.toFixed(2) + "\"></rect>";
    }).join("");
    var box = el("div", { class: "chart short", tabindex: "0", role: "img", "aria-label": "Bar chart, peak " + fmtInt(max) + " " + unit });
    box.innerHTML = "<svg viewBox=\"0 0 600 120\" preserveAspectRatio=\"none\" aria-hidden=\"true\">" + rects + "</svg>";
    var tip = el("div", { class: "tooltip" });
    box.append(el("span", { class: "y-label top", text: fmtInt(max) }), tip);
    if (max === 0) { return [box, el("p", { class: "hint", text: "Nothing recorded in this window. If this lasts, check the websocket." })]; }
    var current = -1;
    function show(index) {
      var item = items[index];
      if (!item) { return; }
      current = index;
      tip.replaceChildren(el("strong", { text: fmtInt(valueOf(item)) + " " + unit }), el("div", { text: labelOf(item) }));
      tip.style.display = "block";
      placeTip(box, tip, (index + 0.5) / items.length);
    }
    function indexAt(event) {
      var rect = box.getBoundingClientRect();
      return rect.width > 0 ? Math.min(items.length - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * items.length))) : 0;
    }
    box.addEventListener("pointermove", function (event) { show(indexAt(event)); });
    box.addEventListener("pointerdown", function (event) { show(indexAt(event)); });
    box.addEventListener("pointerleave", function (event) { if (event.pointerType === "mouse") { tip.style.display = "none"; } });
    box.addEventListener("focus", function () { show(items.length - 1); });
    box.addEventListener("blur", function () { tip.style.display = "none"; });
    box.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") { return; }
      event.preventDefault();
      show(Math.max(0, Math.min(items.length - 1, (current < 0 ? items.length - 1 : current + (event.key === "ArrowRight" ? 1 : -1)))));
    });
    return box;
  }

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
        out.push(empty("Nothing to measure yet", "Run the recorder for two weeks, backtest the scorer and wallet tracker, then paper trade 300+ trades. Expectancy appears here as trades close."));
        return out;
      }
      out.push(edgeStats(summary));
      out.push(card("Equity curve", "Cumulative PnL in SOL after fees, by trade. Drag across the chart to inspect.",
        points.length > 1 ? [lineChart(points), el("div", { class: "axis-row" }, el("span", { text: "Trade 1" }), el("span", { text: "Trade " + fmtInt(points[points.length - 1].index) }))] : null));
      if (results[0].truncated) { out.push(card(null, "Only the most recent trades were loaded. Narrow the filter for exact totals.")); }
      out.push(card(null, "Expectancy after fees over hundreds of trades is the only number that proves an edge. Flat or negative results are the tooling working: they saved real money."));
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
        return empty("No closed trades for this filter", "Breakdowns show which risk buckets, signals, hours and hold times to cut or scale once trades close.");
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
        out.push(empty("No paired trades yet", "Go live small only after 300+ paper trades show an edge. Every live entry gets a shadow paper trade, and this tab shows where the simulation is too optimistic."));
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
        out.push(empty("No scored launches with known outcomes", "Run the recorder for two weeks before tuning. The scorer writes a score at each checkpoint and the finaliser labels outcomes once they are known."));
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
      out.push(card("Launches per hour", "Last 24 hours.", barChart(h.launchesPerHour, function (item) { return item.count; }, function (item) { return fmtTime(item.hourStartMs); }, "launches")));
      out.push(card("Trades per minute", "Last 60 minutes.", barChart(h.tradesPerMinute, function (item) { return item.count; }, function (item) { return fmtTime(item.minuteStartMs); }, "trades")));
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
        return empty("No signals yet", "Signals need a tracked-wallet ranking (Wallets tab) and launch scores. Run the recorder for two weeks, then rank wallets.");
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
        return empty("No launches recorded", "Check the Recorder tab: the recorder subscribes to pump.fun logs and stores every launch.");
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
        return empty("No wallet ranking yet", "Wallets are ranked weekly from recorded trades. Run the recorder for two weeks, then backtest the tracker before trusting its picks.");
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
      score.flags && score.flags.length ? el("div", { class: "chips" }, score.flags.map(function (flag) { return el("span", { class: "chip bad", text: flag }); })) : el("p", { class: "hint", text: "No flags." }),
      contributions.length ? card("Biggest contributions", null, kv(contributions.map(function (pair) { return [pair[0], fmtNum(pair[1], 2), pair[1] > 0 ? "neg" : "pos"]; }))) : null,
      features.length ? card("Features", null, kv(features)) : null
    ];
  }
  function openScore(mint, title) {
    var body = el("div", null, el("p", { class: "hint", text: "Loading score…" }));
    var close = el("button", { class: "icon-btn", type: "button", "aria-label": "Close", text: "×" });
    var panel = el("div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": "Launch score" },
      el("div", { class: "panel-head" }, el("h2", { text: title || shortAddr(mint) }), close),
      el("p", { class: "mono", text: mint }), body);
    var sheet = el("div", { class: "sheet" }, panel);
    function onKey(event) { if (event.key === "Escape") { dismiss(); } }
    function dismiss() { sheetOpen = false; document.removeEventListener("keydown", onKey); sheet.remove(); }
    close.addEventListener("click", dismiss);
    sheet.addEventListener("click", function (event) { if (event.target === sheet) { dismiss(); } });
    document.addEventListener("keydown", onKey);
    document.body.append(sheet);
    sheetOpen = true;
    close.focus();
    api("/api/score/" + encodeURIComponent(mint)).then(function (score) {
      body.replaceChildren.apply(body, scoreBody(score).filter(Boolean));
    }).catch(function (error) {
      var text = error.status === 404 ? "Not scored yet. The scorer writes a score at its checkpoints after launch." : error.auth ? "Unlock the dashboard first." : error.message;
      body.replaceChildren(el("p", { class: "hint", text: text }));
    });
  }

  function tokenForm() {
    var input = el("input", { type: "password", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "DASHBOARD_TOKEN", "aria-label": "Dashboard token" });
    function submit() {
      var value = input.value.trim();
      if (!value) { return; }
      storageSet(TOKEN_KEY, value);
      refresh();
    }
    input.addEventListener("keydown", function (event) { if (event.key === "Enter") { submit(); } });
    return card("This dashboard is locked", "Paste the DASHBOARD_TOKEN from the service settings. It is stored on this device only. Opening the page once with ?token= in the address works too.",
      field("Token", input), actions([el("button", { class: "btn primary", type: "button", text: "Unlock", onclick: submit })]));
  }
  function errorCard(error) {
    return card("Could not load this view", null, el("p", { class: "error-text", text: error && error.message ? error.message : "Unknown error" }), actions([el("button", { class: "btn", type: "button", text: "Try again", onclick: render })]));
  }

  var VIEWS = {
    edge: edgeView, breakdowns: breakdownsView, compare: compareView, scorer: scorerView,
    recorder: recorderView, signals: signalsView, launches: launchesView, wallets: walletsView
  };

  function setActiveTab() {
    Array.prototype.forEach.call(dom.tabs.children, function (button) {
      var active = button.getAttribute("data-tab") === state.tab;
      button.setAttribute("aria-selected", active ? "true" : "false");
      if (active && button.scrollIntoView) { button.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    });
  }
  function render() {
    var seq = ++renderSeq;
    setActiveTab();
    renderFilters();
    dom.main.classList.add("loading");
    var view = VIEWS[state.tab] || edgeView;
    Promise.resolve().then(view).then(function (result) {
      if (seq !== renderSeq) { return; }
      var fragment = document.createDocumentFragment();
      append(fragment, result);
      dom.main.replaceChildren(fragment);
      dom.updated.textContent = "Updated " + new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }).catch(function (error) {
      if (seq !== renderSeq) { return; }
      dom.main.replaceChildren(error && error.auth ? tokenForm() : errorCard(error));
    }).then(function () {
      if (seq === renderSeq) { dom.main.classList.remove("loading"); }
    });
  }
  function loadMeta() {
    return api("/api/runs", { limit: 200 }).then(function (result) {
      meta.runs = result.runs || [];
      meta.modes = result.modes || [];
    }).catch(function () { return null; });
  }
  function checkHealth() {
    fetch("/healthz", { cache: "no-store" }).then(function (res) { dom.dot.className = "dot " + (res.ok ? "good" : "bad"); })
      .catch(function () { dom.dot.className = "dot bad"; });
  }
  function refresh() {
    checkHealth();
    return loadMeta().then(render);
  }
  function selectTab(id) {
    if (window.location.hash === "#" + id) { if (state.tab !== id) { state.tab = id; savePrefs(); render(); } return; }
    window.location.hash = id;
  }
  function build() {
    dom.dot = el("span", { class: "dot", "aria-hidden": "true" });
    dom.updated = el("span", { class: "updated", "aria-live": "polite" });
    dom.tabs = el("nav", { class: "tabs", role: "tablist", "aria-label": "Sections" }, TABS.map(function (tab) {
      return el("button", { type: "button", role: "tab", "data-tab": tab[0], text: tab[1], onclick: function () { selectTab(tab[0]); } });
    }));
    dom.filters = el("div", { class: "filters" });
    dom.main = el("main", { id: "main" });
    var header = el("header", { class: "top" },
      el("div", { class: "bar" },
        el("div", { class: "brand" }, dom.dot, "SNYPRA edge"),
        el("div", { class: "brand" }, dom.updated, el("button", { class: "icon-btn", type: "button", "aria-label": "Refresh", text: "↻", onclick: refresh }))),
      dom.tabs, dom.filters);
    var footer = el("footer", { class: "footer" }, "Numbers are after fees. Expectancy decides, not win rate.", el("br"),
      el("button", { type: "button", text: "Forget token on this device", onclick: function () { storageSet(TOKEN_KEY, null); refresh(); } }));
    document.body.replaceChildren(header, dom.main, footer);
  }
  function init() {
    captureToken();
    state.tab = tabFromHash() || state.tab || "edge";
    build();
    window.addEventListener("hashchange", function () {
      var tab = tabFromHash();
      if (tab && tab !== state.tab) { state.tab = tab; savePrefs(); render(); }
    });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && !sheetOpen) { refresh(); } });
    window.setInterval(function () { if (document.visibilityState === "visible" && !sheetOpen) { refresh(); } }, REFRESH_MS);
    refresh();
  }
  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }
})();
`;
