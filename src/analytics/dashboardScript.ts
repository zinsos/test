import { ANALYSIS_SCRIPT } from "./dashboardAnalysis.js";
import { CHART_SCRIPT } from "./dashboardCharts.js";
import { ICON_SCRIPT } from "./dashboardIcons.js";
import { LAB_VIEW_SCRIPT } from "./dashboardLab.js";
import { LIVE_VIEW_SCRIPT } from "./dashboardLive.js";
import { OVERVIEW_SCRIPT } from "./dashboardOverview.js";

const CORE_SCRIPT = String.raw`
  var TOKEN_KEY = "snypra-edge-token";
  var PREFS_KEY = "snypra-edge-prefs";
  var REFRESH_MS = 60000;
  var LIVE_REFRESH_MS = 10000;
  var STALL_MS = 30000;
  var TICK_MS = 1000;
  var WALLET_MS = 15000;
  var TIPS_MS = 60000;
  var COMPACT_SCROLL_PX = 48;
  var TIP_TONES = { good: ["Working", "good"], warn: ["Watch", "warn"], bad: ["Problem", "bad"], info: ["Info", "info"] };
  var ARM_MS = 6000;
  var SOLSCAN_ACCOUNT_URL = "https://solscan.io/account/";
  var PREFS_VERSION = "2";
  var PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  var PUMP_COIN_URL = "https://pump.fun/coin/";
  var MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var DASH = "—";
  var MINUS = "−";
  var DOT = " · ";
  var TABS = [
    ["trades", "Overview", "primary", "overview", "Equity, open positions and recent trades of the current run."],
    ["live", "Live", "primary", "live", "Open positions on a live price chart, and everything the bot does as it happens."],
    ["edge", "Performance", "primary", "performance", "Expectancy after fees: over hundreds of trades it is the one number that proves an edge."],
    ["lab", "Lab", "primary", "lab", "Strategy variants replayed over recorded launches with real fills and fees."],
    ["breakdowns", "Breakdowns", "more", "breakdowns", "Which risk buckets, signals, hours and hold times to cut or scale."],
    ["compare", "Paper vs Live", "more", "compare", "Where the paper simulation is more optimistic than live fills."],
    ["scorer", "Scorer", "more", "scorer", "How well the launch risk score separates outcomes."],
    ["recorder", "Recorder", "more", "recorder", "Whether the recorder sees every launch and trade."],
    ["signals", "Signals", "more", "signals", "Every entry signal, traded or skipped with its reason."],
    ["launches", "Launches", "more", "launches", "The newest pump.fun launches with their latest risk score."],
    ["wallets", "Wallets", "more", "wallets", "Smart wallets ranked from recorded trades."],
    ["settings", "Settings", "system", "settings", "The Helius RPC key and this device."]
  ];
  var NAV_GROUPS = [["primary", "Trading"], ["more", "Analysis"], ["system", "System"]];
  var STATIC_TABS = { settings: true };
  var HELIUS_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var RELOAD_AFTER_KEY_MS = 15000;
  var FILTER_TABS = { edge: true, breakdowns: true, compare: true };
  var LIVE_TABS = { trades: true };
  var STREAM_TABS = { live: true };
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
    lean_cut: ["Leaning " + MINUS, "warn"], insufficient: ["Too few", ""]
  };
  var TONE_LABELS = { good: "Looks good", warn: "Not proven", bad: "Problem", neutral: "Waiting for data" };
  var REASON_LABELS = {
    dev_sold: "Dev sold", insider_sold: "Insiders sold", smart_exit: "Smart wallets sold", stop_loss: "Stop loss",
    migration_exit: "Migration exit", take_profit: "Take-profit", trailing_stop: "Trailing stop", moonbag_trail: "Moonbag trail",
    time_stop: "Time stop", max_hold: "Max hold", migration_max_hold: "Max hold after migration", external_or_unknown_exit: "Sold outside the bot",
    quote_mint_not_allowed: "Not SOL-quoted", quote_mint_not_tradable: "Not SOL-quoted", max_concurrent: "Too many open positions",
    max_open_positions: "Too many open positions", already_holding_mint: "Already holding this coin", dev_daily_limit: "Dev limit reached today",
    halted_daily_loss: "Daily loss limit", killed: "Buys paused", kill_switch: "Kill switch", cooldown: "Cooldown", risk_rejected: "Risk limit",
    risk_limit: "Risk limit", risk_too_high: "Risk too high", launch_not_in_memory: "Launch not in memory", incomplete_data: "Incomplete data",
    no_balance: "Wallet balance too low", no_price: "No price yet", trader_stopped: "Trader stopped", awaiting_migration: "Waiting for migration",
    score_momentum: "Score momentum", smart_convergence: "Smart-wallet convergence"
  };
  var EXIT_SHORT = {
    trailing_stop: "Trail", take_profit: "TP", stop_loss: "Stop", time_stop: "Time", moonbag_trail: "Bag", max_hold: "Max hold",
    migration_max_hold: "Max hold", dev_sold: "Dev sold", insider_sold: "Insiders", smart_exit: "Smart exit", migration_exit: "Migration",
    external_or_unknown_exit: "External"
  };

  var state = loadPrefs();
  var meta = { runs: [], modes: [] };
  var dom = {};
  var renderSeq = 0;
  var sheetOpen = false;
  var rendering = false;
  var locked = false;
  var lastAttemptMs = 0;
  var lastRenderMs = 0;
  var staleNote = "";
  var health = { server: null };
  var conn = { down: false, sinceMs: 0 };

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) { window.localStorage.removeItem(key); } else { window.localStorage.setItem(key, value); }
    } catch (e) { return; }
  }
  function loadPrefs() {
    var prefs = { v: "", tab: "trades", mode: "auto", runId: "", period: "all", checkpoint: "", quote: "", tradesRun: "", liveFilter: "activity" };
    var raw = storageGet(PREFS_KEY);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        Object.keys(prefs).forEach(function (key) { if (parsed && typeof parsed[key] === "string") { prefs[key] = parsed[key]; } });
      } catch (e) { return prefs; }
    }
    if (prefs.v !== PREFS_VERSION) { prefs.v = PREFS_VERSION; prefs.tab = "trades"; }
    return prefs;
  }
  function savePrefs() { storageSet(PREFS_KEY, JSON.stringify(state)); }
  function tabInfo(id) {
    for (var i = 0; i < TABS.length; i += 1) { if (TABS[i][0] === id) { return TABS[i]; } }
    return null;
  }
  function tabFromHash() {
    var wanted = (window.location.hash || "").replace("#", "");
    return tabInfo(wanted) ? wanted : "";
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
  function forgetToken() { storageSet(TOKEN_KEY, null); refresh(false); }

  function append(node, child) {
    if (child === null || child === undefined || child === false) { return; }
    if (Array.isArray(child)) { child.forEach(function (inner) { append(node, inner); }); return; }
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  function fill(node) {
    node.replaceChildren();
    for (var i = 1; i < arguments.length; i += 1) { append(node, arguments[i]); }
    return node;
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
  function setClass(node, name, on) { if (node && node.classList) { if (on) { node.classList.add(name); } else { node.classList.remove(name); } } }

  function isNum(value) { return typeof value === "number" && isFinite(value); }
  function minus(text) { return text.charAt(0) === "-" ? MINUS + text.slice(1) : text; }
  function signedText(text, value, plus) {
    if (Number(text) === 0) { return text; }
    if (value < 0) { return MINUS + text; }
    return plus === false ? text : "+" + text;
  }
  function fmtSol(value, signed) { return isNum(value) ? signedText(Math.abs(value).toFixed(4), value, signed) : DASH; }
  function fmtUsd(value) { return isNum(value) ? (value < 0 ? MINUS + "$" : "$") + Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : DASH; }
  function fmtCompactUsd(value) {
    if (!isNum(value)) { return DASH; }
    var size = Math.abs(value);
    var text = size >= 1e6 ? (size / 1e6).toFixed(2) + "M" : size >= 1e3 ? (size / 1e3).toFixed(1) + "k" : size.toFixed(0);
    return (value < 0 ? MINUS : "") + "$" + text;
  }
  function fmtSolAmount(value) { return fmtSol(value, false); }
  function fmtPct(value, decimals) { return isNum(value) ? minus((value * 100).toFixed(decimals === undefined ? 1 : decimals)) + "%" : DASH; }
  function fmtNum(value, decimals) { return isNum(value) ? minus(value.toFixed(decimals === undefined ? 2 : decimals)) : DASH; }
  function fmtValue(value) {
    if (!isNum(value)) { return DASH; }
    if (Number.isInteger(value)) { return minus(value.toLocaleString("en-US")); }
    var size = Math.abs(value);
    return minus(value.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : size >= 1 ? 2 : 3));
  }
  function fmtInt(value) { return isNum(value) ? minus(Math.round(value).toLocaleString("en-US")) : DASH; }
  function fmtBps(value) { return isNum(value) ? minus(String(Math.round(value))) + " bps" : DASH; }
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
    return isNum(ms) ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : DASH;
  }
  function fmtClockTime(ms) { return isNum(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : DASH; }
  function fmtSeconds(ms) { return isNum(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }) : DASH; }
  function fmtDay(ms) { return isNum(ms) ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : DASH; }
  function sameDay(a, b) { var x = new Date(a); var y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); }
  function fmtWhen(ms) { return isNum(ms) ? (sameDay(ms, Date.now()) ? fmtClockTime(ms) : fmtDay(ms)) : DASH; }
  function tzLabel() {
    try {
      var parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i += 1) { if (parts[i].type === "timeZoneName") { return parts[i].value; } }
    } catch (e) { return "local time"; }
    return "local time";
  }
  function shortAddr(value) { return value && value.length > 12 ? value.slice(0, 4) + "…" + value.slice(-4) : (value || DASH); }
  function signClass(value) { return isNum(value) ? (value > 0 ? "pos" : value < 0 ? "neg" : "") : ""; }
  function multipleClass(value) { return isNum(value) ? (value > 1 ? "pos" : value < 1 ? "neg" : "") : ""; }
  function fmtSignedPct(value) { return isNum(value) ? signedText(Math.abs(value).toFixed(1), value) + "%" : DASH; }
  function fmtPlainPct(value) { return isNum(value) ? Math.round(value) + "%" : DASH; }
  function interval(range) { return range ? fmtSol(range.low) + " to " + fmtSol(range.high) : DASH; }
  function quoteLabel(mint) { return mint === "SOL" ? "SOL" : mint === PUMP_MINT ? "PUMP" : shortAddr(mint); }
  function readable(text) { return String(text || "").split("_").join(" "); }
  function sentence(text) { var value = String(text || ""); return value ? value.charAt(0).toUpperCase() + value.slice(1) : value; }
  function humanize(text) { return Object.prototype.hasOwnProperty.call(REASON_LABELS, text) ? REASON_LABELS[text] : sentence(readable(text)); }
  function exitShort(text) { return Object.prototype.hasOwnProperty.call(EXIT_SHORT, text) ? EXIT_SHORT[text] : humanize(text); }
  function killText(reason) {
    if (!reason) { return "New buys are paused."; }
    if (String(reason).indexOf("dashboard") === 0) { return "Paused from the dashboard (Close all). New buys wait until you resume."; }
    return "Paused: " + humanize(reason) + ". New buys wait until you resume.";
  }
  function solUsd() { return wallet.data && isNum(wallet.data.solUsd) ? wallet.data.solUsd : null; }
  function usdOf(sol) { var price = solUsd(); return isNum(sol) && price !== null ? sol * price : null; }
  function fmtMcap(sol) {
    if (!isNum(sol)) { return DASH; }
    return (sol >= 1000 ? (sol / 1000).toFixed(1) + "k" : sol.toFixed(sol >= 100 ? 0 : 1)) + " SOL";
  }

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
  function networkError() { var error = new Error("Can't reach the bot. Check that the service is running and this device is online."); error.network = true; return error; }
  function readJson(res) {
    if (res.status === 401) { var authError = new Error("unauthorized"); authError.auth = true; throw authError; }
    return res.json().catch(function () { return null; }).then(function (body) {
      if (!res.ok) {
        var error = new Error(body && body.message ? body.message : "Request failed (" + res.status + ")");
        error.status = res.status;
        throw error;
      }
      return body;
    });
  }
  function api(path, params) {
    return fetch(path + queryString(params), { headers: authHeaders(), cache: "no-store", credentials: "same-origin" })
      .catch(function () { throw networkError(); }).then(readJson);
  }
  function apiPost(path, body) {
    var headers = authHeaders();
    headers["Content-Type"] = "application/json";
    return fetch(path, { method: "POST", headers: headers, body: JSON.stringify(body || {}), cache: "no-store", credentials: "same-origin" })
      .catch(function () { throw networkError(); }).then(readJson);
  }

  function card(title, hint) {
    var node = el("section", { class: "card" });
    if (title || hint) {
      node.append(el("div", { class: "card-head" }, el("div", null, title ? el("h2", { class: "card-title", text: title }) : null, hint ? el("p", { class: "hint", text: hint }) : null)));
    }
    for (var i = 2; i < arguments.length; i += 1) { append(node, arguments[i]); }
    return node;
  }
  function empty(title, text, iconName) {
    return el("section", { class: "card empty" }, icon(iconName || "inbox", "empty-icon"), el("strong", { text: title }), text ? el("span", { class: "empty-text", text: text }) : null);
  }
  function stat(label, value, sub, cls) {
    return el("div", { class: "stat" }, el("div", { class: "label", text: label }), el("div", { class: "value " + (cls || ""), text: value }), sub ? el("div", { class: "sub", text: sub }) : null);
  }
  function kpi(label, value, unit, sub, valueCls, subCls) {
    return el("div", { class: "kpi" },
      el("div", { class: "kpi-label" }, label, unit ? el("span", { class: "kpi-unit", text: " " + unit }) : null),
      el("div", { class: "kpi-value " + (valueCls || ""), text: value }),
      sub ? el("div", { class: "kpi-sub " + (subCls || ""), text: sub }) : null);
  }
  function miniStat(label, value, sub, cls, subCls) {
    return el("div", { class: "mini-stat" }, el("div", { class: "ms-label", text: label }),
      el("div", { class: "ms-value " + (cls || ""), text: value }),
      sub ? el("div", { class: "ms-sub " + (subCls || ""), text: sub }) : null);
  }
  function grid(items, cls) { return el("div", { class: "grid" + (cls ? " " + cls : "") }, items); }
  function badge(text, tone) { return el("span", { class: "badge " + (tone || ""), text: text }); }
  function banner(tone, iconName) {
    var node = el("div", { class: "banner " + (tone || ""), role: tone === "bad" ? "alert" : "status" }, icon(iconName || "alert"));
    var body = el("div", null);
    for (var i = 2; i < arguments.length; i += 1) { append(body, arguments[i]); }
    node.append(body);
    return node;
  }
  function meter(fraction) {
    var bar = el("span");
    bar.style.width = Math.max(0, Math.min(1, isNum(fraction) ? fraction : 0)) * 100 + "%";
    return el("div", { class: "meter", role: "presentation" }, bar);
  }
  function hero(narrative, figure, unit, extras, labels) {
    var tone = narrative && narrative.tone !== "neutral" ? narrative.tone : "";
    var names = labels || TONE_LABELS;
    return el("section", { class: "card hero " + tone },
      badge(names[narrative ? narrative.tone : "neutral"] || "", tone),
      figure ? el("div", { class: "figure", text: figure }) : null,
      figure && unit ? el("div", { class: "figure-unit", text: unit }) : null,
      el("p", { class: "headline", text: narrative ? narrative.headline : "" }),
      narrative && narrative.detail ? el("p", { class: "detail", text: narrative.detail }) : null,
      extras || null);
  }
  function table(headers, rows, narrowHidden, cls, leftCols) {
    var hidden = narrowHidden || {};
    var left = leftCols || {};
    var head = el("tr", null, headers.map(function (text, index) { return el("th", { class: ((hidden[index] ? "hide-narrow " : "") + (left[index] ? "t-left" : "")).trim() || null, scope: "col", text: text }); }));
    return el("div", { class: "table-wrap" + (cls ? " " + cls : "") }, el("table", null, el("thead", null, head), el("tbody", null, rows)));
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
  function field(label, control, cls) { return el("label", { class: "field" + (cls ? " " + cls : "") }, el("span", { class: "field-label", text: label }), control); }
  function actions(items) { return el("div", { class: "actions" }, items); }
  function downloadButton(text, path, params, filename) {
    var label = el("span", { text: text });
    var button = el("button", { class: "btn", type: "button" }, icon("download"), label);
    button.addEventListener("click", function () {
      button.disabled = true;
      label.textContent = "Preparing…";
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
        label.textContent = text;
      }).catch(function (error) {
        label.textContent = error.message || "Download failed";
      }).then(function () { button.disabled = false; });
    });
    return button;
  }
  function mintButton(mint, label, cls) {
    return el("button", { class: "title-btn" + (cls ? " " + cls : ""), type: "button", text: label || shortAddr(mint), onclick: function () { openScore(mint, label); } });
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
  function tradesWord(count) { return fmtInt(count) + (count === 1 ? " trade" : " trades"); }
  function modeOptions() {
    var known = {};
    var options = [["auto", sentence(resolvedMode() || "paper") + " (auto)"], ["all", "All modes"]];
    meta.modes.forEach(function (item) { known[item.mode] = item.closedTrades; });
    ["live", "paper", "backtest"].forEach(function (mode) { if (!(mode in known)) { known[mode] = 0; } });
    Object.keys(known).forEach(function (mode) { options.push([mode, sentence(mode) + DOT + tradesWord(known[mode])]); });
    return options;
  }
  function runOptions() {
    var mode = state.mode === "auto" ? resolvedMode() : state.mode === "all" ? "" : state.mode;
    var options = [["", "All runs"]];
    var listed = false;
    meta.runs.forEach(function (run) {
      if (String(run.id) === state.runId) { listed = true; }
      if (mode && run.mode !== mode) { return; }
      options.push([String(run.id), "#" + run.id + " " + sentence(run.mode) + (run.label ? DOT + run.label : "") + DOT + tradesWord(run.closedTrades)]);
    });
    if (state.runId && !listed) { options.push([state.runId, "#" + state.runId + " (opened from Lab)"]); }
    return options;
  }
  function renderFilters() {
    dom.filters.replaceChildren();
    if (!FILTER_TABS[state.tab]) { return; }
    if (state.tab !== "compare") {
      dom.filters.append(field("Mode", selectBox(modeOptions(), state.mode, function (value) { state.mode = value; state.runId = ""; savePrefs(); render(); }, "Mode")));
    }
    dom.filters.append(field("Period", selectBox(PERIODS.map(function (p) { return [p[0], p[1]]; }), state.period, function (value) { state.period = value; savePrefs(); render(); }, "Period")));
    dom.filters.append(field("Run", selectBox(runOptions(), state.runId, function (value) { state.runId = value; savePrefs(); render(); }, "Run")));
    dom.filters.className = "filters" + (state.tab === "compare" ? " two" : "");
  }
`;

