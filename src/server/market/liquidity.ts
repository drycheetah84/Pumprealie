import type { Venue } from '../../shared/types';
import { LAMPORTS_PER_SOL, TOKEN_UNIT } from '../lib/util';

/**
 * Constant-product liquidity state shared by the Pump bonding curve and PumpSwap pools.
 *
 * - Bonding curve: price is set by the *virtual* reserves; payouts are capped by the
 *   curve's real SOL reserves and purchases by its real token reserves.
 * - PumpSwap: price is set by `vault + pool.virtualQuoteReserves`; payouts are capped by
 *   `vault - protocolFees - creatorFees`.
 *
 * Fees are charged on top of the quote paid on buys and deducted from the quote received
 * on sells (this mirrors both programs). Amounts: quote in lamports, base in raw token units.
 */
export interface LiquidityState {
  venue: Venue;
  baseReserve: number;
  quoteReserve: number;
  realBaseReserve: number;
  realQuoteReserve: number;
  feeBps: number;
  observedAt: number;
  source: string;
  slot: number | null;
}

export interface BuyQuote {
  quoteInLamports: number;
  tokensOut: number;
  feeLamports: number;
  avgPriceSol: number;
  impactPct: number;
  capped: boolean;
}

export interface SellQuote {
  tokensIn: number;
  quoteOutLamports: number;
  feeLamports: number;
  avgPriceSol: number;
  impactPct: number;
  capped: boolean;
}

/** Spot price in SOL per whole token. */
export function spotPriceSol(s: Pick<LiquidityState, 'baseReserve' | 'quoteReserve'>): number | null {
  if (s.baseReserve <= 0 || s.quoteReserve <= 0) return null;
  return s.quoteReserve / LAMPORTS_PER_SOL / (s.baseReserve / TOKEN_UNIT);
}

function priceOf(lamports: number, tokens: number): number {
  return tokens > 0 ? lamports / LAMPORTS_PER_SOL / (tokens / TOKEN_UNIT) : 0;
}

/** Quote spending `budgetLamports` in total (fee included). */
export function quoteBuy(s: LiquidityState, budgetLamports: number): BuyQuote {
  const spot = spotPriceSol(s) ?? 0;
  if (budgetLamports <= 0 || s.baseReserve <= 0 || s.quoteReserve <= 0) {
    return { quoteInLamports: 0, tokensOut: 0, feeLamports: 0, avgPriceSol: 0, impactPct: 0, capped: false };
  }
  let net = Math.floor((budgetLamports * 10_000) / (10_000 + s.feeBps));
  let tokens = Math.floor((s.baseReserve * net) / (s.quoteReserve + net));
  let capped = false;
  if (tokens > s.realBaseReserve) {
    // Curve can only sell what it holds; the remaining budget is not spent.
    capped = true;
    tokens = Math.max(0, s.realBaseReserve);
    net = tokens > 0 ? Math.ceil((s.quoteReserve * tokens) / (s.baseReserve - tokens)) : 0;
  }
  const fee = Math.ceil((net * s.feeBps) / 10_000);
  const paid = net + fee;
  const avg = priceOf(paid, tokens);
  const avgExFee = priceOf(net, tokens);
  return {
    quoteInLamports: paid,
    tokensOut: tokens,
    feeLamports: fee,
    avgPriceSol: avg,
    impactPct: spot > 0 && avgExFee > 0 ? ((avgExFee - spot) / spot) * 100 : 0,
    capped,
  };
}

/** Quote selling `tokens` raw units. */
export function quoteSell(s: LiquidityState, tokens: number): SellQuote {
  const spot = spotPriceSol(s) ?? 0;
  if (tokens <= 0 || s.baseReserve <= 0 || s.quoteReserve <= 0) {
    return { tokensIn: tokens, quoteOutLamports: 0, feeLamports: 0, avgPriceSol: 0, impactPct: tokens > 0 ? -100 : 0, capped: tokens > 0 };
  }
  let gross = Math.floor((s.quoteReserve * tokens) / (s.baseReserve + tokens));
  let capped = false;
  if (gross > s.realQuoteReserve) {
    capped = true;
    gross = Math.max(0, s.realQuoteReserve);
  }
  const fee = Math.ceil((gross * s.feeBps) / 10_000);
  const out = Math.max(0, gross - fee);
  const avg = priceOf(out, tokens);
  const avgExFee = priceOf(gross, tokens);
  return {
    tokensIn: tokens,
    quoteOutLamports: out,
    feeLamports: fee,
    avgPriceSol: avg,
    impactPct: spot > 0 ? ((avgExFee - spot) / spot) * 100 : -100,
    capped,
  };
}

export function applyBuy(s: LiquidityState, q: BuyQuote): LiquidityState {
  const net = q.quoteInLamports - q.feeLamports;
  return {
    ...s,
    baseReserve: s.baseReserve - q.tokensOut,
    quoteReserve: s.quoteReserve + net,
    realBaseReserve: s.realBaseReserve - q.tokensOut,
    realQuoteReserve: s.realQuoteReserve + net,
  };
}

export function applySell(s: LiquidityState, q: SellQuote): LiquidityState {
  const gross = q.quoteOutLamports + q.feeLamports;
  return {
    ...s,
    baseReserve: s.baseReserve + q.tokensIn,
    quoteReserve: s.quoteReserve - gross,
    realBaseReserve: s.realBaseReserve + q.tokensIn,
    realQuoteReserve: s.realQuoteReserve - gross,
  };
}

/**
 * Move the state along the constant-product invariant until spot price changes by
 * `priceChangePct`, as if other traders had moved the market. Real reserves move by the
 * same quote/base deltas (other traders' buys add real SOL; sells remove it).
 */
export function shiftPrice(s: LiquidityState, priceChangePct: number): LiquidityState {
  const factor = Math.max(1e-6, 1 + priceChangePct / 100);
  const k = s.baseReserve * s.quoteReserve;
  const newQuote = s.quoteReserve * Math.sqrt(factor);
  const newBase = k / newQuote;
  const dq = newQuote - s.quoteReserve;
  const db = newBase - s.baseReserve;
  return {
    ...s,
    baseReserve: newBase,
    quoteReserve: newQuote,
    realQuoteReserve: Math.max(0, s.realQuoteReserve + dq),
    realBaseReserve: Math.max(0, s.realBaseReserve + db),
  };
}

/** Remove a fraction of withdrawable quote liquidity (models a drain / rug). */
export function drainLiquidity(s: LiquidityState, fractionRemoved: number): LiquidityState {
  const f = Math.min(1, Math.max(0, fractionRemoved));
  return { ...s, realQuoteReserve: s.realQuoteReserve * (1 - f), quoteReserve: s.quoteReserve * (1 - f) };
}

/** Largest SOL budget whose entry impact and immediate exit impact (fees excluded) stay under `maxImpactPct`. */
export function maxBuyForImpact(s: LiquidityState, maxImpactPct: number, ceilingLamports: number): number {
  let lo = 0;
  let hi = ceilingLamports;
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const q = quoteBuy(s, mid);
    const exit = quoteSell(applyBuy(s, q), q.tokensOut);
    if (q.impactPct <= maxImpactPct && -exit.impactPct <= maxImpactPct && !q.capped && !exit.capped) lo = mid;
    else hi = mid;
    if (hi - lo < 1000) break;
  }
  return lo;
}
