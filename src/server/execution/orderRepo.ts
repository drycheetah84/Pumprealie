import type { OrderRecord, OrderStatus, Side, TradingMode, Venue } from '../../shared/types';
import { TERMINAL_ORDER_STATUSES } from '../../shared/types';
import { json, type DB } from '../db/database';

/** Allowed lifecycle transitions. Anything else is a programming error and is refused. */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ['VALIDATED', 'REJECTED', 'CANCELLED'],
  VALIDATED: ['SUBMITTED', 'REJECTED', 'CANCELLED', 'FAILED'],
  SUBMITTED: ['CONFIRMED', 'FAILED', 'EXPIRED', 'RECONCILING'],
  RECONCILING: ['CONFIRMED', 'SETTLED', 'FAILED', 'EXPIRED'],
  CONFIRMED: ['SETTLED', 'RECONCILING'],
  SETTLED: [],
  FAILED: [],
  EXPIRED: [],
  REJECTED: [],
  CANCELLED: [],
};

export class DuplicateOrderError extends Error {
  constructor(
    message: string,
    readonly existing: OrderRecord | null,
  ) {
    super(message);
  }
}

export class InvalidTransitionError extends Error {}

export interface NewOrder {
  idempotencyKey: string;
  mode: TradingMode;
  mint: string;
  side: Side;
  venue: Venue;
  strategy: string;
  requestedSol: number | null;
  requestedTokensRaw: string | null;
  maxSlippagePct: number;
  reason: string;
  positionId: number | null;
  decisionId: number | null;
  /** Stored with the CREATED event so a restart can settle the order with its original plan. */
  context?: Record<string, unknown>;
}

export type OrderPatch = Partial<
  Pick<
    OrderRecord,
    | 'quotedTokensRaw'
    | 'quotedSol'
    | 'filledTokensRaw'
    | 'filledSol'
    | 'feeSol'
    | 'signature'
    | 'lastValidBlockHeight'
    | 'attempts'
    | 'error'
    | 'positionId'
    | 'venue'
  >
>;

const COLS: Record<keyof OrderPatch, string> = {
  quotedTokensRaw: 'quoted_tokens_raw',
  quotedSol: 'quoted_sol',
  filledTokensRaw: 'filled_tokens_raw',
  filledSol: 'filled_sol',
  feeSol: 'fee_sol',
  signature: 'signature',
  lastValidBlockHeight: 'last_valid_block_height',
  attempts: 'attempts',
  error: 'error',
  positionId: 'position_id',
  venue: 'venue',
};

export class OrderRepo {
  constructor(private readonly db: DB) {}

