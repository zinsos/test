import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeLogs, type DecodedChainEvent } from "../src/chain/events.js";
import type { ParsedTransaction } from "../src/chain/rpc.js";
import { SOL_QUOTE } from "../src/core/constants.js";
import {
  curveQuoteMint,
  fromRpcTransaction,
  fromWeb3Transaction,
  parseFill,
  tokenAccountRent,
  type ConfirmedTransaction
} from "../src/execution/fillParser.js";
import { amountsFromParsed, outflowBeyondTrade, qualityOf } from "../src/execution/liveFill.js";
import { PUMP_QUOTE_MINT, confirmedFromFixture, fixture, order, type FixtureTx } from "./execution.fixtures.js";

function events(tx: FixtureTx): DecodedChainEvent[] {
  return decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 0, receivedAtMs: 0 }).events;
}

function onlyTrade(tx: FixtureTx): Extract<DecodedChainEvent, { kind: "trade" | "poolTrade" }> {
  const trades = events(tx).filter((event) => event.kind === "trade" || event.kind === "poolTrade");
  const first = trades[0];
  if (trades.length !== 1 || !first || (first.kind !== "trade" && first.kind !== "poolTrade")) {
    throw new Error("expected exactly one trade");
  }
  return first;
}

function signer(tx: FixtureTx): string {
  const key = tx.accountKeys[0];
  if (!key) {
    throw new Error("no signer");
  }
  return key;
}

describe("curve buy fill (SOL, 34N2fYTH)", () => {
  const tx = fixture("34N2fYTH");
  const trade = onlyTrade(tx);
  const mint = trade.kind === "trade" ? trade.mint : "";
  const user = signer(tx);
  const fee = 105_000n;
  const parsed = parseFill(confirmedFromFixture(tx, fee), { user, mint, pool: null });

  it("takes amounts and fees from the decoded TradeEvent", () => {
    expect(parsed.failed).toBe(false);
    expect(parsed.venue).toBe("curve");
    expect(parsed.side).toBe("buy");
    expect(parsed.tradeEvents).toBe(1);
    expect(parsed.quoteMint).toBe(SOL_QUOTE);
    expect(parsed.tokenAmount).toBe(trade.tokenAmount);
    expect(parsed.tokenAmount).toBe(245_224_727_144n);
    expect(parsed.quoteAmount).toBe(19_555_555n);
    expect(parsed.protocolFee).toBe(trade.protocolFee);
    expect(parsed.creatorFee).toBe(trade.creatorFee);
    expect(parsed.userQuote).toBe(19_800_000n);
    expect(parsed.userQuote).toBe(parsed.quoteAmount + parsed.protocolFee + parsed.creatorFee);
  });

  it("derives the token delta, the new token account rent and the residual outflow from balances", () => {
    expect(parsed.tokenDelta).toBe(parsed.tokenAmount);
    expect(parsed.solDelta).toBe(139_987_030n - 162_605_870n);
    expect(parsed.wrappedSolDelta).toBe(0n);
    expect(parsed.rentPaid).toBe(1_513_840n);
    expect(parsed.rentRefunded).toBe(0n);
    expect(parsed.networkFee).toBe(fee);
    expect(parsed.unexplainedLamports).toBe(1_200_000n);
    expect(-parsed.solDelta).toBe(parsed.userQuote + parsed.networkFee + parsed.rentPaid + parsed.unexplainedLamports);
  });

  it("builds fill amounts, counts the residual as tips and prices against the reference", () => {
    const amounts = amountsFromParsed(parsed, 0n, "buy");
    expect(amounts.tokenAmount).toBe(parsed.tokenAmount);
    expect(amounts.userQuote).toBe(19_800_000n);
    expect(outflowBeyondTrade(parsed, 0n)).toBe(1_200_000n);
    expect(outflowBeyondTrade(parsed, 2_000_000n)).toBe(2_000_000n);
    const reference = Number(parsed.userQuote) / Number(parsed.tokenAmount);
    const quality = qualityOf(order({ referencePrice: reference }), amounts, null);
    expect(quality.fillPrice).toBeCloseTo(reference, 15);
    expect(quality.slippageBps).toBe(0);
    expect(quality.priceImpactBps).toBeNull();
  });

  it("ignores trades by other wallets or for other mints", () => {
    const other = parseFill(confirmedFromFixture(tx, fee), { user: "SomeoneElse111111111111111111111111111111111", mint, pool: null });
    expect(other.tradeEvents).toBe(0);
    expect(other.side).toBeNull();
    expect(other.quoteMint).toBeNull();
    const wrongMint = parseFill(confirmedFromFixture(tx, fee), { user, mint: PUMP_QUOTE_MINT, pool: null });
    expect(wrongMint.tradeEvents).toBe(0);
  });

  it("reports nothing traded for a failed transaction but still exposes its fee", () => {
    const failed = parseFill(confirmedFromFixture(tx, 5_000n, { InstructionError: [3, { Custom: 6042 }] }), { user, mint, pool: null });
    expect(failed.failed).toBe(true);
    expect(failed.tradeEvents).toBe(0);
    expect(failed.tokenAmount).toBe(0n);
    expect(failed.networkFee).toBe(5_000n);
  });

  it("falls back to balance deltas when no event matches", () => {
    const stripped: ConfirmedTransaction = { ...confirmedFromFixture(tx, fee), logMessages: [] };
    const fallback = parseFill(stripped, { user, mint, pool: null });
    expect(fallback.tradeEvents).toBe(0);
    const amounts = amountsFromParsed(fallback, 1_200_000n, "buy");
    expect(amounts.tokenAmount).toBe(245_224_727_144n);
    expect(amounts.userQuote).toBe(19_800_000n);
    expect(outflowBeyondTrade(fallback, 1_200_000n)).toBe(1_200_000n);
  });
});

