import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import type { Logger } from 'pino';
import type { Store } from '../db/store';
import type { EventBus } from '../lib/events';
import { errMsg } from '../lib/util';
import type { SolanaRpc } from '../market/providers/solanaRpc';
import type { Portfolio } from '../portfolio/portfolio';
import type { ExecutionService, EntryRequest } from './executionService';
import type { LiveExecutor } from './liveExecutor';
import type { OrderRepo } from './orderRepo';

/**
 * Keeps the live ledger honest:
 *  - resolves orders whose outcome is unknown (SUBMITTED/RECONCILING after restarts or RPC errors)
 *    strictly from on-chain status — never by resubmitting;
 *  - compares wallet token balances to open positions and blocks entries on mismatch.
 */
export class LiveReconciler {
  walletSol: number | null = null;
  walletCheckedAt: number | null = null;
  mismatch = false;
  mismatchDetail: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly rpc: SolanaRpc,
    private readonly live: LiveExecutor,
    private readonly orders: OrderRepo,
    private readonly execution: ExecutionService,
    private readonly portfolio: Portfolio,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  start(intervalMs = 20_000) {
    void this.run();
    this.timer = setInterval(() => void this.run(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.reconcileOrders();
      await this.reconcileBalances();
    } catch (e) {
      this.log.warn({ err: errMsg(e) }, 'live reconciliation failed');
    } finally {
      this.busy = false;
    }
  }

  async reconcileOrders() {
    const now = Date.now();
    for (const o of this.orders.listActive('live')) {
      if (o.status === 'CREATED' || o.status === 'VALIDATED') {
        if (now - o.updatedAt > 120_000) this.orders.transition(o.id, 'CANCELLED', { error: 'not submitted before restart/timeout' });
        continue;
      }
      if (now - o.updatedAt < 30_000 && o.status !== 'RECONCILING') continue;
      if (o.status === 'SUBMITTED' || o.status === 'CONFIRMED') this.orders.transition(o.id, 'RECONCILING', {}, { reason: 'outcome unknown; reconciling from chain' });
      const res = await this.live.reconcile(o);
      if (!res || res.status === 'AMBIGUOUS') continue;
      if (o.side === 'buy') {
        const ctx = this.orders.createdContext<{ symbol: string | null; plan: EntryRequest['plan'] }>(o.id);
        const plan = ctx?.plan ?? { stopPct: 12, targetPct: 20, maxHoldSec: 900, trailingPct: 10, thesis: 'recovered order' };
        this.execution.settleEntry(o.id, { mode: 'live', mint: o.mint, symbol: ctx?.symbol ?? null, strategy: o.strategy, venue: o.venue, plan }, res);
      } else if (o.positionId) {
        this.execution.settleExit(o.id, o.positionId, 'live', `${o.reason} (reconciled)`, res);
      }
      this.store.audit('system', 'order.reconciled', null, null, { orderId: o.id, status: res.status, signature: o.signature });
    }
  }

  async reconcileBalances() {
    const wallet = this.live.wallet;
    this.walletSol = (await this.rpc.getBalance(wallet)) / 1e9;
    this.walletCheckedAt = Date.now();
    const held = new Map<string, number>();
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const accounts = await this.rpc.getTokenAccountsByOwner(wallet, program);
      for (const a of accounts) {
        const acc = unpackAccount(a.pubkey, a.account, program);
        const m = acc.mint.toBase58();
        held.set(m, (held.get(m) ?? 0) + Number(acc.amount));
      }
    }
    const problems: string[] = [];
    const pending = new Set(this.orders.listActive('live').map((o) => o.mint));
    for (const p of this.portfolio.openPositions('live')) {
      if (pending.has(p.mint)) continue;
      const expected = Number(p.tokenAmountRaw);
      const actual = held.get(p.mint) ?? 0;
      if (Math.abs(actual - expected) > Math.max(1000, expected * 0.01)) problems.push(`${p.mint}: ledger ${expected} vs wallet ${actual}`);
    }
    const was = this.mismatch;
    this.mismatch = problems.length > 0;
    this.mismatchDetail = problems;
    if (this.mismatch && !was) {
      this.bus.emit('alert', this.store.addAlert('critical', 'LEDGER_MISMATCH', `Wallet balances disagree with ledger; entries blocked: ${problems.join('; ')}`));
      this.store.audit('system', 'reconciliation.mismatch', null, null, { problems });
    }
  }
}
