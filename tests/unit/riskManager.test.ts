import { describe, expect, it } from 'vitest';
import { assessToken } from '../../src/server/analysis/assessment';
import { DEFAULT_COSTS } from '../../src/server/analysis/profitability';
import { defaultRiskSettings, hardLimitsFromEnv, clampRiskSettings } from '../../src/server/config/riskSettings';
import { MIN_POSITION_SOL, RiskManager, type SystemConditions } from '../../src/server/risk/riskManager';
import { StrategyRegistry } from '../../src/server/strategy/registry';
import type { EntrySignal } from '../../src/server/strategy/types';
import type { PortfolioSummary } from '../../src/shared/types';
import { memDb, testEnv } from '../helpers/app';
import { curveState, healthyToken } from '../helpers/fixtures';

const NOW = 1_800_000_000_000;
const env = testEnv();
const hard = hardLimitsFromEnv(env);

const pf = (over: Partial<PortfolioSummary> = {}): PortfolioSummary => ({
  mode: 'paper',
  configuredCapitalSol: 1,
  cashSol: 1,
  walletSol: null,
  reservedSol: 0.02,
  availableSol: 0.98,
  openExposureSol: 0,
  indicativeValueSol: 0,
  executableValueSol: 0,
  equitySol: 1,
  realizedPnlSol: 0,
  unrealizedPnlSol: 0,
  todayPnlSol: 0,
  dayStartEquitySol: 1,
  peakEquitySol: 1,
  drawdownPct: 0,
  feesPaidSol: 0,
  openPositions: 0,
  tradeCount: 0,
  consecutiveLosses: 0,
  valuationMethod: 'test',
  ...over,
});

const sys = (over: Partial<SystemConditions> = {}): SystemConditions => ({
  mode: 'paper',
  killSwitchActive: false,
  liveArmed: false,
  dbHealthy: true,
  providerProblems: [],
  marketDataAgeMs: 100,
  staleMs: 20_000,
  ledgerMismatch: false,
  ambiguousOrders: 0,
  ...over,
});

const signal: EntrySignal = { strategy: 'momentum', confidence: 0.8, thesis: 'test', reasons: [], targetPct: 25, stopPct: 12, maxHoldSec: 900, trailingPct: 10, wantsHighRisk: false };

function assessment(settings = defaultRiskSettings(env)) {
  const t = healthyToken(NOW);
  const strategies = new StrategyRegistry(memDb());
  return assessToken(t, { now: NOW, staleMs: 20_000, settings, referenceSizeSol: 0.01, creatorHistory: { launches: 1, graduated: 0, flagged: 0, launchesLast24h: 1 }, providerProblems: [], costs: DEFAULT_COSTS, strategies, enabledStrategies: settings.enabledStrategies }).assessment;
}

describe('risk manager: account-level gates', () => {
  const rm = new RiskManager(defaultRiskSettings(env), hard, 1);
  it('allows entries when all gates pass', () => expect(rm.entryBlockers(sys(), pf())).toEqual([]));
  it('blocks on kill switch, offline mode, unarmed live, stale data, providers, db, ledger mismatch, ambiguous orders', () => {
    expect(rm.entryBlockers(sys({ killSwitchActive: true }), pf())[0]).toMatch(/kill switch/);
    expect(rm.entryBlockers(sys({ mode: 'offline' }), pf())).toContain('trading mode is offline');
    expect(rm.entryBlockers(sys({ mode: 'live', liveArmed: false }), pf())).toContain('live trading not armed');
    expect(rm.entryBlockers(sys({ marketDataAgeMs: 60_000 }), pf()).join()).toMatch(/stale/);
    expect(rm.entryBlockers(sys({ providerProblems: ['solana-rpc down'] }), pf()).join()).toMatch(/provider/);
    expect(rm.entryBlockers(sys({ dbHealthy: false }), pf())).toContain('database unavailable');
    expect(rm.entryBlockers(sys({ ledgerMismatch: true }), pf()).join()).toMatch(/mismatch/);
    expect(rm.entryBlockers(sys({ ambiguousOrders: 1 }), pf()).join()).toMatch(/reconciliation/);
  });
  it('enforces the daily loss limit (3% of day-start equity)', () => {
    expect(rm.entryBlockers(sys(), pf({ todayPnlSol: -0.029 }))).toEqual([]);
    expect(rm.entryBlockers(sys(), pf({ todayPnlSol: -0.03 })).join()).toMatch(/daily loss/);
    expect(rm.limitBreached(pf({ todayPnlSol: -0.031 }))).toBe(true);
  });
  it('suspends trading at the drawdown limit (5%)', () => {
    expect(rm.entryBlockers(sys(), pf({ drawdownPct: 5.01 })).join()).toMatch(/drawdown/);
    expect(rm.limitBreached(pf({ drawdownPct: 5 }))).toBe(true);
  });
  it('pauses after too many consecutive losses', () => {
    expect(rm.entryBlockers(sys(), pf({ consecutiveLosses: 5 })).join()).toMatch(/consecutive/);
  });
});

