import { DASHBOARD_VIEW_CSS } from "./dashboardStyleViews.js";

const THEME_TOKENS = `
  color-scheme: dark;
  --page: #090909;
  --sidebar: #0b0b0b;
  --surface: #0f0f0f;
  --surface-2: #151515;
  --surface-3: #1c1c1c;
  --card-bg: linear-gradient(180deg, #131313 0%, #0e0e0e 100%);
  --ink: #f2f2f2;
  --ink-2: #a8a8a8;
  --muted: #7a7a7a;
  --faint: #545454;
  --line: #1c1c1c;
  --grid: #1e1e1e;
  --axis: #3a3a3a;
  --border: #262626;
  --border-strong: #3d3d3d;
  --accent: #f3c24b;
  --accent-ink: #f3c24b;
  --accent-wash: rgba(243, 194, 75, 0.1);
  --accent-line: rgba(243, 194, 75, 0.4);
  --on-accent: #111111;
  --good: #34d17f;
  --good-ink: #5ee39a;
  --good-wash: rgba(52, 209, 127, 0.11);
  --warn: #f59f43;
  --warn-ink: #ffb871;
  --warn-wash: rgba(245, 159, 67, 0.12);
  --bad: #f25c5c;
  --bad-ink: #ff8585;
  --bad-wash: rgba(242, 92, 92, 0.12);
  --info: #8b97ff;
  --info-ink: #aab3ff;
  --info-wash: rgba(139, 151, 255, 0.12);
  --neutral: #6f6f6f;
  --shadow: 0 18px 48px rgba(0, 0, 0, 0.6);
  --sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --s1: 4px;
  --s2: 8px;
  --s3: 12px;
  --s4: 16px;
  --s5: 20px;
  --s6: 24px;
  --s7: 32px;
  --r1: 4px;
  --r2: 6px;
  --r3: 10px;
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs-md: 13px;
  --fs-base: 14px;
  --fs-lg: 16px;
  --fs-xl: 20px;
  --fs-2xl: 26px;
  --fs-3xl: 36px;
  --gutter: 16px;
  --side-w: 236px;
  --top-h: 52px;
  --nav-h: 60px;
  --content-max: 1240px;
  --safe-b: env(safe-area-inset-bottom, 0px);
`;

