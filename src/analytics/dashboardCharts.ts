export const CHART_SCRIPT = String.raw`
  var CHART_SPAN = 1000;
  var CHART_TAG_GAP_PCT = 10;
  var CHART_TAG_MIN_PCT = 5;
  var CHART_TAG_MAX_PCT = 95;
  var CHART_GRID_CLEAR_PCT = 6;
  var CHART_EDGE_PCT = 7;
  var CHART_TONES = { accent: "#f3c24b", good: "#34d17f", bad: "#f25c5c" };
  var chartSeq = 0;

  function svgInto(box, markup) { box.innerHTML = markup; return box; }
  function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }
  function coord(value) { return clamp(isNum(value) ? value : 0, -CHART_SPAN, 2 * CHART_SPAN).toFixed(1); }
  function pctOf(value) { return (clamp(isNum(value) ? value : 0, 0, CHART_SPAN) / 10).toFixed(2) + "%"; }
  function nextGradientId() { chartSeq += 1; return "cgrad" + chartSeq; }
  function svgOpen() { return "<svg viewBox=\"0 0 1000 1000\" preserveAspectRatio=\"none\" aria-hidden=\"true\" focusable=\"false\">"; }
  function gradientDefs(id, tone, strength) {
    var color = CHART_TONES[tone] || CHART_TONES.accent;
    var top = clamp(Number(strength) || 0.25, 0, 1).toFixed(2);
    return "<defs><linearGradient id=\"" + id + "\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">" +
      "<stop offset=\"0\" stop-color=\"" + color + "\" stop-opacity=\"" + top + "\"></stop>" +
      "<stop offset=\"0.7\" stop-color=\"" + color + "\" stop-opacity=\"" + (Number(top) * 0.25).toFixed(3) + "\"></stop>" +
      "<stop offset=\"1\" stop-color=\"" + color + "\" stop-opacity=\"0\"></stop></linearGradient></defs>";
  }
  function hLine(cls, yValue) { return "<line class=\"" + cls + "\" x1=\"0\" x2=\"1000\" y1=\"" + coord(yValue) + "\" y2=\"" + coord(yValue) + "\"></line>"; }
  function vLine(cls, xValue) { return "<line class=\"" + cls + "\" x1=\"" + coord(xValue) + "\" x2=\"" + coord(xValue) + "\" y1=\"0\" y2=\"1000\"></line>"; }
  function pathD(xs, ys) { return xs.map(function (xv, i) { return (i ? "L" : "M") + coord(xv) + " " + coord(ys[i]); }).join(" "); }
  function areaD(xs, ys) { return pathD(xs, ys) + " L" + coord(xs[xs.length - 1]) + " 1000 L" + coord(xs[0]) + " 1000 Z"; }

  function niceStep(span, count) {
    var raw = span / Math.max(1, count);
    if (!(raw > 0) || !isFinite(raw)) { return 1; }
    var power = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var options = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < options.length; i += 1) { if (power * options[i] >= raw * 0.999) { return power * options[i]; } }
    return power * 10;
  }
  function niceTicks(lo, hi, count) {
    var step = niceStep(hi - lo, count);
    var ticks = [];
    for (var v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9 && ticks.length < 50; v += step) { ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v); }
    return { step: step, ticks: ticks };
  }
  function stepDecimals(step) {
    for (var d = 0; d < 7; d += 1) { var scaled = step * Math.pow(10, d); if (Math.abs(Math.round(scaled) - scaled) < 1e-6) { return d; } }
    return 6;
  }
  function fmtTick(value, step, signed) {
    if (Math.abs(value) < step * 1e-6) { return "0"; }
    var text = Math.abs(value).toFixed(stepDecimals(step));
    if (value < 0) { return "-" + text; }
    return signed ? "+" + text : text;
  }
  function multipleTicks(lo, hi, maxTicks) {
    if (!(lo > 0) || !(hi > lo)) { return []; }
    var minGap = (Math.log(hi) - Math.log(lo)) / (maxTicks + 1);
    var picked = [];
    MULT_NICE.forEach(function (m) {
      if (picked.length >= maxTicks || m < lo || m > hi) { return; }
      for (var i = 0; i < picked.length; i += 1) { if (Math.abs(Math.log(m) - Math.log(picked[i])) < minGap) { return; } }
      picked.push(m);
    });
    return picked.sort(function (a, b) { return a - b; });
  }
  var MULT_NICE = [1, 2, 0.5, 10, 5, 3, 1.5, 4, 20, 0.25, 0.75, 1.25, 2.5, 50, 100, 0.1, 30, 15, 8, 6, 0.8, 0.6, 0.4, 0.9, 0.7, 1.75, 0.3, 0.2, 12, 25, 40, 75, 1.1, 1.2, 1.3, 1.4, 1.6, 1.8, 0.85, 0.95, 1.05, 0.05];
  var TIME_STEPS_SEC = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
  function timeTicks(startMs, endMs, originMs, maxTicks) {
    var spanSec = Math.max(1, (endMs - startMs) / 1000);
    var step = TIME_STEPS_SEC[TIME_STEPS_SEC.length - 1];
    for (var i = 0; i < TIME_STEPS_SEC.length; i += 1) { if (spanSec / TIME_STEPS_SEC[i] <= maxTicks) { step = TIME_STEPS_SEC[i]; break; } }
    var ticks = [];
    for (var sec = Math.ceil((startMs - originMs) / 1000 / step) * step; originMs + sec * 1000 <= endMs && ticks.length < 20; sec += step) {
      ticks.push({ atMs: originMs + sec * 1000, sec: sec });
    }
    return ticks;
  }
  function fmtClock(sec) {
    if (!isNum(sec)) { return DASH; }
    var safe = Math.abs(Math.round(sec));
    var sign = sec < -0.5 ? "−" : "";
    if (safe >= 3600) { var h = Math.floor(safe / 3600); var m = Math.floor((safe % 3600) / 60); return sign + h + "h" + (m < 10 ? "0" : "") + m; }
    var mm = Math.floor(safe / 60);
    var ss = safe % 60;
    return sign + mm + ":" + (ss < 10 ? "0" : "") + ss;
  }
  function spreadTags(spots) {
    var sorted = spots.slice().sort(function (a, b) { return a.top - b.top; });
    function spread() {
      for (var i = 0; i < sorted.length; i += 1) {
        var floor = i ? sorted[i - 1].top + CHART_TAG_GAP_PCT : CHART_TAG_MIN_PCT;
        sorted[i].top = Math.max(sorted[i].top, floor);
      }
    }
    spread();
    var overflow = sorted.length ? sorted[sorted.length - 1].top - CHART_TAG_MAX_PCT : 0;
    if (overflow > 0) {
      sorted.forEach(function (spot) { spot.top -= overflow; });
      sorted[0].top = Math.max(sorted[0].top, CHART_TAG_MIN_PCT);
      spread();
    }
    return sorted;
  }

  function chartFrame(kind, ariaLabel, gutter) {
    var f = {
      box: el("div", { class: "chart " + kind + (gutter === false ? " no-gutter" : ""), role: "img", tabindex: "0", "aria-label": ariaLabel }),
      plot: el("div", { class: "chart-plot" }),
      art: el("div", { class: "chart-art" }),
      marks: el("div", { class: "chart-marks" }),
      vline: el("div", { class: "chart-vline" }),
      hline: el("div", { class: "chart-hline" }),
      dot: el("div", { class: "chart-dot" }),
      gutter: el("div", { class: "chart-gutter" }),
      tags: el("div", { class: "chart-tags" }),
      ytag: el("span", { class: "chart-ytag" }),
      xaxis: el("div", { class: "chart-x" }),
      tip: el("div", { class: "tooltip" }),
      api: null, hover: null, current: -1
    };
    f.plot.append(f.art, f.marks, f.hline, f.vline, f.dot);
    f.gutter.append(f.tags, f.ytag);
    f.box.append(f.plot, f.gutter, f.xaxis, f.tip);
    return f;
  }
  function chartXLabels(f, items) {
    f.xaxis.replaceChildren();
    items.forEach(function (item) {
      var edge = item.x < CHART_EDGE_PCT * 10 ? " first" : item.x > CHART_SPAN - CHART_EDGE_PCT * 10 ? " last" : "";
      var node = el("span", { class: "chart-xlab" + edge, text: item.text });
      node.style.left = pctOf(item.x);
      f.xaxis.append(node);
    });
  }
  function chartGutter(f, grid, tags) {
    var placed = spreadTags(tags);
    var nodes = [];
    grid.forEach(function (item) {
      var top = clamp(item.y, 0, CHART_SPAN) / 10;
      if (top < 3 || top > 97) { return; }
      for (var i = 0; i < placed.length; i += 1) { if (Math.abs(placed[i].top - top) < CHART_GRID_CLEAR_PCT) { return; } }
      var node = el("span", { class: "chart-ylab", text: item.text });
      node.style.top = top.toFixed(2) + "%";
      nodes.push(node);
    });
    placed.forEach(function (spot) {
      var node = el("span", { class: spot.cls, text: spot.text });
      node.style.top = spot.top.toFixed(2) + "%";
      nodes.push(node);
    });
    f.tags.replaceChildren();
    append(f.tags, nodes);
    return placed;
  }
  function chartMark(cls, xValue, yValue, text) {
    var node = el("span", { class: cls, text: text || null });
    node.style.left = pctOf(xValue);
    node.style.top = pctOf(yValue);
    return node;
  }
  function placeTip(f, fraction) {
    var width = f.box.clientWidth || 0;
    var plotWidth = f.plot.clientWidth || width;
    var tipWidth = f.tip.offsetWidth || 0;
    var x = fraction * plotWidth;
    var left = x + 14 + tipWidth <= plotWidth ? x + 14 : x - 14 - tipWidth;
    f.tip.style.left = Math.max(0, Math.min(Math.max(0, width - tipWidth), left)) + "px";
  }
  function chartHide(f) {
    [f.vline, f.hline, f.dot, f.ytag, f.tip].forEach(function (node) { node.style.display = "none"; });
  }
  function chartShowAt(f, xValue, yValue, rows, tagText) {
    f.vline.style.display = "block";
    f.vline.style.left = pctOf(xValue);
    f.hline.style.display = "block";
    f.hline.style.top = pctOf(yValue);
    f.dot.style.display = "block";
    f.dot.style.left = pctOf(xValue);
    f.dot.style.top = pctOf(yValue);
    if (tagText) {
      f.ytag.style.display = "block";
      f.ytag.style.top = pctOf(yValue);
      f.ytag.textContent = tagText;
    } else {
      f.ytag.style.display = "none";
    }
    f.tip.replaceChildren();
    append(f.tip, rows);
    f.tip.style.display = "block";
    placeTip(f, clamp(xValue, 0, CHART_SPAN) / CHART_SPAN);
  }
  function chartNearest(f, fraction) {
    var size = f.api ? f.api.size() : 0;
    if (!size) { return -1; }
    var target = fraction * CHART_SPAN;
    var lo = 0;
    var hi = size - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (f.api.x(mid) < target) { lo = mid + 1; } else { hi = mid; } }
    if (lo > 0 && Math.abs(f.api.x(lo - 1) - target) <= Math.abs(f.api.x(lo) - target)) { return lo - 1; }
    return lo;
  }
  function chartPick(f, index) {
    if (!f.api || index < 0 || index >= f.api.size()) { return; }
    f.current = index;
    f.api.show(index);
  }
  function chartRefresh(f) {
    if (!f.api || !f.api.size()) { chartHide(f); return; }
    if (f.hover !== null) { chartPick(f, chartNearest(f, f.hover)); return; }
    if (f.current >= 0 && document.activeElement === f.box) { chartPick(f, Math.min(f.current, f.api.size() - 1)); }
  }
  function chartBind(f, api) {
    f.api = api;
    if (f.bound) { chartRefresh(f); return; }
    f.bound = true;
    function fromEvent(event) {
      var rect = f.plot.getBoundingClientRect();
      return rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 1;
    }
    function onPointer(event) { f.hover = fromEvent(event); chartPick(f, chartNearest(f, f.hover)); }
    f.plot.addEventListener("pointermove", onPointer);
    f.plot.addEventListener("pointerdown", onPointer);
    f.plot.addEventListener("pointerleave", function (event) { if (event.pointerType === "mouse") { f.hover = null; f.current = -1; chartHide(f); } });
    f.box.addEventListener("focus", function () { if (f.hover === null && f.api) { chartPick(f, f.api.size() - 1); } });
    f.box.addEventListener("blur", function () { f.hover = null; f.current = -1; chartHide(f); });
    f.box.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { f.hover = null; chartHide(f); return; }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") { return; }
      event.preventDefault();
      var size = f.api ? f.api.size() : 0;
      if (!size) { return; }
      f.hover = null;
      chartPick(f, clamp(f.current < 0 ? size - 1 : f.current + (event.key === "ArrowRight" ? 1 : -1), 0, size - 1));
    });
  }

  function equityChart(points) {
    var last = points[points.length - 1];
    var lastIndex = last.index || 1;
    var lo = 0;
    var hi = 0;
    points.forEach(function (point) { lo = Math.min(lo, point.equitySol); hi = Math.max(hi, point.equitySol); });
    if (hi - lo < 1e-9) { hi += 0.001; lo -= 0.001; }
    var pad = (hi - lo) * 0.08;
    hi += pad;
    lo -= pad;
    var ticks = niceTicks(lo, hi, 4);
    function y(value) { return ((hi - value) / (hi - lo)) * CHART_SPAN; }
    var xs = points.map(function (point) { return (point.index / lastIndex) * CHART_SPAN; });
    var ys = points.map(function (point) { return y(point.equitySol); });
    var tone = last.equitySol < 0 ? "bad" : "accent";
    var f = chartFrame("equity-chart", "Equity curve over " + lastIndex + " trades, ending at " + fmtSol(last.equitySol) + " SOL", true);
    var id = nextGradientId();
    var svg = [svgOpen(), gradientDefs(id, tone, 0.3)];
    ticks.ticks.forEach(function (tick) { svg.push(hLine("cg", y(tick))); });
    svg.push(hLine("zero", y(0)));
    svg.push("<path class=\"eq-area\" fill=\"url(#" + id + ")\" d=\"" + areaD(xs, ys) + "\"></path>");
    svg.push("<path class=\"eq-line" + (tone === "bad" ? " neg-line" : "") + "\" d=\"" + pathD(xs, ys) + "\"></path></svg>");
    svgInto(f.art, svg.join(""));
    chartGutter(f, ticks.ticks.map(function (tick) { return { y: y(tick), text: fmtTick(tick, ticks.step, true) }; }),
      [{ top: ys[ys.length - 1] / 10, cls: "eq-now", text: fmtSol(last.equitySol) }]);
    var xt = niceTicks(0, lastIndex, 5);
    chartXLabels(f, xt.ticks.filter(function (tick) { return tick >= 1 && Math.round(tick) === tick; }).map(function (tick) {
      return { x: (tick / lastIndex) * CHART_SPAN, text: "#" + fmtInt(tick) };
    }));
    f.marks.replaceChildren(chartMark("now-dot" + (tone === "bad" ? " neg" : ""), xs[xs.length - 1], ys[ys.length - 1]));
    chartBind(f, {
      size: function () { return points.length; },
      x: function (i) { return xs[i]; },
      show: function (i) {
        var point = points[i];
        chartShowAt(f, xs[i], ys[i], [
          el("strong", { class: signClass(point.equitySol), text: fmtSol(point.equitySol) + " SOL" }),
          el("div", { text: point.index ? "Trade #" + point.index + DOT + fmtTime(point.atMs) : "Start" }),
          point.index ? el("div", { class: "tt-muted", text: "This trade " + fmtSol(point.pnlSol) + DOT + "drawdown " + fmtSol(point.drawdownSol, false) }) : null
        ], fmtSol(point.equitySol));
      }
    });
    return f.box;
  }

  function barChart(items, valueOf, labelOf, unit, tickOf) {
    var max = 0;
    items.forEach(function (item) { max = Math.max(max, valueOf(item)); });
    var f = chartFrame("bar-chart short", "Bar chart, peak " + fmtInt(max) + " " + unit, true);
    var ticks = niceTicks(0, max > 0 ? max : 1, 3);
    var top = Math.max(ticks.ticks[ticks.ticks.length - 1] || 1, max > 0 ? max : 1);
    var slot = CHART_SPAN / Math.max(1, items.length);
    var gap = Math.min(slot * 0.18, 6);
    function y(value) { return CHART_SPAN - (value / top) * (CHART_SPAN - 20); }
    var svg = [svgOpen()];
    ticks.ticks.forEach(function (tick) { if (tick > 0) { svg.push(hLine("cg", y(tick))); } });
    items.forEach(function (item, i) {
      var value = valueOf(item);
      var height = value > 0 ? Math.max(4, CHART_SPAN - y(value)) : 4;
      svg.push("<rect class=\"bar-rect" + (value > 0 ? "" : " dim") + "\" x=\"" + coord(i * slot + gap / 2) + "\" y=\"" + coord(CHART_SPAN - height) +
        "\" width=\"" + coord(Math.max(1, slot - gap)) + "\" height=\"" + coord(height) + "\"></rect>");
    });
    svg.push("</svg>");
    svgInto(f.art, svg.join(""));
    chartGutter(f, ticks.ticks.filter(function (tick) { return tick > 0; }).map(function (tick) { return { y: y(tick), text: fmtInt(tick) }; }), []);
    if (items.length) {
      var picks = items.length > 2 ? [0, Math.floor((items.length - 1) / 2), items.length - 1] : items.map(function (_, i) { return i; });
      chartXLabels(f, picks.map(function (i) { return { x: (i + 0.5) * slot, text: tickOf ? tickOf(items[i]) : labelOf(items[i]) }; }));
    }
    if (max === 0) { return [f.box, el("p", { class: "hint", text: "Nothing recorded in this window. If this lasts, check the websocket." })]; }
    chartBind(f, {
      size: function () { return items.length; },
      x: function (i) { return (i + 0.5) * slot; },
      show: function (i) {
        var item = items[i];
        chartShowAt(f, (i + 0.5) * slot, y(valueOf(item)), [el("strong", { text: fmtInt(valueOf(item)) + " " + unit }), el("div", { class: "tt-muted", text: labelOf(item) })], fmtInt(valueOf(item)));
      }
    });
    return f.box;
  }

  function labHistoryChart(history) {
    var points = history.filter(function (point) { return isNum(point.expectancySol); });
    if (points.length < 2) { return null; }
    var lo = 0;
    var hi = 0;
    points.forEach(function (point) {
      [point.expectancySol, point.ciLowSol, point.ciHighSol].forEach(function (value) { if (isNum(value)) { lo = Math.min(lo, value); hi = Math.max(hi, value); } });
    });
    if (hi - lo < 1e-9) { hi += 0.001; lo -= 0.001; }
    var pad = (hi - lo) * 0.1;
    hi += pad;
    lo -= pad;
    var ticks = niceTicks(lo, hi, 4);
    function y(value) { return ((hi - value) / (hi - lo)) * CHART_SPAN; }
    var inset = 40;
    var xs = points.map(function (_, i) { return inset + (i / (points.length - 1)) * (CHART_SPAN - 2 * inset); });
    var ys = points.map(function (point) { return y(point.expectancySol); });
    var banded = points.every(function (point) { return isNum(point.ciLowSol) && isNum(point.ciHighSol); });
    var f = chartFrame("lab-chart", "Baseline expectancy over " + points.length + " lab runs", true);
    var svg = [svgOpen()];
    ticks.ticks.forEach(function (tick) { svg.push(hLine("cg", y(tick))); });
    svg.push(hLine("zero", y(0)));
    if (banded) {
      var upper = pathD(xs, points.map(function (point) { return y(point.ciHighSol); }));
      var lower = xs.slice().reverse().map(function (xv, i) { return "L" + coord(xv) + " " + coord(y(points[points.length - 1 - i].ciLowSol)); }).join(" ");
      svg.push("<path class=\"ci-band\" d=\"" + upper + " " + lower + " Z\"></path>");
    }
    svg.push("<path class=\"lab-line\" d=\"" + pathD(xs, ys) + "\"></path></svg>");
    svgInto(f.art, svg.join(""));
    chartGutter(f, ticks.ticks.map(function (tick) { return { y: y(tick), text: fmtTick(tick, ticks.step, true) }; }), []);
    var every = Math.max(1, Math.ceil(points.length / 6));
    chartXLabels(f, points.map(function (point, i) { return { i: i, point: point }; }).filter(function (item) { return item.i % every === 0 || item.i === points.length - 1; }).map(function (item) {
      return { x: xs[item.i], text: "#" + item.point.labRunId };
    }));
    f.marks.replaceChildren();
    append(f.marks, points.map(function (_, i) { return chartMark("pt-mark", xs[i], ys[i]); }));
    chartBind(f, {
      size: function () { return points.length; },
      x: function (i) { return xs[i]; },
      show: function (i) {
        var point = points[i];
        chartShowAt(f, xs[i], ys[i], [
          el("strong", { class: signClass(point.expectancySol), text: fmtSol(point.expectancySol) + " SOL/trade" }),
          el("div", { text: "Lab run #" + point.labRunId + DOT + fmtDay(point.startedAtMs) }),
          el("div", { class: "tt-muted", text: (isNum(point.ciLowSol) && isNum(point.ciHighSol) ? "95% " + fmtSol(point.ciLowSol) + " to " + fmtSol(point.ciHighSol) + DOT : "") + fmtInt(point.trades) + " trades" })
        ], fmtSol(point.expectancySol));
      }
    });
    return f.box;
  }
`;
