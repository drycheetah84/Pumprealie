import type { SystemStatus, TokenSummary } from '../../shared/types';
import type { App } from '../app';
import { VERSION } from '../app';

export function systemStatus(app: App): SystemStatus {
  const now = Date.now();
  const sys = app.engine.systemConditions(now);
  const pf = app.engine.lastPortfolio ?? app.engine.portfolioSummary(now);
  const blockers = app.risk.entryBlockers(sys, pf);
  return {
    mode: app.modes.mode,
    liveArmed: app.modes.liveArmed,
    liveAllowedByEnv: app.env.LIVE_TRADING_ENABLED,
    walletPublicKey: app.signer?.publicKey.toBase58() ?? null,
    killSwitch: app.store.getKillSwitch(),
    entriesBlocked: blockers.length > 0,
    entryBlockReasons: blockers,
    providers: app.health.all(),
    trackedTokens: app.market.registry.tokens.size,
    startedAt: app.startedAt,
    version: VERSION,
    paperTradesClosed: app.portfolio.closedCount('paper'),
    minPaperTradesForLive: app.env.MIN_PAPER_TRADES_FOR_LIVE,
  };
}

export interface ScannerQuery {
  sort?: string;
  dir?: 'asc' | 'desc';
  maxRisk?: number;
  minLiquidity?: number;
  minMomentum?: number;
  maxAgeMin?: number;
  strategy?: string;
  action?: string;
  q?: string;
  limit?: number;
}

const SORTS: Record<string, (t: TokenSummary) => number> = {
  risk: (t) => t.riskScore ?? 999,
  liquidity: (t) => t.realSolReserves ?? -1,
  momentum: (t) => t.momentum5mPct ?? -999,
  age: (t) => (t.createdAt ? -t.createdAt : -Infinity),
  volume: (t) => t.volume5mSol,
  opportunity: (t) => t.expectedNetPct ?? -999,
  updated: (t) => t.lastUpdate,
};

export function scanner(app: App, q: ScannerQuery): TokenSummary[] {
  const now = Date.now();
  let rows = app.engine.assessments.map((a) => a.summary);
  if (q.maxRisk !== undefined) rows = rows.filter((r) => (r.riskScore ?? 100) <= q.maxRisk!);
  if (q.minLiquidity !== undefined) rows = rows.filter((r) => (r.realSolReserves ?? 0) >= q.minLiquidity!);
  if (q.minMomentum !== undefined) rows = rows.filter((r) => (r.momentum5mPct ?? -Infinity) >= q.minMomentum!);
  if (q.maxAgeMin !== undefined) rows = rows.filter((r) => r.createdAt !== null && now - r.createdAt <= q.maxAgeMin! * 60_000);
  if (q.strategy) rows = rows.filter((r) => r.strategy === q.strategy);
  if (q.action) rows = rows.filter((r) => r.action === q.action);
  if (q.q) {
    const s = q.q.toLowerCase();
    rows = rows.filter((r) => r.mint.toLowerCase().includes(s) || (r.symbol ?? '').toLowerCase().includes(s) || (r.name ?? '').toLowerCase().includes(s));
  }
  const key = SORTS[q.sort ?? 'volume'] ?? SORTS.volume!;
  const dir = q.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => (key(a) - key(b)) * dir);
  return rows.slice(0, Math.min(q.limit ?? 200, 500));
}
