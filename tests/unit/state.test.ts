import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../../src/server/db/database';
import { Store } from '../../src/server/db/store';
import { ModeController } from '../../src/server/engine/modeController';
import { EventBus } from '../../src/server/lib/events';
import { defaultRiskSettings } from '../../src/server/config/riskSettings';
import { Portfolio } from '../../src/server/portfolio/portfolio';
import { StrategyRegistry } from '../../src/server/strategy/registry';
import { evaluateExit } from '../../src/server/strategy/exitPolicy';
import type { PositionRecord } from '../../src/shared/types';
import { memDb, testEnv } from '../helpers/app';

describe('kill switch persistence', () => {
  it('survives a restart (file-backed database) until explicitly cleared', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pumpraelie-ks-')), 'db.sqlite');
    let db = openDatabase(file);
    migrate(db);
    new Store(db).setKillSwitch(true, 'test stop', 'tester');
    db.close();
    db = openDatabase(file);
    migrate(db);
    const s = new Store(db);
    expect(s.getKillSwitch()).toMatchObject({ active: true, reason: 'test stop', changedBy: 'tester' });
    expect(s.listAudit().map((a) => a.action)).toContain('kill_switch.activate');
    s.setKillSwitch(false, null, 'tester');
    expect(s.getKillSwitch().active).toBe(false);
    db.close();
  });

  it('command nonces cannot be replayed', () => {
    const s = new Store(memDb());
    expect(s.consumeNonce('abc123abc123abc123')).toBe(true);
    expect(s.consumeNonce('abc123abc123abc123')).toBe(false);
  });

  it('migrations are idempotent', () => {
    const db = memDb();
    expect(migrate(db)).toEqual([]);
  });
});

describe('live mode activation', () => {
  const env = testEnv({ MIN_PAPER_TRADES_FOR_LIVE: '2' });
  it('refuses live without env enablement, signer and paper history; is never armed after restart', () => {
    const store = new Store(memDb());
    const m = new ModeController(env, store, new EventBus(), { walletPublicKey: () => null, paperTradesClosed: () => 0, settings: () => defaultRiskSettings(env) });
    expect(m.liveBlockers().join()).toMatch(/LIVE_TRADING_ENABLED/);
    expect(() => m.prepareLive('t', null)).toThrow(/cannot be enabled/);
    expect(m.liveArmed).toBe(false);
  });

  it('requires the exact phrase within the challenge window', () => {
    const e = testEnv({ LIVE_TRADING_ENABLED: 'true', MIN_PAPER_TRADES_FOR_LIVE: '2' });
    const store = new Store(memDb());
    const m = new ModeController(e, store, new EventBus(), { walletPublicKey: () => 'Wa11etPubKey1111111111111111111111111111', paperTradesClosed: () => 3, settings: () => defaultRiskSettings(e) });
    const c = m.prepareLive('op', null);
    expect(() => m.confirmLive(c.id, 'enable live', 'op', null)).toThrow(/does not match/);
    m.confirmLive(c.id, c.phrase, 'op', null);
    expect(m.mode).toBe('live');
    expect(m.liveArmed).toBe(true);
    // A new controller (restart) keeps the mode but is disarmed.
    const after = new ModeController(e, store, new EventBus(), { walletPublicKey: () => 'Wa11etPubKey1111111111111111111111111111', paperTradesClosed: () => 3, settings: () => defaultRiskSettings(e) });
    expect(after.mode).toBe('live');
    expect(after.liveArmed).toBe(false);
  });
});

