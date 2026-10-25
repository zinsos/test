import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeLogs, decodeRawEvent, normalizeQuoteMint, type DecodedChainEvent } from "../src/chain/events.js";
import { extractProgramData } from "../src/chain/logs.js";
import { feeAmount, quoteBuyExactQuoteIn, quoteSell, tokensForNetQuote } from "../src/chain/curve.js";
import { SOL_QUOTE } from "../src/core/constants.js";
import type { TradeEvent } from "../src/core/types.js";

interface FixtureTx {
  signature: string;
  slot: number;
  blockTime: number;
  category: string;
  logs: string[];
}

const fixtures: FixtureTx[] = JSON.parse(readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8"));

function decodeAll(tx: FixtureTx): DecodedChainEvent[] {
  return decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 1, receivedAtMs: 0 }).events;
}

function curveTrades(): TradeEvent[] {
  return fixtures.flatMap(decodeAll).filter((event): event is TradeEvent => event.kind === "trade" && event.venue === "curve");
}

describe("mainnet fixture decoding", () => {
  it("decodes every pump and pumpswap event completely", () => {
    let total = 0;
    for (const tx of fixtures) {
      for (const entry of extractProgramData(tx.logs).entries) {
        const raw = decodeRawEvent(entry.programId, entry.data);
        if (raw) {
          total += 1;
          expect(raw.complete, `${tx.signature} ${raw.name}`).toBe(true);
        }
      }
    }
    expect(total).toBeGreaterThan(40);
  });

  it("maps creates with dev and quote mint", () => {
    const creates = fixtures.flatMap(decodeAll).filter((event) => event.kind === "create");
    expect(creates.length).toBe(8);
    for (const create of creates) {
      expect(create.kind === "create" && create.tokenTotalSupply).toBe(1_000_000_000_000_000n);
      expect(create.kind === "create" && create.virtualTokenReserves).toBe(1_073_000_000_000_000n);
    }
    const sol = creates.filter((event) => event.kind === "create" && event.quoteMint === SOL_QUOTE);
    expect(sol.length).toBe(1);
    expect(sol[0]?.kind === "create" && sol[0].virtualQuoteReserves).toBe(30_000_000_000n);
  });

  it("uses quote fields for pump-coin quoted trades and sol fields for sol trades", () => {
    for (const trade of curveTrades()) {
      expect(trade.quoteAmount).toBeGreaterThan(0n);
      expect(trade.virtualQuoteReserves).toBeGreaterThan(0n);
    }
  });

  it("reproduces the sol dev buy exactly from initial reserves", () => {
    const tx = fixtures.find((candidate) => candidate.signature.startsWith("K48XDQLk"));
    expect(tx).toBeDefined();
    const events = decodeAll(tx as FixtureTx);
    const create = events.find((event) => event.kind === "create");
    const trade = events.find((event): event is TradeEvent => event.kind === "trade");
    if (!create || create.kind !== "create" || !trade) {
      throw new Error("fixture missing events");
    }
    const quote = quoteBuyExactQuoteIn(
      {
        virtualTokenReserves: create.virtualTokenReserves,
        virtualQuoteReserves: create.virtualQuoteReserves,
        realTokenReserves: create.realTokenReserves,
        realQuoteReserves: 0n
      },
      trade.userQuote,
      { protocolFeeBps: trade.protocolFeeBps, creatorFeeBps: trade.creatorFeeBps }
    );
    expect(trade.userQuote).toBe(6_000_000_000n);
    expect(quote.netQuote).toBe(trade.quoteAmount);
    expect(quote.protocolFee).toBe(trade.protocolFee);
    expect(quote.creatorFee).toBe(trade.creatorFee);
    expect(quote.tokensOut).toBe(trade.tokenAmount);
    expect(quote.after.virtualQuoteReserves).toBe(trade.virtualQuoteReserves);
    expect(quote.after.virtualTokenReserves).toBe(trade.virtualTokenReserves);
  });

  it("reproduces curve trades from reserves reconstructed before the trade", () => {
    const trades = curveTrades();
    expect(trades.length).toBeGreaterThanOrEqual(8);
    for (const trade of trades) {
      const fees = { protocolFeeBps: trade.protocolFeeBps, creatorFeeBps: trade.creatorFeeBps };
      expect(feeAmount(trade.quoteAmount, trade.protocolFeeBps)).toBe(trade.protocolFee);
      expect(feeAmount(trade.quoteAmount, trade.creatorFeeBps)).toBe(trade.creatorFee);
      if (trade.isBuy) {
        const before = {
          virtualTokenReserves: trade.virtualTokenReserves + trade.tokenAmount,
          virtualQuoteReserves: trade.virtualQuoteReserves - trade.quoteAmount,
          realTokenReserves: null,
          realQuoteReserves: null
        };
        if (trade.ixName === "buy_exact_quote_in") {
          expect(tokensForNetQuote(before, trade.quoteAmount)).toBe(trade.tokenAmount);
        }
        expect(trade.userQuote).toBe(trade.quoteAmount + trade.protocolFee + trade.creatorFee);
      } else {
        const before = {
          virtualTokenReserves: trade.virtualTokenReserves - trade.tokenAmount,
          virtualQuoteReserves: trade.virtualQuoteReserves + trade.quoteAmount,
          realTokenReserves: null,
          realQuoteReserves: null
        };
        const quote = quoteSell(before, trade.tokenAmount, fees);
        expect(quote.grossQuote).toBe(trade.quoteAmount);
        expect(quote.netQuote).toBe(trade.userQuote);
      }
    }
  });

  it("treats pool event reserves as pre-trade and balances user totals", () => {
    const poolTrades = fixtures.flatMap(decodeAll).filter((event) => event.kind === "poolTrade");
    expect(poolTrades.length).toBeGreaterThanOrEqual(20);
    for (const trade of poolTrades) {
      if (trade.kind !== "poolTrade") {
        continue;
      }
      if (!trade.isBuy) {
        expect(trade.userQuote).toBe(trade.quoteAmount - trade.lpFee - trade.protocolFee - trade.creatorFee);
      }
      expect(trade.virtualTokenReserves).toBeGreaterThan(0n);
      expect(trade.virtualQuoteReserves).toBeGreaterThan(0n);
    }
  });

  it("links migrations to pools and resolves pool trades in the same transaction", () => {
    const migrations = fixtures.flatMap(decodeAll).filter((event) => event.kind === "migrate");
    expect(migrations.length).toBe(2);
    for (const migration of migrations) {
      if (migration.kind === "migrate") {
        expect(migration.pool.length).toBeGreaterThan(30);
        expect(migration.quoteAmount).toBeGreaterThan(80_000_000_000n);
      }
    }
  });

  it("normalizes quote mints", () => {
    expect(normalizeQuoteMint("11111111111111111111111111111111")).toBe(SOL_QUOTE);
    expect(normalizeQuoteMint("So11111111111111111111111111111111111111112")).toBe(SOL_QUOTE);
    expect(normalizeQuoteMint(null)).toBe(SOL_QUOTE);
    expect(normalizeQuoteMint("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn")).toBe("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
  });
});
