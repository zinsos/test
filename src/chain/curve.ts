import { BPS } from "../core/constants.js";

export interface CurveReserves {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint | null;
  realQuoteReserves: bigint | null;
}

export interface FeeRates {
  protocolFeeBps: number;
  creatorFeeBps: number;
}

export interface CurveBuyQuote {
  tokensOut: bigint;
  netQuote: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  totalCost: bigint;
  unspent: bigint;
  cappedByReserves: boolean;
  after: CurveReserves;
}

export interface CurveSellQuote {
  grossQuote: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  netQuote: bigint;
  after: CurveReserves;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) {
    throw new Error("division by non-positive");
  }
  if (a <= 0n) {
    return 0n;
  }
  return (a + b - 1n) / b;
}

export function feeAmount(amount: bigint, bps: number): bigint {
  if (bps <= 0 || amount <= 0n) {
    return 0n;
  }
  return ceilDiv(amount * BigInt(bps), BPS);
}

export function curvePrice(reserves: Pick<CurveReserves, "virtualTokenReserves" | "virtualQuoteReserves">): number {
  if (reserves.virtualTokenReserves <= 0n) {
    return 0;
  }
  return Number(reserves.virtualQuoteReserves) / Number(reserves.virtualTokenReserves);
}

export function marketCapQuote(
  reserves: Pick<CurveReserves, "virtualTokenReserves" | "virtualQuoteReserves">,
  totalSupply: bigint
): bigint {
  if (reserves.virtualTokenReserves <= 0n) {
    return 0n;
  }
  return (reserves.virtualQuoteReserves * totalSupply) / reserves.virtualTokenReserves;
}

export function tokensForNetQuote(reserves: CurveReserves, netQuote: bigint): bigint {
  if (netQuote <= 1n) {
    return 0n;
  }
  const input = netQuote - 1n;
  return (input * reserves.virtualTokenReserves) / (reserves.virtualQuoteReserves + input);
}

export function netQuoteForTokens(reserves: CurveReserves, tokens: bigint): bigint {
  if (tokens <= 0n) {
    return 0n;
  }
  if (tokens >= reserves.virtualTokenReserves) {
    throw new Error("cannot buy all virtual tokens");
  }
  return ceilDiv(tokens * reserves.virtualQuoteReserves, reserves.virtualTokenReserves - tokens) + 1n;
}

export function netFromBudget(budget: bigint, fees: FeeRates): bigint {
  if (budget <= 0n) {
    return 0n;
  }
  const totalBps = BigInt(fees.protocolFeeBps + fees.creatorFeeBps);
  let net = (budget * BPS) / (BPS + totalBps);
  const cost = net + feeAmount(net, fees.protocolFeeBps) + feeAmount(net, fees.creatorFeeBps);
  if (cost > budget) {
    net -= cost - budget;
  }
  return net > 0n ? net : 0n;
}

export function quoteBuyExactQuoteIn(reserves: CurveReserves, budget: bigint, fees: FeeRates): CurveBuyQuote {
  let net = netFromBudget(budget, fees);
  let tokens = tokensForNetQuote(reserves, net);
  let capped = false;
  if (reserves.realTokenReserves !== null && tokens > reserves.realTokenReserves) {
    tokens = reserves.realTokenReserves;
    net = tokens > 0n ? netQuoteForTokens(reserves, tokens) : 0n;
    capped = true;
  }
  const protocolFee = feeAmount(net, fees.protocolFeeBps);
  const creatorFee = feeAmount(net, fees.creatorFeeBps);
  const totalCost = tokens > 0n ? net + protocolFee + creatorFee : 0n;
  return {
    tokensOut: tokens,
    netQuote: tokens > 0n ? net : 0n,
    protocolFee: tokens > 0n ? protocolFee : 0n,
    creatorFee: tokens > 0n ? creatorFee : 0n,
    totalCost,
    unspent: budget - totalCost,
    cappedByReserves: capped,
    after: applyBuy(reserves, tokens, tokens > 0n ? net : 0n)
  };
}

