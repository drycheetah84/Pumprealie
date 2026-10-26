import WebSocket from 'ws';
import type { Logger } from 'pino';
import { errMsg } from '../../lib/util';

/**
 * WebSocket with exponential-backoff reconnect, liveness watchdog and an `onOpen`
 * hook used to (re)establish subscriptions after every reconnect.
 */
export class ReconnectingWs {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  lastMessageAt = 0;
  connectedAt = 0;
  reconnects = 0;

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly handlers: {
      onOpen: (ws: ReconnectingWs) => void;
      onMessage: (data: string) => void;
      onStateChange?: (state: 'open' | 'closed' | 'error', detail?: string) => void;
    },
    private readonly log: Logger,
    private readonly opts: { silenceTimeoutMs: number; maxBackoffMs?: number } = { silenceTimeoutMs: 30_000 },
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdog = null;
    this.ws?.removeAllListeners();
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(obj: unknown): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(obj));
    return true;
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: 15_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.connectedAt = Date.now();
      this.lastMessageAt = Date.now();
      this.log.info({ ws: this.name }, 'websocket connected');
      this.handlers.onStateChange?.('open');
      this.handlers.onOpen(this);
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastMessageAt > this.opts.silenceTimeoutMs) {
          this.log.warn({ ws: this.name }, 'websocket silent; forcing reconnect');
          this.handlers.onStateChange?.('error', 'silence timeout');
          ws.terminate();
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, Math.min(10_000, this.opts.silenceTimeoutMs / 2));
    });
    ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      try {
        this.handlers.onMessage(data.toString());
      } catch (e) {
        this.log.error({ ws: this.name, err: errMsg(e) }, 'websocket message handler failed');
      }
    });
    ws.on('pong', () => {
      this.lastMessageAt = Math.max(this.lastMessageAt, Date.now() - 1);
    });
    ws.on('error', (e) => {
      this.handlers.onStateChange?.('error', errMsg(e));
      this.log.warn({ ws: this.name, err: errMsg(e) }, 'websocket error');
    });
    ws.on('close', (code) => {
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      this.handlers.onStateChange?.('closed', `code ${code}`);
      if (this.stopped) return;
      this.reconnects++;
      const delay = Math.min(this.opts.maxBackoffMs ?? 30_000, 500 * 2 ** this.attempt++) + Math.floor(Math.random() * 250);
      this.log.warn({ ws: this.name, code, delay }, 'websocket closed; reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }
}
