import { describe, expect, it } from 'vitest';
import { AccountLayout, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { hardLimitsFromEnv } from '../../src/server/config/riskSettings';
import { Store } from '../../src/server/db/store';
import { ExecutionService } from '../../src/server/execution/executionService';
import type { LiveExecutor } from '../../src/server/execution/liveExecutor';
import { LiveReconciler } from '../../src/server/execution/liveReconciler';
import { OrderRepo } from '../../src/server/execution/orderRepo';
import type { ExecutionResult } from '../../src/server/execution/types';
import { EventBus } from '../../src/server/lib/events';
import { silentLogger } from '../../src/server/lib/logger';
import type { SolanaRpc } from '../../src/server/market/providers/solanaRpc';
import { Portfolio } from '../../src/server/portfolio/portfolio';
import { memDb, testEnv } from '../helpers/app';

const MINT = new PublicKey('BTS2jevT5QXCni96oHzAp66pYPMzMUAVKjndxuxEpump');

function tokenAccount(owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: MINT, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { pubkey: Keypair.generate().publicKey, account: { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0 } };
}

function setup(walletTokens: bigint, reconcileResult: ExecutionResult | null) {
  const db = memDb();
  const store = new Store(db);
  const orders = new OrderRepo(db);
  const portfolio = new Portfolio(db);
  const wallet = Keypair.generate().publicKey;
  const rpc = {
    getBalance: async () => 2e9,
    getTokenAccountsByOwner: async (_o: PublicKey, program: PublicKey) => (program.equals(TOKEN_2022_PROGRAM_ID) ? [tokenAccount(wallet, walletTokens)] : []),
  } as unknown as SolanaRpc;
  const reconcileCalls: number[] = [];
  const live = { wallet, reconcile: async (o: { id: number }) => { reconcileCalls.push(o.id); return reconcileResult; } } as unknown as LiveExecutor;
  const exec = new ExecutionService(db, orders, portfolio, store, hardLimitsFromEnv(testEnv()), {}, { killSwitchActive: () => false, liveArmed: () => true }, null, silentLogger);
  const rec = new LiveReconciler(rpc, live, orders, exec, portfolio, store, new EventBus(), silentLogger);
  return { db, store, orders, portfolio, rec, reconcileCalls };
}

describe('live wallet/ledger reconciliation', () => {
  it('detects a mismatch between wallet token balance and the ledger and blocks entries', async () => {
    const c = setup(10n, null);
    c.portfolio.applyBuy({ mode: 'live', orderId: null as unknown as number, mint: MINT.toBase58(), symbol: null, strategy: 's', venue: 'bonding_curve', tokensRaw: 5_000_000_000, solSpent: 0.01, networkFeeSol: 0.00003, entryPriceSol: 1, stopPct: 1, targetPct: 1, maxHoldSec: 60, meta: {}, at: Date.now() });
    await c.rec.reconcileBalances();
    expect(c.rec.walletSol).toBe(2);
    expect(c.rec.mismatch).toBe(true);
    expect(c.store.listAlerts()[0]!.code).toBe('LEDGER_MISMATCH');
  });

  it('passes when balances agree', async () => {
    const c = setup(5_000_000_000n, null);
    c.portfolio.applyBuy({ mode: 'live', orderId: null as unknown as number, mint: MINT.toBase58(), symbol: null, strategy: 's', venue: 'bonding_curve', tokensRaw: 5_000_000_000, solSpent: 0.01, networkFeeSol: 0.00003, entryPriceSol: 1, stopPct: 1, targetPct: 1, maxHoldSec: 60, meta: {}, at: Date.now() });
    await c.rec.reconcileBalances();
    expect(c.rec.mismatch).toBe(false);
  });

  it('settles a submitted order found on-chain after a restart (no resubmission)', async () => {
    const c = setup(0n, { status: 'SETTLED', tokensRaw: 777, solAmount: 0.01, networkFeeSol: 0.00003, signature: 'SIGX', error: null, quotedTokensRaw: 700, quotedSol: 0.01 });
    const o = c.orders.create({ idempotencyKey: 'live:entry:x', mode: 'live', mint: MINT.toBase58(), side: 'buy', venue: 'bonding_curve', strategy: 'momentum', requestedSol: 0.01, requestedTokensRaw: null, maxSlippagePct: 3, reason: 'r', positionId: null, decisionId: null, context: { symbol: 'T', plan: { stopPct: 9, targetPct: 19, maxHoldSec: 99, trailingPct: 5, thesis: 't' } } });
    c.orders.transition(o.id, 'VALIDATED');
    c.orders.transition(o.id, 'SUBMITTED', { signature: 'SIGX', lastValidBlockHeight: 100 });
    c.db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(Date.now() - 120_000, o.id);
    await c.rec.reconcileOrders();
    expect(c.reconcileCalls).toEqual([o.id]);
    expect(c.orders.get(o.id)!.status).toBe('SETTLED');
    const p = c.portfolio.activePosition('live', MINT.toBase58())!;
    expect(p.tokenAmountRaw).toBe('777');
    expect(p.stopPct).toBe(9); // original plan restored from the order context
  });

  it('marks an expired submission EXPIRED and leaves the ledger untouched', async () => {
    const c = setup(0n, { status: 'EXPIRED', tokensRaw: 0, solAmount: 0, networkFeeSol: 0, signature: 'SIGY', error: 'blockhash expired', quotedTokensRaw: null, quotedSol: null });
    const o = c.orders.create({ idempotencyKey: 'live:entry:y', mode: 'live', mint: MINT.toBase58(), side: 'buy', venue: 'bonding_curve', strategy: 'momentum', requestedSol: 0.01, requestedTokensRaw: null, maxSlippagePct: 3, reason: 'r', positionId: null, decisionId: null });
    c.orders.transition(o.id, 'VALIDATED');
    c.orders.transition(o.id, 'SUBMITTED', { signature: 'SIGY', lastValidBlockHeight: 100 });
    c.db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(Date.now() - 120_000, o.id);
    await c.rec.reconcileOrders();
    expect(c.orders.get(o.id)!.status).toBe('EXPIRED');
    expect(c.portfolio.openPositions('live')).toEqual([]);
  });
});
