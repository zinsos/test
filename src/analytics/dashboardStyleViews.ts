const CHART_RULES = `
.chart-block { min-width: 0; }
.chart-empty { margin: 4px 0 0; padding: 18px 12px; border: 1px dashed var(--border); border-radius: var(--r2); text-align: center; font-size: var(--fs-md); color: var(--muted); }
.chart-readout { display: flex; flex-direction: column; justify-content: center; gap: 3px; min-height: 42px; margin: 0 0 8px; min-width: 0; }
.ro-main { display: flex; align-items: baseline; gap: 4px 14px; font: 500 12px/1.3 var(--mono); color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; min-width: 0; }
.ro-item { white-space: nowrap; }
.ro-item.strong { font: 650 16px/1.2 var(--sans); letter-spacing: -0.2px; color: var(--ink); }
.ro-item.strong.pos { color: var(--good-ink); }
.ro-item.strong.neg { color: var(--bad-ink); }
.ro-key { color: var(--muted); margin-right: 6px; font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; }
.ro-sub { font: 500 12px/1.35 var(--mono); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ro-sub.fill { color: var(--accent-ink); }
.ro-sub.warn { color: var(--warn-ink); }
.chart-readout.hovering .ro-sub:not(.fill) { color: var(--ink-2); }
.chart { --gutter-w: 76px; position: relative; height: 210px; outline: none; user-select: none; -webkit-user-select: none; }
.chart.short { height: 150px; }
.chart.live-chart { --gutter-w: 90px; height: 230px; }
.chart:focus-visible { box-shadow: 0 0 0 2px var(--accent); border-radius: var(--r2); }
.chart-plot { position: absolute; left: 0; top: 0; right: var(--gutter-w); bottom: 22px; touch-action: pan-y; cursor: crosshair; }
.chart-art { position: absolute; inset: 0; }
.chart-art svg { display: block; width: 100%; height: 100%; overflow: visible; }
.chart-gutter { position: absolute; top: 0; right: 0; bottom: 22px; width: var(--gutter-w); border-left: 1px solid var(--line); }
.chart-x { position: absolute; left: 0; right: var(--gutter-w); bottom: 0; height: 22px; border-top: 1px solid var(--line); }
.chart-xlab { position: absolute; top: 6px; transform: translateX(-50%); font: 500 11px/1 var(--mono); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.chart-xlab.first { transform: none; }
.chart-xlab.last { transform: translateX(-100%); }
.chart-ylab { position: absolute; left: 10px; transform: translateY(-50%); font: 500 11px/1 var(--mono); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.chart-tags, .chart-marks { position: absolute; inset: 0; pointer-events: none; }
.chart-marks { overflow: visible; }
.chart-wait { position: absolute; inset: 0 var(--gutter-w) 22px 0; display: flex; align-items: center; justify-content: center; text-align: center; font-size: var(--fs-md); color: var(--muted); }
.cg { stroke: var(--grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
.cg-v { stroke: #171717; }
.base { stroke: var(--axis); stroke-width: 1; vector-effect: non-scaling-stroke; }
.zero { stroke: var(--axis); stroke-width: 1; stroke-dasharray: 3 4; vector-effect: non-scaling-stroke; }
.eq-line, .lv-price, .lab-line { fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.lv-tail { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 3 4; opacity: 0.55; vector-effect: non-scaling-stroke; }
.eq-area, .lv-area { stroke: none; }
.eq-line.neg-line { stroke: var(--bad); }
.ci-band { fill: var(--accent-wash); stroke: none; }
.bar-rect { fill: #b8952f; }
.bar-rect.last { fill: var(--accent); }
.lv-entry, .lv-stop, .lv-trail, .lv-tp, .lv-open { fill: none; stroke-width: 1; vector-effect: non-scaling-stroke; }
.lv-entry { stroke: #8a8a8a; stroke-dasharray: 5 4; }
.lv-stop { stroke: var(--bad); stroke-dasharray: 2 3; }
.lv-trail { stroke: var(--info); stroke-dasharray: 6 3; }
.lv-tp { stroke: var(--good); stroke-dasharray: 2 3; }
.lv-open { stroke: #3a3a3a; stroke-dasharray: 2 3; }
.lv-label, .lv-now, .eq-now {
  position: absolute; left: 9px; right: 2px; transform: translateY(-50%); font: 600 11px/17px var(--sans); letter-spacing: 0; padding: 0 5px; border-radius: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; background: var(--surface); border: 1px solid var(--border-strong); color: var(--ink-2); z-index: 1;
}
.lv-label.lv-entry { color: #d0d0d0; border-color: #4a4a4a; }
.lv-label.lv-stop { color: var(--bad-ink); border-color: rgba(242, 92, 92, 0.55); background: #170c0c; }
.lv-label.lv-trail { color: var(--info-ink); border-color: rgba(139, 151, 255, 0.55); background: #0f1018; }
.lv-label.lv-tp { color: var(--good-ink); border-color: rgba(52, 209, 127, 0.5); background: #0b150f; }
.lv-label.off { opacity: 0.85; border-style: dashed; }
.lv-now, .eq-now { background: var(--accent); border-color: var(--accent); color: var(--on-accent); z-index: 2; }
.eq-now.neg, .lv-now.neg { background: var(--bad); border-color: var(--bad); color: #170707; }
.lv-now.pos { background: var(--good); border-color: var(--good); color: #06150c; }
.tag-lead { position: absolute; left: 4px; width: 0; border-left: 1px solid var(--ink-2); opacity: 0.7; }
.tag-tick { position: absolute; left: 0; width: 9px; height: 0; border-top: 1px solid var(--ink-2); opacity: 0.7; }
.tag-lead.lv-stop, .tag-tick.lv-stop { border-color: var(--bad); }
.tag-lead.lv-trail, .tag-tick.lv-trail { border-color: var(--info); }
.tag-lead.lv-tp, .tag-tick.lv-tp { border-color: var(--good); }
.tag-lead.lv-entry, .tag-tick.lv-entry { border-color: #8a8a8a; }
.chart-vline, .chart-hline { position: absolute; pointer-events: none; display: none; }
.chart-vline { top: 0; bottom: 0; width: 0; border-left: 1px dashed #707070; }
.chart-hline { left: 0; right: 0; height: 0; border-top: 1px dashed #505050; }
.chart-dot { position: absolute; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; border-radius: 50%; background: var(--ink); box-shadow: 0 0 0 3px rgba(242, 242, 242, 0.18); pointer-events: none; display: none; z-index: 3; }
.now-dot { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: var(--accent); z-index: 2; }
.now-dot::after { content: ""; position: absolute; inset: -6px; border-radius: 50%; border: 1.5px solid var(--accent); opacity: 0; animation: now-pulse 1.8s ease-out infinite; }
.now-dot.still::after, .now-dot.stale::after { animation: none; }
.now-dot.stale { opacity: 0.6; }
.now-dot.neg { background: var(--bad); }
.now-dot.neg::after { border-color: var(--bad); }
.now-dot.pos { background: var(--good); }
.now-dot.pos::after { border-color: var(--good); }
@keyframes now-pulse { 0% { transform: scale(0.5); opacity: 0.9; } 100% { transform: scale(1.6); opacity: 0; } }
.fill-mark {
  position: absolute; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font: 700 11px/1 var(--mono); z-index: 2; border: 2px solid var(--page);
}
.fill-mark.buy { background: var(--good); color: #04130a; }
.fill-mark.sell { background: var(--bad); color: #190606; }
.pt-mark { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: var(--accent); border: 1.5px solid var(--page); }
.pt-mark.neg { background: var(--bad); }
.spark { height: 46px; margin: 10px 0 2px; }
.spark svg { display: block; width: 100%; height: 100%; overflow: visible; }
.spark-line { fill: none; stroke: var(--good); stroke-width: 1.6; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.spark.bad .spark-line { stroke: var(--bad); }
.spark-area { stroke: none; }
.spark-entry { stroke: #4d4d4d; stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
@media (min-width: 900px) {
  .chart { height: 260px; }
  .chart.live-chart { height: 300px; }
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
.run-pick { min-width: 0; flex: 1 1 100%; }
.run-pick select { min-height: 40px; }
.ov-grid { display: flex; flex-direction: column; }
.ov-col { display: contents; }
.ov-open { order: 1; }
.ov-wallet { order: 2; }
.ov-closed { order: 3; }
.ov-tips { order: 4; }
.ov-run { order: 5; }
.ov-activity { order: 6; }
.wallet-card { border-color: #33301f; background: linear-gradient(180deg, #15130d 0%, #0f0f0f 70%); }
.wallet-figure { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; margin: 4px 0 2px; }
.wallet-figure .figure { margin: 0; font-size: 30px; }
.wallet-figure .figure-unit { margin: 0; font-size: var(--fs-md); }
.figure-usd { font: 500 15px/1.2 var(--mono); color: var(--ink-2); margin-left: 6px; font-variant-numeric: tabular-nums; }
.wallet-sub { font-size: var(--fs-sm); color: var(--muted); }
.wallet-card .kv { margin-top: var(--s2); }
.wallet-note { font-size: var(--fs-sm); color: var(--ink-2); margin-top: var(--s2); }
.pos-list { display: grid; margin: 0 calc(-1 * var(--card-pad)); }
.pos-row { padding: 12px var(--card-pad) 6px; border-top: 1px solid var(--line); min-width: 0; }
.pos-row:first-child { border-top: none; padding-top: 2px; }
.pos-row.pending { background: repeating-linear-gradient(135deg, transparent 0 8px, rgba(255, 255, 255, 0.012) 8px 16px); }
.pos-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
.pos-name { min-width: 0; }
.pos-name .title-btn { min-height: 44px; margin: -6px 0; font-size: 16px; }
.pos-name .meta { font-size: var(--fs-sm); color: var(--muted); }
.pos-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: 0 0 auto; }
.pos-mult { font-size: 22px; font-weight: 650; letter-spacing: -0.6px; font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 30px; }
.mini-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 10px 0 2px; padding: 10px 0 0; border-top: 1px solid var(--line); }
.ms-label { font: 500 11px/1.3 var(--mono); letter-spacing: 0.6px; text-transform: uppercase; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ms-value { font-size: var(--fs-base); font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ms-sub { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pos-foot { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0 12px; margin-top: 2px; min-width: 0; }
.pos-foot .meta { font-size: var(--fs-sm); color: var(--muted); flex: 1 1 160px; }
.pos-links { display: flex; align-items: center; gap: 16px; }
.footnote { font-size: var(--fs-sm); color: var(--muted); line-height: 1.5; margin: 0 0 var(--s3); }
.blotter td { padding-top: 8px; padding-bottom: 8px; }
.t-time { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.t-coin { width: 34%; }
th.t-left, td.t-coin { text-align: left; }
.blotter td.t-coin { padding-left: 4px; }
.t-exit { color: var(--ink-2); }
.t-pnl { font-weight: 600; }
.t-rank { color: var(--muted); font-family: var(--mono); }
.t-result { white-space: normal; }
.skip-text { font-size: var(--fs-sm); color: var(--muted); }
.risk-num { font-weight: 650; }
.risk-num.good { color: var(--good-ink); }
.risk-num.warn { color: var(--warn-ink); }
.risk-num.bad { color: var(--bad-ink); }
.dense td { padding-top: 7px; padding-bottom: 7px; }
.more-btn { margin-top: var(--s3); }
.tip { border-left: 2px solid var(--axis); padding: 10px 0 10px 12px; }
.tip.tone-good { border-left-color: var(--good); }
.tip.tone-warn { border-left-color: var(--warn); }
.tip.tone-bad { border-left-color: var(--bad); }
.tip.tone-info { border-left-color: var(--accent); }
.tip-title { font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; min-width: 0; line-height: 1.4; }
.tip-detail { margin: 4px 0 0; font-size: var(--fs-md); color: var(--ink-2); line-height: 1.5; }
.tip-meta { margin: 4px 0 0; font: 500 11px var(--mono); letter-spacing: 0.4px; text-transform: uppercase; color: var(--muted); }
.list.tips .item { padding-left: 12px; }
.call-cell { width: 1%; }
.badge.call { padding: 3px 8px; }
.call-legend { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: var(--s2); }
.call-key { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--ink-2); }
.call-key .badge { padding: 4px; }
.call-key .badge-text { display: none; }
@media (max-width: 479px) {
  .badge.call { padding: 4px; }
  .badge.call .badge-text { display: none; }
  .t-coin { width: auto; }
}
@container main (min-width: 600px) {
  .run-pick { flex: 0 1 280px; }
  .run-meta { width: auto; }
}
@container main (min-width: 900px) {
  .ov-grid { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(300px, 1fr); gap: var(--s3); align-items: start; }
  .ov-col { display: flex; flex-direction: column; min-width: 0; }
  .ov-col > * { order: 0; }
}
`;

