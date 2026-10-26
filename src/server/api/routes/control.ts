import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from '../../app';
import { riskSettingsPatchSchema } from '../../config/riskSettings';
import { errMsg } from '../../lib/util';
import { ApiError } from '../auth';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const ACTOR = 'dashboard-operator';

export function registerControlRoutes(f: FastifyInstance, app: App, sensitive: Guard) {
  const audit = (req: FastifyRequest, action: string, detail: unknown) => app.store.audit(ACTOR, action, req.id, req.ip, detail);

  // Kill switch: persisted (committed) before the response is sent.
  f.post('/api/emergency/stop', { preHandler: sensitive }, async (req) => {
    const { reason } = z.object({ reason: z.string().max(300).default('manual emergency stop') }).parse(req.body ?? {});
    const state = app.store.setKillSwitch(true, reason, ACTOR);
    const mode = app.modes.mode === 'offline' ? 'paper' : app.modes.mode;
    const cancelled = app.execution.cancelPendingEntries(mode, 'kill switch');
    app.modes.disarm(ACTOR, 'kill switch');
    audit(req, 'emergency.stop', { reason, cancelled });
    app.bus.emit('alert', app.store.addAlert('critical', 'KILL_SWITCH', `Kill switch activated: ${reason}`));
    app.bus.emit('status:changed', { reason: 'kill switch' });
    return { killSwitch: state, cancelledEntries: cancelled, note: 'New entries are blocked in all modes. Exits and risk reduction continue.' };
  });

  f.post('/api/emergency/clear', { preHandler: sensitive }, async (req) => {
    const { confirm } = z.object({ confirm: z.literal('CLEAR KILL SWITCH') }).parse(req.body);
    const state = app.store.setKillSwitch(false, null, ACTOR);
    audit(req, 'emergency.clear', { confirm });
    app.bus.emit('status:changed', { reason: 'kill switch cleared' });
    return { killSwitch: state };
  });

  f.post('/api/mode', { preHandler: sensitive }, async (req) => {
    const { mode } = z.object({ mode: z.enum(['paper', 'offline']) }).parse(req.body);
    app.modes.setMode(mode, ACTOR, req.id);
    return { mode: app.modes.mode, liveArmed: app.modes.liveArmed };
  });

  f.get('/api/mode/live/requirements', async () => ({ blockers: app.modes.liveBlockers(), wallet: app.signer?.publicKey.toBase58() ?? null }));

  f.post('/api/mode/live/prepare', { preHandler: sensitive }, async (req) => {
    try {
      return { challenge: app.modes.prepareLive(ACTOR, req.id) };
    } catch (e) {
      throw new ApiError(409, 'live_blocked', errMsg(e));
    }
  });

  f.post('/api/mode/live/confirm', { preHandler: sensitive }, async (req) => {
    const b = z.object({ challengeId: z.string().uuid(), phrase: z.string().max(200) }).parse(req.body);
    try {
      app.modes.confirmLive(b.challengeId, b.phrase, ACTOR, req.id);
    } catch (e) {
      audit(req, 'live.confirm_failed', { err: errMsg(e) });
      throw new ApiError(409, 'live_confirmation_failed', errMsg(e));
    }
    return { mode: app.modes.mode, liveArmed: app.modes.liveArmed };
  });

  f.post('/api/mode/live/disarm', { preHandler: sensitive }, async (req) => {
    app.modes.disarm(ACTOR, 'operator request');
    audit(req, 'live.disarm', {});
    return { mode: app.modes.mode, liveArmed: app.modes.liveArmed };
  });

  f.put('/api/risk-controls', { preHandler: sensitive }, async (req) => {
    const patch = riskSettingsPatchSchema.parse(req.body);
    const known = new Set(app.strategies.strategies.map((s) => s.id));
    if (patch.enabledStrategies?.some((s) => !known.has(s))) throw new ApiError(400, 'unknown_strategy', 'enabledStrategies contains an unknown strategy');
    const res = app.updateRiskSettings(patch, ACTOR);
    audit(req, 'risk_controls.update', { patch, adjustments: res.adjustments });
    return res;
  });

  f.post('/api/positions/:id/close', { preHandler: sensitive }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { fraction } = z.object({ fraction: z.number().min(0.01).max(1).default(1) }).parse(req.body ?? {});
    const p = app.portfolio.position(id);
    if (!p || p.status === 'closed') throw new ApiError(404, 'not_found', 'open position not found');
    if (p.mode !== (app.modes.mode === 'offline' ? 'paper' : app.modes.mode)) throw new ApiError(409, 'mode_mismatch', `position belongs to ${p.mode} book; switch mode first`);
    const t = app.market.registry.get(p.mint);
    if (!t?.liquidity) throw new ApiError(409, 'no_quote', 'no executable quote available for this token right now');
    audit(req, 'position.manual_close', { id, fraction });
    const order = await app.execution.submitExit({
      mode: p.mode,
      position: p,
      fraction,
      reason: 'manual close by operator',
      maxSlippagePct: app.riskSettings().maxSlippagePct,
      decisionState: t.liquidity,
      tokenProgram: t.tokenProgram,
    });
    return { order };
  });

  f.post('/api/positions/:id/write-off', { preHandler: sensitive }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { confirm, reason } = z.object({ confirm: z.literal('WRITE OFF'), reason: z.string().min(3).max(300) }).parse(req.body);
    const p = app.portfolio.position(id);
    if (!p || p.status !== 'stuck') throw new ApiError(409, 'not_stuck', 'only positions marked stuck can be written off');
    app.portfolio.writeOff(id, reason, Date.now());
    audit(req, 'position.write_off', { id, reason, confirm });
    return { position: app.portfolio.position(id) };
  });
}
