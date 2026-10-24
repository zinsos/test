export const TOKEN_PARAM = "token";
export const MAX_URL_LENGTH = 2048;
export const MAX_TOKEN_LENGTH = 512;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

export type ParsedDashboardUrl =
  | { ok: true; origin: string; tokenFromUrl: string | null }
  | { ok: false; error: string };

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function tryUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function parseDashboardUrl(input: string): ParsedDashboardUrl {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter the dashboard address." };
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, error: "That address is too long." };
  }
  const url = tryUrl(SCHEME_PATTERN.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url === null || url.hostname.length === 0) {
    return { ok: false, error: "That is not a valid address. Paste the full https:// link of the dashboard." };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, error: "Remove the user name or password from the address." };
  }
  const allowedHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !allowedHttp) {
    return { ok: false, error: "The address must start with https:// (plain http is only allowed for 127.0.0.1 and localhost)." };
  }
  const tokenFromUrl = url.searchParams.get(TOKEN_PARAM);
  return { ok: true, origin: url.origin, tokenFromUrl: tokenFromUrl !== null && tokenFromUrl.length > 0 ? tokenFromUrl : null };
}

export function isValidToken(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH && TOKEN_PATTERN.test(token);
}

export function originOf(candidate: string): string | null {
  const url = tryUrl(candidate);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return null;
  }
  return url.origin;
}

export function isSameOrigin(candidate: string, origin: string): boolean {
  return originOf(candidate) === origin;
}

export function requestOriginOf(candidate: string): string | null {
  return originOf(/^wss?:/i.test(candidate) ? candidate.replace(/^ws/i, "http") : candidate);
}

export function withDashboardAuthorization(
  requestUrl: string,
  headers: Readonly<Record<string, string>>,
  origin: string,
  token: string | null
): Record<string, string> {
  if (token === null || !isValidToken(token) || requestOriginOf(requestUrl) !== origin) {
    return { ...headers };
  }
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "authorization") {
      next[name] = value;
    }
  }
  next.Authorization = `Bearer ${token}`;
  return next;
}

export function isBlobOfOrigin(candidate: string, origin: string): boolean {
  return candidate.startsWith("blob:") && originOf(candidate.slice("blob:".length)) === origin;
}

export function externalHttpsUrl(candidate: string): string | null {
  const url = tryUrl(candidate);
  if (url === null || url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    return null;
  }
  url.searchParams.delete(TOKEN_PARAM);
  return url.href;
}

export function dashboardHomeUrl(origin: string): string {
  return `${origin}/`;
}

export function webVersionUrl(origin: string): string | null {
  return origin.startsWith("https://") ? dashboardHomeUrl(origin) : null;
}

export function hostLabel(origin: string): string {
  const url = tryUrl(origin);
  return url === null ? origin : url.host;
}

export function isQuickTunnelHost(origin: string): boolean {
  const url = tryUrl(origin);
  return url !== null && url.hostname.endsWith(".trycloudflare.com");
}