const LIVE_RULES = `
.live-chip { justify-self: start; min-height: 26px; padding: 3px 10px; }
.live-chip.pulse::before { animation: live-pulse 1.6s ease-in-out infinite; }
@keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.live-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s3); align-items: start; }
.live-cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s3); }
.live-cards > .card { margin: 0; }
.live-pos-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; margin-bottom: 8px; }
.live-pos-head .title-btn { min-height: 44px; margin: -6px 0; font-size: 17px; }
.live-pos-head .meta { font-size: var(--fs-sm); color: var(--muted); }
.live-pos .pos-mult { font-size: 26px; }
.live-pos .mini-stats { margin-top: 12px; }
.exit-chips { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.exit-chip { display: inline-flex; align-items: center; gap: 7px; padding: 4px 9px; border-radius: var(--r2); border: 1px solid var(--border); background: var(--surface); font: 500 12px/1.35 var(--mono); color: var(--ink); white-space: nowrap; }
.exit-chip::before { content: ""; width: 12px; height: 0; border-top: 2px dashed var(--muted); flex: 0 0 auto; }
.exit-chip .chip-key { color: var(--muted); }
.exit-chip.lv-stop::before { border-top-color: var(--bad); }
.exit-chip.lv-stop .chip-val { color: var(--bad-ink); }
.exit-chip.lv-trail::before { border-top-color: var(--info); }
.exit-chip.lv-trail .chip-val { color: var(--info-ink); }
.exit-chip.lv-tp::before { border-top-color: var(--good); }
.exit-chip.lv-tp .chip-val { color: var(--good-ink); }
.exit-chip.timer::before { width: 7px; height: 7px; border: 1.5px solid var(--muted); border-radius: 50%; }
@container main (max-width: 559px) {
  .exit-chips { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .exit-chip { min-width: 0; overflow: hidden; }
  .exit-chip .chip-val { overflow: hidden; text-overflow: ellipsis; }
}
.feed-card { margin: 0; padding-bottom: 6px; }
.feed-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: var(--s2); }
.feed-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--s2); margin-bottom: var(--s2); }

.feed-note { margin: var(--s2) 0; }
.feed { margin: 0 calc(-1 * var(--card-pad)); }
.feed-item { border-top: 1px solid var(--line); min-width: 0; }
.feed-row {
  display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 2px 10px; align-items: baseline; width: 100%; min-height: 44px;
  padding: 8px var(--card-pad); border: none; background: none; text-align: left; cursor: pointer; transition: background 0.12s;
}
.feed-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.feed-time { font: 500 12px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.feed-kind { font: 600 11px/1.4 var(--mono); letter-spacing: 0.6px; text-transform: uppercase; color: var(--ink-2); }
.feed-text { grid-column: 1 / -1; font-size: var(--fs-md); overflow-wrap: anywhere; min-width: 0; color: var(--ink); }
.tone-good .feed-kind { color: var(--good-ink); }
.tone-bad .feed-kind { color: var(--bad-ink); }
.tone-warn .feed-kind { color: var(--warn-ink); }
.tone-info .feed-kind { color: var(--accent-ink); }
.tone-neutral .feed-text, .cat-score .feed-text { color: var(--ink-2); }
@media (hover: hover) {
  .feed-row:hover { background: rgba(255, 255, 255, 0.025); }
}
@container main (min-width: 880px) {
  .live-layout { grid-template-columns: minmax(0, 1fr) 350px; }
  .feed-card { position: sticky; top: calc(var(--sticky-top, 56px) + 12px); max-height: calc(100vh - var(--sticky-top, 56px) - 28px); overflow-y: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .live-chip.pulse::before { animation: none; }
}
`;