describe("curve sell fill (pump-coin quoted, Xre9uFxg)", () => {
  const tx = fixture("Xre9uFxg");
  const trade = onlyTrade(tx);
  const mint = trade.kind === "trade" ? trade.mint : "";
  const user = signer(tx);
  const parsed = parseFill(confirmedFromFixture(tx, 5_000n), { user, mint, pool: null });

  it("decodes the sell and identifies the non-SOL quote mint", () => {
    expect(parsed.side).toBe("sell");
    expect(parsed.venue).toBe("curve");
    expect(parsed.quoteMint).toBe(PUMP_QUOTE_MINT);
    expect(curveQuoteMint(tx.logs, { mint, user })).toBe(PUMP_QUOTE_MINT);
    expect(parsed.tokenAmount).toBe(1_628_902_193_410n);
    expect(parsed.tokenDelta).toBe(-parsed.tokenAmount);
    expect(parsed.quoteAmount).toBe(trade.quoteAmount);
    expect(parsed.userQuote).toBe(parsed.quoteAmount - parsed.protocolFee - parsed.creatorFee);
  });

  it("does not mix pump-coin amounts into the SOL residual", () => {
    expect(parsed.unexplainedLamports).toBe(-parsed.networkFee - parsed.solDelta - parsed.wrappedSolDelta);
    expect(outflowBeyondTrade(parsed, 0n)).toBe(0n);
  });
});

describe("pool buy fill (SOL pool, HbTsTmJR)", () => {
  const tx = fixture("HbTsTmJR");
  const trade = onlyTrade(tx);
  const pool = trade.kind === "poolTrade" ? trade.pool : "";
  const user = signer(tx);
  const baseMint = tx.postTokenBalances.find((entry) => entry.owner === user)?.mint ?? "";

  it("decodes the PumpSwap BuyEvent and reads the quote mint from the pool vaults", () => {
    const parsed = parseFill(confirmedFromFixture(tx, 5_000n), { user, mint: baseMint, pool });
    expect(baseMint.startsWith("FLQdUSx5")).toBe(true);
    expect(parsed.venue).toBe("pool");
    expect(parsed.side).toBe("buy");
    expect(parsed.quoteMint).toBe(SOL_QUOTE);
    expect(parsed.tokenAmount).toBe(54_091_443n);
    expect(parsed.tokenDelta).toBe(54_091_443n);
    expect(parsed.userQuote).toBe(48_502_040n);
    expect(parsed.lpFee).toBe(trade.lpFee);
    expect(parsed.userQuote).toBe(parsed.quoteAmount + parsed.lpFee + parsed.protocolFee + parsed.creatorFee);
    expect(parsed.solDelta).toBe(-48_507_040n);
    expect(parsed.unexplainedLamports).toBe(0n);
  });

  it("matches by user when the pool is not known in advance", () => {
    const parsed = parseFill(confirmedFromFixture(tx, 5_000n), { user, mint: baseMint, pool: null });
    expect(parsed.tradeEvents).toBe(1);
    expect(parsed.quoteMint).toBe(SOL_QUOTE);
    const wrongPool = parseFill(confirmedFromFixture(tx, 5_000n), { user, mint: baseMint, pool: "OtherPool1111111111111111111111111111111111" });
    expect(wrongPool.tradeEvents).toBe(0);
  });
});

