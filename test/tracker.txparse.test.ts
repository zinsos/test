import { describe, expect, it } from "vitest";
import { WSOL_MINT } from "../src/core/constants.js";
import {
  curveQuoteMints,
  extractWalletTrades,
  tokenDeltasForOwner,
  transactionInputFromParsed,
  type TokenBalanceInput
} from "../src/tracker/txParse.js";
import { asInput, asParsed, fixture, fixtures, signerOf as signer } from "./tracker.fixtures.js";

const PUMP_COIN = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("transaction parsing for wallet history", () => {
  it("resolves a canonical SOL pool buy from the pool vaults", () => {
    const tx = fixture("4cMbR6jb");
    const result = extractWalletTrades(asInput(tx), signer(tx));
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade?.venue).toBe("pool");
    expect(trade?.isBuy).toBe(true);
    expect(trade?.mint.startsWith("Bu5K2w")).toBe(true);
    expect(trade?.quoteMint).toBe("SOL");
    expect(trade?.tokenAmount).toBe(4_258_562_794_036n);
    expect(trade?.userQuote).toBe(2_031_319_518n);
    expect(trade?.atMs).toBe(tx.blockTime * 1000);
    expect(trade?.signature).toBe(tx.signature);
  });

  it("matches the wallet token delta of the resolved mint for pool trades", () => {
    for (const prefix of ["4cMbR6jb", "LgA9SRv6", "5AEMQEMz", "4hrCMpeN", "5Wqtq6N3"]) {
      const tx = fixture(prefix);
      const wallet = signer(tx);
      const [trade] = extractWalletTrades(asInput(tx), wallet).trades;
      const delta = tokenDeltasForOwner(tx.preTokenBalances, tx.postTokenBalances, wallet).get(trade?.mint ?? "");
      expect(delta, prefix).toBe(trade?.isBuy ? trade.tokenAmount : -(trade?.tokenAmount ?? 0n));
    }
  });

  it("aggregates several trades on one pool in a single transaction", () => {
    const tx = fixture("3XUxjmaJ");
    const result = extractWalletTrades(asInput(tx), signer(tx));
    expect(result.trades.map((trade) => trade.tokenAmount)).toEqual([575_157n, 510_067n, 201_304n]);
    expect(result.trades.map((trade) => trade.eventIndex)).toEqual([0, 1, 2]);
    expect(new Set(result.trades.map((trade) => trade.mint)).size).toBe(1);
  });

  it("inverts pools whose base mint is wrapped SOL", () => {
    const tx = fixture("59D8jt8W");
    const wallet = signer(tx);
    const [trade] = extractWalletTrades(asInput(tx), wallet).trades;
    expect(trade?.isBuy).toBe(true);
    expect(trade?.quoteMint).toBe("SOL");
    expect(trade?.mint).not.toBe(WSOL_MINT);
    expect(trade?.userQuote).toBe(4_618_560n);
    const deltas = tokenDeltasForOwner(tx.preTokenBalances, tx.postTokenBalances, wallet);
    expect(deltas.get(trade?.mint ?? "")).toBe(trade?.tokenAmount);
    expect(deltas.get(WSOL_MINT)).toBe(-4_618_560n);
  });

  it("keeps only trades made by the requested wallet", () => {
    const tx = fixture("4yx7mN5X");
    const mine = extractWalletTrades(asInput(tx), signer(tx)).trades;
    expect(mine).toHaveLength(1);
    expect(mine[0]?.isBuy).toBe(true);
    expect(extractWalletTrades(asInput(tx), "SomeoneElse111111111111111111111111111111111").trades).toEqual([]);
  });

  it("uses the pool creation event for migration transactions", () => {
    const tx = fixture("GK5Z3vZ6");
    const [trade] = extractWalletTrades(asInput(tx), signer(tx)).trades;
    expect(trade?.venue).toBe("pool");
    expect(trade?.mint.startsWith("66CFbD")).toBe(true);
    expect(trade?.quoteMint).toBe("SOL");
    expect(trade?.tokenAmount).toBe(300_000_000_000n);
  });

  it("takes curve quote mints from the trade event", () => {
    const sol = fixture("K48XDQLk");
    const [solTrade] = extractWalletTrades(asInput(sol), signer(sol)).trades;
    expect(solTrade?.venue).toBe("curve");
    expect(solTrade?.quoteMint).toBe("SOL");
    expect(solTrade?.userQuote).toBe(6_000_000_000n);
    const pump = fixture("2Jgi7QN6");
    const [pumpTrade] = extractWalletTrades(asInput(pump), signer(pump)).trades;
    expect(pumpTrade?.quoteMint).toBe(PUMP_COIN);
    expect(curveQuoteMints(pump.logs).get(pumpTrade?.mint ?? "")).toBe(PUMP_COIN);
  });

  it("records a pump coin bought through a USDC pool and spent on the curve", () => {
    const tx = fixture("4K4iSwph");
    const trades = extractWalletTrades(asInput(tx), signer(tx)).trades;
    expect(trades).toHaveLength(2);
    const pool = trades.find((trade) => trade.venue === "pool");
    const curve = trades.find((trade) => trade.venue === "curve");
    expect(pool?.mint).toBe(PUMP_COIN);
    expect(pool?.quoteMint).toBe(USDC);
    expect(curve?.quoteMint).toBe(PUMP_COIN);
  });

  it("decodes every fixture without throwing and never returns WSOL as the traded mint", () => {
    let total = 0;
    for (const tx of fixtures) {
      const result = extractWalletTrades(asInput(tx), signer(tx));
      for (const trade of result.trades) {
        expect(trade.mint).not.toBe(WSOL_MINT);
        expect(trade.tokenAmount).toBeGreaterThan(0n);
        total += 1;
      }
    }
    expect(total).toBeGreaterThanOrEqual(30);
  });

  it("converts parsed rpc transactions and drops failed ones", () => {
    const tx = fixture("4cMbR6jb");
    const input = transactionInputFromParsed(tx.signature, asParsed(tx));
    expect(input?.blockTimeMs).toBe(tx.blockTime * 1000);
    expect(input?.logs).toHaveLength(tx.logs.length);
    const failed = asParsed(tx);
    if (failed.meta) {
      failed.meta.err = { InstructionError: [0, "Custom"] };
    }
    expect(transactionInputFromParsed(tx.signature, failed)).toBeNull();
    expect(transactionInputFromParsed(tx.signature, { ...asParsed(tx), meta: null })).toBeNull();
  });

  it("computes token deltas including closed accounts", () => {
    const pre: TokenBalanceInput[] = [
      { accountIndex: 1, mint: "A", owner: "W", uiTokenAmount: { amount: "100" } },
      { accountIndex: 2, mint: "B", owner: "W", uiTokenAmount: { amount: "50" } },
      { accountIndex: 3, mint: "A", owner: "X", uiTokenAmount: { amount: "7" } }
    ];
    const post: TokenBalanceInput[] = [
      { accountIndex: 1, mint: "A", owner: "W", uiTokenAmount: { amount: "160" } },
      { accountIndex: 4, mint: "C", owner: "W", uiTokenAmount: { amount: "9" } }
    ];
    const deltas = tokenDeltasForOwner(pre, post, "W");
    expect(deltas.get("A")).toBe(60n);
    expect(deltas.get("B")).toBe(-50n);
    expect(deltas.get("C")).toBe(9n);
  });
});