describe('portfolio accounting', () => {
  it('computes equity, day start and drawdown from executable values', () => {
    const db = memDb();
    const pf = new Portfolio(db);
    pf.ensureFunded('paper', 1);
    pf.ensureFunded('paper', 1); // idempotent
    const now = Date.now();
    const p = pf.applyBuy({ mode: 'paper', orderId: null as unknown as number, mint: 'M', symbol: null, strategy: 's', venue: 'bonding_curve', tokensRaw: 1e9, solSpent: 0.1, networkFeeSol: 0.001, entryPriceSol: 1e-4, stopPct: 10, targetPct: 20, maxHoldSec: 60, meta: {}, at: now });
    pf.updateValuation(p.id, 0.12, 0.08, now);
    const s = pf.summary('paper', { configuredCapitalSol: 1, feeReserveSol: 0.02, walletSol: null, now, pendingEntrySol: 0 });
    expect(s.cashSol).toBeCloseTo(0.899, 9);
    expect(s.executableValueSol).toBeCloseTo(0.08);
    expect(s.indicativeValueSol).toBeCloseTo(0.12);
    expect(s.equitySol).toBeCloseTo(0.979, 9);
    expect(s.drawdownPct).toBeCloseTo(2.1, 6);
    expect(s.unrealizedPnlSol).toBeCloseTo(0.08 - 0.101, 9);
  }, 10_000);
});

describe('exit policy', () => {
  const pos = (over: Partial<PositionRecord> = {}): PositionRecord => ({
    id: 1, mode: 'paper', mint: 'M', symbol: null, strategy: 's', status: 'open', venue: 'bonding_curve', tokenAmountRaw: '1000000000', costBasisSol: 0.1, entryPriceSol: 1, entryAt: 0, exitAt: null,
    realizedPnlSol: 0, proceedsSol: 0, feesSol: 0, peakValueSol: 0.1, stopPct: 10, targetPct: 25, maxHoldSec: 600, lastIndicativeValueSol: null, lastExecutableValueSol: null, lastValuationAt: null, closeReason: null, meta: { trailingPct: 10 }, ...over,
  });
  const base = { token: undefined, features: null, risk: null, now: 60_000, emergency: false };
  it('holds without an executable quote (no blind sells)', () => {
    expect(evaluateExit({ ...base, position: pos(), executableValueSol: null }).action).toBe('hold');
  });
  it('stops out on executable loss, takes partial profit at target, trails, and times out', () => {
    expect(evaluateExit({ ...base, position: pos(), executableValueSol: 0.089 }).action).toBe('sell');
    const t = evaluateExit({ ...base, position: pos(), executableValueSol: 0.13 });
    expect(t.action).toBe('reduce');
    expect(t.fraction).toBe(0.5);
    expect(evaluateExit({ ...base, position: pos({ peakValueSol: 0.2, meta: { partialTaken: true, trailingPct: 10 } }), executableValueSol: 0.17 }).reason).toMatch(/trailing/);
    expect(evaluateExit({ ...base, position: pos(), executableValueSol: 0.1, now: 700_000 }).reason).toMatch(/max holding/);
  });
  it('exits immediately on critical risk escalation or emergency policy', () => {
    const risk = { score: 70, tier: 'very_high' as const, categories: [], criticalFlags: ['CREATOR_DUMPING' as const], dataConfidence: 1, missing: [], calibrated: false as const };
    expect(evaluateExit({ ...base, position: pos(), executableValueSol: 0.1, risk }).urgent).toBe(true);
    expect(evaluateExit({ ...base, position: pos(), executableValueSol: 0.1, emergency: true }).action).toBe('sell');
  });
});

describe('strategy configuration versioning', () => {
  it('saves versions, refuses invalid params and reverts to known-good', () => {
    const reg = new StrategyRegistry(memDb());
    const v1 = reg.params('momentum');
    reg.save('momentum', { ...v1, minMomentum5mPct: 20 }, 'op', 'tweak');
    expect(reg.params('momentum').minMomentum5mPct).toBe(20);
    expect(() => reg.save('momentum', { ...v1, minMomentum5mPct: 9999 }, 'op', 'bad')).toThrow(/outside/);
    reg.revertToKnownGood('momentum', 'op');
    expect(reg.params('momentum').minMomentum5mPct).toBe(v1.minMomentum5mPct);
    expect(reg.history('momentum').length).toBe(3);
  });
});
