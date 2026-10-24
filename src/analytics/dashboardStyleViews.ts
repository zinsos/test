const CHART_RULES = `
.chart { position: relative; height: 220px; outline: none; user-select: none; -webkit-user-select: none; }
.chart.short { height: 150px; }
.chart:focus-visible { box-shadow: 0 0 0 2px var(--accent); border-radius: var(--r2); }
.chart-plot { position: absolute; left: 0; top: 0; right: 72px; bottom: 22px; touch-action: pan-y; cursor: crosshair; }
.chart.no-gutter .chart-plot, .chart.no-gutter .chart-x { right: 0; }
.chart-art { position: absolute; inset: 0; }
.chart-art svg { display: block; width: 100%; height: 100%; overflow: visible; }
.chart-gutter { position: absolute; top: 0; right: 0; bottom: 22px; width: 72px; border-left: 1px solid var(--line); }
.chart.no-gutter .chart-gutter { display: none; }
.chart-x { position: absolute; left: 0; right: 72px; bottom: 0; height: 22px; border-top: 1px solid var(--line); }
.chart-xlab { position: absolute; top: 5px; transform: translateX(-50%); font: 500 10px/1 var(--mono); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.chart-xlab.first { transform: none; }
.chart-xlab.last { transform: translateX(-100%); }
.chart-ylab { position: absolute; left: 8px; transform: translateY(-50%); font: 500 10px/1 var(--mono); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.chart-tags, .chart-marks { position: absolute; inset: 0; pointer-events: none; }
.chart-marks { overflow: visible; }
.chart-wait { position: absolute; inset: 0 72px 22px 0; display: flex; align-items: center; justify-content: center; text-align: center; font-size: var(--fs-md); color: var(--muted); }
.chart-wait[hidden] { display: none; }
.cg { stroke: var(--grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
.cg-v { stroke: #161616; }
.zero { stroke: var(--axis); stroke-width: 1; stroke-dasharray: 3 4; vector-effect: non-scaling-stroke; }
.eq-line, .lv-price, .lab-line { fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.eq-area, .lv-area { stroke: none; }
.eq-line.neg-line { stroke: var(--bad); }
.ci-band { fill: var(--accent-wash); stroke: none; }
.bar-rect { fill: var(--accent); opacity: 0.85; }
.bar-rect.dim { fill: var(--axis); opacity: 1; }
.lv-entry, .lv-stop, .lv-trail, .lv-tp, .lv-open { fill: none; stroke-width: 1; vector-effect: non-scaling-stroke; }
.lv-entry { stroke: #8a8a8a; stroke-dasharray: 5 4; }
.lv-stop { stroke: var(--bad); stroke-dasharray: 2 3; }
.lv-trail { stroke: var(--info); stroke-dasharray: 6 3; }
.lv-tp { stroke: var(--good); stroke-dasharray: 2 3; }
.lv-open { stroke: #3a3a3a; stroke-dasharray: 2 3; }
.lv-label, .lv-now, .chart-ytag, .eq-now {
  position: absolute; right: 2px; min-width: 64px; transform: translateY(-50%); font: 600 10px/16px var(--sans); letter-spacing: 0; padding: 0 5px; border-radius: 3px;
  white-space: nowrap; font-variant-numeric: tabular-nums; background: var(--surface); border: 1px solid var(--border-strong); color: var(--ink-2); z-index: 1;
}
.lv-label.lv-entry { color: #c4c4c4; border-color: #4a4a4a; }
.lv-label.lv-stop { color: var(--bad-ink); border-color: rgba(242, 92, 92, 0.55); background: #170c0c; }
.lv-label.lv-trail { color: var(--info-ink); border-color: rgba(139, 151, 255, 0.55); background: #0f1018; }
.lv-label.lv-tp { color: var(--good-ink); border-color: rgba(52, 209, 127, 0.5); background: #0b150f; }
.lv-now, .eq-now { background: var(--accent); border-color: var(--accent); color: var(--on-accent); z-index: 1; }
.lv-now.neg { background: var(--bad); border-color: var(--bad); color: #170707; }
.lv-now.pos { background: var(--good); border-color: var(--good); color: #06150c; }
.chart-ytag { display: none; background: #2a2a2a; border-color: #555555; color: var(--ink); z-index: 3; }
.chart-vline, .chart-hline { position: absolute; pointer-events: none; display: none; }
.chart-vline { top: 0; bottom: 0; width: 0; border-left: 1px dashed #6a6a6a; }
.chart-hline { left: 0; right: 0; height: 0; border-top: 1px dashed #4f4f4f; }
.chart-dot { position: absolute; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; border-radius: 50%; background: var(--ink); box-shadow: 0 0 0 3px rgba(242, 242, 242, 0.18); pointer-events: none; display: none; z-index: 3; }
.now-dot { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: var(--accent); z-index: 2; }
.now-dot::after { content: ""; position: absolute; inset: -6px; border-radius: 50%; border: 1.5px solid var(--accent); opacity: 0; animation: now-pulse 1.8s ease-out infinite; }
.now-dot.neg { background: var(--bad); }
.now-dot.neg::after { border-color: var(--bad); }
.now-dot.pos { background: var(--good); }
.now-dot.pos::after { border-color: var(--good); }
@keyframes now-pulse { 0% { transform: scale(0.5); opacity: 0.9; } 100% { transform: scale(1.6); opacity: 0; } }
.fill-mark {
  position: absolute; width: 17px; height: 17px; margin: -8.5px 0 0 -8.5px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font: 700 9px/1 var(--mono); z-index: 2; border: 1.5px solid var(--page);
}
.fill-mark.buy { background: var(--good); color: #04130a; }
.fill-mark.sell { background: var(--bad); color: #190606; }
.pt-mark { position: absolute; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: var(--accent); border: 1.5px solid var(--page); }
.tooltip {
  position: absolute; top: 6px; pointer-events: none; display: none; background: rgba(20, 20, 20, 0.96); border: 1px solid var(--border-strong);
  border-radius: var(--r2); padding: 7px 10px; font-size: var(--fs-sm); box-shadow: var(--shadow); white-space: nowrap; z-index: 5; line-height: 1.5;
}
.tooltip strong { display: block; font-size: var(--fs-base); font-weight: 650; font-variant-numeric: tabular-nums; }
.tooltip .tt-muted { color: var(--muted); }
.tooltip .tt-fill { color: var(--accent-ink); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font: 500 10.5px/1.6 var(--mono); color: var(--muted); }
.lg { display: inline-flex; align-items: center; gap: 6px; }
.lg::before { content: ""; width: 14px; height: 0; border-top: 2px solid var(--axis); }
.lg-price::before { border-top-color: var(--accent); }
.lg-entry::before { border-top: 1px dashed #8a8a8a; }
.lg-stop::before { border-top: 1px dashed var(--bad); }
.lg-trail::before { border-top: 1px dashed var(--info); }
.lg-tp::before { border-top: 1px dashed var(--good); }
.lg-buy::before, .lg-sell::before { width: 9px; height: 9px; border: none; border-radius: 50%; background: var(--good); }
.lg-sell::before { background: var(--bad); }
@media (min-width: 900px) {
  .chart { height: 240px; }
  .chart.live-chart { height: 250px; }
  .chart.short { height: 160px; }
}
@media (prefers-reduced-motion: reduce) {
  .now-dot::after { animation: none; opacity: 0; }
}
`;

