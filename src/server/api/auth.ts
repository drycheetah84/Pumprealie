import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../db/store';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function tokensEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Resolve the dashboard token. In development without DASHBOARD_API_TOKEN a random token is
 * generated once and stored in DATA_DIR/dashboard-token (mode 0600). It is a dashboard
 * credential only and is completely separate from wallet signing material.
 */
export function resolveDashboardToken(configured: string | undefined, dataDir: string): { token: string; generatedFile: string | null } {
  if (configured) return { token: configured, generatedFile: null };
  const file = path.join(dataDir, 'dashboard-token');
  if (fs.existsSync(file)) return { token: fs.readFileSync(file, 'utf8').trim(), generatedFile: file };
  fs.mkdirSync(dataDir, { recursive: true });
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return { token, generatedFile: file };
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim();
}

export function makeAuthHook(token: string) {
  return async (req: FastifyRequest) => {
    const t = bearer(req);
    if (!t || !tokensEqual(t, token)) throw new ApiError(401, 'unauthorized', 'missing or invalid bearer token');
  };
}

/**
 * Replay protection for state-changing commands: each request must carry a unique nonce
 * and a timestamp within ±60s. Nonces are persisted, so replays fail even across restarts.
 */
export function makeSensitiveGuard(store: Store) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const nonce = req.headers['x-request-nonce'];
    const ts = Number(req.headers['x-request-timestamp']);
    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128) throw new ApiError(400, 'nonce_required', 'x-request-nonce header (16-128 chars) is required for this command');
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60_000) throw new ApiError(400, 'stale_request', 'x-request-timestamp must be within 60s of server time');
    if (!store.consumeNonce(nonce)) throw new ApiError(409, 'replayed_request', 'this command was already processed (duplicate nonce)');
  };
}
