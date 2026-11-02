const LIGHT_TOKENS = `
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --surface-2: #f0efec;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #6b6a65;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11, 11, 11, 0.1);
  --accent: #2a78d6;
  --accent-ink: #1c5cab;
  --accent-wash: rgba(42, 120, 214, 0.1);
  --good: #0ca30c;
  --good-ink: #006300;
  --good-wash: rgba(12, 163, 12, 0.1);
  --warn: #fab219;
  --warn-ink: #7a4f00;
  --warn-wash: rgba(250, 178, 25, 0.16);
  --bad: #d03b3b;
  --bad-ink: #b02a2a;
  --bad-wash: rgba(208, 59, 59, 0.1);
  --neutral: #898781;
  --shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
`;

const DARK_TOKENS = `
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --surface-2: #252523;
  --ink: #f0efec;
  --ink-2: #c3c2b7;
  --muted: #a3a199;
  --grid: #2c2c2a;
  --axis: #4a4a46;
  --border: rgba(255, 255, 255, 0.1);
  --accent: #3987e5;
  --accent-ink: #86b6ef;
  --accent-wash: rgba(57, 135, 229, 0.16);
  --good-ink: #3fcf3f;
  --good-wash: rgba(12, 163, 12, 0.18);
  --warn-ink: #fab219;
  --warn-wash: rgba(250, 178, 25, 0.16);
  --bad-ink: #ef7d7d;
  --bad-wash: rgba(208, 59, 59, 0.2);
  --shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
`;

