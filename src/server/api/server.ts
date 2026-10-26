import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { App } from '../app';
import { ApiError, makeAuthHook, makeSensitiveGuard } from './auth';
import { registerRealtime } from './realtime';
import { registerControlRoutes } from './routes/control';
import { registerReadRoutes } from './routes/read';
import { registerResearchRoutes } from './routes/research';

export interface ServerOptions {
  token: string;
  webRoot?: string | null;
}

export async function buildServer(app: App, opts: ServerOptions): Promise<FastifyInstance> {
  const f = Fastify({
    logger: false,
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 256 * 1024,
    trustProxy: false,
  });

  await f.register(cors, {
    // No configured origins → no CORS headers → only same-origin browser access.
    origin: app.env.CORS_ORIGINS.length ? app.env.CORS_ORIGINS : false,
    credentials: false,
  });
  await f.register(rateLimit, { max: app.env.API_RATE_LIMIT_PER_MIN, timeWindow: '1 minute', allowList: [] });
  await f.register(websocket, { options: { maxPayload: 64 * 1024 } });

  f.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-correlation-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  f.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message }, correlationId: req.id });
    if (err instanceof ZodError)
      return reply.status(400).send({ error: { code: 'validation_error', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, correlationId: req.id });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'too many requests' }, correlationId: req.id });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: 'bad_request', message: e.message ?? 'bad request' }, correlationId: req.id });
    app.log.error({ err: e.message, correlationId: req.id, url: req.url }, 'api error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'internal error' }, correlationId: req.id });
  });

  const auth = makeAuthHook(opts.token);
  const sensitive = makeSensitiveGuard(app.store);

  // Public, minimal liveness/readiness probe (no sensitive data).
  f.get('/api/health', async (_req, reply) => {
    const dbOk = (() => {
      try {
        return app.db.prepare('SELECT 1 AS ok').get() !== undefined;
      } catch {
        return false;
      }
    })();
    const problems = app.health.criticalProblems();
    const status = !dbOk ? 'down' : problems.length ? 'degraded' : 'ok';
    return reply.status(dbOk ? 200 : 503).send({ status, db: dbOk, uptimeSec: Math.round((Date.now() - app.startedAt) / 1000), problems });
  });

  await f.register(async (scope) => {
    scope.addHook('onRequest', auth);
    registerReadRoutes(scope, app);
    registerControlRoutes(scope, app, sensitive);
    registerResearchRoutes(scope, app, sensitive);
  });
  // The WebSocket authenticates with its first message (browsers cannot send auth headers).
  await f.register(async (scope) => registerRealtime(scope, app, opts.token));

  const webRoot = opts.webRoot ?? null;
  if (webRoot && fs.existsSync(path.join(webRoot, 'index.html'))) {
    await f.register(fastifyStatic, { root: webRoot, prefix: '/', index: ['index.html'] });
    f.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.status(404).send({ error: { code: 'not_found', message: 'route not found' }, correlationId: req.id });
      return reply.sendFile('index.html');
    });
  } else {
    f.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'route not found (dashboard not built: run npm run build:web)' }, correlationId: req.id }));
  }
  return f;
}
