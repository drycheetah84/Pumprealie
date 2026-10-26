import type { MarketFeatures, WindowStats } from '../../shared/types';
import { pctChange, stdev } from '../lib/util';
import { spotPriceSol } from '../market/liquidity';
import type { TokenState } from '../market/tokenRegistry';
import type { TradeEvent } from '../market/types';

/** Initial real token reserves of a standard Pump curve (793.1M tokens, 6 decimals). */
export const STANDARD_INITIAL_REAL_TOKENS = 793_100_000_000_000;
export const STANDARD_TOTAL_SUPPLY = 1_000_000_000_000_000;

export function tradePrice(e: TradeEvent): number | null {
  if (e.vSol && e.vToken) return spotPriceSol({ baseReserve: e.vToken, quoteReserve: e.vSol });
  return e.tokenAmount > 0 ? e.solLamports / 1e9 / (e.tokenAmount / 1e6) : null;
}

function windowStats(trades: TradeEvent[], from: number, windowSec: number, priceAtStart: number | null, lastPrice: number | null): WindowStats {
  let vol = 0;
  let bv = 0;
  let sv = 0;
  let buys = 0;
  let sells = 0;
  const traders = new Set<string>();
  for (const e of trades) {
    if (e.ts < from) continue;
    const s = e.solLamports / 1e9;
    vol += s;
    traders.add(e.trader);
    if (e.side === 'buy') {
      buys++;
      bv += s;
    } else {
      sells++;
      sv += s;
    }
  }
  return {
    windowSec,
    volumeSol: vol,
    buyVolumeSol: bv,
    sellVolumeSol: sv,
    buys,
    sells,
    uniqueTraders: traders.size,
    priceChangePct: priceAtStart && lastPrice ? pctChange(priceAtStart, lastPrice) : null,
  };
}

/** Price as of time `ts`: last trade at or before ts. */
function priceAt(trades: TradeEvent[], ts: number): number | null {
  let p: number | null = null;
  for (const e of trades) {
    if (e.ts > ts) break;
    p = tradePrice(e) ?? p;
  }
  return p;
}

/**
 * Deterministic market features computed only from information in `t` at time `now`
 * (trades with ts > now are ignored, which keeps historical replay free of look-ahead).
 */
