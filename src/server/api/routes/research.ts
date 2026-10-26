import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from '../../app';
import { errMsg } from '../../lib/util';
import { ApiError } from '../auth';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
const ACTOR = 'dashboard-operator';

const backtestBody = z.object({
  fromTs: z.number().int().positive().optional(),
  toTs: z.number().int().positive().optional(),
  trainFraction: z.number().min(0.3).max(0.9).default(0.7),
  enabledStrategies: z.array(z.string().max(64)).max(10).optional(),
  paramOverrides: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  latencyMs: z.number().int().min(0).max(30_000).optional(),
  failureRate: z.number().min(0).max(0.5).optional(),
  seed: z.number().int().optional(),
  evalIntervalMs: z.number().int().min(1000).max(60_000).optional(),
  assumeStandardMintWhenUnknown: z.boolean().optional(),
});

export function registerResearchRoutes(f: FastifyInstance, app: App, sensitive: Guard) {
  const strategyId = z.object({ id: z.string().max(64) });

  f.get('/api/strategies', async () => {
    const mode = app.modes.mode === 'live' ? 'live' : 'paper';
    const stats = app.portfolio.strategyStats(mode);
    const enabled = app.riskSettings().enabledStrategies;
    return {
      strategies: app.strategies.strategies.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        enabled: enabled.includes(s.id),
        allocationPct: app.riskSettings().strategyAllocationPct[s.id] ?? null,
        entryCriteria: s.entryCriteria,
        exitCriteria: s.exitCriteria,
        paramSpecs: s.paramSpecs,
        params: app.strategies.params(s.id),
        history: app.strategies.history(s.id).slice(0, 10),
        performance: stats.find((x) => x.strategy === s.id) ?? null,
      })),
      exitPolicy: {
        name: 'Exit & position protection (shared)',
        rules: [
          'risk escalation flags (liquidity collapse, creator dumping, transfer restriction, extreme exit impact) → sell now',
          'executable P&L ≤ −stop → sell (stops may fill worse than the stop level)',
          'risk score ≥ 80 or liquidity −30% in 5m → sell',
          'target reached → sell half, trail the rest',
          'trailing stop from peak executable value',
          'max holding period',
          'no executable quote / stale data → hold and alert (no blind sells)',
        ],
      },
    };
  });

  f.put('/api/strategies/:id/params', { preHandler: sensitive }, async (req) => {
    const { id } = strategyId.parse(req.params);
    const body = z.object({ params: z.record(z.string(), z.number()), note: z.string().max(300).default('operator edit') }).parse(req.body);
    try {
      const v = app.strategies.save(id, { ...app.strategies.params(id), ...body.params }, ACTOR, body.note);
      app.store.audit(ACTOR, 'strategy.params', req.id, req.ip, { id, params: body.params, version: v.version });
      return { version: v };
    } catch (e) {
      throw new ApiError(400, 'invalid_params', errMsg(e));
    }
  });

  f.post('/api/strategies/:id/known-good', { preHandler: sensitive }, async (req) => {
    const { id } = strategyId.parse(req.params);
    app.strategies.markKnownGood(id);
    app.store.audit(ACTOR, 'strategy.known_good', req.id, req.ip, { id });
    return { ok: true };
  });

  f.post('/api/strategies/:id/revert', { preHandler: sensitive }, async (req) => {
    const { id } = strategyId.parse(req.params);
    try {
      const v = app.strategies.revertToKnownGood(id, ACTOR);
      app.store.audit(ACTOR, 'strategy.revert', req.id, req.ip, { id, version: v.version });
      return { version: v };
    } catch (e) {
      throw new ApiError(409, 'no_known_good', errMsg(e));
    }
  });

  f.get('/api/backtests', async () => ({ backtests: app.backtests.list(), dataset: app.store.tradeTimeRange() }));

  f.get('/api/backtests/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = app.backtests.get(id);
    if (!b) throw new ApiError(404, 'not_found', 'backtest not found');
    return { backtest: b };
  });

  f.post('/api/backtests', { preHandler: sensitive }, async (req, reply) => {
    const p = backtestBody.parse(req.body ?? {});
    try {
      app.backtests.period(p);
      const id = app.backtests.start(p);
      app.store.audit(ACTOR, 'backtest.start', req.id, req.ip, { id, params: p });
      return reply.status(202).send({ id });
    } catch (e) {
      throw new ApiError(409, 'backtest_unavailable', errMsg(e));
    }
  });

  f.post('/api/strategies/:id/optimize', { preHandler: sensitive }, async (req, reply) => {
    const { id } = strategyId.parse(req.params);
    const p = backtestBody.extend({ candidates: z.number().int().min(2).max(40).default(12) }).parse(req.body ?? {});
    if (!app.strategies.get(id)) throw new ApiError(404, 'not_found', 'unknown strategy');
    try {
      app.backtests.period(p);
    } catch (e) {
      throw new ApiError(409, 'backtest_unavailable', errMsg(e));
    }
    app.store.audit(ACTOR, 'optimizer.start', req.id, req.ip, { id, params: p });
    void app.backtests.optimize(id, p).catch((e) => app.log.warn({ err: errMsg(e) }, 'optimizer failed'));
    return reply.status(202).send({ started: true, note: 'Results appear under /api/proposals when finished.' });
  });

  f.get('/api/proposals', async () => ({ proposals: app.backtests.proposals() }));

  f.post('/api/proposals/:id/decision', { preHandler: sensitive }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    try {
      app.backtests.decide(id, accept, ACTOR);
    } catch (e) {
      throw new ApiError(409, 'proposal_error', errMsg(e));
    }
    return { ok: true };
  });
}
