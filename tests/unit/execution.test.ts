import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_COSTS, txFeeLamports } from '../../src/server/analysis/profitability';
import { hardLimitsFromEnv } from '../../src/server/config/riskSettings';
import type { DB } from '../../src/server/db/database';
import { Store } from '../../src/server/db/store';
import { ExecutionService, type EntryRequest } from '../../src/server/execution/executionService';
import { DuplicateOrderError, InvalidTransitionError, OrderRepo } from '../../src/server/execution/orderRepo';
import { PaperExecutor } from '../../src/server/execution/paperExecutor';
import type { ExecutionResult, Executor } from '../../src/server/execution/types';
import { silentLogger } from '../../src/server/lib/logger';
import { applyBuy, quoteBuy, type LiquidityState } from '../../src/server/market/liquidity';
import { Portfolio } from '../../src/server/portfolio/portfolio';
import { memDb, testEnv } from '../helpers/app';
import { curveState, MINT } from '../helpers/fixtures';

const env = testEnv();
const hard = hardLimitsFromEnv(env);
const FEE = txFeeLamports(DEFAULT_COSTS) / 1e9;

interface Ctx {
  db: DB;
  store: Store;
  orders: OrderRepo;
  portfolio: Portfolio;
  state: { current: LiquidityState | null; random: number; now: number };
  exec: ExecutionService;
  kill: { active: boolean };
}

function setup(extraExecutors: Partial<Record<'live', Executor>> = {}): Ctx {
  const db = memDb();
  // Orders reference decisions by foreign key; create the decisions the tests use.
  for (let i = 1; i <= 20; i++) db.prepare("INSERT INTO decisions (id, mode, mint, decided_at, strategy, action, approved, size_sol, reasons) VALUES (?, 'paper', ?, ?, 'momentum', 'buy', 1, 0.01, '[]')").run(i, MINT, Date.now());
  const store = new Store(db);
  const orders = new OrderRepo(db);
  const portfolio = new Portfolio(db);
  portfolio.ensureFunded('paper', 1);
  const state = { current: curveState(30, Date.now()) as LiquidityState | null, random: 0.99, now: Date.now() };
  const paper = new PaperExecutor({
    latencyMs: 0,
    failureRate: 0.03,
    costs: DEFAULT_COSTS,
    maxQuoteAgeMs: 20_000,
    now: () => state.now,
    sleep: async () => undefined,
    stateAt: () => state.current,
    random: () => state.random,
  });
  const kill = { active: false };
  const exec = new ExecutionService(db, orders, portfolio, store, hard, { paper, ...extraExecutors }, { killSwitchActive: () => kill.active, liveArmed: () => true }, null, silentLogger);
  return { db, store, orders, portfolio, state, exec, kill };
}

const entry = (c: Ctx, over: Partial<EntryRequest> = {}): EntryRequest => ({
  mode: 'paper',
  mint: MINT,
  symbol: 'TEST',
  venue: 'bonding_curve',
  strategy: 'momentum',
  sizeSol: 0.01,
  maxSlippagePct: 3,
  decisionId: 1,
  decisionState: c.state.current!,
  tokenProgram: null,
  plan: { stopPct: 12, targetPct: 25, maxHoldSec: 900, trailingPct: 10, thesis: 'test' },
  reason: 'test entry',
  estNetworkFeeSol: FEE,
  capitalBaseSol: 1,
  ...over,
});

describe('order lifecycle & idempotency', () => {
  let c: Ctx;
  beforeEach(() => {
    c = setup();
  });

  it('settles a paper buy: CREATED → VALIDATED → SUBMITTED → CONFIRMED → SETTLED', async () => {
    const o = await c.exec.submitEntry(entry(c));
    expect(o.status).toBe('SETTLED');
    expect(c.orders.events(o.id).map((e) => e.to)).toEqual(['CREATED', 'VALIDATED', 'SUBMITTED', 'CONFIRMED', 'SETTLED']);
    const p = c.portfolio.activePosition('paper', MINT)!;
    expect(Number(p.tokenAmountRaw)).toBeGreaterThan(0);
    expect(p.costBasisSol).toBeCloseTo(0.01 + FEE, 6);
    expect(c.portfolio.cash('paper')).toBeCloseTo(1 - 0.01 - FEE, 6);
  });

  it('rejects duplicate idempotency keys (restart / repeated event safety)', async () => {
    await c.exec.submitEntry(entry(c));
    expect(() => c.orders.create({ idempotencyKey: 'paper:entry:' + MINT + ':1', mode: 'paper', mint: MINT, side: 'buy', venue: 'bonding_curve', strategy: 'm', requestedSol: 0.01, requestedTokensRaw: null, maxSlippagePct: 3, reason: 'x', positionId: null, decisionId: 1 })).toThrow(DuplicateOrderError);
    // A repeated submit with the same decision returns the existing order instead of trading twice.
    const again = await c.exec.submitEntry(entry(c));
    expect(again.status).toBe('SETTLED');
    expect(c.orders.list({ mode: 'paper' })).toHaveLength(1);
  });

  it('allows only one active order per mint and side (DB constraint)', () => {
    c.orders.create({ idempotencyKey: 'k1', mode: 'paper', mint: MINT, side: 'buy', venue: 'bonding_curve', strategy: 'm', requestedSol: 0.01, requestedTokensRaw: null, maxSlippagePct: 3, reason: 'x', positionId: null, decisionId: null });
    expect(() => c.orders.create({ idempotencyKey: 'k2', mode: 'paper', mint: MINT, side: 'buy', venue: 'bonding_curve', strategy: 'm', requestedSol: 0.01, requestedTokensRaw: null, maxSlippagePct: 3, reason: 'x', positionId: null, decisionId: null })).toThrow(DuplicateOrderError);
  });

  it('refuses illegal lifecycle transitions', () => {
    const o = c.orders.create({ idempotencyKey: 'k3', mode: 'paper', mint: MINT, side: 'buy', venue: 'bonding_curve', strategy: 'm', requestedSol: 0.01, requestedTokensRaw: null, maxSlippagePct: 3, reason: 'x', positionId: null, decisionId: null });
    expect(() => c.orders.transition(o.id, 'SETTLED')).toThrow(InvalidTransitionError);
  });

  it('the unique index also prevents two active positions for one mint', async () => {
    await c.exec.submitEntry(entry(c));
    expect(() =>
      c.portfolio.applyBuy({ mode: 'paper', orderId: 1, mint: MINT, symbol: null, strategy: 'm', venue: 'bonding_curve', tokensRaw: 1, solSpent: 0.001, networkFeeSol: 0, entryPriceSol: 1, stopPct: 1, targetPct: 1, maxHoldSec: 1, meta: {}, at: Date.now() }),
    ).toThrow(/UNIQUE/);
  });
});

