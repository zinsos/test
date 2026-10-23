import { describe, expect, it } from "vitest";
import type { ParsedTransaction, SignatureInfo } from "../../src/chain/rpc.js";
import { VirtualClock } from "../../src/core/clock.js";
import { WalletIntelService, type IntelRpc } from "../../src/scorer/intel.js";
import { scorerConfig, T0 } from "../scorer.fixtures.js";

const HOUR = 3_600_000;

class GrowingHistoryRpc implements IntelRpc {
  readonly history: SignatureInfo[] = [];

  push(signature: string): void {
    this.history.unshift({ signature, slot: this.history.length + 1, blockTime: Math.floor(T0 / 1000), err: null });
  }

  async getSignaturesForAddress(_address: string, options: { before?: string; limit?: number }): Promise<SignatureInfo[]> {
    const start = options.before ? this.history.findIndex((info) => info.signature === options.before) + 1 : 0;
    return this.history.slice(start, start + (options.limit ?? 1000));
  }

  async getParsedTransaction(): Promise<ParsedTransaction | null> {
    return null;
  }
}

describe("review: wallet freshness is cached per wallet, not per buy", () => {
  it("does not report a wallet as fresh for a launch it buys after 40 further transactions", async () => {
    const rpc = new GrowingHistoryRpc();
    rpc.push("funding");
    rpc.push("buy-A");
    const clock = new VirtualClock(T0);
    const service = new WalletIntelService({ db: null, rpc, clock, config: scorerConfig() });
    const first = await service.ensure([{ wallet: "W", buySignature: "buy-A", buySlot: 2 }], clock.nowMs() + 8_000);
    expect(first.get("W")?.priorTxCount).toBe(1);
    for (let index = 0; index < 40; index += 1) {
      rpc.push(`trade-${index}`);
    }
    rpc.push("buy-B");
    clock.advanceTo(T0 + 20 * HOUR);
    const second = await service.ensure([{ wallet: "W", buySignature: "buy-B", buySlot: 50 }], clock.nowMs() + 8_000);
    expect(second.get("W")?.checkedBeforeSignature).toBe("buy-B");
    expect(second.get("W")?.priorTxCapped).toBe(true);
  });
});
