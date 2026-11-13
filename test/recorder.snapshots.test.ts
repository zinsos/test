import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeLogs } from "../src/chain/events.js";
import type { ParsedAccountInfo } from "../src/chain/rpc.js";
import { MarketState } from "../src/market/state.js";
import {
  computeRpcSnapshot,
  computeTradeSnapshot,
  snapshotRow,
  supplyShare,
  tokenAccountOwner,
  tradeSnapshotFromLaunch,
  type SnapshotTrade,
  type TradeSnapshotInput
} from "../src/recorder/snapshots.js";

const T0 = 1_800_000_000_000;
const SUPPLY = 1_000_000n;
const DEV = "Dev";
const CREATOR = "Creator";
const CURVE = "Curve";
const POOL = "Pool";

function trade(sec: number, wallet: string, isBuy: boolean, tokenAmount: bigint, mcapQuote = 100n): SnapshotTrade {
  return { atMs: T0 + sec * 1000, slot: 10 + sec, wallet, isBuy, venue: "curve", tokenAmount, mcapQuote };
}

function input(trades: SnapshotTrade[], overrides: Partial<TradeSnapshotInput> = {}): TradeSnapshotInput {
  return {
    checkpointSec: 30,
    createdAtMs: T0,
    createdSlot: 10,
    tokenTotalSupply: SUPPLY,
    initialMcapQuote: 28n,
    devWallets: [DEV, CREATOR],
    excludedOwners: [CURVE, POOL],
    trades,
    ...overrides
  };
}

describe("supply share", () => {
  it("is a fraction of total supply with six decimals and zero for degenerate inputs", () => {
    expect(supplyShare(250_000n, SUPPLY)).toBe(0.25);
    expect(supplyShare(1n, 3n)).toBeCloseTo(0.333333, 6);
    expect(supplyShare(0n, SUPPLY)).toBe(0);
    expect(supplyShare(-5n, SUPPLY)).toBe(0);
    expect(supplyShare(5n, 0n)).toBe(0);
  });
});

describe("trade based holder snapshot", () => {
  it("replays balances up to the checkpoint only", () => {
    const snapshot = computeTradeSnapshot(
      input([
        trade(0, DEV, true, 100_000n, 120n),
        trade(5, "A", true, 50_000n, 140n),
        trade(30, "B", true, 20_000n, 150n),
        trade(31, "C", true, 300_000n, 400n)
      ])
    );
    expect(snapshot.source).toBe("trades");
    expect(snapshot.takenAtMs).toBe(T0 + 30_000);
    expect(snapshot.holderCount).toBe(3);
    expect(snapshot.holders.map((holder) => holder.wallet)).toEqual([DEV, "A", "B"]);
    expect(snapshot.mcapQuote).toBe(150n);
    expect(snapshot.slot).toBe(40);
    expect(snapshot.top10Share).toBeCloseTo(0.17, 10);
    expect(snapshot.devShare).toBeCloseTo(0.1, 10);
    expect(snapshot.curveShare).toBeCloseTo(0.83, 10);
  });

  it("drops wallets that sold out and clamps oversold wallets to zero", () => {
    const snapshot = computeTradeSnapshot(
      input([trade(1, "A", true, 10_000n), trade(2, "A", false, 10_000n), trade(3, "B", false, 5_000n), trade(4, "C", true, 1_000n)])
    );
    expect(snapshot.holderCount).toBe(1);
    expect(snapshot.holders[0]?.wallet).toBe("C");
    expect(snapshot.curveShare).toBeCloseTo(0.999, 10);
  });

  it("counts dev wallet and creator together once each", () => {
    const snapshot = computeTradeSnapshot(
      input([trade(0, DEV, true, 100_000n), trade(1, CREATOR, true, 50_000n)], { devWallets: [DEV, CREATOR, DEV] })
    );
    expect(snapshot.devShare).toBeCloseTo(0.15, 10);
  });

  it("excludes curve and pool addresses from holders and top 10", () => {
    const snapshot = computeTradeSnapshot(input([trade(0, POOL, true, 500_000n), trade(1, "A", true, 10_000n)]));
    expect(snapshot.holders.map((holder) => holder.wallet)).toEqual(["A"]);
    expect(snapshot.top10Share).toBeCloseTo(0.01, 10);
  });

  it("limits top 10 share to ten holders and holders to top N with deterministic ties", () => {
    const trades: SnapshotTrade[] = [];
    for (let index = 0; index < 15; index += 1) {
      trades.push(trade(1, `W${String(index).padStart(2, "0")}`, true, 1_000n));
    }
    const snapshot = computeTradeSnapshot(input(trades, { topN: 12 }));
    expect(snapshot.holderCount).toBe(15);
    expect(snapshot.holders).toHaveLength(12);
    expect(snapshot.holders[0]?.wallet).toBe("W00");
    expect(snapshot.top10Share).toBeCloseTo(0.01, 10);
  });

  it("uses initial mcap and full curve share when nothing traded", () => {
    const snapshot = computeTradeSnapshot(input([]));
    expect(snapshot.holderCount).toBe(0);
    expect(snapshot.mcapQuote).toBe(28n);
    expect(snapshot.curveShare).toBe(1);
    expect(snapshot.top10Share).toBe(0);
    expect(snapshot.devShare).toBe(0);
    expect(snapshot.slot).toBe(10);
  });

  it("reports no curve share once the launch left the curve", () => {
    const poolTrade: SnapshotTrade = { ...trade(10, "A", true, 1_000n), venue: "pool" };
    expect(computeTradeSnapshot(input([poolTrade])).curveShare).toBeNull();
    expect(computeTradeSnapshot(input([trade(1, "A", true, 1n)], { completedAtMs: T0 + 20_000 })).curveShare).toBeNull();
    expect(computeTradeSnapshot(input([trade(1, "A", true, 1n)], { completedAtMs: T0 + 40_000 })).curveShare).not.toBeNull();
  });
});

