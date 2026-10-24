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
  var HEADER_TODAY_FRESH_MS = 30000;
  var TIP_TONES = { good: ["Working", "good"], warn: ["Watch", "warn"], bad: ["Problem", "bad"], info: ["Info", "info"] };
  var ARM_MS = 6000;
  var SOLSCAN_ACCOUNT_URL = "https://solscan.io/account/";
  var PREFS_VERSION = "2";
  var PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  var PUMP_COIN_URL = "https://pump.fun/coin/";
  var MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var DASH = "—";
  var DOT = " · ";
  var TABS = [
    ["trades", "Overview", "primary", "overview", "Equity, open positions and recent trades of the current run."],
    ["live", "Live", "primary", "live", "Open positions on a live price chart, and everything the bot does as it happens."],
    ["edge", "Performance", "primary", "performance", "Expectancy after fees, the one number that proves an edge."],
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
    lean_cut: ["Leaning −", "warn"], insufficient: ["Too few", ""]
  };
  var TONE_LABELS = { good: "Looks good", warn: "Not proven", bad: "Problem", neutral: "Waiting for data" };

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

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) { window.localStorage.removeItem(key); } else { window.localStorage.setItem(key, value); }
    } catch (e) { return; }
  }
  function loadPrefs() {
    var prefs = { v: "", tab: "trades", mode: "auto", runId: "", period: "all", checkpoint: "", quote: "", tradesRun: "", liveFilter: "all" };
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
  function fmtUsd(value) { return isNum(value) ? (value < 0 ? "-$" : "$") + Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : DASH; }
  function fmtSolAmount(value) { return isNum(value) ? value.toFixed(4) : DASH; }
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
  function fmtClockTime(ms) { return isNum(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }) : DASH; }
  function fmtDay(ms) { return isNum(ms) ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : DASH; }
  function shortAddr(value) { return value && value.length > 12 ? value.slice(0, 4) + "…" + value.slice(-4) : (value || DASH); }
  function signClass(value) { return isNum(value) ? (value > 0 ? "pos" : value < 0 ? "neg" : "") : ""; }
  function multipleClass(value) { return isNum(value) ? (value > 1 ? "pos" : value < 1 ? "neg" : "") : ""; }
  function fmtSignedPct(value) { return isNum(value) ? (value > 0 ? "+" : "") + value.toFixed(1) + "%" : DASH; }
  function fmtPlainPct(value) { return isNum(value) ? Math.round(value) + "%" : DASH; }
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
    return fetch(path + queryString(params), { headers: authHeaders(), cache: "no-store", credentials: "same-origin" }).then(readJson);
  }
  function apiPost(path, body) {
    var headers = authHeaders();
    headers["Content-Type"] = "application/json";
    return fetch(path, { method: "POST", headers: headers, body: JSON.stringify(body || {}), cache: "no-store", credentials: "same-origin" }).then(readJson);
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
    return el("section", { class: "card empty" }, icon(iconName || "inbox", "empty-icon"), el("strong", { text: title }), el("span", { text: text }));
  }
  function stat(label, value, sub, cls) {
    return el("div", { class: "stat" }, el("div", { class: "label", text: label }), el("div", { class: "value " + (cls || ""), text: value }), sub ? el("div", { class: "sub", text: sub }) : null);
  }
  function kpi(label, value, unit, sub, valueCls, subCls) {
    return el("div", { class: "kpi" },
      el("div", { class: "kpi-label", text: label }),
      el("div", { class: "kpi-value " + (valueCls || "") }, value, unit && value !== DASH ? el("span", { class: "kpi-unit", text: unit }) : null),
      sub ? el("div", { class: "kpi-sub " + (subCls || ""), text: sub }) : null);
  }
  function miniStat(label, value, unit, cls) {
    return el("div", { class: "mini-stat" }, el("div", { class: "ms-label", text: label }),
      el("div", { class: "ms-value " + (cls || "") }, value, unit && value !== DASH ? el("span", { class: "unit", text: unit }) : null));
  }
  function grid(items) { return el("div", { class: "grid" }, items); }
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
    var head = el("tr", null, headers.map(function (text, index) { return el("th", { class: hidden[index] ? "hide-narrow" : null, scope: "col", text: text }); }));
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
  function mintButton(mint, label) {
    return el("button", { class: "title-btn", type: "button", text: label || shortAddr(mint), onclick: function () { openScore(mint, label); } });
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
    var listed = false;
    meta.runs.forEach(function (run) {
      if (String(run.id) === state.runId) { listed = true; }
      if (mode && run.mode !== mode) { return; }
      options.push([String(run.id), "#" + run.id + " " + run.mode + (run.label ? " " + run.label : "") + " (" + fmtInt(run.closedTrades) + ")"]);
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
    dom.filters.append(field("Run", selectBox(runOptions(), state.runId, function (value) { state.runId = value; savePrefs(); render(); }, "Run"), state.tab === "compare" ? "" : "wide"));
  }
`;

const SHELL_SCRIPT = String.raw`
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
      field("Token", input), actions([el("button", { class: "btn primary", type: "button", onclick: submit }, icon("lock"), "Unlock")]));
  }
  function errorCard(error) {
    return card("Could not load this view", null, el("p", { class: "error-text", text: error && error.message ? error.message : "Unknown error" }), actions([el("button", { class: "btn", type: "button", text: "Try again", onclick: render })]));
  }
  function skeleton() {
    return el("div", { class: "skeleton", "aria-hidden": "true" }, el("div", { class: "sk sk-row" }), el("div", { class: "sk sk-card" }), el("div", { class: "sk sk-card" }));
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
  function sidebar() {
    var groups = NAV_GROUPS.map(function (group) {
      return el("div", { class: "side-group" },
        el("div", { class: "side-label", text: group[1] }),
        TABS.filter(function (tab) { return tab[2] === group[0]; }).map(function (tab) { return navLink(tab, "side-link"); }));
    });
    return el("aside", { class: "sidebar" },
      el("a", { class: "brand side-brand", href: "#trades", "aria-label": "SNYPRA edge" }, el("span", { class: "wordmark" }, "snypra", el("span", { class: "amber", text: "_" })), el("span", { class: "brand-sub", text: "edge" })),
      el("nav", { "aria-label": "Sections" }, groups),
      el("div", { class: "side-foot" }, "Private trading terminal", el("br"), "Numbers are after fees."));
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
  function setActiveTab() {
    var info = tabInfo(state.tab) || TABS[0];
    dom.navLinks.forEach(function (link) {
      var active = link.getAttribute("data-tab") === state.tab;
      link.setAttribute("aria-current", active ? "page" : "false");
    });
    if (dom.moreButton) { dom.moreButton.className = "nav-tab" + (info[2] !== "primary" ? " active" : ""); }
    dom.title.textContent = info[1];
    dom.desc.textContent = info[4];
    if (document.title !== undefined) { document.title = info[1] + DOT + "SNYPRA edge"; }
  }

  function currentMode() {
    if (wallet.data && wallet.data.enabled && wallet.data.mode) { return wallet.data.mode; }
    var active = meta.runs.filter(function (run) { return (run.mode === "paper" || run.mode === "live") && !run.endedAtMs; });
    return active[0] ? active[0].mode : "";
  }
  function headerToday() {
    var w = wallet.data;
    var activeRun = meta.runs.filter(function (run) { return (run.mode === "paper" || run.mode === "live") && !run.endedAtMs; })[0];
    var sameRun = overview.runId !== null && (!activeRun || activeRun.id === overview.runId);
    if (sameRun && isNum(overview.todayPnlSol) && Date.now() - overview.atMs < HEADER_TODAY_FRESH_MS) { return overview.todayPnlSol; }
    return w && isNum(w.todayPnlSol) ? w.todayPnlSol : null;
  }
  function tick(label, value, sub, cls) {
    return el("span", { class: "tick" }, el("span", { class: "tick-label", text: label }), el("span", { class: "tick-value " + (cls || ""), text: value }), sub ? el("span", { class: "tick-sub", text: sub }) : null);
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
        el("span", { text: " The bot can't see new coins, trade or sell. If Helius says the key is out of credits, paste a new key in Settings." })),
      el("button", { type: "button", class: "btn alert-btn", onclick: function () { selectTab("settings"); } }, icon("key"), "Change key"));
  }
  function renderHealth() {
    if (!dom.dot) { return; }
    var market = wallet.data && wallet.data.marketData;
    var tone = "";
    var text = "Connecting";
    if (health.server === false) { tone = "bad"; text = "Server unreachable"; }
    else if (market && market.stale) { tone = "bad"; text = "No market data"; }
    else if (market) { tone = "good"; text = "Market data live"; }
    else if (health.server === true) { tone = "good"; text = "Online"; }
    dom.dot.className = "dot " + tone;
    dom.healthText.textContent = text;
    dom.health.setAttribute("title", text);
    dom.health.setAttribute("aria-label", text);
  }
  function renderChrome() {
    if (!dom.mode) { return; }
    var mode = currentMode();
    dom.mode.className = "mode-badge " + (mode === "live" || mode === "paper" ? mode : "");
    dom.mode.textContent = mode === "live" ? "Live" : mode === "paper" ? "Paper" : "";
    renderHealth();
    renderAlert();
    var w = wallet.data;
    if (!w || !w.enabled) { dom.ticker.replaceChildren(); return; }
    var today = headerToday();
    fill(dom.ticker,
      tick("Balance", fmtSolAmount(w.totalSol) + " SOL", fmtUsd(w.totalUsd)),
      isNum(today) ? tick("Today", fmtSol(today) + " SOL", null, signClass(today)) : null,
      w.entriesPaused ? el("span", { class: "tick-flag", text: "buys paused" }) : null);
  }

  function showUpdated() {
    if (STREAM_TABS[state.tab] === true && !locked) { dom.updated.textContent = liveStatusText(); return; }
    if (!lastRenderMs) { dom.updated.textContent = staleNote; return; }
    var text = "Updated " + fmtDur(Math.max(0, (Date.now() - lastRenderMs) / 1000)) + " ago";
    dom.updated.textContent = staleNote ? text + DOT + staleNote : text;
  }
  function holdsFocus(node) {
    var active = document.activeElement;
    return !!(active && node && active !== node && typeof node.contains === "function" && node.contains(active));
  }
  function editingIn(node) {
    var tag = holdsFocus(node) ? String(document.activeElement.tagName || "").toUpperCase() : "";
    return tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA";
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
      locked = false;
    }).catch(function (error) {
      if (seq !== renderSeq) { return; }
      if (silent && !(error && error.auth)) { staleNote = "retrying"; return; }
      locked = !!(error && error.auth);
      dom.main.replaceChildren(error && error.auth ? tokenForm() : errorCard(error));
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
      renderChrome();
    }).catch(function () { return null; });
  }
  function checkHealth() {
    fetch("/healthz", { cache: "no-store" }).then(function (res) { health.server = !!res.ok; renderHealth(); })
      .catch(function () { health.server = false; renderHealth(); });
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
    dom.dot = el("span", { class: "dot", "aria-hidden": "true" });
    dom.healthText = el("span", { class: "health-text", text: "Connecting" });
    dom.health = el("span", { class: "health", role: "status" }, dom.dot, dom.healthText);
    dom.mode = el("span", { class: "mode-badge" });
    dom.ticker = el("div", { class: "ticker", role: "status", "aria-live": "polite" });
    dom.alert = el("div", { class: "alert", role: "alert" });
    dom.updated = el("span", { class: "updated" });
    dom.title = el("h1", { class: "page-title" });
    dom.desc = el("p", { class: "page-desc" });
    dom.filters = el("div", { class: "filters" });
    dom.main = el("main", { id: "main" });
    var header = el("header", { class: "topbar" },
      el("div", { class: "topbar-row" },
        el("a", { class: "brand brand-top", href: "#trades", "aria-label": "SNYPRA edge" }, el("span", { class: "wordmark" }, "snypra", el("span", { class: "amber", text: "_" })), el("span", { class: "brand-sub", text: "edge" })),
        dom.mode, dom.health, el("span", { class: "spacer" }), dom.ticker,
        el("div", { class: "top-actions" },
          el("button", { class: "icon-btn", type: "button", "aria-label": "Settings", title: "Settings", onclick: function () { selectTab("settings"); } }, icon("settings")),
          el("button", { class: "icon-btn", type: "button", "aria-label": "Refresh", title: "Refresh", onclick: function () { refresh(false); } }, icon("refresh")))),
      dom.alert);
    var footer = el("footer", { class: "footer" }, el("span", { text: "Numbers are after fees. Expectancy decides, not win rate." }),
      el("button", { type: "button", text: "Forget token on this device", onclick: forgetToken }));
    var content = el("div", { class: "content" },
      el("div", { class: "page-head" }, el("div", { class: "page-head-row" }, dom.title, dom.updated), dom.desc),
      dom.filters, dom.main, footer);
    document.body.replaceChildren(el("div", { class: "app" }, sidebar(), el("div", { class: "shell" }, header, content)), bottomNav());
  }
  function init() {
    captureToken();
    state.tab = tabFromHash() || state.tab || "trades";
    if (!tabInfo(state.tab)) { state.tab = "trades"; }
    build();
    window.addEventListener("hashchange", function () {
      var tab = tabFromHash();
      if (tab && tab !== state.tab) { state.tab = tab; savePrefs(); scrollTop(); render(); }
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") { liveStop(); return; }
      if (autoRefreshAllowed()) { refresh(true); }
    });
    window.setInterval(periodicRefresh, REFRESH_MS);
    window.setInterval(tick1s, TICK_MS);
    refresh(false);
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
