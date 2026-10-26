import type { Logger } from 'pino';
import { parsePumpLogs, PUMP_PROGRAM } from '../pumpEvents';
import type { ProviderHealthMonitor } from '../providerHealth';
import type { CreateEvent, MigrationEvent, TradeEvent } from '../types';
import { ReconnectingWs } from './reconnectingWs';

export interface StreamHandlers {
  onTrades: (t: TradeEvent[]) => void;
  onCreates: (c: CreateEvent[]) => void;
  onMigrations: (m: MigrationEvent[]) => void;
}

/**
 * Real-time Pump market data from Solana RPC `logsSubscribe`.
 * - One subscription on the Pump bonding-curve program: every create/trade/complete event.
 * - One subscription per watched PumpSwap pool (`mentions` accepts one address), for
 *   graduated tokens we track.
 * Failed transactions are counted but never treated as trades.
 */
export class PumpLogStream {
  private ws: ReconnectingWs;
  private poolSubs = new Map<string, { mint: string; reqId: number; subId: number | null }>();
  private reqToPool = new Map<number, string>();
  private poolToMint = new Map<string, string>();
  private nextId = 10;
  private mainSubId: number | null = null;
  stats = { messages: 0, trades: 0, creates: 0, completes: 0, failedTx: 0, decodeErrors: 0, startedAt: Date.now() };
  readonly healthName = 'pump-log-stream';

  constructor(
    wsUrl: string,
    private readonly handlers: StreamHandlers,
    private readonly health: ProviderHealthMonitor,
    private readonly log: Logger,
  ) {
    health.register(this.healthName, { critical: true, downAfterMs: 45_000 });
    this.ws = new ReconnectingWs(
      'solana-logs',
      wsUrl,
      {
        onOpen: () => this.subscribeAll(),
        onMessage: (d) => this.onMessage(d),
        onStateChange: (state, detail) => {
          if (state !== 'open') this.health.failure(this.healthName, `${state}${detail ? `: ${detail}` : ''}`);
        },
      },
      log,
      { silenceTimeoutMs: 30_000 },
    );
  }

  start() {
    this.ws.start();
  }

  stop() {
    this.ws.stop();
  }

  get lastMessageAt(): number {
    return this.ws.lastMessageAt;
  }

  get reconnects(): number {
    return this.ws.reconnects;
  }

  private subscribeAll() {
    this.mainSubId = null;
    this.reqToPool.clear();
    this.ws.send({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }] });
    for (const [pool, s] of this.poolSubs) {
      s.subId = null;
      this.sendPoolSub(pool, s);
    }
  }

  private sendPoolSub(pool: string, s: { reqId: number }) {
    s.reqId = this.nextId++;
    this.reqToPool.set(s.reqId, pool);
    this.ws.send({ jsonrpc: '2.0', id: s.reqId, method: 'logsSubscribe', params: [{ mentions: [pool] }, { commitment: 'confirmed' }] });
  }

  watchPool(pool: string, mint: string) {
    if (this.poolSubs.has(pool)) return;
    const s = { mint, reqId: 0, subId: null as number | null };
    this.poolSubs.set(pool, s);
    this.poolToMint.set(pool, mint);
    this.sendPoolSub(pool, s);
  }

  unwatchPool(pool: string) {
    const s = this.poolSubs.get(pool);
    if (!s) return;
    if (s.subId !== null) this.ws.send({ jsonrpc: '2.0', id: this.nextId++, method: 'logsUnsubscribe', params: [s.subId] });
    this.poolSubs.delete(pool);
    this.poolToMint.delete(pool);
  }

  get watchedPools(): number {
    return this.poolSubs.size;
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      params?: { result: { context: { slot: number }; value: { signature: string; err: unknown; logs: string[] } } };
    };
    if (msg.id !== undefined) {
      if (msg.error) {
        this.health.failure(this.healthName, `subscribe failed: ${msg.error.message}`);
        return;
      }
      if (msg.id === 1) this.mainSubId = msg.result as number;
      else {
        const pool = this.reqToPool.get(msg.id);
        const s = pool ? this.poolSubs.get(pool) : undefined;
        if (s) s.subId = msg.result as number;
      }
      return;
    }
    if (!msg.params) return;
    this.stats.messages++;
    const { context, value } = msg.params.result;
    if (value.err) {
      this.stats.failedTx++;
      return;
    }
    const parsed = parsePumpLogs(value.logs, value.signature, context.slot, Date.now(), (p) => this.poolToMint.get(p));
    this.stats.decodeErrors += parsed.decodeErrors;
    if (parsed.creates.length) {
      this.stats.creates += parsed.creates.length;
      this.handlers.onCreates(parsed.creates);
    }
    if (parsed.trades.length) {
      this.stats.trades += parsed.trades.length;
      this.handlers.onTrades(parsed.trades);
    }
    if (parsed.completes.length) {
      this.stats.completes += parsed.completes.length;
      this.handlers.onMigrations(parsed.completes);
    }
    if (this.stats.messages % 50 === 0 || parsed.trades.length) {
      const secs = Math.max(1, (Date.now() - this.stats.startedAt) / 1000);
      this.health.success(
        this.healthName,
        null,
        `${(this.stats.trades / secs).toFixed(1)} trades/s, ${this.poolSubs.size} pool subs, ${this.ws.reconnects} reconnects`,
      );
    }
  }
}
