import { createHash } from "node:crypto";
import { DASHBOARD_SCRIPT } from "./dashboardScript.js";
import { DASHBOARD_CSS } from "./dashboardStyle.js";

export const DASHBOARD_TITLE = "SNYPRA edge";

function sourceHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

export function renderDashboardHtml(): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="theme-color" content="#090909">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${DASHBOARD_TITLE}</title>`,
    `<style>${DASHBOARD_CSS}</style>`,
    "</head>",
    "<body>",
    '<noscript><p>This dashboard needs JavaScript.</p></noscript>',
    `<script>${DASHBOARD_SCRIPT}</script>`,
    "</body>",
    "</html>"
  ].join("\n");
}

export function dashboardContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    `script-src ${sourceHash(DASHBOARD_SCRIPT)}`,
    `style-src ${sourceHash(DASHBOARD_CSS)}`,
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}
