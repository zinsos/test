import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction
} from "@solana/web3.js";
import type { Rng } from "../core/rng.js";

export const JITO_TIP_ACCOUNTS: readonly string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
];

export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

export interface TipTransfer {
  account: PublicKey;
  lamports: bigint;
}

export interface TransactionPlan {
  payer: PublicKey;
  recentBlockhash: string;
  instructions: readonly TransactionInstruction[];
  computeUnitLimit: number;
  priorityFeeLamports: number | bigint;
  tip: TipTransfer | null;
}

export function microLamportsPerComputeUnit(priorityFeeLamports: number | bigint, computeUnitLimit: number): bigint {
  const fee = BigInt(priorityFeeLamports);
  if (computeUnitLimit <= 0 || fee <= 0n) {
    return 0n;
  }
  return (fee * MICRO_LAMPORTS_PER_LAMPORT) / BigInt(Math.floor(computeUnitLimit));
}

export function priorityFeeLamportsFor(microLamportsPerUnit: bigint, computeUnitLimit: number): bigint {
  const total = microLamportsPerUnit * BigInt(Math.floor(computeUnitLimit));
  return (total + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
}

export function computeBudgetInstructions(computeUnitLimit: number, priorityFeeLamports: number | bigint): TransactionInstruction[] {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: Math.floor(computeUnitLimit) })];
  const microLamports = microLamportsPerComputeUnit(priorityFeeLamports, computeUnitLimit);
  if (microLamports > 0n) {
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  return instructions;
}

export function pickTipAccount(rng: Rng): PublicKey {
  const index = Math.min(JITO_TIP_ACCOUNTS.length - 1, Math.floor(rng() * JITO_TIP_ACCOUNTS.length));
  return new PublicKey(JITO_TIP_ACCOUNTS[index] ?? JITO_TIP_ACCOUNTS[0] ?? "");
}

export function planInstructions(plan: TransactionPlan): TransactionInstruction[] {
  const instructions = [...computeBudgetInstructions(plan.computeUnitLimit, plan.priorityFeeLamports), ...plan.instructions];
  if (plan.tip && plan.tip.lamports > 0n) {
    instructions.push(SystemProgram.transfer({ fromPubkey: plan.payer, toPubkey: plan.tip.account, lamports: plan.tip.lamports }));
  }
  return instructions;
}

export function compileTransaction(plan: TransactionPlan): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: plan.payer,
    recentBlockhash: plan.recentBlockhash,
    instructions: planInstructions(plan)
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export function signatureOf(transaction: VersionedTransaction): string {
  const signature = transaction.signatures[0];
  if (!signature) {
    throw new Error("transaction has no signature slot");
  }
  return bs58.encode(signature);
}
