import { readFileSync } from "node:fs";
import type { ParsedTransaction, TokenBalance } from "../src/chain/rpc.js";
import type { TransactionInput } from "../src/tracker/txParse.js";

export interface FixtureTx {
  signature: string;
  slot: number;
  blockTime: number;
  category: string;
  logs: string[];
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
}

export const fixtures: FixtureTx[] = JSON.parse(
  readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8")
);

export function fixture(prefix: string): FixtureTx {
  const found = fixtures.find((tx) => tx.signature.startsWith(prefix));
  if (!found) {
    throw new Error(`fixture ${prefix} missing`);
  }
  return found;
}

export function signerOf(tx: FixtureTx): string {
  const key = tx.accountKeys[0];
  if (!key) {
    throw new Error("fixture has no signer");
  }
  return key;
}

export function asInput(tx: FixtureTx): TransactionInput {
  return {
    signature: tx.signature,
    slot: tx.slot,
    blockTimeMs: tx.blockTime * 1000,
    logs: tx.logs,
    preTokenBalances: tx.preTokenBalances,
    postTokenBalances: tx.postTokenBalances
  };
}

export function asParsed(tx: FixtureTx): ParsedTransaction {
  return {
    slot: tx.slot,
    blockTime: tx.blockTime,
    meta: {
      err: null,
      fee: 5000,
      preBalances: tx.preBalances,
      postBalances: tx.postBalances,
      logMessages: tx.logs,
      preTokenBalances: tx.preTokenBalances,
      postTokenBalances: tx.postTokenBalances
    },
    transaction: {
      signatures: [tx.signature],
      message: { accountKeys: tx.accountKeys, instructions: [] }
    }
  };
}
