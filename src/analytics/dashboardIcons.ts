export const ICON_SCRIPT = String.raw`
  var ICON_PATHS = {
    overview: "<rect x=\"3.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.6\"></rect><rect x=\"13.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.6\"></rect><rect x=\"3.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"1.6\"></rect><rect x=\"13.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"1.6\"></rect>",
    live: "<path d=\"M2.5 12h4l2.5-6.5 4.5 13 2.5-6.5h5.5\"></path>",
    performance: "<path d=\"M3 17.5l5.5-5.5 4 4 8-8.5\"></path><path d=\"M15 7.5h6v6\"></path>",
    lab: "<path d=\"M9 3h6\"></path><path d=\"M10 3v6.2L4.6 18.4A1.7 1.7 0 0 0 6.1 21h11.8a1.7 1.7 0 0 0 1.5-2.6L14 9.2V3\"></path><path d=\"M7.2 15h9.6\"></path>",
    more: "<circle class=\"f\" cx=\"5\" cy=\"12\" r=\"1.7\"></circle><circle class=\"f\" cx=\"12\" cy=\"12\" r=\"1.7\"></circle><circle class=\"f\" cx=\"19\" cy=\"12\" r=\"1.7\"></circle>",
    settings: "<path d=\"M4 6.5h9\"></path><path d=\"M19 6.5h1\"></path><circle cx=\"16\" cy=\"6.5\" r=\"2.3\"></circle><path d=\"M4 12h2\"></path><path d=\"M12 12h8\"></path><circle cx=\"9\" cy=\"12\" r=\"2.3\"></circle><path d=\"M4 17.5h10\"></path><path d=\"M20 17.5h0\"></path><circle cx=\"17\" cy=\"17.5\" r=\"2.3\"></circle>",
    refresh: "<path d=\"M20 11.5A8 8 0 1 0 17.7 17\"></path><path d=\"M20.5 4.5V11h-6.5\"></path>",
    breakdowns: "<path d=\"M3.5 20.5h17\"></path><path d=\"M6.5 17V11\"></path><path d=\"M12 17V5\"></path><path d=\"M17.5 17v-8\"></path>",
    compare: "<rect x=\"3.5\" y=\"4\" width=\"7\" height=\"16\" rx=\"1.6\"></rect><rect x=\"13.5\" y=\"4\" width=\"7\" height=\"16\" rx=\"1.6\"></rect><path d=\"M6 15l2-3 1 1.5\"></path><path d=\"M16 14.5l2-3.5 1 2\"></path>",
    scorer: "<path d=\"M3.5 17a8.5 8.5 0 1 1 17 0\"></path><path d=\"M12 17l4.5-5.5\"></path><circle class=\"f\" cx=\"12\" cy=\"17\" r=\"1.6\"></circle>",
    recorder: "<ellipse cx=\"12\" cy=\"6\" rx=\"7.5\" ry=\"2.8\"></ellipse><path d=\"M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6\"></path><path d=\"M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8\"></path>",
    signals: "<path d=\"M13 2.5L4.5 13.5h6.5l-1 8 8.5-11h-6.5z\"></path>",
    launches: "<path d=\"M12 2.8c3 2 4.5 5.3 4.5 9.2v4.5h-9V12c0-3.9 1.5-7.2 4.5-9.2z\"></path><path d=\"M7.5 13.5l-2.8 2.4v3.6l2.8-1.5\"></path><path d=\"M16.5 13.5l2.8 2.4v3.6l-2.8-1.5\"></path><path d=\"M10.5 20.5h3\"></path><circle cx=\"12\" cy=\"9.5\" r=\"1.6\"></circle>",
    wallets: "<path d=\"M19.5 7.5V5.8A1.8 1.8 0 0 0 17.7 4H5.8A2.3 2.3 0 0 0 3.5 6.3v11.4A2.3 2.3 0 0 0 5.8 20h13.9V7.5H5.8a2.3 2.3 0 0 1-2.3-2.2\"></path><circle class=\"f\" cx=\"16.3\" cy=\"13.8\" r=\"1.3\"></circle>",
    external: "<path d=\"M14 4h6v6\"></path><path d=\"M20 4l-9 9\"></path><path d=\"M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10\"></path>",
    close: "<path d=\"M6 6l12 12\"></path><path d=\"M18 6L6 18\"></path>",
    alert: "<path d=\"M12 3.5l9.5 16.5h-19z\"></path><path d=\"M12 10v4.5\"></path><circle class=\"f\" cx=\"12\" cy=\"17.3\" r=\"1.1\"></circle>",
    lock: "<rect x=\"5\" y=\"10.5\" width=\"14\" height=\"10\" rx=\"2\"></rect><path d=\"M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3\"></path>",
    inbox: "<path d=\"M3.5 13.5l2.8-8h11.4l2.8 8\"></path><path d=\"M3.5 13.5V19h17v-5.5\"></path><path d=\"M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5\"></path>",
    key: "<circle cx=\"8\" cy=\"15\" r=\"4.5\"></circle><path d=\"M11.3 11.7L20 3\"></path><path d=\"M16.5 6.5l2.5 2.5\"></path><path d=\"M14.5 8.5l2 2\"></path>",
    download: "<path d=\"M12 4v11\"></path><path d=\"M7.5 10.5L12 15l4.5-4.5\"></path><path d=\"M4.5 19.5h15\"></path>"
  };

  function icon(key, cls) {
    var node = el("span", { class: "icon" + (cls ? " " + cls : ""), "aria-hidden": "true" });
    svgInto(node, "<svg viewBox=\"0 0 24 24\" focusable=\"false\">" + (ICON_PATHS.hasOwnProperty(key) ? ICON_PATHS[key] : "") + "</svg>");
    return node;
  }
`;
