import { Keypair, PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { quoteBuyExactQuoteIn, quoteSell, type CurveReserves } from "../src/chain/curve.js";
import { VirtualClock } from "../src/core/clock.js";
import type { OrderRequest } from "../src/core/types.js";
import {
  DEFAULT_COMPUTE_UNIT_LIMITS,
  PumpInstructionBuilder,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TradeRefusedError,
  associatedTokenAddress,
  type BuildRequest,
  type BuiltTrade
} from "../src/execution/instructions.js";
import { loadPumpSdk, loadPumpSwapSdk } from "../src/execution/sdk.js";
import { canonicalPumpPoolAddress } from "../src/chain/pda.js";
import { SOL_QUOTE, WSOL_MINT } from "../src/core/constants.js";
import { PUMP_QUOTE_MINT, SOL, initialReserves } from "./execution.fixtures.js";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const DISCRIMINATORS = {
  global: [167, 232, 232, 177, 200, 108, 114, 127],
  feeConfig: [143, 52, 146, 187, 219, 123, 76, 155],
  bondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  buyExactQuoteInV3: [225, 247, 80, 30, 213, 179, 132, 136],
  buyV2: [184, 23, 238, 97, 103, 197, 211, 61],
  sellV3: [28, 146, 222, 119, 38, 196, 105, 213],
  sellV2: [93, 246, 130, 60, 231, 233, 64, 178]
};
const FEES = { protocolFeeBps: 95, creatorFeeBps: 30 };
const CREATOR = new PublicKey("DevWa11et1111111111111111111111111111111111");

function accountInfo(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
  return { data, owner, lamports: 2_000_000, executable: false, rentEpoch: 0 };
}

function withDiscriminator(size: number, discriminator: number[]): Buffer {
  const data = Buffer.alloc(size);
  Buffer.from(discriminator).copy(data, 0);
  return data;
}

function feeConfigData(): Buffer {
  const data = withDiscriminator(2512, DISCRIMINATORS.feeConfig);
  const tiers = 8 + 1 + 32 + 24;
  data.writeUInt32LE(1, tiers);
  const fees = tiers + 4 + 16;
  data.writeBigUInt64LE(0n, fees);
  data.writeBigUInt64LE(BigInt(FEES.protocolFeeBps), fees + 8);
  data.writeBigUInt64LE(BigInt(FEES.creatorFeeBps), fees + 16);
  return data;
}

interface CurveSpec {
  reserves?: CurveReserves;
  complete?: boolean;
  cashback?: boolean;
  quoteMint?: string;
}

function curveData(spec: CurveSpec = {}): Buffer {
  const reserves = spec.reserves ?? initialReserves();
  const data = withDiscriminator(166, DISCRIMINATORS.bondingCurve);
  data.writeBigUInt64LE(reserves.virtualTokenReserves, 8);
  data.writeBigUInt64LE(reserves.virtualQuoteReserves, 16);
  data.writeBigUInt64LE(reserves.realTokenReserves ?? 0n, 24);
  data.writeBigUInt64LE(reserves.realQuoteReserves ?? 0n, 32);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  data[48] = spec.complete ? 1 : 0;
  CREATOR.toBuffer().copy(data, 49);
  data[82] = spec.cashback ? 1 : 0;
  if (spec.quoteMint) {
    new PublicKey(spec.quoteMint).toBuffer().copy(data, 83);
  }
  return data;
}

function tokenAccountData(amount: bigint): Buffer {
  const data = Buffer.alloc(170);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}

function splMintData(): Buffer {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(1_000_000_000n, 36);
  data[44] = 6;
  data[45] = 1;
  return data;
}

class FakeChain {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly reads: string[] = [];

  set(key: PublicKey | string, info: AccountInfo<Buffer>): void {
    this.accounts.set(typeof key === "string" ? key : key.toBase58(), info);
  }

  async getAccountInfo(key: PublicKey): Promise<AccountInfo<Buffer> | null> {
    this.reads.push(key.toBase58());
    return this.accounts.get(key.toBase58()) ?? null;
  }

  async getMultipleAccountsInfo(keys: PublicKey[]): Promise<Array<AccountInfo<Buffer> | null>> {
    return keys.map((key) => {
      this.reads.push(key.toBase58());
      return this.accounts.get(key.toBase58()) ?? null;
    });
  }

  readsOf(key: PublicKey): number {
    return this.reads.filter((read) => read === key.toBase58()).length;
  }
}

interface World {
  chain: FakeChain;
  builder: PumpInstructionBuilder;
  mint: PublicKey;
  user: PublicKey;
}

function world(spec: CurveSpec = {}): World {
  const sdk = loadPumpSdk();
  const chain = new FakeChain();
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  chain.set(sdk.GLOBAL_PDA, accountInfo(withDiscriminator(1088, DISCRIMINATORS.global), PUMP_PROGRAM));
  chain.set(sdk.PUMP_FEE_CONFIG_PDA, accountInfo(feeConfigData(), sdk.PUMP_FEE_PROGRAM_ID));
  chain.set(sdk.bondingCurvePda(mint), accountInfo(curveData(spec), PUMP_PROGRAM));
  chain.set(mint, accountInfo(Buffer.alloc(82), new PublicKey(TOKEN_2022_PROGRAM_ID)));
  const builder = new PumpInstructionBuilder({ connection: chain as unknown as Connection, clock: new VirtualClock(0), configTtlMs: 60_000 });
  return { chain, builder, mint, user };
}

function request(w: World, overrides: Partial<OrderRequest> = {}, extra: Partial<BuildRequest> = {}): BuildRequest {
  return {
    order: {
      side: "buy",
      mint: w.mint.toBase58(),
      quoteBudget: SOL / 10n,
      tokenAmount: null,
      maxSlippageBps: 1500,
      reason: "test",
      urgency: "normal",
      signalSlot: 1,
      signalAtMs: 1,
      referencePrice: 0,
      positionId: null,
      closesPosition: false,
      ...overrides
    },
    user: w.user,
    slippageBps: 1500,
    closeTokenAccount: false,
    hints: { migrated: false, pool: null, tokenProgram: TOKEN_2022_PROGRAM_ID },
    ...extra
  };
}

function tradeInstruction(built: BuiltTrade, discriminator: number[]): Buffer {
  const instruction = built.instructions.find((candidate) => candidate.programId.equals(PUMP_PROGRAM));
  if (!instruction) {
    throw new Error("no pump instruction");
  }
  expect(Array.from(instruction.data.subarray(0, 8))).toEqual(discriminator);
  return instruction.data;
}

function sdkLessSlippage(amount: bigint, percent: number): bigint {
  return amount - (amount * BigInt(Math.floor(percent * 10))) / 1_000n;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TradeRefusedError) {
      return error.code;
    }
    throw error;
  }
  return "none";
}