const OVERVIEW_RULES = `
.run-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin: 0 0 var(--s3); min-width: 0; }
.run-title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.run-title h2 { font-size: var(--fs-lg); font-weight: 650; letter-spacing: -0.3px; }
.run-meta { font-size: var(--fs-sm); color: var(--muted); width: 100%; }
.run-pick { margin-top: var(--s3); min-width: 0; }
.ov-grid { display: flex; flex-direction: column; }
.ov-col { display: contents; }
.ov-open { order: 1; }
.ov-wallet { order: 2; }
.ov-closed { order: 3; }
.ov-tips { order: 4; }
.ov-run { order: 5; }
.ov-activity { order: 6; }
.wallet-card { border-color: #33301f; background: linear-gradient(180deg, #15130d 0%, #0e0e0e 70%); }
.wallet-figure { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; margin: 6px 0 2px; }
.wallet-figure .figure { margin: 0; font-size: 30px; }
.wallet-figure .figure-unit { margin: 0; }
.wallet-card .kv { margin-top: var(--s3); }
.wallet-note { font-size: var(--fs-sm); color: var(--ink-2); margin-top: var(--s2); }
.pos-list { display: grid; gap: var(--s2); }
.ov-section { margin: 0 0 var(--s3); min-width: 0; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 0 0 var(--s2); padding: 0 2px; }
.section-head h2 { font-size: 15px; font-weight: 600; letter-spacing: -0.2px; }
.section-head .hint { font-size: var(--fs-sm); color: var(--muted); }
.footnote { font-size: var(--fs-sm); color: var(--muted); line-height: 1.5; margin: var(--s2) 2px 0; }
.pos-card { border: 1px solid var(--border); border-radius: var(--r3); background: var(--surface); padding: 12px 14px; min-width: 0; }
.pos-card.pending { border-style: dashed; }
.pos-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
.pos-name { min-width: 0; }
.pos-name .title-btn { min-height: 44px; margin: -6px 0; font-size: 16px; }
.pos-name .meta { font-size: var(--fs-sm); color: var(--muted); }
.pos-mult { font-size: 22px; font-weight: 650; letter-spacing: -0.6px; font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 32px; }
.mini-stats { display: grid; grid-template-columns: minmax(0, 1.45fr) repeat(3, minmax(0, 1fr)); gap: 8px; margin: 10px 0 2px; padding: 10px 0 0; border-top: 1px solid var(--line); }
.ms-label { font: 500 9.5px/1.3 var(--mono); letter-spacing: 1px; text-transform: uppercase; color: var(--muted); }
.ms-value { font-size: var(--fs-base); font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ms-value .unit { font-size: 10.5px; font-weight: 500; color: var(--muted); font-family: var(--mono); }
.pos-foot { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0 12px; margin-top: 4px; min-width: 0; }
.pos-foot .meta { font-size: var(--fs-sm); color: var(--muted); flex: 1 1 200px; }
.pos-links { display: flex; align-items: center; gap: 14px; }
.trade-coin .title-btn { min-height: 44px; margin: -8px 0 -7px; font-size: var(--fs-base); }
.trade-link { width: 44px; }
.trade-link .ext-link { justify-content: flex-end; min-width: 44px; }
.more-btn { margin-top: var(--s2); }
.tip { border-left: 2px solid var(--axis); padding: 10px 0 10px 12px; }
.tip.tone-good { border-left-color: var(--good); }
.tip.tone-warn { border-left-color: var(--warn); }
.tip.tone-bad { border-left-color: var(--bad); }
.tip.tone-info { border-left-color: var(--accent); }
.tip-title { font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; min-width: 0; line-height: 1.4; }
.tip-detail { margin: 4px 0 0; font-size: var(--fs-md); color: var(--ink-2); line-height: 1.5; }
.tip-meta { margin: 4px 0 0; font: 500 10px var(--mono); letter-spacing: 0.6px; text-transform: uppercase; color: var(--muted); }
.list.tips .item { padding-left: 12px; }
@media (min-width: 1100px) {
  .ov-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(320px, 1fr); gap: var(--s3); align-items: start; }
  .ov-col { display: flex; flex-direction: column; min-width: 0; }
  .ov-col > * { order: 0; }
  .run-meta { width: auto; }
}
`;