const BASE_RULES = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; background: var(--page); }
body {
  margin: 0; min-height: 100vh; background: var(--page); color: var(--ink); font: 400 var(--fs-base)/1.5 var(--sans);
  letter-spacing: -0.005em; overflow-x: hidden; -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
}
button, select, input { font: inherit; color: inherit; }
button { -webkit-appearance: none; appearance: none; }
a { color: inherit; }
h1, h2, h3, p { margin: 0; }
a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.mono { font-family: var(--mono); font-size: var(--fs-md); overflow-wrap: anywhere; }
.num, .tnum { font-variant-numeric: tabular-nums; }
.pos { color: var(--good-ink); }
.neg { color: var(--bad-ink); }
.amber { color: var(--accent); }
.icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: 0 0 auto; }
.icon svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; overflow: visible; }
.icon .f { fill: currentColor; stroke: none; }
`;

const SHELL_RULES = `
.app { min-height: 100vh; }
.sidebar { display: none; }
.shell { min-width: 0; }
.topbar {
  position: sticky; top: 0; z-index: 30; background: rgba(9, 9, 9, 0.9); border-bottom: 1px solid var(--border); padding-top: env(safe-area-inset-top, 0px);
  -webkit-backdrop-filter: saturate(140%) blur(14px); backdrop-filter: saturate(140%) blur(14px);
}
.topbar-row {
  display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto; grid-template-rows: var(--top-h) auto;
  grid-template-areas: "brand mode . health actions" "ticker ticker ticker ticker ticker"; align-items: center; column-gap: var(--s2);
  max-width: var(--content-max); margin: 0 auto; padding: 0 var(--gutter);
}
.brand { display: inline-flex; align-items: baseline; gap: 7px; text-decoration: none; min-width: 0; }
.brand-top { grid-area: brand; min-height: 44px; align-items: center; }
.wordmark { font-size: 20px; font-weight: 800; letter-spacing: -1.1px; line-height: 1; color: var(--ink); }
.brand-sub { font: 500 10px/1 var(--mono); letter-spacing: 1.8px; text-transform: uppercase; color: var(--accent); }
.mode-badge { grid-area: mode; justify-self: start; font: 600 10.5px/1 var(--mono); letter-spacing: 1.2px; text-transform: uppercase; padding: 5px 8px; border-radius: var(--r1); border: 1px solid var(--border-strong); color: var(--ink-2); white-space: nowrap; }
.mode-badge:empty { display: none; }
.mode-badge.live { border-color: rgba(242, 92, 92, 0.55); color: var(--bad-ink); background: var(--bad-wash); }
.mode-badge.paper { border-color: var(--accent-line); color: var(--accent-ink); background: var(--accent-wash); }
.health { grid-area: health; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font: 500 var(--fs-sm)/1 var(--sans); color: var(--ink-2); white-space: nowrap; min-height: 32px; min-width: 20px; }
.health-text { display: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--neutral); flex: 0 0 auto; box-shadow: 0 0 0 3px rgba(111, 111, 111, 0.15); }
.dot.good { background: var(--good); box-shadow: 0 0 0 3px rgba(52, 209, 127, 0.16); }
.dot.bad { background: var(--bad); box-shadow: 0 0 0 3px rgba(242, 92, 92, 0.2); }
.spacer { display: none; }
.top-actions { grid-area: actions; display: flex; align-items: center; gap: 2px; margin-right: -8px; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; border-radius: var(--r2);
  border: 1px solid transparent; background: transparent; color: var(--ink-2); cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.icon-btn:hover { background: var(--surface-2); color: var(--ink); border-color: var(--border); }
.icon-btn .icon { width: 19px; height: 19px; }
.ticker { grid-area: ticker; display: flex; align-items: center; gap: var(--s4); padding: 0 0 10px; min-width: 0; overflow: hidden; font-variant-numeric: tabular-nums; }
.ticker:empty { display: none; }
.tick { display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; min-width: 0; }
.tick-label { font: 500 10px/1 var(--mono); letter-spacing: 1.2px; text-transform: uppercase; color: var(--muted); }
.tick-value { font: 600 var(--fs-md)/1.2 var(--mono); color: var(--ink); }
.tick-value.pos { color: var(--good-ink); }
.tick-value.neg { color: var(--bad-ink); }
.tick-sub { font: 500 var(--fs-sm)/1.2 var(--mono); color: var(--ink-2); }
.tick-flag { font: 600 10px/1 var(--mono); letter-spacing: 1px; text-transform: uppercase; color: var(--bad-ink); padding: 4px 6px; border-radius: var(--r1); background: var(--bad-wash); }
.alert { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; max-width: var(--content-max); margin: 0 auto; padding: 10px var(--gutter); background: var(--bad-wash); border-top: 1px solid rgba(242, 92, 92, 0.35); color: var(--ink); font-size: var(--fs-md); }
.alert:empty { display: none; }
.alert .icon { color: var(--bad-ink); }
.alert strong { color: var(--bad-ink); font-weight: 600; }
.alert-text { flex: 1 1 220px; min-width: 0; }
.alert-btn { border-color: var(--bad); color: var(--ink); min-height: 40px; }
.content { max-width: var(--content-max); margin: 0 auto; padding: var(--s4) var(--gutter) calc(var(--nav-h) + var(--safe-b) + 28px); }
.page-head { margin: 2px 0 var(--s4); min-width: 0; }
.page-head-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s3); min-width: 0; }
.page-title { font-size: var(--fs-xl); font-weight: 650; letter-spacing: -0.4px; line-height: 1.2; }
.page-desc { margin-top: 3px; font-size: var(--fs-md); color: var(--ink-2); }
.updated { font: 500 var(--fs-xs)/1.4 var(--mono); color: var(--muted); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 60%; }
main { min-width: 0; }
main.loading { opacity: 0.6; transition: opacity 0.2s; }
.filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s2); margin: 0 0 var(--s4); }
.filters .wide { grid-column: 1 / -1; }
.filters:empty { display: none; }
.footer { margin-top: var(--s7); padding: var(--s5) 0 0; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 16px; font: 500 var(--fs-xs)/1.6 var(--mono); color: var(--muted); }
.footer button { border: none; background: none; color: var(--accent-ink); min-height: 44px; padding: 0; cursor: pointer; font: inherit; }
.bottom-nav {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
  height: calc(var(--nav-h) + var(--safe-b)); padding-bottom: var(--safe-b); background: rgba(11, 11, 11, 0.94); border-top: 1px solid var(--border);
  -webkit-backdrop-filter: saturate(140%) blur(14px); backdrop-filter: saturate(140%) blur(14px);
}
.nav-tab {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 44px; min-width: 0;
  border: none; background: none; color: var(--muted); text-decoration: none; cursor: pointer; font: 500 10.5px/1 var(--sans); letter-spacing: 0.1px; padding: 0 2px;
  position: relative; transition: color 0.15s;
}
.nav-tab .icon { width: 21px; height: 21px; }
.nav-tab-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-tab[aria-current="page"], .nav-tab.active { color: var(--accent); }
.nav-tab[aria-current="page"]::before, .nav-tab.active::before { content: ""; position: absolute; top: 0; left: 28%; right: 28%; height: 2px; border-radius: 0 0 2px 2px; background: var(--accent); }
.side-brand { display: flex; align-items: baseline; gap: 8px; padding: 22px 20px 18px; }
.side-group { padding: 6px 12px; }
.side-label { padding: 12px 10px 6px; font: 500 10px/1 var(--mono); letter-spacing: 1.6px; text-transform: uppercase; color: var(--faint); }
.side-link {
  display: flex; align-items: center; gap: 11px; min-height: 44px; padding: 0 10px; border-radius: var(--r2); color: var(--ink-2); text-decoration: none;
  font-size: var(--fs-base); font-weight: 500; position: relative; transition: background 0.15s, color 0.15s;
}
.side-link:hover { background: var(--surface-2); color: var(--ink); }
.side-link[aria-current="page"] { background: var(--surface-3); color: var(--ink); }
.side-link[aria-current="page"]::before { content: ""; position: absolute; left: -12px; top: 11px; bottom: 11px; width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); }
.side-link[aria-current="page"] .icon { color: var(--accent); }
.side-foot { margin-top: auto; padding: 14px 20px 20px; border-top: 1px solid var(--line); font: 500 var(--fs-xs)/1.6 var(--mono); color: var(--muted); }
.more-list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; grid-template-columns: 1fr; gap: 4px; }
.more-link {
  display: grid; grid-template-columns: 36px minmax(0, 1fr); align-items: center; gap: 2px 12px; min-height: 56px; padding: 8px 10px; border-radius: var(--r2);
  color: var(--ink); text-decoration: none; border: 1px solid transparent;
}
.more-link:hover, .more-link[aria-current="page"] { background: var(--surface-3); border-color: var(--border); }
.more-link .icon { grid-row: span 2; width: 36px; height: 36px; padding: 8px; border-radius: 8px; background: var(--surface-3); color: var(--ink-2); }
.more-link[aria-current="page"] .icon { color: var(--accent); background: var(--accent-wash); }
.more-name { font-weight: 600; font-size: var(--fs-base); line-height: 1.3; }
.more-desc { font-size: var(--fs-sm); color: var(--muted); line-height: 1.35; }
@media (min-width: 640px) {
  :root { --gutter: 24px; }
  .filters { grid-template-columns: repeat(3, minmax(0, 1fr)); max-width: 760px; }
  .filters .wide { grid-column: auto; }
  .health-text { display: inline; }
  .more-list { grid-template-columns: 1fr 1fr; }
}
@media (min-width: 1024px) {
  .app { display: grid; grid-template-columns: var(--side-w) minmax(0, 1fr); background: linear-gradient(to right, var(--sidebar) calc(var(--side-w) - 1px), var(--border) calc(var(--side-w) - 1px), var(--border) var(--side-w), var(--page) var(--side-w)); }
  .sidebar { display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--sidebar); border-right: 1px solid var(--border); }
  .bottom-nav, .brand-top { display: none; }
  .content { padding: var(--s6) var(--gutter) var(--s7); }
  .topbar-row { grid-template-columns: auto auto minmax(0, 1fr) auto auto; grid-template-rows: 56px; grid-template-areas: "mode health . ticker actions"; column-gap: var(--s3); }
  .ticker { padding: 0 var(--s3) 0 0; gap: var(--s5); }
  .tick-value { font-size: var(--fs-base); }
  .page-title { font-size: 22px; }
}
`;

const COMPONENT_RULES = `
.card { background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--r3); padding: var(--s4); margin: 0 0 var(--s3); min-width: 0; }
.card > h2, .card-title { font-size: 15px; font-weight: 600; letter-spacing: -0.2px; line-height: 1.35; margin: 0 0 2px; }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s3); margin: 0 0 var(--s3); min-width: 0; }
.card-head > div { min-width: 0; }
.card .hint { font-size: var(--fs-md); color: var(--ink-2); margin: 2px 0 var(--s3); line-height: 1.5; }
.card-head .hint { margin-bottom: 0; }
.card h3 { font-size: var(--fs-md); font-weight: 600; color: var(--ink); margin: var(--s4) 0 var(--s2); }
.eyebrow { margin: 0 0 4px; font: 500 10.5px/1.5 var(--mono); letter-spacing: 1.6px; text-transform: uppercase; color: var(--accent); }
.section-label { font: 500 10.5px/1.5 var(--mono); letter-spacing: 1.4px; text-transform: uppercase; color: var(--muted); margin: var(--s5) 0 var(--s2); }
.hero { border-left: 3px solid var(--neutral); }
.hero.good { border-left-color: var(--good); }
.hero.warn { border-left-color: var(--warn); }
.hero.bad { border-left-color: var(--bad); }
.headline { font-size: 17px; font-weight: 600; margin: var(--s3) 0 0; line-height: 1.35; letter-spacing: -0.2px; }
.figure { font-size: var(--fs-3xl); font-weight: 600; letter-spacing: -1.4px; line-height: 1.05; margin: var(--s3) 0 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.figure-unit { font: 500 var(--fs-sm) var(--mono); color: var(--ink-2); margin: 6px 0 0; }
.detail { color: var(--ink-2); font-size: var(--fs-base); margin: var(--s2) 0 0; line-height: 1.55; }
.subline { font-size: var(--fs-md); color: var(--ink-2); margin: var(--s2) 0 0; font-variant-numeric: tabular-nums; line-height: 1.5; }
.badge {
  display: inline-flex; align-items: center; gap: 6px; font: 600 10px/1.4 var(--mono); letter-spacing: 0.9px; text-transform: uppercase;
  padding: 3px 8px; border-radius: 999px; background: var(--surface-3); color: var(--ink-2); white-space: nowrap; border: 1px solid transparent;
}
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge.good { background: var(--good-wash); color: var(--good-ink); }
.badge.warn { background: var(--warn-wash); color: var(--warn-ink); }
.badge.bad { background: var(--bad-wash); color: var(--bad-ink); }
.badge.info { background: var(--accent-wash); color: var(--accent-ink); }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--s2); }
.badges:empty { display: none; }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0 0 var(--s3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r3); overflow: hidden; }
.kpi { padding: 11px 10px 12px; min-width: 0; box-shadow: 1px 0 0 var(--border), 0 1px 0 var(--border); }
.kpi-label { font: 500 9.5px/1.3 var(--mono); letter-spacing: 1.1px; text-transform: uppercase; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi-value { font-size: 18px; font-weight: 600; letter-spacing: -0.5px; line-height: 1.2; margin-top: 6px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi-unit { font: 500 10.5px var(--mono); color: var(--muted); letter-spacing: 0; margin-left: 3px; }
.kpi-sub { font-size: 11.5px; color: var(--muted); margin-top: 3px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0 0 var(--s3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r3); overflow: hidden; }
.card .grid { margin: var(--s3) 0; }
.stat { padding: 12px; min-width: 0; box-shadow: 1px 0 0 var(--border), 0 1px 0 var(--border); }
.stat .label { font: 500 10px/1.4 var(--mono); letter-spacing: 1.1px; text-transform: uppercase; color: var(--muted); }
.stat .value { font-size: 17px; font-weight: 600; letter-spacing: -0.4px; margin-top: 4px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; line-height: 1.25; }
.stat .sub { font-size: var(--fs-sm); color: var(--muted); margin-top: 2px; line-height: 1.4; }
.meter { height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; margin: var(--s3) 0 0; }
.meter > span { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 3px; }
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 calc(-1 * var(--s4)); padding: 0 var(--s4); }
table { width: 100%; border-collapse: collapse; font-size: var(--fs-md); font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 9px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; vertical-align: middle; }
th:first-child, td:first-child { text-align: left; padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
td:first-child { white-space: normal; overflow-wrap: anywhere; min-width: 64px; }
th { font: 500 10px/1.3 var(--mono); letter-spacing: 1px; text-transform: uppercase; color: var(--muted); background: var(--surface); border-bottom-color: var(--border); }
tbody tr { transition: background 0.12s; }
tbody tr:hover td { background: rgba(255, 255, 255, 0.018); }
tr:last-child td { border-bottom: none; }
tr.cut td { background: var(--bad-wash); }
tr.scale td { background: var(--good-wash); }
tr.insufficient td { color: var(--muted); }
tr.current-size td { background: var(--accent-wash); }
.cell-main { display: block; }
.cell-sub { display: block; font-size: var(--fs-sm); color: var(--muted); margin-top: 1px; white-space: nowrap; }
td .cell-sub.pos { color: var(--good-ink); }
td .cell-sub.neg { color: var(--bad-ink); }
.list { margin: 0; padding: 0; list-style: none; }
.item { padding: 12px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.item:first-child { padding-top: 4px; }
.item:last-child { border-bottom: none; padding-bottom: 2px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.row + .row { margin-top: 3px; }
.meta { font-size: var(--fs-md); color: var(--ink-2); overflow-wrap: anywhere; min-width: 0; }
.big-num { font-size: 18px; font-weight: 650; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; white-space: nowrap; flex: 0 0 auto; }
.big-num .unit { font-size: var(--fs-sm); font-weight: 500; color: var(--ink-2); letter-spacing: 0; }
.ext-link {
  display: inline-flex; align-items: center; gap: 5px; min-height: 44px; flex: 0 0 auto; color: var(--ink-2); font-size: var(--fs-md);
  font-weight: 500; text-decoration: none; white-space: nowrap; transition: color 0.15s;
}
.ext-link .icon { width: 14px; height: 14px; }
.ext-link:hover, .ext-link:focus-visible { color: var(--accent-ink); }
.title-btn {
  border: none; background: none; padding: 0; min-height: 44px; display: inline-flex; align-items: center; gap: 6px; font-weight: 650; font-size: 15px;
  color: var(--ink); cursor: pointer; text-align: left; min-width: 0; overflow-wrap: anywhere; letter-spacing: -0.2px; transition: color 0.15s;
}
.title-btn:hover { color: var(--accent-ink); }
.title-btn.mono { font-family: var(--mono); font-weight: 500; font-size: var(--fs-md); }
.link-btn {
  border: none; background: none; padding: 0; min-height: 44px; color: var(--accent-ink); font-weight: 600; font-size: var(--fs-md);
  cursor: pointer; flex: 0 0 auto; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px;
}
.link-btn .icon { width: 15px; height: 15px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: var(--r2);
  border: 1px solid var(--border-strong); background: var(--surface-2); font-weight: 550; font-size: var(--fs-base); cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.btn:hover { border-color: #555555; background: var(--surface-3); }
.btn:disabled { opacity: 0.5; cursor: progress; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn.primary:hover { background: #f7cf6a; }
.btn.danger { border-color: rgba(242, 92, 92, 0.6); background: var(--bad-wash); color: var(--bad-ink); }
.btn.danger:hover { border-color: var(--bad); }
.btn.danger.armed { background: var(--bad); border-color: var(--bad); color: #160606; }
.btn.block { width: 100%; }
.actions { display: flex; flex-wrap: wrap; gap: var(--s2); margin: var(--s3) 0 0; }
.field { display: flex; flex-direction: column; gap: 5px; font: 500 10px/1.3 var(--mono); letter-spacing: 1px; text-transform: uppercase; color: var(--muted); min-width: 0; }
select, input {
  min-height: 44px; width: 100%; font-size: 16px; border-radius: var(--r2); border: 1px solid var(--border); background: var(--surface-2); color: var(--ink);
  padding: 0 12px; letter-spacing: 0; text-transform: none; font-family: var(--sans); transition: border-color 0.15s;
}
select:hover, input:hover { border-color: var(--border-strong); }
input::placeholder { color: var(--faint); }
.controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s2); margin: 0 0 var(--s4); max-width: 520px; }
.empty { text-align: center; padding: 32px 18px; color: var(--ink-2); font-size: var(--fs-md); line-height: 1.55; }
.empty-icon { display: inline-flex; width: 40px; height: 40px; padding: 10px; border-radius: 50%; background: var(--surface-3); color: var(--muted); margin-bottom: 10px; }
.empty strong { display: block; color: var(--ink); font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.empty .subline { margin-top: 10px; }
.card.empty.slim { padding: 20px 16px; }
.error-text { color: var(--bad-ink); }
.split { display: grid; grid-template-columns: 1fr; gap: var(--s3); }
.split > .card { margin: 0; }
.kv { display: grid; grid-template-columns: fit-content(58%) minmax(0, 1fr); margin: 0; font-size: var(--fs-md); }
.kv dt, .kv dd { padding: 7px 0; border-bottom: 1px solid var(--line); }
.kv dt { color: var(--ink-2); overflow-wrap: anywhere; padding-right: 12px; }
.kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; padding-left: 12px; color: var(--ink); }
.kv dt:last-of-type, .kv dd:last-of-type { border-bottom: none; }
.banner { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: var(--r3); border: 1px solid var(--border); background: var(--surface); margin: 0 0 var(--s3); font-size: var(--fs-md); line-height: 1.5; }
.banner .icon { margin-top: 1px; }
.banner.warn { border-color: rgba(245, 159, 67, 0.4); background: var(--warn-wash); }
.banner.warn .icon { color: var(--warn-ink); }
.banner.bad { border-color: rgba(242, 92, 92, 0.45); background: var(--bad-wash); }
.banner.bad .icon { color: var(--bad-ink); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: var(--s2) 0; }
.chip { font: 500 var(--fs-sm) var(--mono); padding: 3px 9px; border-radius: 999px; background: var(--surface-3); color: var(--ink); overflow-wrap: anywhere; }
.chip.bad { background: var(--bad-wash); color: var(--bad-ink); }
.sheet { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.62); display: flex; align-items: flex-end; justify-content: center; }
.panel {
  background: var(--surface); border: 1px solid var(--border); width: 100%; max-width: 640px; max-height: 86vh; overflow-y: auto;
  border-radius: 14px 14px 0 0; padding: 8px var(--s4) calc(24px + var(--safe-b)); box-shadow: var(--shadow);
}
.panel::before { content: ""; display: block; width: 36px; height: 4px; border-radius: 2px; background: var(--border-strong); margin: 0 auto 8px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; }
.panel-head h2 { font-size: var(--fs-lg); font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.muted-line { color: var(--muted); font-size: var(--fs-sm); }
.sheet-hint { margin: var(--s3) 0 0; font-size: var(--fs-md); color: var(--ink-2); }
.panel .badges { margin-top: var(--s3); }
.skeleton { display: grid; gap: var(--s3); }
.sk { border-radius: var(--r3); border: 1px solid var(--line); background: linear-gradient(90deg, #111111 0%, #181818 40%, #111111 80%); background-size: 200% 100%; animation: sk-shine 1.3s ease-in-out infinite; }
.sk-row { height: 74px; }
.sk-card { height: 180px; }
@keyframes sk-shine { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
@media (min-width: 640px) {
  .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .split { grid-template-columns: 1fr 1fr; }
  .sheet { align-items: center; }
  .panel { border-radius: 12px; padding-top: 14px; }
  .panel::before { display: none; }
  .card { padding: 18px 20px; }
  .table-wrap { margin: 0 -20px; padding: 0 20px; }
}
@media (min-width: 900px) {
  .kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .kpi { padding: 14px 16px 15px; }
  .kpi-value { font-size: 22px; }
  .kpi-label { font-size: 10px; }
}
@media (min-width: 1024px) {
  .table-wrap { overflow: visible; }
  thead th { position: sticky; top: 56px; z-index: 2; }
}
@media (max-width: 420px) {
  .hide-narrow { display: none; }
  .figure { font-size: 32px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
  .sk { animation: none; }
}
`;

export const DASHBOARD_CSS = `
:root {${THEME_TOKENS}}
${BASE_RULES}${SHELL_RULES}${COMPONENT_RULES}${DASHBOARD_VIEW_CSS}`;
