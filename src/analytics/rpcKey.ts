export const HELIUS_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RpcProvider = "helius" | "custom" | "none";

export interface RpcKeyStatus {
  provider: RpcProvider;
  keyHint: string | null;
  canChange: boolean;
}

export interface RpcKeyChange {
  ok: true;
  keyHint: string;
  restarting: boolean;
}

export interface RpcKeyControls {
  status(): RpcKeyStatus;
  change(key: string): Promise<RpcKeyChange>;
}

export function keyHint(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function isHeliusKey(value: unknown): value is string {
  return typeof value === "string" && HELIUS_KEY_PATTERN.test(value);
}