const LIVE_RULES = `
.live-bar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--s2); align-items: center; margin: 0 0 var(--s3); }
.live-chip { justify-self: start; white-space: normal; min-height: 28px; padding: 4px 11px; max-width: 46vw; }
.live-chip.pulse::before { animation: live-pulse 1.6s ease-in-out infinite; }
@keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.live-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s3); align-items: start; }
.live-cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s3); }
.live-cards > .card { margin: 0; }
.live-pos-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
.live-pos-head .title-btn { min-height: 44px; margin: -6px 0; font-size: 17px; }
.live-pos .pos-mult { font-size: 24px; }
.live-pos .mini-stats { margin-bottom: 10px; }
.chart.live-chart { margin: 4px 0 0; }
.live-levels { font-size: var(--fs-sm); color: var(--ink-2); margin-top: 8px; line-height: 1.55; }
.feed-card { margin: 0; }
.feed { margin: 0 calc(-1 * var(--s4)); }
.feed-item { border-left: 2px solid transparent; border-bottom: 1px solid var(--line); min-width: 0; }
.feed-item:last-child { border-bottom: none; }
.feed-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; align-items: baseline; width: 100%; min-height: 44px;
  padding: 8px var(--s4) 8px 14px; border: none; background: none; text-align: left; cursor: pointer; transition: background 0.12s;
}
.feed-row:hover { background: rgba(255, 255, 255, 0.02); }
.feed-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.feed-time { font: 500 var(--fs-xs) var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.feed-kind { font: 600 10px/1.4 var(--mono); letter-spacing: 0.8px; text-transform: uppercase; color: var(--ink-2); }
.feed-text { grid-column: 1 / -1; font-size: var(--fs-md); overflow-wrap: anywhere; min-width: 0; color: var(--ink); }
.tone-good { border-left-color: var(--good); }
.tone-good .feed-kind { color: var(--good-ink); }
.tone-bad { border-left-color: var(--bad); }
.tone-bad .feed-kind { color: var(--bad-ink); }
.tone-warn { border-left-color: var(--warn); }
.tone-warn .feed-kind { color: var(--warn-ink); }
.tone-info { border-left-color: var(--accent); }
.tone-info .feed-kind { color: var(--accent-ink); }
.tone-neutral .feed-text { color: var(--ink-2); }
@media (min-width: 640px) {
  .live-bar { grid-template-columns: auto minmax(0, 240px) auto; justify-content: start; }
  .live-chip { max-width: none; }
  .feed-row { grid-template-columns: 72px 66px minmax(0, 1fr); }
  .feed-text { grid-column: auto; }
  .feed { margin: 0 -20px; }
  .feed-row { padding-right: 20px; }
}
@media (min-width: 1200px) {
  .live-layout { grid-template-columns: minmax(0, 1fr) 400px; }
  .feed-card { position: sticky; top: 72px; max-height: calc(100vh - 92px); overflow-y: auto; }
  .feed-row { grid-template-columns: 74px minmax(0, 1fr); }
  .feed-kind { grid-column: 2; grid-row: 1; }
  .feed-text { grid-column: 1 / -1; }
}
@media (prefers-reduced-motion: reduce) {
  .live-chip.pulse::before { animation: none; }
}
`;

