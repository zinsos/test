import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

export const SECRET_KEY_LENGTH = 64;

export class KeypairLoadError extends Error {
  constructor(reason: string) {
    super(`invalid wallet secret: ${reason}`);
    this.name = "KeypairLoadError";
  }
}

function bytesFromJsonArray(text: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KeypairLoadError("not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new KeypairLoadError("JSON value is not an array");
  }
  const valid = parsed.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255);
  if (!valid) {
    throw new KeypairLoadError("JSON array must contain only byte values");
  }
  return Uint8Array.from(parsed as number[]);
}

function bytesFromBase58(text: string): Uint8Array {
  try {
    return bs58.decode(text);
  } catch {
    throw new KeypairLoadError("not valid base58");
  }
}

export function secretBytes(secret: string): Uint8Array {
  const text = secret.trim();
  if (text.length === 0) {
    throw new KeypairLoadError("empty");
  }
  return text.startsWith("[") ? bytesFromJsonArray(text) : bytesFromBase58(text);
}

export function loadKeypair(secret: string): Keypair {
  const bytes = secretBytes(secret);
  try {
    if (bytes.length !== SECRET_KEY_LENGTH) {
      throw new KeypairLoadError(`expected ${SECRET_KEY_LENGTH} bytes, got ${bytes.length}`);
    }
    try {
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch {
      throw new KeypairLoadError("public key half does not match the private key");
    }
  } finally {
    bytes.fill(0);
  }
}

export function walletAddress(keypair: Keypair): string {
  return keypair.publicKey.toBase58();
}