const LAB_RULES = `
.lab-board { list-style: none; margin: 0 calc(-1 * var(--card-pad)); padding: 0; }
.lab-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; row-gap: 4px; padding: 12px var(--card-pad); border-top: 1px solid var(--line); align-items: center; min-width: 0; }
.lab-row > * { grid-column: 1 / -1; min-width: 0; }
.lab-row > .l-name { grid-column: 1; grid-row: 1; }
.lab-row > .l-exp { grid-column: 2; grid-row: 1; text-align: right; }
.lab-row .l-num, .lab-header { display: none; }
.lab-variant.baseline { background: var(--accent-wash); box-shadow: inset 2px 0 0 var(--accent); }
.lab-name { font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; min-width: 0; color: var(--ink); }
.lab-open { border: none; background: none; padding: 0; min-height: 40px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; text-align: left; }
.lab-open .icon { width: 14px; height: 14px; color: var(--muted); }
.l-name .meta { font-size: var(--fs-sm); color: var(--muted); }
.l-meta { font-size: var(--fs-sm); }
.l-error { font-size: var(--fs-sm); }
.lab-row .badges { margin-top: 2px; }
.lb-range { position: relative; height: 18px; margin: 4px 0 2px; }
.lb-axis { position: absolute; left: 0; right: 0; top: 8px; height: 2px; background: var(--surface-3); border-radius: 1px; }
.lb-zero { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed #707070; }
.lb-ci { position: absolute; top: 6px; height: 6px; border-radius: 3px; background: #4d4d4d; }
.lb-ci.pos { background: rgba(52, 209, 127, 0.5); }
.lb-ci.neg { background: rgba(242, 92, 92, 0.5); }
.lb-pt { position: absolute; top: 4px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: var(--ink); border: 2px solid var(--page); }
.lb-pt.pos { background: var(--good); }
.lb-pt.neg { background: var(--bad); }
.lb-axis-labels { position: relative; height: 14px; font: 500 11px/14px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.lb-tick { position: absolute; top: 0; white-space: nowrap; }
.lb-tick.first { left: 0; }
.lb-tick.last { right: 0; }
.lb-tick.zero { transform: translateX(-50%); color: var(--ink-2); }
.phone-scale { margin: 0 0 6px; }
.learn-list { list-style: none; margin: var(--s2) calc(-1 * var(--card-pad)) 0; padding: 0; }
.learn-row { padding: 12px var(--card-pad); border-top: 1px solid var(--line); min-width: 0; }
.learn-row .meta { font-size: var(--fs-sm); }
.learn-desc { margin-top: 2px; }
.learn-figs { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; margin-top: 6px; min-width: 0; }
.learn-progress { margin-top: 4px; }
.learn-row .meter { margin-top: 8px; }
.learn-reasons { margin: 6px 0 0; padding-left: 18px; font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.5; }
.learn-changes { margin: 6px 0 0; font: 500 var(--fs-sm)/1.5 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.learn-axis { margin-top: var(--s3); }
.learn-stage { margin-top: var(--s3); padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; min-width: 0; }
.learn-stage .meter { margin-top: 8px; }
.learn-stage .meta { font-size: var(--fs-sm); margin-top: 4px; overflow-wrap: anywhere; }
.learn-last { margin-top: var(--s4); }
.learn-last h3 { margin: 0; }
.learn-card td.t-left { text-align: left; white-space: normal; }
.bars .bar-row { padding: 9px 0; border-bottom: 1px solid var(--line); }
.bars .bar-row:last-child { border-bottom: none; }
.bar-name { font-size: var(--fs-md); font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.bar-track { height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; margin: 6px 0 4px; }
.bar-fill { display: block; height: 100%; width: 0; border-radius: 3px; background: var(--accent); }
@container main (min-width: 900px) {
  .phone-scale { display: none; }
  .lab-row { grid-template-columns: minmax(150px, 1.4fr) 92px minmax(120px, 1.2fr) 52px 44px 72px 72px 72px 132px; column-gap: 10px; row-gap: 2px; }
  .lab-row > *, .lab-row > .l-name, .lab-row > .l-exp { grid-column: auto; grid-row: auto; }
  .lab-row > .l-error { grid-column: 1 / -1; }
  .lab-row .l-num { display: block; text-align: right; font-size: var(--fs-md); font-variant-numeric: tabular-nums; }
  .lab-row .l-meta { display: none; }
  .lab-header { display: grid; padding-top: 4px; padding-bottom: 8px; border-top: none; font: 500 11px/1.3 var(--mono); letter-spacing: 0.8px; text-transform: uppercase; color: var(--muted); align-items: end; }
  .lab-header .l-bar { display: flex; flex-direction: column; gap: 4px; }
  .lab-header .lb-axis-labels { text-transform: none; letter-spacing: 0; }
  .lab-header .l-exp { text-align: right; }
  .lab-row .l-exp { font-size: 16px; }
  .lab-row .l-exp .unit { display: none; }
  .lab-row .l-verdict { margin: 0; flex-direction: column; align-items: flex-start; }
  .lab-row.lab-header > * { font: 500 11px/1.3 var(--mono); letter-spacing: 0.8px; }
}
`;

export const DASHBOARD_VIEW_CSS = `${CHART_RULES}${OVERVIEW_RULES}${LIVE_RULES}${LAB_RULES}`;