  /**
   * Create an order. Duplicate idempotency keys and a second active order for the same
   * mode/mint/side are both rejected by unique constraints (restart- and race-safe).
   */
  create(o: NewOrder): OrderRecord {
    const existing = this.byKey(o.idempotencyKey);
    if (existing) throw new DuplicateOrderError(`order with idempotency key ${o.idempotencyKey} already exists`, existing);
    const at = Date.now();
    try {
      const r = this.db
        .prepare(
          `INSERT INTO orders (idempotency_key, mode, mint, side, venue, strategy, status, requested_sol, requested_tokens_raw,
             max_slippage_pct, reason, position_id, decision_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(o.idempotencyKey, o.mode, o.mint, o.side, o.venue, o.strategy, o.requestedSol, o.requestedTokensRaw, o.maxSlippagePct, o.reason, o.positionId, o.decisionId, at, at);
      const id = Number(r.lastInsertRowid);
      this.event(id, null, 'CREATED', { reason: o.reason, ...(o.context ?? {}) });
      return this.get(id)!;
    } catch (e) {
      if (String(e).includes('UNIQUE')) {
        const active = this.activeFor(o.mode, o.mint, o.side);
        throw new DuplicateOrderError(`an active ${o.side} order already exists for ${o.mint}`, active);
      }
      throw e;
    }
  }

  transition(id: number, to: OrderStatus, patch: OrderPatch = {}, detail: unknown = null): OrderRecord {
    const cur = this.get(id);
    if (!cur) throw new Error(`order ${id} not found`);
    if (cur.status !== to && !ORDER_TRANSITIONS[cur.status].includes(to))
      throw new InvalidTransitionError(`order ${id}: ${cur.status} → ${to} not allowed`);
    const sets = ['status = ?', 'updated_at = ?'];
    const vals: unknown[] = [to, Date.now()];
    for (const [k, v] of Object.entries(patch)) {
      const col = COLS[k as keyof OrderPatch];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    vals.push(id);
    this.db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (cur.status !== to) this.event(id, cur.status, to, detail);
    return this.get(id)!;
  }

  patch(id: number, patch: OrderPatch): OrderRecord {
    const cur = this.get(id)!;
    return this.transition(id, cur.status, patch);
  }

  private event(orderId: number, from: OrderStatus | null, to: OrderStatus, detail: unknown) {
    this.db.prepare('INSERT INTO order_events (order_id, at, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?)').run(orderId, Date.now(), from, to, json.str(detail));
  }

  get(id: number): OrderRecord | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? rowToOrder(r) : null;
  }

  byKey(key: string): OrderRecord | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
    return r ? rowToOrder(r) : null;
  }

  activeFor(mode: TradingMode, mint: string, side?: Side): OrderRecord | null {
    const terminal = TERMINAL_ORDER_STATUSES.map((s) => `'${s}'`).join(',');
    const r = (
      side
        ? this.db.prepare(`SELECT * FROM orders WHERE mode = ? AND mint = ? AND side = ? AND status NOT IN (${terminal}) LIMIT 1`).get(mode, mint, side)
        : this.db.prepare(`SELECT * FROM orders WHERE mode = ? AND mint = ? AND status NOT IN (${terminal}) LIMIT 1`).get(mode, mint)
    ) as Record<string, unknown> | undefined;
    return r ? rowToOrder(r) : null;
  }

  listActive(mode?: TradingMode): OrderRecord[] {
    const terminal = TERMINAL_ORDER_STATUSES.map((s) => `'${s}'`).join(',');
    const rows = mode
      ? this.db.prepare(`SELECT * FROM orders WHERE mode = ? AND status NOT IN (${terminal}) ORDER BY id`).all(mode)
      : this.db.prepare(`SELECT * FROM orders WHERE status NOT IN (${terminal}) ORDER BY id`).all();
    return (rows as Record<string, unknown>[]).map(rowToOrder);
  }

  list(opts: { mode?: TradingMode; limit?: number; mint?: string } = {}): OrderRecord[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts.mode) {
      where.push('mode = ?');
      vals.push(opts.mode);
    }
    if (opts.mint) {
      where.push('mint = ?');
      vals.push(opts.mint);
    }
    vals.push(opts.limit ?? 200);
    return (this.db.prepare(`SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...vals) as Record<string, unknown>[]).map(rowToOrder);
  }

  createdContext<T>(orderId: number): T | null {
    const r = this.db.prepare("SELECT detail FROM order_events WHERE order_id = ? AND to_status = 'CREATED' ORDER BY id LIMIT 1").get(orderId) as { detail: string } | undefined;
    return r ? json.parse<T>(r.detail, null as T) : null;
  }

  events(orderId: number): Array<{ at: number; from: string | null; to: string; detail: unknown }> {
    return (this.db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(orderId) as Array<Record<string, unknown>>).map((r) => ({
      at: r.at as number,
      from: r.from_status as string | null,
      to: r.to_status as string,
      detail: json.parse(r.detail as string, null),
    }));
  }
}

export function rowToOrder(r: Record<string, unknown>): OrderRecord {
  return {
    id: r.id as number,
    idempotencyKey: r.idempotency_key as string,
    mode: r.mode as TradingMode,
    mint: r.mint as string,
    side: r.side as Side,
    venue: r.venue as Venue,
    strategy: r.strategy as string,
    status: r.status as OrderStatus,
    requestedSol: r.requested_sol as number | null,
    requestedTokensRaw: r.requested_tokens_raw as string | null,
    maxSlippagePct: r.max_slippage_pct as number,
    quotedTokensRaw: r.quoted_tokens_raw as string | null,
    quotedSol: r.quoted_sol as number | null,
    filledTokensRaw: r.filled_tokens_raw as string | null,
    filledSol: r.filled_sol as number | null,
    feeSol: r.fee_sol as number | null,
    signature: r.signature as string | null,
    lastValidBlockHeight: r.last_valid_block_height as number | null,
    attempts: r.attempts as number,
    error: r.error as string | null,
    reason: r.reason as string,
    positionId: r.position_id as number | null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}
