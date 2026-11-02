const FRACTION_SCALE = 1_000_000_000n;
const FRACTION_SCALE_NUMBER = 1_000_000_000;

export function fractionOf(amount: bigint, fraction: number): bigint {
  if (amount <= 0n || !Number.isFinite(fraction) || fraction <= 0) {
    return 0n;
  }
  if (fraction >= 1) {
    return amount;
  }
  return (amount * BigInt(Math.round(fraction * FRACTION_SCALE_NUMBER))) / FRACTION_SCALE;
}

export function isUsablePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

export function valueAtPrice(tokens: bigint, price: number): bigint {
  if (tokens <= 0n || !isUsablePrice(price)) {
    return 0n;
  }
  const value = Number(tokens) * price;
  return Number.isFinite(value) ? BigInt(Math.floor(value)) : 0n;
}

export function multipleOf(price: number, entryPrice: number): number {
  if (!isUsablePrice(price) || !isUsablePrice(entryPrice)) {
    return 0;
  }
  return price / entryPrice;
}

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
