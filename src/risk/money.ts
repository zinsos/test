import { LAMPORTS_PER_SOL } from "../core/constants.js";

const SCALE = 1_000_000_000n;
const SCALE_NUMBER = 1_000_000_000;

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol <= 0) {
    return 0n;
  }
  return BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL)));
}

export function lamportsToSolNumber(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

export function scaleLamports(amount: bigint, fraction: number): bigint {
  if (amount <= 0n || !Number.isFinite(fraction) || fraction <= 0) {
    return 0n;
  }
  return (amount * BigInt(Math.round(fraction * SCALE_NUMBER))) / SCALE;
}

export function minLamports(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxLamports(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
