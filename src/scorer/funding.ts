import type { ParsedInstruction, ParsedTransaction } from "../chain/rpc.js";
import { SYSTEM_PROGRAM_ID } from "../core/constants.js";
import type { Pubkey } from "../core/types.js";

export interface IncomingTransfer {
  source: Pubkey;
  lamports: bigint;
  kind: string;
}

const RECIPIENT_FIELD: Record<string, string> = {
  transfer: "destination",
  transferWithSeed: "destination",
  createAccount: "newAccount",
  createAccountWithSeed: "newAccount"
};

function isSystemInstruction(instruction: ParsedInstruction): boolean {
  return instruction.programId === SYSTEM_PROGRAM_ID || instruction.program === "system";
}

function lamportsOf(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "bigint" && value >= 0n) {
    return value;
  }
  return null;
}

export function transferToWallet(instruction: ParsedInstruction, wallet: Pubkey): IncomingTransfer | null {
  if (!isSystemInstruction(instruction) || typeof instruction.parsed !== "object" || instruction.parsed === null) {
    return null;
  }
  const type = instruction.parsed.type ?? "";
  const recipientField = RECIPIENT_FIELD[type];
  const info = instruction.parsed.info;
  if (!recipientField || !info || info[recipientField] !== wallet) {
    return null;
  }
  const source = info.source;
  const lamports = lamportsOf(info.lamports);
  if (typeof source !== "string" || source === wallet || lamports === null) {
    return null;
  }
  return { source, lamports, kind: type };
}

export function allInstructions(tx: ParsedTransaction): ParsedInstruction[] {
  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
  return [...outer, ...inner];
}

export function incomingTransfers(tx: ParsedTransaction, wallet: Pubkey): IncomingTransfer[] {
  const transfers: IncomingTransfer[] = [];
  for (const instruction of allInstructions(tx)) {
    const transfer = transferToWallet(instruction, wallet);
    if (transfer) {
      transfers.push(transfer);
    }
  }
  return transfers;
}

export function fundingTransfer(tx: ParsedTransaction, wallet: Pubkey, minLamports: bigint): IncomingTransfer | null {
  if (tx.meta?.err) {
    return null;
  }
  let best: IncomingTransfer | null = null;
  for (const transfer of incomingTransfers(tx, wallet)) {
    if (transfer.lamports >= minLamports && (!best || transfer.lamports > best.lamports)) {
      best = transfer;
    }
  }
  return best;
}
