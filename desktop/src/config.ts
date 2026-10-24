import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isValidToken, parseDashboardUrl } from "./urls.js";

export type TokenScheme = "safeStorage" | "plain";

export interface StoredToken {
  scheme: TokenScheme;
  value: string;
}

export interface DecryptedToken {
  token: string;
  stale: boolean;
}

export interface TokenCodec {
  encrypt(token: string): Promise<StoredToken>;
  decrypt(stored: StoredToken): Promise<DecryptedToken | null>;
}

export interface DesktopConfig {
  origin: string;
  token: string | null;
}

export type LoadedConfig =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ok"; config: DesktopConfig; tokenScheme: TokenScheme | null; stale: boolean }
  | { status: "token_unreadable"; origin: string };

const CONFIG_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStoredToken(value: unknown): StoredToken | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || (value.scheme !== "safeStorage" && value.scheme !== "plain") || typeof value.value !== "string") {
    return undefined;
  }
  return { scheme: value.scheme, value: value.value };
}

export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.next`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

export async function loadConfig(file: string, codec: TokenCodec): Promise<LoadedConfig> {
  if (!existsSync(file)) {
    return { status: "missing" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return { status: "invalid" };
  }
  if (!isRecord(raw) || raw.version !== CONFIG_VERSION || typeof raw.origin !== "string") {
    return { status: "invalid" };
  }
  const parsed = parseDashboardUrl(raw.origin);
  const stored = readStoredToken(raw.token);
  if (!parsed.ok || parsed.origin !== raw.origin || stored === undefined) {
    return { status: "invalid" };
  }
  if (stored === null) {
    return { status: "ok", config: { origin: parsed.origin, token: null }, tokenScheme: null, stale: false };
  }
  const decrypted = await codec.decrypt(stored);
  if (decrypted === null || !isValidToken(decrypted.token)) {
    return { status: "token_unreadable", origin: parsed.origin };
  }
  return { status: "ok", config: { origin: parsed.origin, token: decrypted.token }, tokenScheme: stored.scheme, stale: decrypted.stale };
}

export async function saveConfig(file: string, config: DesktopConfig, codec: TokenCodec): Promise<TokenScheme | null> {
  const token = config.token === null ? null : await codec.encrypt(config.token);
  writeFileAtomic(file, `${JSON.stringify({ version: CONFIG_VERSION, origin: config.origin, token }, null, 2)}\n`);
  return token === null ? null : token.scheme;
}