const LAB_RULES = `
.lab-name { font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.lab-variant.baseline { background: var(--accent-wash); margin: 4px -12px; padding: 12px; border-radius: var(--r2); border-bottom: none; box-shadow: inset 2px 0 0 var(--accent); }
.lb-range { position: relative; height: 18px; margin: 10px 0 2px; }
.lb-axis { position: absolute; left: 0; right: 0; top: 8px; height: 2px; background: var(--surface-3); border-radius: 1px; }
.lb-zero { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed #6a6a6a; }
.lb-ci { position: absolute; top: 6px; height: 6px; border-radius: 3px; background: #4a4a4a; }
.lb-ci.pos { background: rgba(52, 209, 127, 0.45); }
.lb-ci.neg { background: rgba(242, 92, 92, 0.45); }
.lb-pt { position: absolute; top: 4px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: var(--ink); border: 2px solid var(--page); }
.bars .bar-row { padding: 9px 0; border-bottom: 1px solid var(--line); }
.bars .bar-row:last-child { border-bottom: none; }
.bar-name { font-size: var(--fs-md); font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.bar-track { height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; margin: 6px 0 4px; }
.bar-fill { display: block; height: 100%; width: 0; border-radius: 3px; background: var(--accent); }
`;

export const DASHBOARD_VIEW_CSS = `${CHART_RULES}${OVERVIEW_RULES}${LIVE_RULES}${LAB_RULES}`;
