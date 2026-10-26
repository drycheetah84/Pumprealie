import type { Logger } from 'pino';
import type { OrderRecord, PositionRecord, TradingMode, Venue } from '../../shared/types';
import type { HardLimits } from '../config/riskSettings';
import type { DB } from '../db/database';
import type { Store } from '../db/store';
import type { EventBus } from '../lib/events';
import { errMsg } from '../lib/util';
import type { LiquidityState } from '../market/liquidity';
import type { Portfolio } from '../portfolio/portfolio';
import { DuplicateOrderError, type OrderRepo } from './orderRepo';
import type { ExecutionResult, Executor } from './types';

export interface EntryRequest {
  mode: TradingMode;
  mint: string;
  symbol: string | null;
  venue: Venue;
  strategy: string;
  sizeSol: number;
  maxSlippagePct: number;
  decisionId: number | null;
  decisionState: LiquidityState;
  tokenProgram: string | null;
  plan: { stopPct: number; targetPct: number; maxHoldSec: number; trailingPct: number; thesis: string };
  reason: string;
  /** Estimated network fee per transaction (SOL). */
  estNetworkFeeSol: number;
  capitalBaseSol: number;
}

export interface ExitRequest {
  mode: TradingMode;
  position: PositionRecord;
  fraction: number;
  reason: string;
  maxSlippagePct: number;
  decisionState: LiquidityState;
  tokenProgram: string | null;
}

/**
 * Owns the order lifecycle: idempotent creation → hard-limit validation → executor →
 * atomic settlement into the portfolio. Hard limits here are enforced independently of
 * (and in addition to) the risk manager.
 */
export class ExecutionService {
  constructor(
    private readonly db: DB,
    private readonly orders: OrderRepo,
    private readonly portfolio: Portfolio,
    private readonly store: Store,
    private readonly hard: HardLimits,
    private readonly executors: Partial<Record<TradingMode, Executor>>,
    private readonly guards: { killSwitchActive: () => boolean; liveArmed: () => boolean },
    private readonly bus: EventBus | null,
    private readonly log: Logger,
  ) {}

  private emit(o: OrderRecord) {
    this.bus?.emit('order:update', o);
  }

  /** Hard execution-layer checks. Returns a rejection reason or null. */
  validateEntry(r: EntryRequest): string | null {
    if (this.guards.killSwitchActive()) return 'kill switch active';
    if (r.mode === 'offline') return 'mode offline';
    if (r.mode === 'live' && !this.guards.liveArmed()) return 'live trading not armed';
    if (!this.executors[r.mode]) return `no executor for mode ${r.mode}`;
    if (!(r.sizeSol > 0)) return 'size must be positive';
    if (r.sizeSol > this.hard.maxPositionSol) return `size ${r.sizeSol} exceeds hard max ${this.hard.maxPositionSol} SOL`;
    if (r.sizeSol > (r.capitalBaseSol * this.hard.maxPositionPct) / 100 + 1e-9) return `size exceeds hard max ${this.hard.maxPositionPct}% of capital`;
    if (r.maxSlippagePct > this.hard.maxSlippagePct) return `slippage ${r.maxSlippagePct}% exceeds hard max ${this.hard.maxSlippagePct}%`;
    if (r.estNetworkFeeSol > this.hard.maxTxFeeSol) return `network fee ${r.estNetworkFeeSol} exceeds hard max ${this.hard.maxTxFeeSol}`;
    return null;
  }

  async submitEntry(r: EntryRequest): Promise<OrderRecord> {
    let order: OrderRecord;
    try {
      order = this.orders.create({
        idempotencyKey: `${r.mode}:entry:${r.mint}:${r.decisionId ?? Date.now()}`,
        mode: r.mode,
        mint: r.mint,
        side: 'buy',
        venue: r.venue,
        strategy: r.strategy,
        requestedSol: r.sizeSol,
        requestedTokensRaw: null,
        maxSlippagePct: r.maxSlippagePct,
        reason: r.reason,
        positionId: null,
        decisionId: r.decisionId,
        context: { symbol: r.symbol, plan: r.plan },
      });
    } catch (e) {
      if (e instanceof DuplicateOrderError) {
        this.log.warn({ mint: r.mint, err: e.message }, 'duplicate entry prevented');
        if (e.existing) return e.existing;
      }
      throw e;
    }
    this.emit(order);
    const rejection = this.validateEntry(r);
    if (rejection) {
      order = this.orders.transition(order.id, 'REJECTED', { error: rejection }, { rejection });
      this.emit(order);
      return order;
    }
    order = this.orders.transition(order.id, 'VALIDATED');
    const executor = this.executors[r.mode]!;
    let result: ExecutionResult;
    try {
      result = await executor.execute(
        { order, mint: r.mint, side: 'buy', venue: r.venue, budgetSol: r.sizeSol, tokensRaw: null, maxSlippagePct: r.maxSlippagePct, decisionState: r.decisionState, tokenProgram: r.tokenProgram },
        {
          onSubmitted: (sig, lvbh, quoted) => {
            order = this.orders.transition(order.id, 'SUBMITTED', {
              signature: sig,
              lastValidBlockHeight: lvbh,
              attempts: order.attempts + 1,
              quotedTokensRaw: quoted.tokensRaw === null ? null : String(quoted.tokensRaw),
              quotedSol: quoted.sol,
            });
            this.emit(order);
          },
        },
      );
    } catch (e) {
      result = { status: order.status === 'SUBMITTED' ? 'AMBIGUOUS' : 'FAILED', tokensRaw: 0, solAmount: 0, networkFeeSol: 0, signature: order.signature, error: errMsg(e), quotedTokensRaw: null, quotedSol: null };
    }
    return this.settleEntry(order.id, r, result);
  }

