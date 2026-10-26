const TOKEN_KEY = 'pumpraelie.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: token lives only in memory for this tab */
  }
  memoryToken = t;
}

let memoryToken: string | null = null;
const token = () => getToken() ?? memoryToken;

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function request<T>(method: string, path: string, body?: unknown, sensitive = false): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token() ?? ''}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (sensitive) {
    headers['x-request-nonce'] = nonce();
    headers['x-request-timestamp'] = String(Date.now());
  }
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string }; correlationId?: string } | null) ?? null;
    throw new ApiError(res.status, e?.error?.code ?? 'error', e?.error?.message ?? res.statusText, e?.correlationId);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  /** State-changing commands carry a unique nonce + timestamp (server-side replay protection). */
  command: <T>(method: 'POST' | 'PUT', path: string, body?: unknown) => request<T>(method, path, body ?? {}, true),
};

export type StreamMessage = { type: string; data: unknown; at: number };

export function openStream(onMessage: (m: StreamMessage) => void, onState: (open: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/stream`);
    ws.onopen = () => {
      retry = 0;
      ws!.send(JSON.stringify({ type: 'auth', token: token() }));
      onState(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)) as StreamMessage);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      onState(false);
      if (!closed) setTimeout(connect, Math.min(15_000, 1000 * 2 ** retry++));
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