describe('risk manager: position sizing', () => {
  const settings = defaultRiskSettings(env);
  const rm = new RiskManager(settings, hard, 1);
  const a = assessment();
  const liq = curveState(40, NOW);

  it('caps a position at 1% of capital', () => {
    const s = rm.size(signal, a, liq, pf(), 0);
    expect(s.sizeSol).toBeLessThanOrEqual(0.01 + 1e-12);
    expect(s.caps.maxPosition).toBeCloseTo(0.01);
  });
  it('respects aggregate exposure (10%)', () => {
    const s = rm.size(signal, a, liq, pf({ openExposureSol: 0.095 }), 0);
    expect(s.sizeSol).toBeLessThanOrEqual(0.005 + 1e-9);
  });
  it('respects available cash after the fee reserve', () => {
    expect(rm.size(signal, a, liq, pf({ availableSol: 0.002 }), 0).sizeSol).toBeLessThanOrEqual(0.002);
  });
  it('uses equity when it is below configured capital', () => {
    expect(rm.size(signal, a, liq, pf({ equitySol: 0.5 }), 0).caps.maxPosition).toBeCloseTo(0.005);
  });
  it('shrinks with liquidity so impact stays within limits', () => {
    const big = new RiskManager({ ...settings, maxPositionPct: 5 }, { ...hard, maxPositionSol: 100, maxPositionPct: 100 }, 1000);
    const thin = curveState(2, NOW);
    const s = big.size(signal, a, thin, pf({ equitySol: 1000, availableSol: 1000, configuredCapitalSol: 1000 }), 0);
    expect(s.limitingFactor).toBe('liquidity');
  });
  it('rejects entries below the minimum size and when exposure is exhausted', () => {
    const d = rm.evaluateEntry({ signal, assessment: a, liquidity: liq, portfolio: pf({ openExposureSol: 0.1 }), system: sys(), hasActivePosition: false, hasActiveOrder: false, strategyExposureSol: 0, costs: DEFAULT_COSTS, onchainVerifiedAgeMs: 1000 });
    expect(d.approved).toBe(false);
    expect(d.reasons.join()).toMatch(new RegExp(`below minimum ${MIN_POSITION_SOL}`));
  });
});

describe('risk manager: entry decision', () => {
  const permissive = { ...defaultRiskSettings(env), minExpectedNetReturnPct: -100, minRewardToRisk: 0.01, minExitLiquiditySol: 1 };
  const rm = new RiskManager(permissive, hard, 1);
  const base = { signal, liquidity: curveState(40, NOW), portfolio: pf(), system: sys(), hasActivePosition: false, hasActiveOrder: false, strategyExposureSol: 0, costs: DEFAULT_COSTS, onchainVerifiedAgeMs: 1000 };

  it('approves when every gate passes and sizes within limits', () => {
    const d = rm.evaluateEntry({ ...base, assessment: assessment(permissive) });
    expect(d.reasons).toEqual([]);
    expect(d.approved).toBe(true);
    expect(d.sizeSol).toBeGreaterThanOrEqual(MIN_POSITION_SOL);
    expect(d.sizeSol).toBeLessThanOrEqual(0.01);
    expect(d.profitability?.sizeSol).toBe(d.sizeSol);
  });
  it('rejects a second position in the same mint and pending orders', () => {
    expect(rm.evaluateEntry({ ...base, assessment: assessment(permissive), hasActivePosition: true }).approved).toBe(false);
    expect(rm.evaluateEntry({ ...base, assessment: assessment(permissive), hasActiveOrder: true }).approved).toBe(false);
  });
  it('rejects without a recent on-chain reconciliation', () => {
    const d = rm.evaluateEntry({ ...base, assessment: assessment(permissive), onchainVerifiedAgeMs: 60_000 });
    expect(d.reasons.join()).toMatch(/reconciled/);
  });
  it('never lets opportunity override a critical flag', () => {
    const a = assessment(permissive);
    a.risk = { ...a.risk, criticalFlags: ['EXIT_ROUTE_UNAVAILABLE'] };
    a.opportunity = { score: 100, findings: [] };
    expect(rm.evaluateEntry({ ...base, assessment: a }).approved).toBe(false);
  });
  it('rejects high-risk tiers unless a strategy is explicitly allowed', () => {
    const a = assessment(permissive);
    a.risk = { ...a.risk, score: 50, tier: 'high' };
    const strict = new RiskManager({ ...permissive, maxRiskScore: 64 }, hard, 1);
    expect(strict.evaluateEntry({ ...base, assessment: a }).reasons.join()).toMatch(/high/);
    const allowing = new RiskManager({ ...permissive, maxRiskScore: 64, allowHighRiskStrategies: ['momentum'] }, hard, 1);
    expect(allowing.evaluateEntry({ ...base, assessment: a, signal: { ...signal, wantsHighRisk: true } }).reasons.join()).not.toMatch(/tier high/);
  });
  it('rejects when expected return after costs is insufficient (default thresholds)', () => {
    const strict = new RiskManager({ ...defaultRiskSettings(env), minExpectedNetReturnPct: 50 }, hard, 1);
    const d = strict.evaluateEntry({ ...base, assessment: assessment() });
    expect(d.approved).toBe(false);
    expect(d.reasons.join()).toMatch(/expected net/);
  });
});

describe('risk settings are clamped to hard limits', () => {
  it('cannot exceed HARD_* ceilings', () => {
    const { settings, adjustments } = clampRiskSettings({ ...defaultRiskSettings(env), maxPositionPct: 50, maxDrawdownPct: 99, maxRiskScore: 100 }, hard);
    expect(settings.maxPositionPct).toBe(hard.maxPositionPct);
    expect(settings.maxDrawdownPct).toBe(hard.maxDrawdownPct);
    expect(settings.maxRiskScore).toBe(hard.maxRiskScore);
    expect(adjustments.length).toBeGreaterThanOrEqual(3);
  });
});
