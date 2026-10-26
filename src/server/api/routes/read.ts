import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { json } from '../../db/database';
import type { App } from '../../app';
import { hardLimitsFromEnv } from '../../config/riskSettings';
import { TIER_THRESHOLDS } from '../../analysis/risk';
import { ApiError } from '../auth';
import { scanner, systemStatus } from '../views';

const mintParam = z.object({ mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'invalid mint address') });
const modeQuery = z.object({ mode: z.enum(['paper', 'live']).optional() });

export function registerReadRoutes(f: FastifyInstance, app: App) {
  const bookMode = (m?: 'paper' | 'live') => m ?? (app.modes.mode === 'live' ? 'live' : 'paper');

  f.get('/api/status', async () => ({
    ...systemStatus(app),
    engine: { lastTickAt: app.engine.lastTickAt, lastTickMs: app.engine.lastTickMs },
    stream: app.market.streamStats,
    marketStats: app.market.stats,
    rpcEndpoint: app.rpc.endpointName,
    reconciliation: app.reconciler ? { walletSol: app.reconciler.walletSol, checkedAt: app.reconciler.walletCheckedAt, mismatch: app.reconciler.mismatch, detail: app.reconciler.mismatchDetail } : null,
  }));

  f.get('/api/tokens', async (req) => {
    const q = z
      .object({
        sort: z.enum(['risk', 'liquidity', 'momentum', 'age', 'volume', 'opportunity', 'updated']).optional(),
        dir: z.enum(['asc', 'desc']).optional(),
        maxRisk: z.coerce.number().min(0).max(100).optional(),
        minLiquidity: z.coerce.number().min(0).optional(),
        minMomentum: z.coerce.number().optional(),
        maxAgeMin: z.coerce.number().positive().optional(),
        strategy: z.string().max(64).optional(),
        action: z.enum(['buy', 'skip', 'watch', 'hold', 'reduce', 'sell']).optional(),
        q: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    return { tokens: scanner(app, q), asOf: Date.now() };
  });

  f.get('/api/tokens/:mint', async (req) => {
    const { mint } = mintParam.parse(req.params);
    const t = app.market.registry.get(mint);
    const row = app.store.getToken(mint);
    if (!t && !row) throw new ApiError(404, 'not_found', 'token not tracked');
    const now = Date.now();
    const assessments = (
      app.db.prepare('SELECT id, assessed_at, risk_score, tier, action, strategy, expected_net_pct FROM assessments WHERE mint = ? ORDER BY id DESC LIMIT 100').all(mint) as Array<Record<string, unknown>>
    ).map((r) => ({ id: r.id, at: r.assessed_at, riskScore: r.risk_score, tier: r.tier, action: r.action, strategy: r.strategy, expectedNetPct: r.expected_net_pct }));
    const decisions = (app.db.prepare('SELECT * FROM decisions WHERE mint = ? ORDER BY id DESC LIMIT 50').all(mint) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id,
      at: r.decided_at,
      mode: r.mode,
      strategy: r.strategy,
      approved: Boolean(r.approved),
      sizeSol: r.size_sol,
      reasons: json.parse(r.reasons as string, []),
    }));
    return {
      token: row,
      live: t
        ? {
            venue: t.venue,
            complete: t.complete,
            pool: t.pool,
            quoteMint: t.quoteMint,
            quoteVerified: t.quoteVerified,
            observedFromLaunch: t.observedFromLaunch,
            isMayhem: t.isMayhem,
            liquidity: t.liquidity,
            rpcCheckedAt: t.rpcCheckedAt,
            inconsistencyPct: t.inconsistencyPct,
            sources: [...t.sources],
            dex: t.dex,
            creatorActivity: t.creatorActivity,
            creatorStats: t.creator ? app.store.getCreator(t.creator) : null,
            creatorFlow: { boughtTokens: t.creatorBoughtTokens, soldTokens: t.creatorSoldTokens, solIn: t.creatorSolIn / 1e9, solOut: t.creatorSolOut / 1e9 },
          }
        : null,
      assessment: t?.lastAssessment ?? null,
      candles: app.store.candles(mint, Math.floor((now - 6 * 3600_000) / 60_000)),
      liquidityHistory: t ? t.liquidityHistory.toArray().slice(-300) : [],
      recentTrades: t
        ? t.trades
            .toArray()
            .slice(-100)
            .reverse()
            .map((e) => ({ ts: e.ts, side: e.side, sol: e.solLamports / 1e9, tokens: e.tokenAmount, trader: e.trader, signature: e.signature, venue: e.venue, isCreator: e.trader === t.creator }))
        : [],
      assessments,
      decisions,
      orders: app.orders.list({ mint, limit: 50 }),
    };
  });

  f.get('/api/risk', async () => ({
    settings: app.riskSettings(),
    hardLimits: hardLimitsFromEnv(app.env),
    tiers: TIER_THRESHOLDS,
    note: 'Risk scores are heuristic rankings, not calibrated probabilities of loss.',
  }));

  f.get('/api/portfolio', async (req) => {
    const { mode } = modeQuery.parse(req.query);
    const m = bookMode(mode);
    const summary = m === bookMode() && app.engine.lastPortfolio ? app.engine.lastPortfolio : app.portfolio.summary(m, { configuredCapitalSol: app.env.TRADING_CAPITAL_SOL, feeReserveSol: app.riskSettings().feeReserveSol, walletSol: m === 'live' ? (app.reconciler?.walletSol ?? null) : null, now: Date.now(), pendingEntrySol: 0 });
    return { summary, equity: app.portfolio.equityHistory(m, Date.now() - 7 * 86_400_000), strategyStats: app.portfolio.strategyStats(m) };
  });

  f.get('/api/positions', async (req) => {
    const q = z.object({ mode: z.enum(['paper', 'live']).optional(), status: z.enum(['open', 'closed']).optional() }).parse(req.query);
    const m = bookMode(q.mode);
    const enrich = (p: ReturnType<typeof app.portfolio.openPositions>[number]) => {
      const t = app.market.registry.get(p.mint);
      return { ...p, liquiditySol: t?.liquidity ? t.liquidity.realQuoteReserve / 1e9 : null, riskScore: t?.lastAssessment?.risk.score ?? null, criticalFlags: t?.lastAssessment?.risk.criticalFlags ?? [] };
    };
    if (q.status === 'closed') return { positions: app.portfolio.closedPositions(m, 300) };
    return { positions: app.portfolio.openPositions(m).map(enrich) };
  });

  f.get('/api/trades', async (req) => {
    const q = z.object({ mode: z.enum(['paper', 'live']).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
    return { orders: app.orders.list({ mode: q.mode, limit: q.limit ?? 200 }) };
  });

  f.get('/api/trades/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const o = app.orders.get(id);
    if (!o) throw new ApiError(404, 'not_found', 'order not found');
    return { order: o, events: app.orders.events(id), position: o.positionId ? app.portfolio.position(o.positionId) : null };
  });

  f.get('/api/settings', async () => {
    const e = app.env;
    const host = (u?: string) => (u ? new URL(u).host : null);
    return {
      appEnv: e.APP_ENV,
      tradingModeDefault: e.TRADING_MODE,
      liveTradingEnabledByEnv: e.LIVE_TRADING_ENABLED,
      walletPublicKey: app.signer?.publicKey.toBase58() ?? null,
      // Hosts only: RPC URLs often embed API keys.
      rpcHost: host(e.SOLANA_RPC_URL),
      rpcBackupHost: host(e.SOLANA_RPC_BACKUP_URL),
      providers: { onchainStream: e.ONCHAIN_STREAM_ENABLED, pumpPortal: e.PUMPPORTAL_ENABLED, pumpPortalTrades: Boolean(e.PUMPPORTAL_API_KEY), dexScreener: e.DEXSCREENER_ENABLED },
      capitalSol: e.TRADING_CAPITAL_SOL,
      paper: { latencyMs: e.PAPER_LATENCY_MS, failureRate: e.PAPER_FAILURE_RATE },
      retention: { rawTradesHours: e.RETENTION_RAW_TRADES_HOURS, candleDays: e.RETENTION_CANDLES_DAYS, assessmentDays: e.RETENTION_ASSESSMENTS_DAYS },
      minPaperTradesForLive: e.MIN_PAPER_TRADES_FOR_LIVE,
    };
  });

  f.get('/api/risk-controls', async () => ({ settings: app.riskSettings(), hardLimits: hardLimitsFromEnv(app.env), killSwitch: app.store.getKillSwitch(), mode: app.modes.mode, liveArmed: app.modes.liveArmed }));

  f.get('/api/alerts', async () => ({ alerts: app.store.listAlerts(200) }));
  f.get('/api/audit', async () => ({ entries: app.store.listAudit(300) }));
}
