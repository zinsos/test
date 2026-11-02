import { ceilDiv, feeAmount } from "./curve.js";

export interface PoolReserves {
  baseReserves: bigint;
  quoteReserves: bigint;
}

export interface PoolFeeRates {
  lpFeeBps: number;
  protocolFeeBps: number;
  creatorFeeBps: number;
}

export interface PoolBuyQuote {
  baseOut: bigint;
  quoteIn: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  totalCost: bigint;
  unspent: bigint;
  after: PoolReserves;
}

export interface PoolSellQuote {
  quoteOut: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  netQuote: bigint;
  after: PoolReserves;
}

export function poolPrice(reserves: PoolReserves): number {
  if (reserves.baseReserves <= 0n) {
    return 0;
  }
  return Number(reserves.quoteReserves) / Number(reserves.baseReserves);
}

export function quotePoolBuyExactBase(reserves: PoolReserves, baseOut: bigint, fees: PoolFeeRates): PoolBuyQuote {
  if (baseOut <= 0n || baseOut >= reserves.baseReserves) {
    throw new Error("invalid pool buy size");
  }
  const quoteIn = ceilDiv(reserves.quoteReserves * baseOut, reserves.baseReserves - baseOut);
  const lpFee = feeAmount(quoteIn, fees.lpFeeBps);
  const protocolFee = feeAmount(quoteIn, fees.protocolFeeBps);
  const creatorFee = feeAmount(quoteIn, fees.creatorFeeBps);
  return {
    baseOut,
    quoteIn,
    lpFee,
    protocolFee,
    creatorFee,
    totalCost: quoteIn + lpFee + protocolFee + creatorFee,
    unspent: 0n,
    after: { baseReserves: reserves.baseReserves - baseOut, quoteReserves: reserves.quoteReserves + quoteIn + lpFee }
  };
}

export function quotePoolBuyExactQuote(reserves: PoolReserves, budget: bigint, fees: PoolFeeRates): PoolBuyQuote {
  const totalBps = BigInt(fees.lpFeeBps + fees.protocolFeeBps + fees.creatorFeeBps);
  let net = (budget * 10_000n) / (10_000n + totalBps);
  const fullCost = net + feeAmount(net, fees.lpFeeBps) + feeAmount(net, fees.protocolFeeBps) + feeAmount(net, fees.creatorFeeBps);
  if (fullCost > budget) {
    net -= fullCost - budget;
  }
  if (net <= 0n) {
    return {
      baseOut: 0n,
      quoteIn: 0n,
      lpFee: 0n,
      protocolFee: 0n,
      creatorFee: 0n,
      totalCost: 0n,
      unspent: budget,
      after: { ...reserves }
    };
  }
  const baseOut = (net * reserves.baseReserves) / (reserves.quoteReserves + net);
  const lpFee = feeAmount(net, fees.lpFeeBps);
  const protocolFee = feeAmount(net, fees.protocolFeeBps);
  const creatorFee = feeAmount(net, fees.creatorFeeBps);
  const totalCost = net + lpFee + protocolFee + creatorFee;
  return {
    baseOut,
    quoteIn: net,
    lpFee,
    protocolFee,
    creatorFee,
    totalCost,
    unspent: budget - totalCost,
    after: { baseReserves: reserves.baseReserves - baseOut, quoteReserves: reserves.quoteReserves + net + lpFee }
  };
}

export function quotePoolSell(reserves: PoolReserves, baseIn: bigint, fees: PoolFeeRates): PoolSellQuote {
  if (baseIn <= 0n) {
    return { quoteOut: 0n, lpFee: 0n, protocolFee: 0n, creatorFee: 0n, netQuote: 0n, after: { ...reserves } };
  }
  const quoteOut = (reserves.quoteReserves * baseIn) / (reserves.baseReserves + baseIn);
  const lpFee = feeAmount(quoteOut, fees.lpFeeBps);
  const protocolFee = feeAmount(quoteOut, fees.protocolFeeBps);
  const creatorFee = feeAmount(quoteOut, fees.creatorFeeBps);
  const net = quoteOut - lpFee - protocolFee - creatorFee;
  return {
    quoteOut,
    lpFee,
    protocolFee,
    creatorFee,
    netQuote: net > 0n ? net : 0n,
    after: { baseReserves: reserves.baseReserves + baseIn, quoteReserves: reserves.quoteReserves - (quoteOut - lpFee) }
  };
}

export function maxPoolSellForImpact(reserves: PoolReserves, impactBps: number): bigint {
  if (impactBps <= 0) {
    return 0n;
  }
  if (impactBps >= 10_000) {
    return reserves.baseReserves * 1_000n;
  }
  return (reserves.baseReserves * BigInt(impactBps)) / BigInt(10_000 - impactBps);
}
