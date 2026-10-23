import { describe, expect, it } from "vitest";
import { buildFundingClusters, UnionFind } from "../src/scorer/clusters.js";
import type { WalletIntel } from "../src/scorer/types.js";
import { intelEntry } from "./scorer.fixtures.js";

function intelMap(entries: Array<[string, Partial<WalletIntel>]>): Map<string, WalletIntel> {
  return new Map(entries.map(([wallet, overrides]) => [wallet, intelEntry(wallet, overrides)]));
}

describe("UnionFind", () => {
  it("joins and finds roots with path compression", () => {
    const uf = new UnionFind();
    uf.union("a", "b");
    uf.union("c", "d");
    expect(uf.find("a")).toBe(uf.find("b"));
    expect(uf.find("a")).not.toBe(uf.find("c"));
    uf.union("b", "d");
    expect(uf.find("a")).toBe(uf.find("c"));
    expect(uf.has("e")).toBe(false);
    expect(uf.find("e")).toBe("e");
    expect(uf.has("e")).toBe(true);
  });
});

describe("buildFundingClusters", () => {
  it("links wallets funded by the same non-hub funder", () => {
    const result = buildFundingClusters({
      buyers: ["a", "b", "c", "d"],
      devWallets: ["dev"],
      intel: intelMap([
        ["a", { funder: "F" }],
        ["b", { funder: "F" }],
        ["c", { funder: "F" }],
        ["d", { funder: "G" }]
      ])
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.buyers.sort()).toEqual(["a", "b", "c"]);
    expect(result.clusters[0]?.containsDev).toBe(false);
    expect(result.clusters[0]?.funders).toEqual(["F"]);
    expect(result.devFundedBuyers).toEqual([]);
    expect(result.linkedWallets.has("d")).toBe(false);
  });

  it("never links through hubs flagged by intel or by the isHub callback", () => {
    const flagged = buildFundingClusters({
      buyers: ["a", "b", "c"],
      devWallets: ["dev"],
      intel: intelMap([
        ["a", { funder: "Binance", funderIsHub: true }],
        ["b", { funder: "Binance", funderIsHub: true }],
        ["c", { funder: "Binance", funderIsHub: true }]
      ])
    });
    expect(flagged.clusters).toEqual([]);
    const callback = buildFundingClusters({
      buyers: ["a", "b"],
      devWallets: ["dev"],
      intel: intelMap([
        ["a", { funder: "Kraken" }],
        ["b", { funder: "Kraken" }]
      ]),
      isHub: (address) => address === "Kraken"
    });
    expect(callback.clusters).toEqual([]);
  });

  it("links buyers funded by a dev wallet even if the dev looks like a hub", () => {
    const result = buildFundingClusters({
      buyers: ["a", "b"],
      devWallets: ["dev", "creator"],
      intel: intelMap([
        ["a", { funder: "creator", funderIsHub: true }],
        ["b", { funder: "unrelated" }]
      ])
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.containsDev).toBe(true);
    expect(result.clusters[0]?.members.sort()).toEqual(["a", "creator", "dev"]);
    expect(result.clusters[0]?.buyers).toEqual(["a"]);
    expect(result.devFundedBuyers).toEqual(["a"]);
  });

  it("links a buyer that funded the dev", () => {
    const result = buildFundingClusters({
      buyers: ["a", "b"],
      devWallets: ["dev"],
      intel: intelMap([["dev", { funder: "b" }]])
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.buyers).toEqual(["b"]);
    expect(result.devFundedBuyers).toEqual(["b"]);
  });

  it("links a buyer funded by another early buyer", () => {
    const result = buildFundingClusters({
      buyers: ["a", "b", "c"],
      devWallets: ["dev"],
      intel: intelMap([
        ["b", { funder: "a" }],
        ["c", { funder: "b" }]
      ])
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.buyers.sort()).toEqual(["a", "b", "c"]);
  });

  it("does not report a cluster made only of dev wallets", () => {
    const result = buildFundingClusters({
      buyers: ["a"],
      devWallets: ["dev", "creator"],
      intel: intelMap([["creator", { funder: "dev" }]])
    });
    expect(result.clusters).toEqual([]);
  });

  it("ignores self funding, missing intel and dev wallets listed as buyers", () => {
    const result = buildFundingClusters({
      buyers: ["a", "b", "dev", "a"],
      devWallets: ["dev"],
      intel: intelMap([
        ["a", { funder: "a" }],
        ["b", { funder: null }]
      ])
    });
    expect(result.clusters).toEqual([]);
    expect(result.devFundedBuyers).toEqual([]);
  });

  it("sorts clusters by buyer count", () => {
    const result = buildFundingClusters({
      buyers: ["a", "b", "c", "d", "e"],
      devWallets: ["dev"],
      intel: intelMap([
        ["a", { funder: "X" }],
        ["b", { funder: "X" }],
        ["c", { funder: "Y" }],
        ["d", { funder: "Y" }],
        ["e", { funder: "Y" }]
      ])
    });
    expect(result.clusters.map((cluster) => cluster.buyers.length)).toEqual([3, 2]);
  });
});