describe("PumpInstructionBuilder curve buys", () => {
  it("builds buy_exact_quote_in_v3 with an ATA create and agrees with our curve math", async () => {
    const w = world();
    const built = await w.builder.build(request(w));
    const ours = quoteBuyExactQuoteIn(initialReserves(), SOL / 10n, FEES);
    expect(built.venue).toBe("curve");
    expect(built.instructionSet).toBe("buy_exact_quote_in_v3");
    expect(built.computeUnitLimit).toBe(DEFAULT_COMPUTE_UNIT_LIMITS.curveBuy);
    expect(built.expectedTokens).toBe(ours.tokensOut);
    expect(built.expectedQuote).toBe(SOL / 10n);
    expect(built.instructions[0]?.programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const data = tradeInstruction(built, DISCRIMINATORS.buyExactQuoteInV3);
    expect(data.readBigUInt64LE(8)).toBe(SOL / 10n);
    expect(data.readBigUInt64LE(16)).toBe(sdkLessSlippage(ours.tokensOut, 15));
  });

  it("skips the ATA create when the token account already exists and caches global config", async () => {
    const w = world();
    const ata = associatedTokenAddress(w.user, w.mint, new PublicKey(TOKEN_2022_PROGRAM_ID));
    w.chain.set(ata, accountInfo(tokenAccountData(5n), new PublicKey(TOKEN_2022_PROGRAM_ID)));
    const first = await w.builder.build(request(w));
    await w.builder.build(request(w));
    expect(first.instructions.every((instruction) => instruction.programId.equals(PUMP_PROGRAM))).toBe(true);
    expect(w.chain.readsOf(loadPumpSdk().GLOBAL_PDA)).toBe(1);
  });

  it("falls back to buy_v2 for cashback coins without exceeding the budget", async () => {
    const w = world({ cashback: true });
    const built = await w.builder.build(request(w));
    expect(built.instructionSet).toBe("buy_v2");
    const data = tradeInstruction(built, DISCRIMINATORS.buyV2);
    expect(data.readBigUInt64LE(8)).toBe(built.expectedTokens);
    expect(data.readBigUInt64LE(16)).toBeLessThanOrEqual(SOL / 10n);
    expect(data.readBigUInt64LE(16)).toBeGreaterThan((SOL / 10n) * 99n / 100n);
  });

  it("refuses a completed curve whose pool is not live", async () => {
    const w = world({ complete: true });
    expect(await refusal(w.builder.build(request(w)))).toBe("curve_complete");
  });

  it("refuses curves quoted in a pump coin", async () => {
    const w = world({ quoteMint: PUMP_QUOTE_MINT });
    w.chain.set(PUMP_QUOTE_MINT, accountInfo(splMintData(), new PublicKey(SPL_TOKEN_PROGRAM_ID)));
    expect(await refusal(w.builder.build(request(w)))).toBe("non_sol_quote");
  });

  it("rejects buys without a budget", async () => {
    const w = world();
    expect(await refusal(w.builder.build(request(w, { quoteBudget: null, tokenAmount: 5n })))).toBe("invalid_order");
  });
});

describe("PumpInstructionBuilder curve sells", () => {
  const reserves = quoteBuyExactQuoteIn(initialReserves(), 5n * SOL, FEES).after;

  function sellWorld(balance: bigint | null): World {
    const w = world({ reserves });
    if (balance !== null) {
      const ata = associatedTokenAddress(w.user, w.mint, new PublicKey(TOKEN_2022_PROGRAM_ID));
      w.chain.set(ata, accountInfo(tokenAccountData(balance), new PublicKey(TOKEN_2022_PROGRAM_ID)));
    }
    return w;
  }

  it("sells at most the wallet balance, sets min output and closes the account on a full exit", async () => {
    const balance = 40_000_000_000_000n;
    const w = sellWorld(balance);
    const built = await w.builder.build(
      request(w, { side: "sell", quoteBudget: null, tokenAmount: balance * 2n }, { slippageBps: 2000, closeTokenAccount: true })
    );
    const ours = quoteSell(reserves, balance, FEES);
    expect(built.instructionSet).toBe("sell_v3");
    expect(built.tokenAmount).toBe(balance);
    expect(built.expectedQuote).toBe(ours.netQuote);
    expect(built.computeUnitLimit).toBe(DEFAULT_COMPUTE_UNIT_LIMITS.curveSell);
    const data = tradeInstruction(built, DISCRIMINATORS.sellV3);
    expect(data.readBigUInt64LE(8)).toBe(balance);
    expect(data.readBigUInt64LE(16)).toBe(sdkLessSlippage(ours.netQuote, 20));
    expect(built.closesTokenAccount).toBe(true);
    const close = built.instructions.at(-1);
    expect(close?.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID);
    expect(Array.from(close?.data ?? [])).toEqual([9]);
  });

  it("keeps the account open on a partial sell", async () => {
    const w = sellWorld(40_000_000_000_000n);
    const built = await w.builder.build(
      request(w, { side: "sell", quoteBudget: null, tokenAmount: 10_000_000_000_000n }, { closeTokenAccount: true })
    );
    expect(built.tokenAmount).toBe(10_000_000_000_000n);
    expect(built.closesTokenAccount).toBe(false);
    expect(built.instructions.at(-1)?.programId.equals(PUMP_PROGRAM)).toBe(true);
  });

  it("uses sell_v2 for cashback coins", async () => {
    const w = world({ reserves, cashback: true });
    const ata = associatedTokenAddress(w.user, w.mint, new PublicKey(TOKEN_2022_PROGRAM_ID));
    w.chain.set(ata, accountInfo(tokenAccountData(1_000_000_000n), new PublicKey(TOKEN_2022_PROGRAM_ID)));
    const built = await w.builder.build(request(w, { side: "sell", quoteBudget: null, tokenAmount: 1_000_000_000n }));
    expect(built.instructionSet).toBe("sell_v2");
    tradeInstruction(built, DISCRIMINATORS.sellV2);
  });

  it("refuses to sell when the wallet holds nothing", async () => {
    const w = sellWorld(null);
    expect(await refusal(w.builder.build(request(w, { side: "sell", quoteBudget: null, tokenAmount: 5n })))).toBe("no_balance");
  });
});

describe("PumpInstructionBuilder token programs", () => {
  it("reads and caches the mint owner when no hint is given", async () => {
    const w = world();
    const noHint = { migrated: false, pool: null, tokenProgram: null };
    await w.builder.build(request(w, {}, { hints: noHint }));
    await w.builder.build(request(w, {}, { hints: noHint }));
    expect(w.chain.readsOf(w.mint)).toBe(1);
  });

  it("refuses unknown mints", async () => {
    const w = world();
    w.chain.accounts.delete(w.mint.toBase58());
    expect(await refusal(w.builder.build(request(w, {}, { hints: { migrated: false, pool: null, tokenProgram: null } })))).toBe(
      "invalid_order"
    );
  });

  it("refuses migrated coins whose pool cannot be loaded", async () => {
    const w = world();
    expect(await refusal(w.builder.build(request(w, {}, { hints: { migrated: true, pool: null, tokenProgram: TOKEN_2022_PROGRAM_ID } })))).toBe(
      "pool_unavailable"
    );
  });
});

describe("PumpInstructionBuilder PumpSwap pools", () => {
  function withPoolState(w: World, pool: { baseMint: PublicKey; creator: PublicKey }): PublicKey[] {
    const loaded: PublicKey[] = [];
    const fakeAmm = {
      swapSolanaState: async (poolKey: PublicKey) => {
        loaded.push(poolKey);
        return { pool: { ...pool, quoteMint: new PublicKey(WSOL_MINT) } };
      }
    };
    Object.assign(w.builder, { onlineAmm: fakeAmm });
    return loaded;
  }

  function migrated(pool: string | null): Partial<BuildRequest> {
    return { hints: { migrated: true, pool, tokenProgram: TOKEN_2022_PROGRAM_ID } };
  }

  it("refuses a pool hint that is not the canonical SOL pool of the mint without loading it", async () => {
    const w = world();
    const swapSdk = loadPumpSwapSdk();
    const loaded = withPoolState(w, { baseMint: w.mint, creator: swapSdk.pumpPoolAuthorityPda(w.mint) });
    const foreign = Keypair.generate().publicKey.toBase58();
    expect(await refusal(w.builder.build(request(w, {}, migrated(foreign))))).toBe("invalid_order");
    expect(loaded).toEqual([]);
  });

  it("loads the canonical pool even without a hint and refuses one that belongs to another mint", async () => {
    const w = world();
    const swapSdk = loadPumpSwapSdk();
    const canonical = swapSdk.canonicalPumpPoolPda(w.mint);
    expect(canonicalPumpPoolAddress(w.mint.toBase58(), SOL_QUOTE)).toBe(canonical.toBase58());
    const other = Keypair.generate().publicKey;
    const loaded = withPoolState(w, { baseMint: other, creator: swapSdk.pumpPoolAuthorityPda(other) });
    expect(await refusal(w.builder.build(request(w, {}, migrated(null))))).toBe("invalid_order");
    expect(await refusal(w.builder.build(request(w, {}, migrated(canonical.toBase58()))))).toBe("invalid_order");
    expect(loaded.map((key) => key.toBase58())).toEqual([canonical.toBase58(), canonical.toBase58()]);
  });

  it("refuses a pool whose creator is not the pump pool authority of the mint", async () => {
    const w = world();
    withPoolState(w, { baseMint: w.mint, creator: Keypair.generate().publicKey });
    expect(await refusal(w.builder.build(request(w, {}, migrated(null))))).toBe("invalid_order");
  });
});
