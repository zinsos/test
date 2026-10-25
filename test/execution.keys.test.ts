import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { KeypairLoadError, loadKeypair, secretBytes, walletAddress } from "../src/execution/keys.js";

function expectLoadError(secret: string, fragment: string): void {
  let caught: unknown = null;
  try {
    loadKeypair(secret);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(KeypairLoadError);
  const message = (caught as Error).message;
  expect(message).toContain(fragment);
  if (secret.trim().length > 8) {
    expect(message).not.toContain(secret.trim());
  }
}

describe("loadKeypair", () => {
  const original = Keypair.generate();
  const base58Secret = bs58.encode(original.secretKey);
  const jsonSecret = JSON.stringify(Array.from(original.secretKey));

  it("loads a base58 secret key", () => {
    const loaded = loadKeypair(base58Secret);
    expect(loaded.publicKey.equals(original.publicKey)).toBe(true);
    expect(walletAddress(loaded)).toBe(original.publicKey.toBase58());
  });

  it("loads a JSON byte array, tolerating surrounding whitespace", () => {
    const loaded = loadKeypair(`  ${jsonSecret}\n`);
    expect(loaded.publicKey.equals(original.publicKey)).toBe(true);
    expect(Array.from(loaded.secretKey)).toEqual(Array.from(original.secretKey));
  });

  it("keeps a usable key after wiping the decoded buffer", () => {
    const loaded = loadKeypair(base58Secret);
    const again = loadKeypair(base58Secret);
    expect(Array.from(loaded.secretKey)).toEqual(Array.from(again.secretKey));
    expect(loaded.secretKey.some((byte) => byte !== 0)).toBe(true);
  });

  it("rejects empty input", () => {
    expectLoadError("   ", "empty");
  });

  it("rejects wrong lengths without echoing the secret", () => {
    expectLoadError(bs58.encode(original.secretKey.slice(0, 32)), "expected 64 bytes, got 32");
    expectLoadError(JSON.stringify(Array.from(original.secretKey).concat([1])), "expected 64 bytes, got 65");
  });

  it("rejects malformed base58 and JSON", () => {
    expectLoadError("0OIl-not-base58", "not valid base58");
    expectLoadError("[1, 2,", "not valid JSON");
    expectLoadError(JSON.stringify(Array.from({ length: 64 }, () => 300)), "only byte values");
    expectLoadError(JSON.stringify(Array.from({ length: 64 }, () => 1.5)), "only byte values");
    expect(() => secretBytes("[]")).not.toThrow();
  });

  it("rejects a secret whose public half does not match", () => {
    const tampered = Uint8Array.from(original.secretKey);
    tampered[40] = (tampered[40] ?? 0) ^ 0xff;
    expectLoadError(bs58.encode(tampered), "public key half does not match");
  });
});
