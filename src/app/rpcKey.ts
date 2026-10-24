import { readFile, rename, writeFile } from "node:fs/promises";
import { HttpError } from "../analytics/http.js";
import { isHeliusKey, keyHint, type RpcKeyChange, type RpcKeyControls, type RpcKeyStatus } from "../analytics/rpcKey.js";
import { moduleLogger } from "../core/logger.js";

const log = moduleLogger("app.rpc-key");

const HELIUS_HOST = "mainnet.helius-rpc.com";
const HELIUS_DOMAIN = "helius-rpc.com";
const PROBE_TIMEOUT_MS = 8_000;
const ENV_NAME = /^([A-Za-z_][A-Za-z0-9_]*)=/;

export type KeyProbe = (httpUrl: string) => Promise<void>;

export function heliusUrls(key: string): { http: string; ws: string } {
  return { http: `https://${HELIUS_HOST}/?api-key=${key}`, ws: `wss://${HELIUS_HOST}/?api-key=${key}` };
}

export function heliusKeyOf(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host !== HELIUS_DOMAIN && !host.endsWith(`.${HELIUS_DOMAIN}`)) {
      return null;
    }
    const key = parsed.searchParams.get("api-key");
    return isHeliusKey(key) ? key : null;
  } catch {
    return null;
  }
}

export function withEnvValues(text: string, values: Readonly<Record<string, string>>): string {
  const seen = new Set<string>();
  const lines = text.split("\n").map((line) => {
    const name = ENV_NAME.exec(line)?.[1];
    if (name === undefined || !(name in values)) {
      return line;
    }
    seen.add(name);
    return `${name}=${values[name]}`;
  });
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  for (const [name, value] of Object.entries(values)) {
    if (!seen.has(name)) {
      lines.push(`${name}=${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function probeRpc(httpUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(httpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
  } catch {
    throw new HttpError(502, "rpc_unreachable", "could not reach Helius to check the key, try again");
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(422, "key_rejected", "Helius rejected this key");
  }
  if (response.status === 429) {
    throw new HttpError(503, "rpc_rate_limited", "Helius rate-limited the check, try again in a minute");
  }
  if (!response.ok) {
    throw new HttpError(502, "rpc_error", `Helius answered ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as { result?: unknown } | null;
  if (!body || typeof body.result !== "number") {
    throw new HttpError(422, "key_rejected", "Helius did not accept this key");
  }
}

export interface RpcKeyControlsOptions {
  envFile: string | null;
  currentHttpUrl: string | undefined;
  restart: () => void;
  probe?: KeyProbe;
}

export function createRpcKeyControls(options: RpcKeyControlsOptions): RpcKeyControls {
  let currentKey = heliusKeyOf(options.currentHttpUrl);
  let changing = false;
  const probe = options.probe ?? probeRpc;
  const status = (): RpcKeyStatus => ({
    provider: currentKey ? "helius" : options.currentHttpUrl ? "custom" : "none",
    keyHint: currentKey ? keyHint(currentKey) : null,
    canChange: options.envFile !== null
  });
  const change = async (key: string): Promise<RpcKeyChange> => {
    const envFile = options.envFile;
    if (envFile === null) {
      throw new HttpError(409, "rpc_key_unavailable", "set ENV_FILE to change the key from the dashboard");
    }
    if (!isHeliusKey(key)) {
      throw new HttpError(400, "invalid_key", "that is not a Helius API key");
    }
    if (changing) {
      throw new HttpError(409, "rpc_key_busy", "a key change is already in progress");
    }
    changing = true;
    try {
      const urls = heliusUrls(key);
      await probe(urls.http);
      const before = await readFile(envFile, "utf8");
      const after = withEnvValues(before, { RPC_HTTP_URL: urls.http, RPC_WS_URL: urls.ws });
      await writeFile(`${envFile}.previous`, before, { mode: 0o600 });
      const next = `${envFile}.next`;
      await writeFile(next, after, { mode: 0o600 });
      await rename(next, envFile);
      currentKey = key;
      log.warn({ keyHint: keyHint(key) }, "rpc key changed from the dashboard, restarting");
      options.restart();
      return { ok: true, keyHint: keyHint(key), restarting: true };
    } finally {
      changing = false;
    }
  };
  return { status, change };
}
