import { Keypair, SystemInstruction, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SweeperConfigSchema } from "../../src/config/strategy.js";
import { VirtualClock } from "../../src/core/clock.js";
import { HotColdSweeper, hotFloorLamports, type SweeperConnection } from "../../src/risk/sweeper.js";

const FEE = 5_000n;

class FakeChain {
  balance: bigint;
  sends = 0;

  constructor(balance: bigint) {
    this.balance = balance;
  }

  connection(): SweeperConnection {
    return {
      getBalance: async () => Number(this.balance),
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }),
      sendRawTransaction: async (raw: Uint8Array | Buffer | number[]) => {
        const tx = VersionedTransaction.deserialize(Uint8Array.from(raw as Uint8Array));
        const message = TransactionMessage.decompile(tx.message);
        const transfer = message.instructions[0];
        const lamports = transfer ? SystemInstruction.decodeTransfer(transfer).lamports : 0n;
        if (this.balance < lamports + FEE) {
          throw new Error("insufficient funds");
        }
        this.balance -= lamports + FEE;
        this.sends += 1;
        return "sig";
      },
      confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } })
    } as unknown as SweeperConnection;
  }
}

describe("review live: two sweepers of the same hot wallet both sweep the same excess", () => {
  it("never leaves the hot wallet below hotTargetSol + reserveSol", async () => {
    const config = SweeperConfigSchema.parse({ enabled: true, hotTargetSol: 5, reserveSol: 0.1, minSweepSol: 0.25 });
    const floor = hotFloorLamports(config);
    const chain = new FakeChain(6_000_000_000n);
    const hotKeypair = Keypair.generate();
    const coldAddress = Keypair.generate().publicKey.toBase58();
    const db = { query: async () => ({ rows: [{ id: 1n }] }) };
    const make = (): HotColdSweeper =>
      new HotColdSweeper({
        connection: chain.connection(),
        hotKeypair,
        coldAddress,
        config,
        db: db as never,
        clock: new VirtualClock(0),
        dryRun: false,
        isBusy: () => false
      });
    const service = make();
    const cli = make();
    await Promise.all([service.tick(), cli.tick()]);
    expect(chain.sends).toBeGreaterThan(0);
    expect(chain.balance).toBeGreaterThanOrEqual(floor);
  });
});
