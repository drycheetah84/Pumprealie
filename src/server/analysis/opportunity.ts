import type { Finding, MarketFeatures } from '../../shared/types';
import { clamp } from '../lib/util';

/**
 * Opportunity score (0-100): how attractive current activity is, independent of risk.
 * A high opportunity score never offsets a critical risk flag.
 */
export function scoreOpportunity(f: MarketFeatures, now: number): { score: number; findings: Finding[] } {
  const findings: Finding[] = [];
  const add = (code: string, points: number, message: string) =>
    findings.push({ code, category: 'opportunity', severity: 'info', message, points, source: 'solana-rpc-logs', observedAt: now, confidence: 0.7 });

  const w1 = f.windows[0]!;
  const w5 = f.windows[1]!;
  if (f.momentum5mPct !== null) {
    const p = clamp(f.momentum5mPct, -50, 150);
    if (p > 0) add('MOMENTUM_5M', clamp(p / 4, 0, 25), `5m price change +${p.toFixed(1)}%`);
  }
  if (f.momentum1mPct !== null && f.momentum1mPct > 0) add('MOMENTUM_1M', clamp(f.momentum1mPct / 2, 0, 10), `1m price change +${f.momentum1mPct.toFixed(1)}%`);
  const buyShare = w5.volumeSol > 0 ? w5.buyVolumeSol / w5.volumeSol : 0;
  if (buyShare > 0.5) add('BUY_PRESSURE', clamp((buyShare - 0.5) * 60, 0, 15), `${(buyShare * 100).toFixed(0)}% of 5m volume is buys`);
  if (w5.uniqueTraders >= 5) add('BREADTH', clamp(w5.uniqueTraders / 2, 0, 15), `${w5.uniqueTraders} unique traders in 5m`);
  if (w5.volumeSol > 0) add('VOLUME', clamp(Math.log10(1 + w5.volumeSol) * 10, 0, 15), `${w5.volumeSol.toFixed(2)} SOL volume in 5m`);
  if (f.volumeAcceleration !== null && f.volumeAcceleration > 1.5) add('ACCELERATION', clamp((f.volumeAcceleration - 1) * 4, 0, 10), `1m volume ${f.volumeAcceleration.toFixed(1)}× prior average`);
  if (f.bondingProgressPct !== null && f.bondingProgressPct > 20 && f.bondingProgressPct < 90)
    add('PROGRESS', 5, `bonding curve ${f.bondingProgressPct.toFixed(0)}% complete`);
  if (w1.sells > w1.buys * 2 && w1.sells > 3) add('SELLING_NOW', -15, `${w1.sells} sells vs ${w1.buys} buys in last minute`);
  if (f.drawdownFromPeakPct !== null && f.drawdownFromPeakPct < -40) add('DEEP_DRAWDOWN', -10, `${f.drawdownFromPeakPct.toFixed(0)}% below 1h peak`);

  const score = clamp(findings.reduce((a, x) => a + x.points, 0), 0, 100);
  return { score: Math.round(score * 10) / 10, findings };
}