export function computeFeatures(t: TokenState, now: number): MarketFeatures {
  const all = t.trades.toArray();
  const trades = all[all.length - 1] && all[all.length - 1]!.ts > now ? all.filter((e) => e.ts <= now) : all;
  const last = trades[trades.length - 1];
  const liq = t.liquidity && t.liquidity.observedAt <= now ? t.liquidity : null;
  const priceSol = (liq ? spotPriceSol(liq) : null) ?? (last ? tradePrice(last) : null);

  const supply = t.mintInfo ? Number(t.mintInfo.supplyRaw) : STANDARD_TOTAL_SUPPLY;
  const marketCapSol = priceSol !== null ? (priceSol * supply) / 1e6 : null;
  const marketCapMethod = t.mintInfo
    ? 'spot price (from reserves) × on-chain mint supply'
    : 'spot price (from reserves) × standard Pump supply (1B; mint not yet verified)';

  // Window start price: last trade before the window. If the token launched inside the window
  // and we observed the launch, its first observed price is the true starting price.
  const startPrice = (from: number) => {
    const p = priceAt(trades, from);
    if (p !== null) return p;
    if (t.observedFromLaunch && t.createdAt !== null && t.createdAt >= from && trades[0]) return tradePrice(trades[0]);
    return null;
  };
  const windows = [60, 300, 900, 3600].map((w) => windowStats(trades, now - w * 1000, w, startPrice(now - w * 1000), priceSol));
  const w1 = windows[0]!;
  const w5 = windows[1]!;

  // Volatility: stdev of log returns between consecutive trade prices in the last 5 minutes.
  const recent = trades.filter((e) => e.ts >= now - 300_000);
  const prices = recent.map(tradePrice).filter((p): p is number => p !== null && p > 0);
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i]! / prices[i - 1]!));
  const volatility5mPct = rets.length >= 3 ? stdev(rets) * Math.sqrt(rets.length) * 100 : null;

  // Peak & drawdown over the last hour.
  let peak: number | null = null;
  for (const e of trades) {
    if (e.ts < now - 3600_000) continue;
    const p = tradePrice(e);
    if (p !== null && (peak === null || p > peak)) peak = p;
  }
  if (priceSol !== null && (peak === null || priceSol > peak)) peak = priceSol;
  const drawdownFromPeakPct = peak && priceSol ? ((priceSol - peak) / peak) * 100 : null;

  // Volume acceleration: last minute vs average of the 5 minutes before it.
  const prior = trades.filter((e) => e.ts >= now - 360_000 && e.ts < now - 60_000).reduce((a, e) => a + e.solLamports / 1e9, 0) / 5;
  const volumeAcceleration = prior > 0 ? w1.volumeSol / prior : w1.volumeSol > 0 ? null : 0;

  // Liquidity change over 5 minutes (real SOL reserves).
  const lh = t.liquidityHistory.toArray().filter((p) => p.ts <= now);
  const lNow = lh[lh.length - 1];
  const lThen = [...lh].reverse().find((p) => p.ts <= now - 300_000) ?? lh[0];
  const liquidityChange5mPct = lNow && lThen && lThen.realSol > 0 && lThen !== lNow ? pctChange(lThen.realSol, lNow.realSol) : null;

  // Manipulation heuristics over the 15-minute window.
  const w15 = trades.filter((e) => e.ts >= now - 900_000);
  const volByTrader = new Map<string, number>();
  const sidesByTrader = new Map<string, Set<string>>();
  const sizeCounts = new Map<number, number>();
  for (const e of w15) {
    volByTrader.set(e.trader, (volByTrader.get(e.trader) ?? 0) + e.solLamports);
    const s = sidesByTrader.get(e.trader) ?? new Set();
    s.add(e.side);
    sidesByTrader.set(e.trader, s);
    const bucket = Math.round(e.solLamports / 1e6); // 0.001 SOL buckets
    if (bucket > 0) sizeCounts.set(bucket, (sizeCounts.get(bucket) ?? 0) + 1);
  }
  const totalVol = [...volByTrader.values()].reduce((a, b) => a + b, 0);
  const top3 = [...volByTrader.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const roundTrippers = [...sidesByTrader.entries()].filter(([, s]) => s.size === 2).map(([k]) => k);
  const rtVol = roundTrippers.reduce((a, k) => a + (volByTrader.get(k) ?? 0), 0);
  const repeated = [...sizeCounts.values()].filter((c) => c >= 3).reduce((a, b) => a + b, 0);

  const bought = t.creatorBoughtTokens;
  const creatorSoldTokensPct = t.creator ? (bought > 0 ? (t.creatorSoldTokens / bought) * 100 : t.creatorSoldTokens > 0 ? 100 : 0) : null;

  let bondingProgressPct: number | null = null;
  if (liq && liq.venue === 'bonding_curve' && !t.isMayhem) {
    bondingProgressPct = Math.max(0, Math.min(100, ((STANDARD_INITIAL_REAL_TOKENS - liq.realBaseReserve) / STANDARD_INITIAL_REAL_TOKENS) * 100));
  } else if (t.complete) bondingProgressPct = 100;

  return {
    asOf: now,
    priceSol,
    marketCapSol,
    marketCapMethod,
    realSolReserves: liq ? liq.realQuoteReserve / 1e9 : null,
    bondingProgressPct,
    windows,
    volatility5mPct,
    momentum1mPct: w1.priceChangePct,
    momentum5mPct: w5.priceChangePct,
    drawdownFromPeakPct,
    peakPriceSol: peak,
    volumeAcceleration,
    liquidityChange5mPct,
    topTraderVolumeShare: totalVol > 0 ? top3 / totalVol : null,
    roundTripTraderShare: totalVol > 0 ? rtVol / totalVol : null,
    repeatedSizeShare: w15.length >= 10 ? repeated / w15.length : null,
    tradesPerTrader: volByTrader.size > 0 ? w15.length / volByTrader.size : null,
    creatorSoldTokensPct,
    creatorNetSol: t.creator ? (t.creatorSolOut - t.creatorSolIn) / 1e9 : null,
    tradeCount: trades.length,
    lastTradeAt: last ? last.ts : null,
  };
}
