import type { ReplayResult, SimTrade } from './replay';

export interface GroupStats {
  trades: number;
  winRate: number;
  netPnlSol: number;
  avgPnlPct: number;
}

export interface BacktestMetrics {
  trades: number;
  netReturnSol: number;
  netReturnPct: number;
  /** Realized only (closed trades). */
  realizedPnlSol: number;
  /** Open positions at period end valued at executable sell quotes. */
  openExecutableSol: number;
  /** Open positions at period end valued at indicative mid price (NOT realizable). */
  openMarkSol: number;
  winRate: number;
  avgWinSol: number;
  avgLossSol: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  sharpe: number | null;
  returnOnDeployedPct: number;
  feesSol: number;
  avgHoldSec: number;
  avgExposureSol: number;
  maxExposureSol: number;
  failedEntries: number;
  failedExits: number;
  unexecutableExitEvents: number;
  unexecutableExitRate: number;
  /** Mean decision-time expected net % (quoted) vs mean realized % — calibration check. */
  meanQuotedExpectedPct: number | null;
  meanRealizedPct: number | null;
  distinctTokens: number;
  largestTokenProfitShare: number | null;
  byStrategy: Record<string, GroupStats>;
  byRiskTier: Record<string, GroupStats>;
  byLaunchAge: Record<string, GroupStats>;
  byMarketRegime: Record<string, GroupStats>;
  byCloseReason: Record<string, GroupStats>;
}

function group(trades: SimTrade[], key: (t: SimTrade) => string): Record<string, GroupStats> {
  const m = new Map<string, SimTrade[]>();
  for (const t of trades) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return Object.fromEntries(
    [...m.entries()].map(([k, ts]) => [
      k,
      {
        trades: ts.length,
        winRate: ts.filter((t) => t.pnlSol > 0).length / ts.length,
        netPnlSol: ts.reduce((a, t) => a + t.pnlSol, 0),
        avgPnlPct: ts.reduce((a, t) => a + t.pnlPct, 0) / ts.length,
      },
    ]),
  );
}

const ageBucket = (s: number | null) => (s === null ? 'unknown' : s < 300 ? '<5m' : s < 1800 ? '5-30m' : s < 7200 ? '30m-2h' : '>2h');
const reasonBucket = (r: string) => r.split(':')[0]!.split(' ')[0]!;

export function computeMetrics(r: ReplayResult, capitalSol: number): BacktestMetrics {
  const t = r.trades;
  const wins = t.filter((x) => x.pnlSol > 0);
  const losses = t.filter((x) => x.pnlSol <= 0);
  const gw = wins.reduce((a, x) => a + x.pnlSol, 0);
  const gl = -losses.reduce((a, x) => a + x.pnlSol, 0);
  const realized = gw - gl;
  const openExec = r.openAtEnd.reduce((a, p) => a + p.executableSol - p.costSol, 0);
  const openMark = r.openAtEnd.reduce((a, p) => a + p.markSol - p.costSol, 0);
  let peak = -Infinity;
  let mdd = 0;
  for (const p of r.equityCurve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) mdd = Math.max(mdd, ((peak - p.equity) / peak) * 100);
  }
  // Sharpe on hourly equity returns (only meaningful with enough samples).
  const hourly: number[] = [];
  let lastHour = -1;
  let lastEq: number | null = null;
  for (const p of r.equityCurve) {
    const h = Math.floor(p.at / 3600_000);
    if (h !== lastHour) {
      if (lastEq !== null && lastEq > 0) hourly.push(p.equity / lastEq - 1);
      lastEq = p.equity;
      lastHour = h;
    }
  }
  const mean = hourly.length ? hourly.reduce((a, b) => a + b, 0) / hourly.length : 0;
  const sd = hourly.length > 1 ? Math.sqrt(hourly.reduce((a, b) => a + (b - mean) ** 2, 0) / (hourly.length - 1)) : 0;
  const sharpe = hourly.length >= 24 && sd > 0 ? (mean / sd) * Math.sqrt(24 * 365) : null;
  const deployed = t.reduce((a, x) => a + x.costSol, 0);
  const exposures = r.equityCurve.map((p) => p.exposure);
  const byToken = new Map<string, number>();
  for (const x of wins) byToken.set(x.mint, (byToken.get(x.mint) ?? 0) + x.pnlSol);
  const largest = gw > 0 ? Math.max(...byToken.values()) / gw : null;
  const quoted = t.map((x) => x.quotedExpectedNetPct).filter((x): x is number => x !== null);
  return {
    trades: t.length,
    netReturnSol: realized + openExec,
    netReturnPct: ((realized + openExec) / capitalSol) * 100,
    realizedPnlSol: realized,
    openExecutableSol: openExec,
    openMarkSol: openMark,
    winRate: t.length ? wins.length / t.length : 0,
    avgWinSol: wins.length ? gw / wins.length : 0,
    avgLossSol: losses.length ? -gl / losses.length : 0,
    profitFactor: gl > 0 ? gw / gl : null,
    maxDrawdownPct: mdd,
    sharpe,
    returnOnDeployedPct: deployed > 0 ? (realized / deployed) * 100 : 0,
    feesSol: t.reduce((a, x) => a + x.feesSol, 0),
    avgHoldSec: t.length ? t.reduce((a, x) => a + x.holdSec, 0) / t.length : 0,
    avgExposureSol: exposures.length ? exposures.reduce((a, b) => a + b, 0) / exposures.length : 0,
    maxExposureSol: exposures.length ? Math.max(...exposures) : 0,
    failedEntries: r.failedEntries,
    failedExits: r.failedExits,
    unexecutableExitEvents: r.unexecutableExitEvents,
    unexecutableExitRate: t.length + r.openAtEnd.length > 0 ? r.unexecutableExitEvents / (t.length + r.openAtEnd.length) : 0,
    meanQuotedExpectedPct: quoted.length ? quoted.reduce((a, b) => a + b, 0) / quoted.length : null,
    meanRealizedPct: t.length ? t.reduce((a, x) => a + x.pnlPct, 0) / t.length : null,
    distinctTokens: new Set(t.map((x) => x.mint)).size,
    largestTokenProfitShare: largest,
    byStrategy: group(t, (x) => x.strategy),
    byRiskTier: group(t, (x) => x.riskTier),
    byLaunchAge: group(t, (x) => ageBucket(x.launchAgeSec)),
    byMarketRegime: group(t, (x) => x.marketRegime),
    byCloseReason: group(t, (x) => reasonBucket(x.closeReason)),
  };
}

/** Objective used by the optimizer: return penalized by drawdown; requires breadth. */
export function objective(m: BacktestMetrics): number {
  if (m.trades < 5) return -Infinity;
  return m.netReturnPct - 0.5 * m.maxDrawdownPct;
}
