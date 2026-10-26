import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../src/server/backtest/metrics';
import { runReplay, type ReplayConfig, type ReplayDataSource } from '../../src/server/backtest/replay';
import { DEFAULT_COSTS } from '../../src/server/analysis/profitability';
import { defaultRiskSettings, hardLimitsFromEnv } from '../../src/server/config/riskSettings';
import type { TradeEvent } from '../../src/server/market/types';
import { StrategyRegistry } from '../../src/server/strategy/registry';
import { memDb, testEnv } from '../helpers/app';
import { curveState, trade } from '../helpers/fixtures';

const T0 = 1_800_000_000_000;

/** Synthetic but protocol-consistent tape: each trade carries the curve state after it. */
function tape(): TradeEvent[] {
  const out: TradeEvent[] = [];
  const tokens = [
    { mint: 'PUMPER1111111111111111111111111111111111111', drift: 0.9, start: 15 },
    { mint: 'RUGGER1111111111111111111111111111111111111', drift: 0.55, start: 25 },
    { mint: 'CHOPPY1111111111111111111111111111111111111', drift: 0.7, start: 20 },
  ];
  for (const tk of tokens) {
    let real = tk.start;
    for (let i = 0; i < 600; i++) {
      const ts = T0 + i * 5000 + tokens.indexOf(tk) * 1000;
      const rugPhase = tk.mint.startsWith('RUGGER') && i > 350;
      const buy = rugPhase ? (i * 7) % 10 < 1 : ((i * 7919) % 100) / 100 < (i < 300 ? tk.drift : 1 - tk.drift + 0.2);
      const size = 0.1 + ((i * 37) % 23) / 25;
      real = Math.max(0.5, Math.min(80, real + (buy ? size : -size * (rugPhase ? 3 : 1))));
      out.push(trade({ mint: tk.mint, ts, side: buy ? 'buy' : 'sell', sol: size, trader: `w${(i * 17) % 90}`, state: curveState(real, ts), signature: `${tk.mint.slice(0, 6)}-${i}` }));
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function source(events: TradeEvent[]): ReplayDataSource {
  return {
    trades: (from, to) => events.filter((e) => e.ts >= from && e.ts < to),
    tokenMeta: (mint) => ({ mint, creator: 'CreatorX', createdAt: T0 - 60_000, quoteMint: '11111111111111111111111111111111', tokenProgram: null, isMayhem: false, name: mint.slice(0, 6), symbol: mint.slice(0, 4) }),
    mintInfoAsOf: () => null,
    holdersAsOf: () => null,
    creatorLaunchesBetween: () => 1,
  };
}

const env = testEnv();
function cfg(toTs: number): ReplayConfig {
  return {
    fromTs: T0,
    toTs,
    capitalSol: 1,
    settings: { ...defaultRiskSettings(env), minExpectedNetReturnPct: -100, minRewardToRisk: 0.01, maxRiskScore: 64, minExitLiquiditySol: 1, enabledStrategies: ['momentum'] },
    hard: hardLimitsFromEnv(env),
    costs: DEFAULT_COSTS,
    paramOverrides: { momentum: { minLiquiditySol: 2, minMomentum5mPct: 1, maxMomentum5mPct: 300, minBuyShare: 0.5, minUniqueTraders5m: 3, maxDrawdownFromPeakPct: 60, targetPct: 15, stopPct: 8, trailingPct: 6, maxHoldSec: 600 } },
    evalIntervalMs: 5000,
    latencyMs: 800,
    failureRate: 0.03,
    seed: 7,
    assumeStandardMintWhenUnknown: true,
    staleMs: 20_000,
  };
}

describe('historical replay', () => {
  const events = tape();
  const end = T0 + 600 * 5000 + 10_000;
  const strategies = new StrategyRegistry(memDb());

  it('is deterministic for a given seed and dataset', async () => {
    const a = await runReplay(source(events), strategies, cfg(end));
    const b = await runReplay(source(events), strategies, cfg(end));
    expect(a.decisions).toEqual(b.decisions);
    expect(a.trades).toEqual(b.trades);
    expect(a.decisions.length).toBeGreaterThan(0);
  });

  it('has no look-ahead: appending future data never changes earlier decisions', async () => {
    const cut = T0 + 300 * 5000;
    const truncated = await runReplay(source(events.filter((e) => e.ts < cut)), strategies, cfg(cut));
    const full = await runReplay(source(events), strategies, cfg(end));
    const before = (d: { at: number }[]) => d.filter((x) => x.at < cut - 5000);
    expect(before(truncated.decisions).length).toBeGreaterThan(0);
    expect(before(full.decisions)).toEqual(before(truncated.decisions));
  });

  it('reports realized vs executable vs mark-to-market separately, including failed tokens', async () => {
    const r = await runReplay(source(events), strategies, cfg(end));
    const m = computeMetrics(r, 1);
    expect(m.trades + r.openAtEnd.length).toBeGreaterThan(0);
    expect(m.realizedPnlSol).toBeCloseTo(r.trades.reduce((a, t) => a + t.pnlSol, 0), 9);
    expect(typeof m.openMarkSol).toBe('number');
    expect(m.feesSol).toBeGreaterThan(0);
    expect(r.tokensSeen).toBe(3);
    expect(r.assumptions.join()).toMatch(/standard Pump mints/);
  });
});
