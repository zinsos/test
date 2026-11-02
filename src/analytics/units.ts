import { LAMPORTS_PER_SOL } from "../core/constants.js";

const LAMPORTS_PER_SOL_NUMBER = Number(LAMPORTS_PER_SOL);

export function lamportsToSol(lamports: bigint): number {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = lamports % LAMPORTS_PER_SOL;
  return Number(whole) + Number(fraction) / LAMPORTS_PER_SOL_NUMBER;
}

export function lamportsRatio(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) {
    return null;
  }
  return Number(numerator) / Number(denominator);
}

export function sumBigInt(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return total;
}

export function finiteOrNull(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}