const SHELL_SCRIPT = String.raw`
  function tokenForm() {
    var input = el("input", { type: "password", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Dashboard token", "aria-label": "Dashboard token" });
    function submit() {
      var value = input.value.trim();
      if (!value) { return; }
      storageSet(TOKEN_KEY, value);
      refresh();
    }
    input.addEventListener("keydown", function (event) { if (event.key === "Enter") { submit(); } });
    return el("section", { class: "card signin" },
      el("div", { class: "signin-mark" }, icon("lock")),
      el("h2", { class: "card-title", text: "This dashboard is locked" }),
      el("p", { class: "hint", text: "Paste the DASHBOARD_TOKEN from the service settings. It stays on this device. Opening the page once with ?token= in the address works too." }),
      field("Token", input), actions([el("button", { class: "btn primary block", type: "button", onclick: submit }, "Unlock")]));
  }
  function errorCard(error) {
    return el("section", { class: "card empty" }, icon("alert", "empty-icon bad"),
      el("strong", { text: "Could not load this view" }),
      el("span", { class: "empty-text", text: error && error.message ? error.message : "Unknown error" }),
      actions([el("button", { class: "btn", type: "button", text: "Try again", onclick: function () { render(); } })]));
  }
  function skeleton() {
    return el("div", { class: "skeleton", "aria-hidden": "true" }, el("div", { class: "sk sk-row" }), el("div", { class: "sk-split" }, el("div", { class: "sk sk-card" }), el("div", { class: "sk sk-card" })), el("div", { class: "sk sk-card" }));
  }

  var VIEWS = {
    trades: tradesView, live: liveView, edge: edgeView, lab: labView, breakdowns: breakdownsView, compare: compareView, scorer: scorerView,
    recorder: recorderView, signals: signalsView, launches: launchesView, wallets: walletsView, settings: settingsView
  };

  function navLink(tab, cls) {
    var link = el("a", { class: cls, href: "#" + tab[0], "data-tab": tab[0], "aria-current": "false" }, icon(tab[3]), el("span", { class: cls === "nav-tab" ? "nav-tab-label" : null, text: tab[1] }));
    link.addEventListener("click", function () { if (state.tab === tab[0]) { scrollTop(); } });
    dom.navLinks.push(link);
    return link;
  }
  function wordmark(cls) {
    return el("a", { class: "brand " + cls, href: "#trades", "aria-label": "SNYPRA edge" }, el("span", { class: "wordmark" }, "snypra", el("span", { class: "amber", text: "_" })), el("span", { class: "brand-sub", text: "edge" }));
  }
  function sidebar() {
    var groups = NAV_GROUPS.map(function (group) {
      return el("div", { class: "side-group" },
        el("div", { class: "side-label", text: group[1] }),
        TABS.filter(function (tab) { return tab[2] === group[0]; }).map(function (tab) { return navLink(tab, "side-link"); }));
    });
    dom.clock = el("span", { class: "clock-time" });
    return el("aside", { class: "sidebar" }, wordmark("side-brand"), el("nav", { "aria-label": "Sections" }, groups),
      el("div", { class: "side-foot" }, dom.clock, el("span", { class: "clock-zone", text: tzLabel() + DOT + "24-hour" })));
  }
  function bottomNav() {
    dom.moreButton = el("button", { class: "nav-tab", type: "button", "aria-haspopup": "dialog", onclick: openMore }, icon("more"), el("span", { class: "nav-tab-label", text: "More" }));
    return el("nav", { class: "bottom-nav", "aria-label": "Main sections" },
      TABS.filter(function (tab) { return tab[2] === "primary"; }).map(function (tab) { return navLink(tab, "nav-tab"); }),
      dom.moreButton);
  }
  function openMore() {
    if (sheetOpen) { return; }
    var close = el("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, icon("close"));
    var opener = document.activeElement;
    var list = el("ul", { class: "more-list" }, TABS.filter(function (tab) { return tab[2] !== "primary"; }).map(function (tab) {
      var link = el("a", { class: "more-link", href: "#" + tab[0], "aria-current": tab[0] === state.tab ? "page" : "false" },
        icon(tab[3]), el("span", { class: "more-name", text: tab[1] }), el("span", { class: "more-desc", text: tab[4] }));
      link.addEventListener("click", function () { dismiss(); });
      return el("li", null, link);
    }));
    var panel = el("div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": "More views" },
      el("div", { class: "panel-head" }, el("h2", { text: "More" }), close), list);
    var sheet = el("div", { class: "sheet" }, panel);
    var shown = true;
    function onKey(event) { if (event.key === "Escape") { dismiss(); } }
    function dismiss() {
      if (!shown) { return; }
      shown = false;
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
  }
  function scrollTop() {
    if (typeof window.scrollTo === "function") { try { window.scrollTo(0, 0); } catch (e) { return; } }
  }
  function toggleInfo() {
    var open = dom.desc.hidden;
    dom.desc.hidden = !open;
    dom.info.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function setActiveTab() {
    var info = tabInfo(state.tab) || TABS[0];
    dom.navLinks.forEach(function (link) {
      var active = link.getAttribute("data-tab") === state.tab;
      link.setAttribute("aria-current", active ? "page" : "false");
    });
    if (dom.moreButton) { dom.moreButton.className = "nav-tab" + (info[2] !== "primary" ? " active" : ""); }
    dom.title.textContent = info[1];
    dom.desc.textContent = info[4];
    dom.desc.hidden = true;
    dom.info.setAttribute("aria-expanded", "false");
    if (document.title !== undefined) { document.title = info[1] + DOT + "SNYPRA edge"; }
  }

  function currentMode() {
    if (wallet.data && wallet.data.enabled && wallet.data.mode) { return wallet.data.mode; }
    var active = meta.runs.filter(function (run) { return (run.mode === "paper" || run.mode === "live") && !run.endedAtMs; });
    return active[0] ? active[0].mode : "";
  }
  function botState() {
    var w = wallet.data;
    var market = w && w.marketData;
    if (health.server === "down" || conn.down) { return { tone: "bad", short: "Offline", text: "Server unreachable" }; }
    if (market && market.stale) { return { tone: "bad", short: "No data", text: "No market data" }; }
    if (health.server === "unhealthy") { return { tone: "bad", short: "Unhealthy", text: "Server unhealthy (database or stream)" }; }
    if (w && w.enabled && w.entriesPaused) { return { tone: "bad", short: "Paused", text: "Buys paused" }; }
    if (w && w.enabled && w.haltedForDay) { return { tone: "warn", short: "Halted", text: "Halted for today" }; }
    if (w && w.enabled) { return { tone: "good", short: "", text: w.mode === "live" ? "Trading live" : "Trading" }; }
    if (market) { return { tone: "good", short: "", text: "Market data live" }; }
    if (health.server === "ok") { return { tone: "good", short: "", text: "Online" }; }
    return { tone: "", short: "", text: "Connecting" };
  }
  function tick(label, value, unit, sub, cls) {
    return el("span", { class: "tick" }, el("span", { class: "tick-label", text: label }),
      el("span", { class: "tick-value " + (cls || ""), text: value }), unit ? el("span", { class: "tick-unit", text: unit }) : null,
      sub ? el("span", { class: "tick-sub", text: sub }) : null);
  }
  function renderAlert() {
    if (!dom.alert) { return; }
    var market = wallet.data && wallet.data.marketData;
    if (!market || !market.stale) { dom.alert.replaceChildren(); return; }
    var since = isNum(market.lastDataAgoMs) ? "for " + fmtDur(market.lastDataAgoMs / 1000) : "since it started";
    fill(dom.alert,
      icon("alert"),
      el("span", { class: "alert-text" },
        el("strong", { text: "No market data " + since + "." }),
        el("span", { class: "alert-detail", text: " The bot can't see new coins or sell. If Helius is out of credits, paste a new key." })),
      el("button", { type: "button", class: "btn alert-btn", onclick: function () { selectTab("settings"); } }, icon("key"), "Change key"));
  }
  function renderOffline() {
    if (!dom.offline) { return; }
    if (!conn.down) { dom.offline.replaceChildren(); return; }
    fill(dom.offline, el("span", { class: "dot bad", "aria-hidden": "true" }),
      el("span", { text: "Disconnected" + (lastRenderMs ? DOT + "showing data from " + fmtSeconds(lastRenderMs) : "") + DOT + "retrying" }));
  }
  function renderStatus() {
    if (!dom.status) { return; }
    var s = botState();
    dom.status.className = "status-chip " + (s.tone || "idle");
    dom.statusDot.className = "dot " + s.tone;
    dom.statusText.textContent = s.text;
    dom.statusShort.textContent = s.short;
    dom.status.setAttribute("title", s.text);
    dom.status.setAttribute("aria-label", s.text);
  }
  function syncStickyTop() {
    var root = document.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== "function" || !dom.header) { return; }
    root.style.setProperty("--sticky-top", (dom.header.offsetHeight || 56) + "px");
  }
  function renderChrome() {
    if (!dom.mode) { return; }
    var mode = currentMode();
    dom.mode.className = "mode-badge " + (mode === "live" || mode === "paper" ? mode : "");
    dom.mode.textContent = mode === "live" ? "Live" : mode === "paper" ? "Paper" : "";
    renderStatus();
    renderAlert();
    renderOffline();
    syncRunBadge();
    var w = wallet.data;
    if (!w || !w.enabled) { dom.ticker.replaceChildren(); syncStickyTop(); return; }
    var today = isNum(w.todayPnlSol) ? w.todayPnlSol : null;
    fill(dom.ticker,
      tick(w.mode === "live" ? "Wallet" : "Equity", fmtSolAmount(w.totalSol), "SOL", isNum(w.totalUsd) ? fmtUsd(w.totalUsd) : null),
      today !== null ? tick("Today", fmtSol(today), "SOL", null, signClass(today)) : null);
    syncStickyTop();
  }
  function onScroll() {
    var compact = (window.scrollY || window.pageYOffset || 0) > COMPACT_SCROLL_PX;
    if (compact === dom.compact) { return; }
    dom.compact = compact;
    setClass(dom.header, "compact", compact);
    syncStickyTop();
  }

  function showUpdated() {
    if (locked || STATIC_TABS[state.tab] === true || STREAM_TABS[state.tab] === true) { dom.updated.textContent = ""; }
    else if (!lastRenderMs) { dom.updated.textContent = staleNote; }
    else {
      var text = "Updated " + fmtDur(Math.max(0, (Date.now() - lastRenderMs) / 1000)) + " ago";
      dom.updated.textContent = staleNote ? text + DOT + staleNote : text;
    }
    if (dom.clock) { dom.clock.textContent = fmtSeconds(Date.now()); }
  }
  function holdsFocus(node) {
    var active = document.activeElement;
    return !!(active && node && active !== node && typeof node.contains === "function" && node.contains(active));
  }
  function editingIn(node) {
    var tag = holdsFocus(node) ? String(document.activeElement.tagName || "").toUpperCase() : "";
    return tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA";
  }
  function setLocked(value) {
    locked = value;
    setClass(document.body, "locked", value);
  }
  function setConnection(down) {
    if (conn.down === down) { return; }
    conn.down = down;
    conn.sinceMs = down ? Date.now() : 0;
    renderChrome();
  }
  function render(quiet) {
    var seq = ++renderSeq;
    var silent = quiet === true;
    if (STREAM_TABS[state.tab] !== true) { liveStop(); }
    if (!silent) {
      setActiveTab();
      dom.main.classList.add("loading");
      if (dom.main.getAttribute("data-view") !== state.tab) {
        dom.main.setAttribute("data-view", state.tab);
        dom.main.replaceChildren(skeleton());
        lastRenderMs = 0;
      }
    }
    if (!silent || !holdsFocus(dom.filters)) { renderFilters(); }
    rendering = true;
    lastAttemptMs = Date.now();
    var view = VIEWS[state.tab] || tradesView;
    Promise.resolve().then(view).then(function (result) {
      if (seq !== renderSeq) { return; }
      var fragment = document.createDocumentFragment();
      append(fragment, result);
      dom.main.replaceChildren(fragment);
      lastRenderMs = Date.now();
      staleNote = "";
      setLocked(false);
      setConnection(false);
    }).catch(function (error) {
      if (seq !== renderSeq) { return; }
      var auth = !!(error && error.auth);
      if (error && error.network) { setConnection(true); }
      if (!auth && lastRenderMs > 0) { staleNote = error && error.network ? "offline" : "retrying"; return; }
      if (silent && !auth) { staleNote = "retrying"; return; }
      setLocked(auth);
      dom.main.replaceChildren(auth ? tokenForm() : errorCard(error));
    }).then(function () {
      if (seq !== renderSeq) { return; }
      rendering = false;
      dom.main.classList.remove("loading");
      showUpdated();
    });
  }
  function autoRefreshAllowed() {
    return document.visibilityState === "visible" && !sheetOpen && !locked && !editingIn(dom.main);
  }
  function liveRefreshDue() {
    if (LIVE_TABS[state.tab] !== true || !autoRefreshAllowed()) { return false; }
    return Date.now() - lastAttemptMs >= (rendering ? STALL_MS : LIVE_REFRESH_MS);
  }
  function tick1s() {
    showUpdated();
    walletTick();
    liveTick();
    if (liveRefreshDue()) { render(true); }
  }
  function loadMeta() {
    return api("/api/runs", { limit: 200 }).then(function (result) {
      meta.runs = result.runs || [];
      meta.modes = result.modes || [];
      conn.down = false;
      renderChrome();
    }).catch(function (error) { if (error && error.network) { setConnection(true); } return null; });
  }
  function checkHealth() {
    fetch("/healthz", { cache: "no-store" }).then(function (res) { health.server = res.ok ? "ok" : "unhealthy"; renderStatus(); })
      .catch(function () { health.server = "down"; renderStatus(); });
  }
  function refresh(quiet) {
    checkHealth();
    lastAttemptMs = Date.now();
    return loadMeta().then(function () { render(quiet === true); });
  }
  function periodicRefresh() {
    if (!autoRefreshAllowed()) { return; }
    if (LIVE_TABS[state.tab] === true || STREAM_TABS[state.tab] === true || STATIC_TABS[state.tab] === true) { checkHealth(); loadMeta(); return; }
    refresh(true);
  }
  function selectTab(id) {
    if (window.location.hash === "#" + id) { if (state.tab !== id) { state.tab = id; savePrefs(); render(); } return; }
    window.location.hash = id;
  }
  function build() {
    dom.navLinks = [];
    dom.statusDot = el("span", { class: "dot", "aria-hidden": "true" });
    dom.statusText = el("span", { class: "status-text", text: "Connecting" });
    dom.statusShort = el("span", { class: "status-short" });
    dom.status = el("span", { class: "status-chip idle", role: "status" }, dom.statusDot, dom.statusText, dom.statusShort);
    dom.mode = el("span", { class: "mode-badge" });
    dom.ticker = el("div", { class: "ticker", role: "status", "aria-live": "polite" });
    dom.alert = el("div", { class: "alert", role: "alert" });
    dom.offline = el("div", { class: "offline-bar", role: "status" });
    dom.updated = el("span", { class: "updated" });
    dom.title = el("h1", { class: "page-title" });
    dom.info = el("button", { class: "info-btn", type: "button", "aria-label": "About this view", title: "About this view", "aria-expanded": "false", onclick: toggleInfo }, icon("info"));
    dom.desc = el("p", { class: "page-desc", hidden: true });
    dom.filters = el("div", { class: "filters" });
    dom.main = el("main", { id: "main" }, skeleton());
    dom.header = el("header", { class: "topbar" },
      el("div", { class: "topbar-row" },
        wordmark("brand-top"), dom.mode, dom.status, el("span", { class: "spacer" }), dom.ticker,
        el("div", { class: "top-actions" },
          el("button", { class: "icon-btn", type: "button", "aria-label": "Settings", title: "Settings", onclick: function () { selectTab("settings"); } }, icon("settings")),
          el("button", { class: "icon-btn", type: "button", "aria-label": "Refresh", title: "Refresh", onclick: function () { refresh(false); } }, icon("refresh")))),
      dom.alert, dom.offline);
    var content = el("div", { class: "content" },
      el("div", { class: "page-head" }, el("div", { class: "page-head-row" }, el("div", { class: "page-title-wrap" }, dom.title, dom.info), dom.updated), dom.desc),
      dom.filters, dom.main);
    document.body.replaceChildren(el("div", { class: "app" }, sidebar(), el("div", { class: "shell" }, dom.header, content)), bottomNav());
  }
  function init() {
    captureToken();
    state.tab = tabFromHash() || state.tab || "trades";
    if (!tabInfo(state.tab)) { state.tab = "trades"; }
    build();
    setActiveTab();
    showUpdated();
    window.addEventListener("hashchange", function () {
      var tab = tabFromHash();
      if (tab && tab !== state.tab) { state.tab = tab; savePrefs(); scrollTop(); render(); }
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", syncStickyTop);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") { liveStop(); return; }
      if (autoRefreshAllowed()) { refresh(true); }
    });
    window.setInterval(periodicRefresh, REFRESH_MS);
    window.setInterval(tick1s, TICK_MS);
    refresh(false);
    loadWallet(true);
  }
`;

export const DASHBOARD_SCRIPT = `
(function () {
  "use strict";
${CORE_SCRIPT}
${ICON_SCRIPT}
${CHART_SCRIPT}
${OVERVIEW_SCRIPT}
${ANALYSIS_SCRIPT}
${LIVE_VIEW_SCRIPT}
${LAB_VIEW_SCRIPT}
${SHELL_SCRIPT}
  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }
})();
`;