export function quoteBuyExactTokens(reserves: CurveReserves, tokens: bigint, fees: FeeRates): CurveBuyQuote {
  let amount = tokens;
  let capped = false;
  if (reserves.realTokenReserves !== null && amount > reserves.realTokenReserves) {
    amount = reserves.realTokenReserves;
    capped = true;
  }
  const net = netQuoteForTokens(reserves, amount);
  const protocolFee = feeAmount(net, fees.protocolFeeBps);
  const creatorFee = feeAmount(net, fees.creatorFeeBps);
  return {
    tokensOut: amount,
    netQuote: net,
    protocolFee,
    creatorFee,
    totalCost: net + protocolFee + creatorFee,
    unspent: 0n,
    cappedByReserves: capped,
    after: applyBuy(reserves, amount, net)
  };
}

export function quoteSell(reserves: CurveReserves, tokens: bigint, fees: FeeRates): CurveSellQuote {
  if (tokens <= 0n) {
    return { grossQuote: 0n, protocolFee: 0n, creatorFee: 0n, netQuote: 0n, after: { ...reserves } };
  }
  const gross = (tokens * reserves.virtualQuoteReserves) / (reserves.virtualTokenReserves + tokens);
  const protocolFee = feeAmount(gross, fees.protocolFeeBps);
  const creatorFee = feeAmount(gross, fees.creatorFeeBps);
  const net = gross - protocolFee - creatorFee;
  return {
    grossQuote: gross,
    protocolFee,
    creatorFee,
    netQuote: net > 0n ? net : 0n,
    after: applySell(reserves, tokens, gross)
  };
}

export function applyBuy(reserves: CurveReserves, tokens: bigint, netQuote: bigint): CurveReserves {
  return {
    virtualTokenReserves: reserves.virtualTokenReserves - tokens,
    virtualQuoteReserves: reserves.virtualQuoteReserves + netQuote,
    realTokenReserves: reserves.realTokenReserves === null ? null : reserves.realTokenReserves - tokens,
    realQuoteReserves: reserves.realQuoteReserves === null ? null : reserves.realQuoteReserves + netQuote
  };
}

export function applySell(reserves: CurveReserves, tokens: bigint, grossQuote: bigint): CurveReserves {
  return {
    virtualTokenReserves: reserves.virtualTokenReserves + tokens,
    virtualQuoteReserves: reserves.virtualQuoteReserves - grossQuote,
    realTokenReserves: reserves.realTokenReserves === null ? null : reserves.realTokenReserves + tokens,
    realQuoteReserves: reserves.realQuoteReserves === null ? null : reserves.realQuoteReserves - grossQuote
  };
}

export function maxSellTokensForImpact(
  reserves: Pick<CurveReserves, "virtualTokenReserves">,
  impactBps: number
): bigint {
  if (impactBps <= 0) {
    return 0n;
  }
  if (impactBps >= 10_000) {
    return reserves.virtualTokenReserves * 1_000n;
  }
  return (reserves.virtualTokenReserves * BigInt(impactBps)) / BigInt(10_000 - impactBps);
}

export function maxBuyNetQuoteForImpact(
  reserves: Pick<CurveReserves, "virtualQuoteReserves">,
  impactBps: number
): bigint {
  if (impactBps <= 0) {
    return 0n;
  }
  if (impactBps >= 10_000) {
    return reserves.virtualQuoteReserves * 1_000n;
  }
  return (reserves.virtualQuoteReserves * BigInt(impactBps)) / BigInt(10_000 - impactBps);
}

export function executionImpactBps(spotPrice: number, executionPrice: number): number {
  if (spotPrice <= 0 || executionPrice <= 0) {
    return 0;
  }
  return Math.round(Math.abs(executionPrice / spotPrice - 1) * 10_000);
}