describe('failures, slippage and hard limits', () => {
  it('a failed transaction charges the network fee and opens no position', async () => {
    const c = setup();
    c.state.random = 0.0; // below the 3% failure rate
    const o = await c.exec.submitEntry(entry(c));
    expect(o.status).toBe('FAILED');
    expect(o.error).toMatch(/simulated transaction failure/);
    expect(c.portfolio.activePosition('paper', MINT)).toBeNull();
    expect(c.portfolio.cash('paper')).toBeCloseTo(1 - FEE, 9);
  });

  it('fails when the price moves beyond slippage tolerance during latency', async () => {
    const c = setup();
    const decision = c.state.current!;
    c.state.current = applyBuy(decision, quoteBuy(decision, 20e9)); // someone bought 20 SOL first
    const o = await c.exec.submitEntry(entry(c, { decisionState: decision }));
    expect(o.status).toBe('FAILED');
    expect(o.error).toMatch(/slippage exceeded/);
  });

  it('fails without fee when the quote is stale or the route vanished', async () => {
    const c = setup();
    c.state.current = { ...c.state.current!, observedAt: c.state.now - 60_000 };
    const stale = await c.exec.submitEntry(entry(c, { decisionId: 10 }));
    expect(stale.error).toMatch(/stale/);
    c.state.current = null;
    const gone = await c.exec.submitEntry(entry(c, { decisionId: 11, decisionState: curveState(30) }));
    expect(gone.error).toMatch(/route unavailable/);
    expect(c.portfolio.cash('paper')).toBeCloseTo(1, 9);
  });

  it('rejects entries above hard limits or under the kill switch, before any execution', async () => {
    const c = setup();
    expect((await c.exec.submitEntry(entry(c, { sizeSol: hard.maxPositionSol * 2, decisionId: 2 }))).status).toBe('REJECTED');
    expect((await c.exec.submitEntry(entry(c, { maxSlippagePct: 50, decisionId: 3 }))).status).toBe('REJECTED');
    expect((await c.exec.submitEntry(entry(c, { estNetworkFeeSol: 1, decisionId: 4 }))).status).toBe('REJECTED');
    c.kill.active = true;
    const k = await c.exec.submitEntry(entry(c, { decisionId: 5 }));
    expect(k.status).toBe('REJECTED');
    expect(k.error).toMatch(/kill switch/);
  });

  it('exits are still allowed under the kill switch (risk reduction)', async () => {
    const c = setup();
    await c.exec.submitEntry(entry(c));
    c.kill.active = true;
    const p = c.portfolio.activePosition('paper', MINT)!;
    const o = await c.exec.submitExit({ mode: 'paper', position: p, fraction: 1, reason: 'test exit', maxSlippagePct: 5, decisionState: c.state.current!, tokenProgram: null });
    expect(o.status).toBe('SETTLED');
    const closed = c.portfolio.position(p.id)!;
    expect(closed.status).toBe('closed');
    // Round trip at a flat price loses fees: realized P&L must be negative.
    expect(closed.realizedPnlSol).toBeLessThan(0);
  });

  it('marks a position stuck after repeated failed exits and raises an alert', async () => {
    const c = setup();
    await c.exec.submitEntry(entry(c));
    const p = c.portfolio.activePosition('paper', MINT)!;
    c.state.current = { ...c.state.current!, realQuoteReserve: 1000 }; // liquidity drained
    for (let i = 0; i < 3; i++) {
      const o = await c.exec.submitExit({ mode: 'paper', position: c.portfolio.position(p.id)!, fraction: 1, reason: 'stop', maxSlippagePct: 5, decisionState: c.state.current!, tokenProgram: null });
      expect(o.status).toBe('FAILED');
    }
    expect(c.portfolio.position(p.id)!.status).toBe('stuck');
    expect(c.store.listAlerts().map((a) => a.code)).toContain('EXIT_DIFFICULT');
  });

  it('partial exits keep proportional cost basis', async () => {
    const c = setup();
    await c.exec.submitEntry(entry(c));
    const p = c.portfolio.activePosition('paper', MINT)!;
    await c.exec.submitExit({ mode: 'paper', position: p, fraction: 0.5, reason: 'target', maxSlippagePct: 5, decisionState: c.state.current!, tokenProgram: null });
    const after = c.portfolio.position(p.id)!;
    expect(after.status).toBe('open');
    expect(after.costBasisSol).toBeCloseTo(p.costBasisSol / 2, 6);
    expect(Number(after.tokenAmountRaw)).toBeCloseTo(Number(p.tokenAmountRaw) / 2, -2);
  });
});