  /** Apply an entry result atomically. Also used by live reconciliation after a restart. */
  settleEntry(orderId: number, r: Pick<EntryRequest, 'mode' | 'mint' | 'symbol' | 'strategy' | 'venue' | 'plan'>, result: ExecutionResult): OrderRecord {
    let order = this.orders.get(orderId)!;
    const at = Date.now();
    this.db.transaction(() => {
      if (result.status === 'SETTLED') {
        if (order.status === 'VALIDATED') order = this.orders.transition(order.id, 'SUBMITTED', { signature: result.signature });
        if (order.status === 'SUBMITTED' || order.status === 'RECONCILING') order = this.orders.transition(order.id, 'CONFIRMED', { signature: result.signature });
        const pos = this.portfolio.applyBuy({
          mode: r.mode,
          orderId: order.id,
          mint: r.mint,
          symbol: r.symbol,
          strategy: r.strategy,
          venue: r.venue,
          tokensRaw: result.tokensRaw,
          solSpent: result.solAmount,
          networkFeeSol: result.networkFeeSol,
          entryPriceSol: result.tokensRaw > 0 ? result.solAmount / (result.tokensRaw / 1e6) : 0,
          stopPct: r.plan.stopPct,
          targetPct: r.plan.targetPct,
          maxHoldSec: r.plan.maxHoldSec,
          meta: { trailingPct: r.plan.trailingPct, thesis: r.plan.thesis },
          at,
        });
        order = this.orders.transition(order.id, 'SETTLED', {
          filledTokensRaw: String(result.tokensRaw),
          filledSol: result.solAmount,
          feeSol: result.networkFeeSol,
          positionId: pos.id,
        }, result.detail ?? null);
        this.bus?.emit('position:update', pos);
      } else if (result.status === 'AMBIGUOUS') {
        if (order.status !== 'RECONCILING') order = this.orders.transition(order.id, order.status === 'VALIDATED' ? 'FAILED' : 'RECONCILING', { error: result.error });
      } else {
        const to = result.status === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
        order = this.orders.transition(order.id, to, { error: result.error, feeSol: result.networkFeeSol, signature: result.signature ?? order.signature }, result.detail ?? null);
        if (result.networkFeeSol > 0) this.portfolio.ledger(r.mode, 'fee', -result.networkFeeSol, order.id, null, `failed entry fee: ${result.error}`, at);
      }
    })();
    this.emit(order);
    if (result.status !== 'SETTLED') this.log.info({ mint: r.mint, status: order.status, err: result.error }, 'entry not filled');
    return order;
  }

  async submitExit(r: ExitRequest): Promise<OrderRecord> {
    const p = r.position;
    const held = Number(p.tokenAmountRaw);
    const tokens = r.fraction >= 0.999 ? held : Math.floor(held * r.fraction);
    const prior = (this.db.prepare("SELECT COUNT(*) AS c FROM orders WHERE position_id = ? AND side = 'sell'").get(p.id) as { c: number }).c;
    let order: OrderRecord;
    try {
      order = this.orders.create({
        idempotencyKey: `${r.mode}:exit:${p.id}:${prior + 1}`,
        mode: r.mode,
        mint: p.mint,
        side: 'sell',
        venue: p.venue,
        strategy: p.strategy,
        requestedSol: null,
        requestedTokensRaw: String(tokens),
        maxSlippagePct: r.maxSlippagePct,
        reason: r.reason,
        positionId: p.id,
        decisionId: null,
      });
    } catch (e) {
      if (e instanceof DuplicateOrderError && e.existing) return e.existing;
      throw e;
    }
    this.emit(order);
    // Exits are allowed under the kill switch (it blocks entries), but never in offline mode.
    let rejection: string | null = null;
    if (r.mode === 'offline') rejection = 'mode offline';
    else if (!this.executors[r.mode]) rejection = `no executor for mode ${r.mode}`;
    else if (tokens <= 0 || tokens > held) rejection = `invalid token amount ${tokens} (held ${held})`;
    else if (r.maxSlippagePct > Math.max(this.hard.maxSlippagePct, 50)) rejection = 'slippage above emergency ceiling';
    if (rejection) {
      order = this.orders.transition(order.id, 'REJECTED', { error: rejection });
      this.emit(order);
      return order;
    }
    order = this.orders.transition(order.id, 'VALIDATED');
    this.portfolio.setStatus(p.id, 'closing');
    let result: ExecutionResult;
    try {
      result = await this.executors[r.mode]!.execute(
        { order, mint: p.mint, side: 'sell', venue: p.venue, budgetSol: null, tokensRaw: tokens, maxSlippagePct: r.maxSlippagePct, decisionState: r.decisionState, tokenProgram: r.tokenProgram },
        {
          onSubmitted: (sig, lvbh, quoted) => {
            order = this.orders.transition(order.id, 'SUBMITTED', { signature: sig, lastValidBlockHeight: lvbh, attempts: order.attempts + 1, quotedTokensRaw: String(tokens), quotedSol: quoted.sol });
            this.emit(order);
          },
        },
      );
    } catch (e) {
      result = { status: order.status === 'SUBMITTED' ? 'AMBIGUOUS' : 'FAILED', tokensRaw: 0, solAmount: 0, networkFeeSol: 0, signature: order.signature, error: errMsg(e), quotedTokensRaw: null, quotedSol: null };
    }
    return this.settleExit(order.id, p.id, r.mode, r.reason, result);
  }