const BASE_RULES = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}
button, select, input { font: inherit; color: inherit; }
.top { position: sticky; top: 0; z-index: 20; background: var(--page); border-bottom: 1px solid var(--border); }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; max-width: 960px; margin: 0 auto; padding: 10px 16px 2px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 650; font-size: 17px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--neutral); flex: 0 0 auto; }
.dot.good { background: var(--good); }
.dot.bad { background: var(--bad); }
.updated { font-size: 12px; color: var(--muted); }
.icon-btn {
  min-width: 44px; min-height: 44px; border-radius: 22px; border: 1px solid var(--border);
  background: var(--surface); cursor: pointer; font-size: 18px; line-height: 1;
}
.tabs {
  display: flex; gap: 6px; overflow-x: auto; max-width: 960px; margin: 0 auto; padding: 6px 16px 10px;
  scrollbar-width: none; -webkit-overflow-scrolling: touch;
}
.tabs::-webkit-scrollbar { display: none; }
.tabs button {
  flex: 0 0 auto; min-height: 44px; padding: 0 16px; border-radius: 22px; border: 1px solid var(--border);
  background: var(--surface); color: var(--ink-2); font-size: 15px; cursor: pointer; white-space: nowrap;
}
.tabs button[aria-selected="true"] { background: var(--ink); color: var(--page); border-color: var(--ink); font-weight: 600; }
main { max-width: 960px; margin: 0 auto; padding: 12px 16px 56px; }
main.loading { opacity: 0.55; transition: opacity 0.2s; }
.filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 auto; max-width: 960px; padding: 0 16px 10px; }
.filters .wide { grid-column: 1 / -1; }
.filters:empty { display: none; }
.filters label, .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-2); min-width: 0; }
select, input {
  min-height: 44px; width: 100%; font-size: 16px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); color: var(--ink); padding: 0 10px;
}
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin: 0 0 12px; min-width: 0; }
.card h2 { font-size: 16px; margin: 0 0 4px; font-weight: 650; }
.card .hint { font-size: 13px; color: var(--ink-2); margin: 0 0 10px; }
.hero { border-left: 5px solid var(--neutral); }
.hero.good { border-left-color: var(--good); }
.hero.warn { border-left-color: var(--warn); }
.hero.bad { border-left-color: var(--bad); }
.headline { font-size: 18px; font-weight: 650; margin: 8px 0 0; line-height: 1.3; }
.figure { font-size: 48px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.05; margin: 10px 0 0; overflow-wrap: anywhere; }
.figure-unit { font-size: 14px; color: var(--ink-2); margin: 2px 0 0; }
.detail { color: var(--ink-2); font-size: 15px; margin: 10px 0 0; }
.subline { font-size: 13px; color: var(--ink-2); margin: 8px 0 0; font-variant-numeric: tabular-nums; }
.badge {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 3px 9px;
  border-radius: 999px; background: var(--surface-2); color: var(--ink-2); white-space: nowrap;
}
.badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.badge.good { background: var(--good-wash); color: var(--good-ink); }
.badge.warn { background: var(--warn-wash); color: var(--warn-ink); }
.badge.bad { background: var(--bad-wash); color: var(--bad-ink); }
.badge.info { background: var(--accent-wash); color: var(--accent-ink); }
.badges { display: flex; flex-wrap: wrap; gap: 6px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 12px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; min-width: 0; }
.stat .label { font-size: 13px; color: var(--ink-2); }
.stat .value { font-size: 20px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.stat .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
.pos { color: var(--good-ink); }
.neg { color: var(--bad-ink); }
.meter { height: 8px; border-radius: 4px; background: var(--accent-wash); overflow: hidden; margin: 10px 0 0; }
.meter > span { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 4px; }
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -4px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 10px 6px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
td:first-child { white-space: normal; overflow-wrap: anywhere; min-width: 64px; }
th { font-size: 12px; font-weight: 600; color: var(--ink-2); }
tr:last-child td { border-bottom: none; }
tr.cut td { background: var(--bad-wash); }
tr.scale td { background: var(--good-wash); }
tr.insufficient td { color: var(--muted); }
.chart { position: relative; height: 200px; touch-action: pan-y; outline: none; }
.chart.short { height: 120px; }
.chart svg { display: block; width: 100%; height: 100%; overflow: visible; }
.chart:focus-visible { box-shadow: 0 0 0 2px var(--accent); border-radius: 6px; }
.eq-line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.eq-area { fill: var(--accent-wash); stroke: none; }
.zero { stroke: var(--axis); stroke-width: 1; vector-effect: non-scaling-stroke; }
.bar-rect { fill: var(--accent); }
.bar-rect.dim { fill: var(--axis); }
.axis-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-top: 6px; font-variant-numeric: tabular-nums; }
.y-label { position: absolute; left: 0; font-size: 11px; color: var(--muted); background: var(--surface); padding: 0 4px 0 0; pointer-events: none; font-variant-numeric: tabular-nums; }
.y-label.top { top: 0; }
.y-label.bottom { bottom: 0; }
.crosshair { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--ink-2); pointer-events: none; display: none; }
.marker { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--surface); pointer-events: none; display: none; }
.tooltip {
  position: absolute; top: 4px; pointer-events: none; display: none; background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 9px; font-size: 12px; box-shadow: var(--shadow); white-space: nowrap; z-index: 2;
}
.tooltip strong { display: block; font-size: 14px; }
.list { margin: 0; padding: 0; list-style: none; }
.item { padding: 12px 0; border-bottom: 1px solid var(--grid); min-width: 0; }
.item:last-child { border-bottom: none; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.row + .row { margin-top: 4px; }
.meta { font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
.num { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; flex: 0 0 auto; }
.big-num { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; flex: 0 0 auto; }
.ext-link {
  display: inline-flex; align-items: center; min-height: 44px; flex: 0 0 auto; color: var(--accent-ink); font-size: 14px;
  font-weight: 600; text-decoration: none; white-space: nowrap;
}
.ext-link:hover, .ext-link:focus-visible { text-decoration: underline; }
.hero > .row h2 { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.title-btn {
  border: none; background: none; padding: 0; min-height: 44px; display: inline-flex; align-items: center; gap: 6px;
  font-weight: 650; font-size: 16px; color: var(--accent-ink); cursor: pointer; text-align: left; min-width: 0; overflow-wrap: anywhere;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
.btn {
  min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface);
  font-weight: 600; cursor: pointer;
}
.btn.primary { background: var(--accent); border-color: transparent; color: #ffffff; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 12px; }
.empty { text-align: center; padding: 28px 12px; color: var(--ink-2); }
.empty strong { display: block; color: var(--ink); font-size: 17px; margin-bottom: 6px; }
.error-text { color: var(--bad-ink); }
.split { display: grid; grid-template-columns: 1fr; gap: 12px; }
.kv { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; font-size: 14px; }
.kv dt { color: var(--ink-2); overflow-wrap: anywhere; }
.kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 12px; }
.sheet { position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, 0.45); display: flex; align-items: flex-end; justify-content: center; }
.panel {
  background: var(--surface); width: 100%; max-width: 640px; max-height: 88vh; overflow-y: auto; border-radius: 18px 18px 0 0;
  padding: 16px 16px 28px; box-shadow: var(--shadow);
}
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.chip { font-size: 12px; padding: 4px 9px; border-radius: 999px; background: var(--surface-2); color: var(--ink); overflow-wrap: anywhere; }
.chip.bad { background: var(--bad-wash); color: var(--bad-ink); }
.footer { text-align: center; font-size: 12px; color: var(--muted); padding: 8px 16px 32px; }
.footer button { border: none; background: none; color: var(--accent-ink); min-height: 44px; cursor: pointer; font-size: 13px; }
@media (min-width: 640px) {
  .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .split { grid-template-columns: 1fr 1fr; }
  .filters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .filters .wide { grid-column: auto; }
  .sheet { align-items: center; }
  .panel { border-radius: 18px; }
}
@media (max-width: 420px) {
  .hide-narrow { display: none; }
  .figure { font-size: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  main.loading { transition: none; }
}
`;

const LIVE_RULES = `
.live-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; margin: 0 0 12px; }
.live-chip { grid-column: 1 / -1; justify-self: start; white-space: normal; min-height: 32px; padding: 4px 12px; }
.live-chip.pulse::before { animation: live-pulse 1.6s ease-in-out infinite; }
@keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.card.empty.slim { padding: 16px 12px; font-size: 14px; }
.live-pos .row .title-btn { font-size: 17px; }
.chart.live-chart { height: 180px; margin: 10px 0 6px; touch-action: auto; }
.live-chart .chart-wait { margin: 0; padding-top: 72px; text-align: center; }
.lv-price { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.lv-entry, .lv-stop, .lv-trail, .lv-tp, .lv-open { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.lv-entry { stroke: var(--ink-2); stroke-dasharray: 6 5; }
.lv-stop { stroke: var(--bad); }
.lv-trail { stroke: var(--warn); }
.lv-tp { stroke: var(--good); }
.lv-open { stroke: var(--axis); stroke-dasharray: 2 4; }
.lv-label {
  position: absolute; right: 0; transform: translateY(-50%); font-size: 11px; font-weight: 600; padding: 0 4px; border-radius: 4px;
  background: var(--surface); pointer-events: none; white-space: nowrap; font-variant-numeric: tabular-nums;
}
.lv-label.lv-entry { color: var(--ink-2); }
.lv-label.lv-stop { color: var(--bad-ink); }
.lv-label.lv-trail { color: var(--warn-ink); }
.lv-label.lv-tp { color: var(--good-ink); }
.lv-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink-2); }
.lg { display: inline-flex; align-items: center; gap: 6px; }
.lg::before { content: ""; width: 16px; height: 0; border-top: 2px solid var(--axis); }
.lg-price::before { border-top-color: var(--accent); }
.lg-entry::before { border-top: 2px dashed var(--ink-2); }
.lg-stop::before { border-top-color: var(--bad); }
.lg-trail::before { border-top-color: var(--warn); }
.lg-tp::before { border-top-color: var(--good); }
.feed-item { border-left: 3px solid var(--axis); border-bottom: 1px solid var(--grid); min-width: 0; }
.feed-item:last-child { border-bottom: none; }
.feed-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; align-items: baseline; width: 100%; min-height: 44px;
  padding: 8px 4px 8px 10px; border: none; background: none; text-align: left; cursor: pointer;
}
.feed-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.feed-time { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.feed-kind { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-2); }
.feed-text { grid-column: 1 / -1; font-size: 14px; overflow-wrap: anywhere; min-width: 0; }
.feed-strategy {
  display: block; font-size: 11px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--accent-ink); overflow-wrap: anywhere;
}
.live-strategy { margin: 0 0 12px; }
.live-strategy:empty { display: none; }
.tone-good { border-left-color: var(--good); }
.tone-good .feed-kind { color: var(--good-ink); }
.tone-bad { border-left-color: var(--bad); }
.tone-bad .feed-kind { color: var(--bad-ink); }
.tone-warn { border-left-color: var(--warn); }
.tone-warn .feed-kind { color: var(--warn-ink); }
.tone-info { border-left-color: var(--accent); }
.tone-info .feed-kind { color: var(--accent-ink); }
.tone-neutral .feed-text { color: var(--ink-2); }
.card h3 { font-size: 14px; font-weight: 650; margin: 16px 0 6px; }
.lab-name { font-size: 16px; overflow-wrap: anywhere; min-width: 0; }
.big-num .unit { font-size: 12px; font-weight: 500; color: var(--ink-2); }
.lab-variant.baseline { background: var(--accent-wash); margin: 0 -16px; padding: 12px 16px; }
tr.main-row td { background: var(--accent-wash); }
tr.lane-row td { border-bottom: none; padding-bottom: 2px; }
tr.lane-detail td { text-align: left; white-space: normal; overflow-wrap: anywhere; padding-top: 0; }
.strategy-cell { min-width: 96px; }
.strategy-cell .link-btn { min-height: 32px; white-space: normal; text-align: left; }
.strategy-cell .badges { align-items: center; }
.show-narrow { display: none; }
@media (max-width: 420px) {
  .show-narrow { display: block; }
}
.link-btn {
  border: none; background: none; padding: 0; min-height: 44px; color: var(--accent-ink); font-weight: 600; font-size: 14px;
  cursor: pointer; flex: 0 0 auto; white-space: nowrap;
}
.bars .bar-row { padding: 8px 0; border-bottom: 1px solid var(--grid); }
.bars .bar-row:last-child { border-bottom: none; }
.bar-name { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.bar-track { height: 8px; border-radius: 4px; background: var(--surface-2); overflow: hidden; margin: 6px 0 4px; }
.bar-fill { display: block; height: 100%; width: 0; border-radius: 4px; background: var(--accent); }
@media (min-width: 640px) {
  .live-bar { grid-template-columns: auto minmax(0, 1fr) auto; }
  .live-chip { grid-column: auto; align-self: center; }
  .feed-row { grid-template-columns: 76px 70px minmax(0, 1fr); }
  .feed.multi .feed-row { grid-template-columns: 76px 128px minmax(0, 1fr); }
  .feed-text { grid-column: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .live-chip.pulse::before { animation: none; }
}
`;

export const DASHBOARD_CSS = `
:root {${LIGHT_TOKENS}}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS}}
}
:root[data-theme="dark"] {${DARK_TOKENS}}
${BASE_RULES}${LIVE_RULES}`;