describe('paper isolation and restart recovery', () => {
  it('paper mode never reaches a live executor; live orders without an executor are rejected', async () => {
    let liveCalls = 0;
    const live: Executor = {
      mode: 'live',
      execute: async () => {
        liveCalls++;
        throw new Error('must not be called');
      },
    };
    const c = setup({ live });
    await c.exec.submitEntry(entry(c));
    expect(liveCalls).toBe(0);
    const c2 = setup();
    const o = await c2.exec.submitEntry(entry(c2, { mode: 'live' }));
    expect(o.status).toBe('REJECTED');
    expect(o.error).toMatch(/no executor/);
  });

  it('recovers interrupted paper orders after a restart', () => {
    const c = setup();
    const o = c.orders.create({ idempotencyKey: 'interrupted', mode: 'paper', mint: MINT, side: 'buy', venue: 'bonding_curve', strategy: 'm', requestedSol: 0.01, requestedTokensRaw: null, maxSlippagePct: 3, reason: 'x', positionId: null, decisionId: null });
    c.orders.transition(o.id, 'VALIDATED');
    c.orders.transition(o.id, 'SUBMITTED', { signature: 'paper-x' });
    // "restart": a new service instance over the same database
    const again = new ExecutionService(c.db, new OrderRepo(c.db), new Portfolio(c.db), c.store, hard, {}, { killSwitchActive: () => false, liveArmed: () => false }, null, silentLogger);
    expect(again.recoverPaperOrders()).toBe(1);
    expect(c.orders.get(o.id)!.status).toBe('FAILED');
  });

  it('an ambiguous live result goes to RECONCILING and settles later from chain data, without resubmitting', async () => {
    let calls = 0;
    const live: Executor = {
      mode: 'live',
      execute: async (_req, hooks) => {
        calls++;
        hooks.onSubmitted('SIG111', 1000, { tokensRaw: 100, sol: 0.01 });
        return { status: 'AMBIGUOUS', tokensRaw: 0, solAmount: 0, networkFeeSol: 0, signature: 'SIG111', error: 'rpc timeout', quotedTokensRaw: 100, quotedSol: 0.01 };
      },
    };
    const c = setup({ live });
    const o = await c.exec.submitEntry(entry(c, { mode: 'live' }));
    expect(o.status).toBe('RECONCILING');
    expect(o.signature).toBe('SIG111');
    // The executor is not invoked again for the same decision (idempotency).
    await c.exec.submitEntry(entry(c, { mode: 'live' }));
    expect(calls).toBe(1);
    const chain: ExecutionResult = { status: 'SETTLED', tokensRaw: 123456789, solAmount: 0.0099, networkFeeSol: 0.000030, signature: 'SIG111', error: null, quotedTokensRaw: 100, quotedSol: 0.01 };
    const settled = c.exec.settleEntry(o.id, { mode: 'live', mint: MINT, symbol: null, strategy: 'momentum', venue: 'bonding_curve', plan: { stopPct: 12, targetPct: 25, maxHoldSec: 900, trailingPct: 10, thesis: 'x' } }, chain);
    expect(settled.status).toBe('SETTLED');
    expect(c.portfolio.activePosition('live', MINT)!.tokenAmountRaw).toBe('123456789');
  });

  it('an expired live transaction is recorded as EXPIRED with no position', async () => {
    const live: Executor = {
      mode: 'live',
      execute: async (_req, hooks) => {
        hooks.onSubmitted('SIG222', 10, { tokensRaw: 1, sol: 0.01 });
        return { status: 'EXPIRED', tokensRaw: 0, solAmount: 0, networkFeeSol: 0, signature: 'SIG222', error: 'blockhash expired', quotedTokensRaw: null, quotedSol: null };
      },
    };
    const c = setup({ live });
    const o = await c.exec.submitEntry(entry(c, { mode: 'live' }));
    expect(o.status).toBe('EXPIRED');
    expect(c.portfolio.activePosition('live', MINT)).toBeNull();
  });
});