describe("rpc holder snapshot", () => {
  it("maps token accounts to owners, separates the curve and excludes the pool", () => {
    const snapshot = computeRpcSnapshot({
      checkpointSec: 60,
      takenAtMs: T0 + 61_000,
      slot: 99,
      tokenTotalSupply: SUPPLY,
      bondingCurve: CURVE,
      pool: POOL,
      devWallets: [DEV, CREATOR],
      mcapQuote: 555n,
      accounts: [
        { address: "acc-curve", amount: 600_000n, owner: CURVE },
        { address: "acc-pool", amount: 100_000n, owner: POOL },
        { address: "acc-dev-1", amount: 50_000n, owner: DEV },
        { address: "acc-dev-2", amount: 30_000n, owner: DEV },
        { address: "acc-creator", amount: 20_000n, owner: CREATOR },
        { address: "acc-unknown", amount: 10_000n, owner: null },
        { address: "acc-empty", amount: 0n, owner: "Z" }
      ]
    });
    expect(snapshot.source).toBe("rpc");
    expect(snapshot.curveShare).toBeCloseTo(0.6, 10);
    expect(snapshot.holders.map((holder) => [holder.wallet, holder.amount])).toEqual([
      [DEV, 80_000n],
      [CREATOR, 20_000n],
      ["acc-unknown", 10_000n]
    ]);
    expect(snapshot.holderCount).toBe(3);
    expect(snapshot.top10Share).toBeCloseTo(0.11, 10);
    expect(snapshot.devShare).toBeCloseTo(0.1, 10);
    expect(snapshot.mcapQuote).toBe(555n);
    expect(snapshot.slot).toBe(99);
  });

  it("handles an empty account list", () => {
    const snapshot = computeRpcSnapshot({
      checkpointSec: 60,
      takenAtMs: T0,
      slot: null,
      tokenTotalSupply: SUPPLY,
      bondingCurve: CURVE,
      pool: null,
      devWallets: [DEV],
      mcapQuote: null,
      accounts: []
    });
    expect(snapshot.holderCount).toBe(0);
    expect(snapshot.curveShare).toBe(0);
    expect(snapshot.top10Share).toBe(0);
  });
});

describe("token account owner", () => {
  it("reads the owner from parsed token account data only", () => {
    const parsed: ParsedAccountInfo = {
      owner: "TokenProgram",
      lamports: 1,
      data: { program: "spl-token", parsed: { type: "account", info: { owner: "Wallet1", mint: "M" } } }
    };
    expect(tokenAccountOwner(parsed)).toBe("Wallet1");
    expect(tokenAccountOwner({ owner: "x", lamports: 1, data: ["abc", "base64"] })).toBeNull();
    expect(tokenAccountOwner({ owner: "x", lamports: 1, data: { parsed: { info: { owner: 5 } } } })).toBeNull();
    expect(tokenAccountOwner(null)).toBeNull();
    expect(tokenAccountOwner(undefined)).toBeNull();
  });
});

describe("snapshot rows", () => {
  it("serializes holders as json with string amounts", () => {
    const snapshot = computeTradeSnapshot(input([trade(0, "A", true, 10_000n)]));
    const row = snapshotRow(7, snapshot);
    expect(row[0]).toBe(7);
    expect(row[2]).toBe("trades");
    expect(row[3]).toBeInstanceOf(Date);
    expect(JSON.parse(String(row[10]))).toEqual([{ wallet: "A", amount: "10000", share: 0.01 }]);
  });
});

describe("snapshots from real launches", () => {
  it("builds a trade snapshot from a replayed pump-quoted launch", () => {
    interface FixtureTx {
      signature: string;
      slot: number;
      logs: string[];
    }
    const fixtures = JSON.parse(
      readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8")
    ) as FixtureTx[];
    const market = new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    for (const tx of [...fixtures].sort((a, b) => a.slot - b.slot)) {
      for (const event of decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 1, receivedAtMs: 0 }).events) {
        const chain = market.resolve(event);
        if (chain) {
          market.apply(chain);
        }
      }
    }
    const launch = [...market.all()].find((candidate) => candidate.mint.startsWith("Cokr"));
    expect(launch).toBeDefined();
    if (!launch) {
      return;
    }
    const early = tradeSnapshotFromLaunch(launch, 1, 50);
    const later = tradeSnapshotFromLaunch(launch, 60, 50);
    expect(early.holderCount).toBe(1);
    expect(early.devShare).toBeGreaterThan(0);
    expect(later.holderCount).toBe(3);
    expect(later.mcapQuote).toBe(launch.trades[launch.trades.length - 1]?.mcapQuote);
    expect((later.curveShare ?? 0) + (later.top10Share ?? 0)).toBeCloseTo(1, 5);
  });
});
