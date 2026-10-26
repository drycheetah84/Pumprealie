import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { TokenSummary } from '../../shared/types';
import type { App } from '../app';
import { tokensEqual } from './auth';
import { systemStatus } from './views';

/**
 * Realtime stream at /api/stream. Browsers cannot set Authorization headers on WebSockets,
 * so the client must send {"type":"auth","token":"..."} as its first message within 5s.
 * Token updates are coalesced and flushed every 2s; orders/positions/alerts are immediate.
 */
export function registerRealtime(f: FastifyInstance, app: App, token: string) {
  const clients = new Set<WebSocket>();
  const pendingTokens = new Map<string, TokenSummary>();

  const broadcast = (type: string, data: unknown) => {
    const msg = JSON.stringify({ type, data, at: Date.now() });
    for (const c of clients) if (c.readyState === 1) c.send(msg);
  };

  const unsub = [
    app.bus.on('token:update', (t) => pendingTokens.set(t.mint, t)),
    app.bus.on('order:update', (o) => broadcast('order', o)),
    app.bus.on('position:update', (p) => broadcast('position', p)),
    app.bus.on('alert', (a) => broadcast('alert', a)),
    app.bus.on('status:changed', () => broadcast('status', systemStatus(app))),
  ];
  const flush = setInterval(() => {
    if (!clients.size) {
      pendingTokens.clear();
      return;
    }
    if (pendingTokens.size) {
      broadcast('tokens', [...pendingTokens.values()].slice(0, 300));
      pendingTokens.clear();
    }
  }, 2000);
  const statusTimer = setInterval(() => {
    if (!clients.size) return;
    broadcast('status', systemStatus(app));
    if (app.engine.lastPortfolio) broadcast('portfolio', app.engine.lastPortfolio);
  }, 5000);
  f.addHook('onClose', async () => {
    clearInterval(flush);
    clearInterval(statusTimer);
    unsub.forEach((u) => u());
    for (const c of clients) c.close();
  });

  f.get('/api/stream', { websocket: true }, (socket) => {
    let authed = false;
    const timer = setTimeout(() => {
      if (!authed) socket.close(4001, 'auth timeout');
    }, 5000);
    socket.on('message', (raw: Buffer) => {
      if (authed) return; // the stream is server → client only
      try {
        const m = JSON.parse(raw.toString()) as { type?: string; token?: string };
        if (m.type === 'auth' && typeof m.token === 'string' && tokensEqual(m.token, token)) {
          authed = true;
          clearTimeout(timer);
          clients.add(socket);
          socket.send(JSON.stringify({ type: 'status', data: systemStatus(app), at: Date.now() }));
          return;
        }
      } catch {
        /* fallthrough */
      }
      socket.close(4003, 'unauthorized');
    });
    socket.on('close', () => {
      clearTimeout(timer);
      clients.delete(socket);
    });
  });
}
