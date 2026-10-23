import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemInstruction,
  TransactionInstruction,
  TransactionMessage
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { createRng } from "../src/core/rng.js";
import {
  associatedTokenAddress,
  budgetBeforeSdkSlippage,
  closeTokenAccountInstruction,
  fromBn,
  isSolQuoteMint,
  lessSlippage,
  sellAmount,
  slippagePercent,
  toBn,
  tokenAccountAmount,
  TOKEN_2022_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID
} from "../src/execution/instructions.js";
import {
  JITO_TIP_ACCOUNTS,
  compileTransaction,
  computeBudgetInstructions,
  microLamportsPerComputeUnit,
  pickTipAccount,
  planInstructions,
  priorityFeeLamportsFor,
  signatureOf
} from "../src/execution/transaction.js";
import { fixture } from "./execution.fixtures.js";

describe("priority fee conversion", () => {
  it("converts a lamport budget into micro-lamports per compute unit without exceeding it", () => {
    expect(microLamportsPerComputeUnit(300_000, 150_000)).toBe(2_000_000n);
    expect(microLamportsPerComputeUnit(1, 3)).toBe(333_333n);
    expect(priorityFeeLamportsFor(microLamportsPerComputeUnit(1, 3), 3)).toBe(1n);
    for (const [fee, units] of [
      [300_000, 150_000],
      [12_345, 99_999],
      [7, 200_000],
      [1_000_000, 1_400_000]
    ] as const) {
      const micro = microLamportsPerComputeUnit(fee, units);
      expect(priorityFeeLamportsFor(micro, units)).toBeLessThanOrEqual(BigInt(fee));
      expect(BigInt(fee) - priorityFeeLamportsFor(micro, units)).toBeLessThanOrEqual(1n);
    }
    expect(microLamportsPerComputeUnit(0, 100_000)).toBe(0n);
    expect(microLamportsPerComputeUnit(100, 0)).toBe(0n);
  });

  it("omits the price instruction when there is no priority fee", () => {
    const withPrice = computeBudgetInstructions(200_000, 100_000);
    expect(withPrice).toHaveLength(2);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(withPrice[0] as TransactionInstruction).units).toBe(200_000);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(withPrice[1] as TransactionInstruction).microLamports).toBe(500_000n);
    const withoutPrice = computeBudgetInstructions(200_000, 0);
    expect(withoutPrice).toHaveLength(1);
    expect(withoutPrice[0]?.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
  });
});

describe("transaction compilation", () => {
  const payer = Keypair.generate();
  const trade = new TransactionInstruction({
    programId: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.from([9, 9])
  });

  it("orders compute budget, trade and tip instructions and signs as the payer", () => {
    const tipAccount = pickTipAccount(createRng("tip"));
    const plan = {
      payer: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [trade],
      computeUnitLimit: 100_000,
      priorityFeeLamports: 50_000,
      tip: { account: tipAccount, lamports: 1_000_000n }
    };
    expect(planInstructions(plan).map((instruction) => instruction.programId.toBase58())).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      trade.programId.toBase58(),
      "11111111111111111111111111111111"
    ]);
    const transaction = compileTransaction(plan);
    expect(transaction.version).toBe(0);
    const unsigned = signatureOf(transaction);
    transaction.sign([payer]);
    expect(signatureOf(transaction)).not.toBe(unsigned);
    expect(transaction.signatures[0]?.some((byte) => byte !== 0)).toBe(true);
    const instructions = TransactionMessage.decompile(transaction.message).instructions;
    const tip = instructions.at(-1);
    expect(tip && SystemInstruction.decodeTransfer(tip).lamports).toBe(1_000_000n);
    expect(planInstructions({ ...plan, tip: null })).toHaveLength(3);
    expect(planInstructions({ ...plan, tip: { account: tipAccount, lamports: 0n } })).toHaveLength(3);
  });

  it("picks tip accounts from the Jito list across the rng range", () => {
    expect(pickTipAccount(() => 0).toBase58()).toBe(JITO_TIP_ACCOUNTS[0]);
    expect(pickTipAccount(() => 0.999999).toBase58()).toBe(JITO_TIP_ACCOUNTS[7]);
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      seen.add(pickTipAccount(createRng(`t${index}`)).toBase58());
    }
    expect(seen.size).toBe(JITO_TIP_ACCOUNTS.length);
    for (const account of JITO_TIP_ACCOUNTS) {
      expect(() => new PublicKey(account)).not.toThrow();
    }
  });
});

describe("instruction helpers", () => {
  it("derives the same associated token account as the real mainnet buy", () => {
    const tx = fixture("34N2fYTH");
    const owner = new PublicKey("2YCYwm44jVCw8CKta9XCpNKtL63HPuFwmSBUyNAEXh7n");
    const mint = new PublicKey("8yDsNzzeQqmaXydvRcq24J1YxLemVY8nFFbU4WmTFfk5");
    const ata = associatedTokenAddress(owner, mint, new PublicKey(TOKEN_2022_PROGRAM_ID));
    expect(ata.toBase58()).toBe(tx.accountKeys[3]);
    expect(associatedTokenAddress(owner, mint, new PublicKey(SPL_TOKEN_PROGRAM_ID)).equals(ata)).toBe(false);
  });

  it("builds a CloseAccount instruction that refunds rent to the owner", () => {
    const owner = Keypair.generate().publicKey;
    const account = Keypair.generate().publicKey;
    const instruction = closeTokenAccountInstruction(account, owner, new PublicKey(TOKEN_2022_PROGRAM_ID));
    expect(instruction.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID);
    expect(Array.from(instruction.data)).toEqual([9]);
    expect(instruction.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable])).toEqual([
      [account.toBase58(), false, true],
      [owner.toBase58(), false, true],
      [owner.toBase58(), true, false]
    ]);
  });

  it("reads token account amounts from raw account data", () => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(245_224_727_144n, 64);
    expect(tokenAccountAmount({ data })).toBe(245_224_727_144n);
    expect(tokenAccountAmount(null)).toBe(0n);
    expect(tokenAccountAmount({ data: Buffer.alloc(10) })).toBe(0n);
  });

  it("converts slippage between bps, SDK percent and minimum outputs", () => {
    expect(slippagePercent(1500)).toBe(15);
    expect(slippagePercent(-5)).toBe(0);
    expect(lessSlippage(10_000n, 1500)).toBe(8_500n);
    expect(lessSlippage(10_000n, 20_000)).toBe(1n);
    expect(lessSlippage(0n, 100)).toBe(0n);
    expect(lessSlippage(3n, 9_999)).toBe(1n);
    const budget = 1_000_000_000n;
    const spend = budgetBeforeSdkSlippage(budget, 1500);
    expect(spend + (spend * 150n) / 1_000n).toBeLessThanOrEqual(budget);
    expect(budgetBeforeSdkSlippage(budget, 0)).toBe(budget);
    expect(sellAmount(10n, 7n)).toBe(7n);
    expect(sellAmount(5n, 7n)).toBe(5n);
    expect(fromBn(toBn(123_456_789_012_345_678n))).toBe(123_456_789_012_345_678n);
  });

  it("recognises SOL quote mints", () => {
    expect(isSolQuoteMint(new PublicKey("So11111111111111111111111111111111111111112"))).toBe(true);
    expect(isSolQuoteMint(PublicKey.default)).toBe(true);
    expect(isSolQuoteMint(new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"))).toBe(false);
  });
});
