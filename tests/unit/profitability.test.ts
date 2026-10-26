import { describe, expect, it } from 'vitest';
import { computeFeatures } from '../../src/server/analysis/features';
import { DEFAULT_COSTS, estimateProfitability, scenarioProbabilities, txFeeLamports } from '../../src/server/analysis/profitability';
import { curveState, healthyToken } from '../helpers/fixtures';

const NOW = 1_800_000_000_000;
const plan = { sizeSol: 0.05, targetPct: 25, stopPct: 12, maxHoldSec: 900 };

describe('profitability engine', () => {
  const t = healthyToken(NOW);
  const f = computeFeatures(t, NOW);
  const liq = curveState(30, NOW);

  it('scenario probabilities sum to one and rug probability rises with risk', () => {
    for (const r of [0, 20, 50, 90]) {
      const p = scenarioProbabilities(r, 50);
      expect(p.bull + p.base + p.bear + p.rug).toBeCloseTo(1, 9);
    }
    expect(scenarioProbabilities(80, 50).rug).toBeGreaterThan(scenarioProbabilities(20, 50).rug);
  });

  it('round-trip cost includes protocol fees on both legs and network fees', () => {
    const e = estimateProfitability(liq, f, plan, 20, 50);
    // 1.25% each way plus fixed network fees on a 0.05 SOL position.
    expect(e.roundTripCostPct).toBeGreaterThan(2.4);
    expect(e.networkFeesSol).toBeCloseTo((2 * txFeeLamports(DEFAULT_COSTS)) / 1e9, 12);
    expect(e.protocolFeesSol).toBeGreaterThan(0);
  });

  it('a flat market loses money after costs (quoted price is not realized profit)', () => {
    const e = estimateProfitability(liq, f, plan, 20, 50);
    const base = e.scenarios.find((s) => s.name === 'base')!;
    expect(base.netPnlSol).toBeLessThan(0);
    expect(e.executableExitSol).toBeLessThan(plan.sizeSol);
  });

  it('the rug scenario loses most of the position', () => {
    const e = estimateProfitability(liq, f, plan, 20, 50);
    expect(e.scenarios.find((s) => s.name === 'rug')!.netPnlPct).toBeLessThan(-70);
  });

  it('expected value falls as risk rises', () => {
    const lo = estimateProfitability(liq, f, plan, 10, 60);
    const hi = estimateProfitability(liq, f, plan, 60, 60);
    expect(hi.expectedNetPct).toBeLessThan(lo.expectedNetPct);
  });

  it('larger positions pay more price impact', () => {
    const small = estimateProfitability(liq, f, { ...plan, sizeSol: 0.01 }, 20, 50);
    const big = estimateProfitability(liq, f, { ...plan, sizeSol: 3 }, 20, 50);
    expect(big.entryImpactPct).toBeGreaterThan(small.entryImpactPct);
    expect(big.exitImpactPct).toBeGreaterThan(small.exitImpactPct);
  });

  it('latency adds adverse entry drift', () => {
    const fast = estimateProfitability(liq, f, plan, 20, 50, { ...DEFAULT_COSTS, latencyMs: 100 });
    const slow = estimateProfitability(liq, f, plan, 20, 50, { ...DEFAULT_COSTS, latencyMs: 10_000 });
    expect(slow.entrySlippagePct).toBeGreaterThan(fast.entrySlippagePct);
    expect(slow.expectedNetSol).toBeLessThan(fast.expectedNetSol);
  });
});