  settleExit(orderId: number, positionId: number, mode: TradingMode, reason: string, result: ExecutionResult): OrderRecord {
    let order = this.orders.get(orderId)!;
    const at = Date.now();
    this.db.transaction(() => {
      if (result.status === 'SETTLED') {
        if (order.status === 'VALIDATED') order = this.orders.transition(order.id, 'SUBMITTED', { signature: result.signature });
        if (order.status === 'SUBMITTED' || order.status === 'RECONCILING') order = this.orders.transition(order.id, 'CONFIRMED');
        const pos = this.portfolio.applySell({ positionId, orderId: order.id, tokensSoldRaw: result.tokensRaw, solReceived: result.solAmount, networkFeeSol: result.networkFeeSol, reason, at });
        order = this.orders.transition(order.id, 'SETTLED', { filledTokensRaw: String(result.tokensRaw), filledSol: result.solAmount, feeSol: result.networkFeeSol }, result.detail ?? null);
        this.bus?.emit('position:update', pos);
      } else if (result.status === 'AMBIGUOUS') {
        // Never assume the sell failed or succeeded: reconcile before any retry.
        if (order.status !== 'RECONCILING') order = this.orders.transition(order.id, order.status === 'VALIDATED' ? 'FAILED' : 'RECONCILING', { error: result.error });
      } else {
        order = this.orders.transition(order.id, result.status === 'EXPIRED' ? 'EXPIRED' : 'FAILED', { error: result.error, feeSol: result.networkFeeSol }, result.detail ?? null);
        if (result.networkFeeSol > 0) this.portfolio.ledger(mode, 'fee', -result.networkFeeSol, order.id, positionId, `failed exit fee: ${result.error}`, at);
        const p = this.portfolio.position(positionId);
        if (p) {
          const attempts = (p.meta.exitAttempts ?? 0) + 1;
          const stuck = attempts >= 3;
          this.portfolio.setStatus(positionId, stuck ? 'stuck' : 'open', { exitAttempts: attempts, lastExitError: result.error ?? undefined, stuckSince: stuck ? (p.meta.stuckSince ?? at) : undefined });
          if (stuck) {
            const alert = this.store.addAlert('critical', 'EXIT_DIFFICULT', `Position ${p.mint} failed to exit ${attempts}×: ${result.error}`, p.mint);
            this.bus?.emit('alert', alert);
          }
        }
      }
    })();
    this.emit(order);
    return order;
  }

  /** Cancel entry orders that have not been submitted (emergency policy). */
  cancelPendingEntries(mode: TradingMode, reason: string): number {
    let n = 0;
    for (const o of this.orders.listActive(mode)) {
      if (o.side === 'buy' && (o.status === 'CREATED' || o.status === 'VALIDATED')) {
        this.emit(this.orders.transition(o.id, 'CANCELLED', { error: reason }));
        n++;
      }
    }
    return n;
  }

  /**
   * Startup recovery for paper mode: paper fills are atomic, so any non-terminal paper
   * order was interrupted before a fill was recorded and can safely be failed.
   * Live orders are left for on-chain reconciliation (LiveReconciler).
   */
  recoverPaperOrders(): number {
    let n = 0;
    for (const o of this.orders.listActive('paper')) {
      const to = o.status === 'CREATED' || o.status === 'VALIDATED' ? 'CANCELLED' : 'FAILED';
      this.orders.transition(o.id, to, { error: 'interrupted by restart before fill (paper)' });
      if (o.side === 'sell' && o.positionId) this.portfolio.setStatus(o.positionId, 'open');
      n++;
    }
    return n;
  }
}
