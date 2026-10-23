import { describe, expect, it } from "vitest";
import type { ParsedTransaction, SignatureInfo } from "../../src/chain/rpc.js";
import { VirtualClock } from "../../src/core/clock.js";
import { SYSTEM_PROGRAM_ID } from "../../src/core/constants.js";
import { buildFundingClusters } from "../../src/scorer/clusters.js";
import { WalletIntelService, type IntelRpc } from "../../src/scorer/intel.js";
import { scorerConfig, T0 } from "../scorer.fixtures.js";

const BLOCK_TIME = Math.floor(T0 / 1000);

class AtomicFundAndBuyRpc implements IntelRpc {
  async getSignaturesForAddress(address: string, options: { before?: string; limit?: number }): Promise<SignatureInfo[]> {
    const history: SignatureInfo[] = [{ signature: `buy-${address}`, slot: 2_000, blockTime: BLOCK_TIME, err: null }];
    const start = options.before ? history.findIndex((info) => info.signature === options.before) + 1 : 0;
    return history.slice(start, start + (options.limit ?? 1000));
  }

  async getParsedTransaction(signature: string): Promise<ParsedTransaction | null> {
    const wallet = signature.slice("buy-".length);
    return {
      slot: 2_000,
      blockTime: BLOCK_TIME,
      meta: { err: null, fee: 5_000, preBalances: [], postBalances: [], innerInstructions: [] },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [],
          instructions: [
            {
              programId: SYSTEM_PROGRAM_ID,
              program: "system",
              parsed: { type: "transfer", info: { source: "BundleMaster", destination: wallet, lamports: 1_000_000_000 } }
            },
            { programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", data: "buy" }
          ]
        }
      }
    };
  }
}

describe("review: wallets funded inside their own buy transaction are never linked", () => {
  it("finds the funder of a zero-history wallet whose SOL arrived in the buy transaction", async () => {
    const clock = new VirtualClock(T0);
    const service = new WalletIntelService({ db: null, rpc: new AtomicFundAndBuyRpc(), clock, config: scorerConfig() });
    const wallets = ["Fresh0", "Fresh1", "Fresh2", "Fresh3", "Fresh4"];
    const intel = await service.ensure(
      wallets.map((wallet) => ({ wallet, buySignature: `buy-${wallet}`, buySlot: 2_000 })),
      clock.nowMs() + 8_000
    );
    expect(intel.get("Fresh0")?.priorTxCount).toBe(0);
    expect(intel.get("Fresh0")?.funder).toBe("BundleMaster");
    const clusters = buildFundingClusters({ buyers: wallets, devWallets: ["DevWallet"], intel });
    expect(clusters.clusters[0]?.buyers.length ?? 0).toBe(5);
  });
});
