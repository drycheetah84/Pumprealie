import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/api/server';
import type { App } from '../../src/server/app';
import { TEST_TOKEN, testApp } from '../helpers/app';

let app: App;
let server: FastifyInstance;
const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const cmd = () => ({ ...auth, 'x-request-nonce': crypto.randomBytes(16).toString('hex'), 'x-request-timestamp': String(Date.now()), 'content-type': 'application/json' });

beforeAll(async () => {
  app = testApp();
  server = await buildServer(app, { token: TEST_TOKEN, webRoot: null });
});
afterAll(async () => {
  await server.close();
  await app.stop();
});

describe('API authentication & authorization', () => {
  it('serves a public health check without sensitive data', async () => {
    const r = await server.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(['db', 'problems', 'status', 'uptimeSec']);
    expect(r.headers['x-correlation-id']).toBeTruthy();
  });

  it('rejects requests without or with a wrong token', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    const bad = await server.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('unauthorized');
    expect(bad.json().correlationId).toBeTruthy();
  });

  it('returns status with a valid token and never exposes secrets', async () => {
    const r = await server.inject({ method: 'GET', url: '/api/status', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().mode).toBe('paper');
    const s = await server.inject({ method: 'GET', url: '/api/settings', headers: auth });
    expect(JSON.stringify(s.json())).not.toMatch(/secret|private|seed|DASHBOARD_API_TOKEN/i);
    expect(s.json().rpcHost).toBe('api.mainnet-beta.solana.com');
  });

  it('requires a nonce + fresh timestamp for sensitive commands and rejects replays', async () => {
    const noNonce = await server.inject({ method: 'POST', url: '/api/emergency/stop', headers: { ...auth, 'content-type': 'application/json' }, payload: {} });
    expect(noNonce.statusCode).toBe(400);
    const stale = await server.inject({ method: 'POST', url: '/api/mode', headers: { ...cmd(), 'x-request-timestamp': String(Date.now() - 300_000) }, payload: { mode: 'paper' } });
    expect(stale.json().error.code).toBe('stale_request');
    const h = cmd();
    expect((await server.inject({ method: 'POST', url: '/api/mode', headers: h, payload: { mode: 'paper' } })).statusCode).toBe(200);
    const replay = await server.inject({ method: 'POST', url: '/api/mode', headers: h, payload: { mode: 'paper' } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('replayed_request');
  });

  it('validates input and returns consistent errors', async () => {
    const r = await server.inject({ method: 'POST', url: '/api/mode', headers: cmd(), payload: { mode: 'live' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_error');
    const m = await server.inject({ method: 'GET', url: '/api/tokens/not-a-mint', headers: auth });
    expect(m.statusCode).toBe(400);
  });

  it('does not emit CORS headers for foreign origins by default', async () => {
    const r = await server.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('API controls', () => {
  it('kill switch is persisted before acknowledging and blocks entries', async () => {
    const r = await server.inject({ method: 'POST', url: '/api/emergency/stop', headers: cmd(), payload: { reason: 'api test' } });
    expect(r.statusCode).toBe(200);
    expect(app.store.getKillSwitch()).toMatchObject({ active: true, reason: 'api test' });
    const st = await server.inject({ method: 'GET', url: '/api/status', headers: auth });
    expect(st.json().entryBlockReasons).toContain('kill switch active');
    const wrong = await server.inject({ method: 'POST', url: '/api/emergency/clear', headers: cmd(), payload: { confirm: 'yes' } });
    expect(wrong.statusCode).toBe(400);
    const ok = await server.inject({ method: 'POST', url: '/api/emergency/clear', headers: cmd(), payload: { confirm: 'CLEAR KILL SWITCH' } });
    expect(ok.statusCode).toBe(200);
    expect(app.store.getKillSwitch().active).toBe(false);
    expect(app.store.listAudit().map((a) => a.action)).toEqual(expect.arrayContaining(['emergency.stop', 'emergency.clear']));
  });

  it('risk controls are clamped to hard limits and audit-logged', async () => {
    const r = await server.inject({ method: 'PUT', url: '/api/risk-controls', headers: cmd(), payload: { maxPositionPct: 90, maxDrawdownPct: 4 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.maxPositionPct).toBe(app.env.HARD_MAX_POSITION_PCT);
    expect(r.json().settings.maxDrawdownPct).toBe(4);
    expect(r.json().adjustments.join()).toMatch(/clamped/);
    const unknown = await server.inject({ method: 'PUT', url: '/api/risk-controls', headers: cmd(), payload: { enabledStrategies: ['yolo'] } });
    expect(unknown.statusCode).toBe(400);
  });

  it('refuses to arm live trading when the environment does not allow it', async () => {
    const r = await server.inject({ method: 'POST', url: '/api/mode/live/prepare', headers: cmd(), payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/LIVE_TRADING_ENABLED/);
    expect(app.modes.liveArmed).toBe(false);
  });

  it('rejects strategy parameters outside their bounds', async () => {
    const r = await server.inject({ method: 'PUT', url: '/api/strategies/momentum/params', headers: cmd(), payload: { params: { stopPct: 999 } } });
    expect(r.statusCode).toBe(400);
  });

  it('explains when a backtest has no data', async () => {
    const r = await server.inject({ method: 'POST', url: '/api/backtests', headers: cmd(), payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/no recorded trades/);
  });

  it('rate limits abusive clients', async () => {
    const local = testApp({ API_RATE_LIMIT_PER_MIN: '5' });
    const s = await buildServer(local, { token: TEST_TOKEN, webRoot: null });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await s.inject({ method: 'GET', url: '/api/health' })).statusCode);
    expect(codes).toContain(429);
    await s.close();
    await local.stop();
  });
});
