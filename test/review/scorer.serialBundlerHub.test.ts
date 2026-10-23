import { describe, expect, it } from "vitest";
import type { ParsedTransaction, SignatureInfo } from "../../src/chain/rpc.js";
import { VirtualClock } from "../../src/core/clock.js";
import { SYSTEM_PROGRAM_ID } from "../../src/core/constants.js";
import { buildFundingClusters } from "../../src/scorer/clusters.js";
import { WalletIntelService, type IntelRpc } from "../../src/scorer/intel.js";
import { scorerConfig, T0 } from "../scorer.fixtures.js";

class FundedByMasterRpc implements IntelRpc {
  async getSignaturesForAddress(address: string): Promise<SignatureInfo[]> {
    return [{ signature: `fund-${address}`, slot: 1_000, blockTime: Math.floor(T0 / 1000) - 600, err: null }];
  }

  async getParsedTransaction(signature: string): Promise<ParsedTransaction | null> {
    const wallet = signature.slice("fund-".length);
    return {
      slot: 1_000,
      blockTime: Math.floor(T0 / 1000) - 600,
      meta: { err: null, fee: 5_000, preBalances: [], postBalances: [], innerInstructions: [] },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [],
          instructions: [
            {
              programId: SYSTEM_PROGRAM_ID,
              program: "system",
              parsed: { type: "transfer", info: { source: "SerialBundlerMaster", destination: wallet, lamports: 500_000_000 } }
            }
          ]
        }
      }
    };
  }
}

describe("review: a serial bundler's funding wallet is reclassified as a hub and its clusters disappear", () => {
  it("still links the ninth launch's five bundle wallets to their shared non-exchange funder", async () => {
    const config = scorerConfig();
    const clock = new VirtualClock(T0);
    const service = new WalletIntelService({ db: null, rpc: new FundedByMasterRpc(), clock, config });
    for (let launch = 0; launch < 8; launch += 1) {
      const wallets = Array.from({ length: 5 }, (_, index) => `L${launch}W${index}`);
      await service.ensure(
        wallets.map((wallet) => ({ wallet, buySignature: `buy-${wallet}`, buySlot: 2_000 })),
        clock.nowMs() + 8_000
      );
      clock.advanceTo(clock.nowMs() + 15 * 60_000);
    }
    const ninth = Array.from({ length: 5 }, (_, index) => `L8W${index}`);
    const intel = await service.ensure(
      ninth.map((wallet) => ({ wallet, buySignature: `buy-${wallet}`, buySlot: 2_000 })),
      clock.nowMs() + 8_000
    );
    expect(intel.get("L8W0")?.funder).toBe("SerialBundlerMaster");
    const result = buildFundingClusters({ buyers: ninth, devWallets: ["DevWallet"], intel });
    expect(intel.get("L8W0")?.funderIsHub).toBe(false);
    expect(result.clusters[0]?.buyers.length ?? 0).toBe(5);
  });
});