describe("pool fills with several events and wrapped SOL", () => {
  it("sums several buys by the same user in one transaction (3XUxjmaJ)", () => {
    const tx = fixture("3XUxjmaJ");
    const trades = events(tx).filter((event) => event.kind === "poolTrade");
    const user = signer(tx);
    const baseMint = tx.postTokenBalances.find((entry) => entry.owner === user)?.mint ?? "";
    const parsed = parseFill(confirmedFromFixture(tx, 5_000n), { user, mint: baseMint, pool: null });
    expect(trades).toHaveLength(3);
    expect(parsed.tradeEvents).toBe(3);
    expect(parsed.tokenAmount).toBe(575_157n + 510_067n + 201_304n);
    expect(parsed.userQuote).toBe(14_694n + 13_030n + 5_144n);
    expect(parsed.tokenDelta).toBe(parsed.tokenAmount);
  });

  it("treats unwrapped pre-existing wSOL as the wallet's own SOL on a full pool exit (4hrCMpeN)", () => {
    const tx = fixture("4hrCMpeN");
    const trade = onlyTrade(tx);
    const user = signer(tx);
    const mint = tx.preTokenBalances.find((entry) => entry.owner === user && entry.mint.startsWith("2ib61EmZFF"))?.mint ?? "";
    const pool = trade.kind === "poolTrade" ? trade.pool : "";
    const parsed = parseFill(confirmedFromFixture(tx, 5_000n), { user, mint, pool });
    expect(parsed.side).toBe("sell");
    expect(parsed.quoteMint).toBe(SOL_QUOTE);
    expect(parsed.userQuote).toBe(1_111_859_575n);
    expect(parsed.tokenDelta).toBe(-7_446_689_282_542n);
    expect(parsed.wrappedSolDelta).toBe(-15_083_812n);
    expect(parsed.rentRefunded).toBe(1_488_440n);
    expect(parsed.rentPaid).toBe(0n);
    const valueDelta = parsed.solDelta + parsed.wrappedSolDelta;
    expect(valueDelta).toBe(parsed.userQuote + parsed.rentRefunded - parsed.networkFee - parsed.unexplainedLamports);
    expect(parsed.networkFee + parsed.unexplainedLamports).toBe(430_600n);
  });

  it("refunds the closed token account rent when the seller closes it (5Wqtq6N3)", () => {
    const tx = fixture("5Wqtq6N3");
    const user = signer(tx);
    const confirmed = confirmedFromFixture(tx, 5_000n);
    expect(tokenAccountRent(confirmed, user)).toEqual({ rentPaid: 0n, rentRefunded: 1_513_840n });
    const mint = tx.preTokenBalances.find((entry) => entry.owner === user && entry.accountIndex === 8)?.mint ?? "";
    const parsed = parseFill(confirmed, { user, mint, pool: null });
    expect(parsed.side).toBe("sell");
    expect(parsed.wrappedSolDelta).toBe(parsed.userQuote);
    expect(parsed.tokenDelta).toBe(-parsed.tokenAmount);
  });
});

describe("transaction adapters", () => {
  const tx = fixture("34N2fYTH");

  it("converts the JSON-RPC jsonParsed shape", () => {
    const rpcTx: ParsedTransaction = {
      slot: tx.slot,
      blockTime: tx.blockTime,
      meta: {
        err: null,
        fee: 105_000,
        preBalances: tx.preBalances,
        postBalances: tx.postBalances,
        logMessages: tx.logs,
        preTokenBalances: tx.preTokenBalances,
        postTokenBalances: tx.postTokenBalances
      },
      transaction: {
        signatures: [tx.signature],
        message: { accountKeys: tx.accountKeys.map((pubkey, index) => ({ pubkey, signer: index === 0, writable: true })), instructions: [] }
      }
    };
    const converted = fromRpcTransaction(tx.signature, rpcTx);
    expect(converted).toEqual(confirmedFromFixture(tx, 105_000n));
    expect(fromRpcTransaction(tx.signature, { ...rpcTx, meta: null })).toBeNull();
  });

  it("converts the web3.js ParsedTransactionWithMeta shape", () => {
    const web3Tx = {
      slot: tx.slot,
      blockTime: tx.blockTime,
      meta: {
        err: null,
        fee: 105_000,
        preBalances: tx.preBalances,
        postBalances: tx.postBalances,
        logMessages: tx.logs,
        preTokenBalances: tx.preTokenBalances,
        postTokenBalances: tx.postTokenBalances,
        computeUnitsConsumed: 120_000
      },
      transaction: {
        signatures: [tx.signature],
        message: {
          accountKeys: tx.accountKeys.map((key) => ({ pubkey: new PublicKey(key), signer: false, writable: true })),
          instructions: [],
          recentBlockhash: "x"
        }
      }
    } as unknown as ParsedTransactionWithMeta;
    const converted = fromWeb3Transaction(tx.signature, web3Tx);
    expect(converted).toEqual({ ...confirmedFromFixture(tx, 105_000n), computeUnitsConsumed: 120_000 });
  });
});
