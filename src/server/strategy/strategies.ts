import type { ParamSpec, Strategy, StrategyContext, StrategyParams, EntryEvaluation } from './types';

const p = (def: number, min: number, max: number, step: number, description: string): ParamSpec => ({ default: def, min, max, step, description });

function reject(reasons: string[]): EntryEvaluation {
  return { ok: false, reasons };
}

/** Common hygiene every entry strategy requires. */
function baseChecks(ctx: StrategyContext, params: StrategyParams): string[] {
  const r: string[] = [];
  const f = ctx.features;
  if (f.priceSol === null) r.push('no price');
  if ((f.realSolReserves ?? 0) < params.minLiquiditySol!) r.push(`liquidity ${(f.realSolReserves ?? 0).toFixed(2)} < ${params.minLiquiditySol} SOL`);
  if (f.lastTradeAt === null || ctx.now - f.lastTradeAt > 60_000) r.push('no trades in last 60s');
  return r;
}

export const momentumStrategy: Strategy = {
  id: 'momentum',
  name: 'Momentum continuation',
  description: 'Sustained buying interest with positive multi-window momentum and adequate exit liquidity; avoids parabolic extensions.',
  paramSpecs: {
    minLiquiditySol: p(8, 1, 80, 1, 'Minimum withdrawable SOL liquidity'),
    minMomentum5mPct: p(8, 1, 60, 1, 'Minimum 5-minute price change'),
    maxMomentum5mPct: p(80, 20, 300, 10, 'Skip if 5-minute move is larger (overextended)'),
    minBuyShare: p(0.58, 0.5, 0.9, 0.02, 'Minimum share of 5m volume that is buys'),
    minUniqueTraders5m: p(12, 3, 100, 1, 'Minimum distinct traders in 5m'),
    maxDrawdownFromPeakPct: p(15, 3, 60, 1, 'Skip if price is this far below the 1h peak'),
    targetPct: p(25, 5, 200, 5, 'Profit target'),
    stopPct: p(12, 3, 50, 1, 'Invalidation distance'),
    trailingPct: p(10, 3, 40, 1, 'Trailing stop from peak value'),
    maxHoldSec: p(900, 60, 7200, 60, 'Maximum holding period'),
  },
  entryCriteria: [
    '5m momentum between min and max',
    '1m momentum not negative',
    'buy share of 5m volume above threshold',
    'enough distinct traders',
    'not deep below 1h peak',
    'liquidity above minimum and no liquidity decline > 15% in 5m',
  ],
  exitCriteria: ['shared exit policy: target, stop, trailing, max hold, risk escalation, liquidity deterioration'],
  evaluate(ctx, params) {
    const f = ctx.features;
    const w5 = f.windows[1]!;
    const r = baseChecks(ctx, params);
    if (f.momentum5mPct === null || f.momentum5mPct < params.minMomentum5mPct!) r.push(`5m momentum ${f.momentum5mPct?.toFixed(1) ?? 'n/a'}% < ${params.minMomentum5mPct}%`);
    if (f.momentum5mPct !== null && f.momentum5mPct > params.maxMomentum5mPct!) r.push(`overextended: 5m +${f.momentum5mPct.toFixed(0)}%`);
    if (f.momentum1mPct !== null && f.momentum1mPct < 0) r.push('1m momentum negative');
    const buyShare = w5.volumeSol > 0 ? w5.buyVolumeSol / w5.volumeSol : 0;
    if (buyShare < params.minBuyShare!) r.push(`buy share ${(buyShare * 100).toFixed(0)}% < ${(params.minBuyShare! * 100).toFixed(0)}%`);
    if (w5.uniqueTraders < params.minUniqueTraders5m!) r.push(`${w5.uniqueTraders} traders < ${params.minUniqueTraders5m}`);
    if (f.drawdownFromPeakPct !== null && f.drawdownFromPeakPct < -params.maxDrawdownFromPeakPct!) r.push(`${f.drawdownFromPeakPct.toFixed(0)}% below peak`);
    if (f.liquidityChange5mPct !== null && f.liquidityChange5mPct < -15) r.push('liquidity declining');
    if (r.length) return reject(r);
    return {
      ok: true,
      signal: {
        strategy: 'momentum',
        confidence: Math.min(1, ctx.opportunityScore / 80),
        thesis: `Momentum +${f.momentum5mPct!.toFixed(1)}% (5m) with ${(buyShare * 100).toFixed(0)}% buy share across ${w5.uniqueTraders} traders`,
        reasons: [`opportunity ${ctx.opportunityScore}`],
        targetPct: params.targetPct!,
        stopPct: params.stopPct!,
        maxHoldSec: params.maxHoldSec!,
        trailingPct: params.trailingPct!,
        wantsHighRisk: false,
      },
    };
  },
};

export const volumeAccelerationStrategy: Strategy = {
  id: 'volume_acceleration',
  name: 'Volume acceleration',
  description: 'Unusual increase in genuine (non-repetitive, broad) trading activity versus prior windows.',
  paramSpecs: {
    minLiquiditySol: p(8, 1, 80, 1, 'Minimum withdrawable SOL liquidity'),
    minAcceleration: p(2.5, 1.2, 10, 0.25, '1m volume / prior 5m per-minute average'),
    minVolume1mSol: p(2, 0.2, 50, 0.2, 'Minimum 1-minute volume'),
    minPriorVolumePerMinSol: p(0.5, 0.05, 20, 0.05, 'Baseline volume required before the spike (launch bursts are not acceleration)'),
    maxRepeatedSizeShare: p(0.3, 0.05, 0.8, 0.05, 'Discount repetitive same-size trades'),
    maxRoundTripShare: p(0.35, 0.05, 0.9, 0.05, 'Discount wallets that buy and sell'),
    minBuyShare1m: p(0.55, 0.5, 0.9, 0.05, 'Buy share of last-minute volume'),
    targetPct: p(20, 5, 200, 5, 'Profit target'),
    stopPct: p(10, 3, 50, 1, 'Invalidation distance'),
    trailingPct: p(8, 3, 40, 1, 'Trailing stop'),
    maxHoldSec: p(600, 60, 7200, 60, 'Maximum holding period'),
  },
  entryCriteria: ['volume acceleration above threshold', 'minimum 1m volume', 'established prior baseline volume (launch bursts excluded)', 'low repetitive-size and round-trip shares', 'buy-dominated last minute'],
  exitCriteria: ['shared exit policy'],
  evaluate(ctx, params) {
    const f = ctx.features;
    const w1 = f.windows[0]!;
    const r = baseChecks(ctx, params);
    if (f.volumeAcceleration === null || f.volumeAcceleration < params.minAcceleration!) r.push(`acceleration ${f.volumeAcceleration?.toFixed(2) ?? 'n/a'} < ${params.minAcceleration}`);
    if (w1.volumeSol < params.minVolume1mSol!) r.push(`1m volume ${w1.volumeSol.toFixed(2)} < ${params.minVolume1mSol}`);
    const priorPerMin = (f.windows[1]!.volumeSol - w1.volumeSol) / 4;
    if (priorPerMin < params.minPriorVolumePerMinSol!) r.push(`prior volume ${priorPerMin.toFixed(2)} SOL/min below baseline ${params.minPriorVolumePerMinSol}`);
    if ((f.repeatedSizeShare ?? 0) > params.maxRepeatedSizeShare!) r.push('repetitive trade sizes');
    if ((f.roundTripTraderShare ?? 0) > params.maxRoundTripShare!) r.push('round-trip volume');
    const bs = w1.volumeSol > 0 ? w1.buyVolumeSol / w1.volumeSol : 0;
    if (bs < params.minBuyShare1m!) r.push(`1m buy share ${(bs * 100).toFixed(0)}%`);
    if (r.length) return reject(r);
    return {
      ok: true,
      signal: {
        strategy: 'volume_acceleration',
        confidence: Math.min(1, f.volumeAcceleration! / (params.minAcceleration! * 2)),
        thesis: `1m volume ${w1.volumeSol.toFixed(2)} SOL is ${f.volumeAcceleration!.toFixed(1)}× the prior rate with ${(bs * 100).toFixed(0)}% buys`,
        reasons: [],
        targetPct: params.targetPct!,
        stopPct: params.stopPct!,
        maxHoldSec: params.maxHoldSec!,
        trailingPct: params.trailingPct!,
        wantsHighRisk: false,
      },
    };
  },
};

export const earlyLaunchStrategy: Strategy = {
  id: 'early_launch',
  name: 'Early-launch evaluation',
  description: 'Young launches observed from creation, with stricter concentration, uncertainty and liquidity limits. Being early is never sufficient on its own.',
  paramSpecs: {
    minLiquiditySol: p(5, 1, 50, 1, 'Minimum withdrawable SOL liquidity'),
    maxAgeSec: p(600, 60, 3600, 60, 'Only tokens younger than this'),
    minAgeSec: p(60, 10, 600, 10, 'Ignore the first seconds (sniper phase)'),
    minUniqueTraders: p(20, 5, 200, 5, 'Distinct traders since launch (5m window)'),
    maxRiskScore: p(35, 10, 44, 1, 'Stricter risk ceiling than the global limit'),
    minDataConfidence: p(0.6, 0.3, 0.95, 0.05, 'Minimum data confidence'),
    minMomentum5mPct: p(5, 0, 50, 1, 'Minimum 5m price change'),
    targetPct: p(40, 10, 300, 10, 'Profit target'),
    stopPct: p(15, 5, 50, 1, 'Invalidation distance'),
    trailingPct: p(15, 5, 40, 1, 'Trailing stop'),
    maxHoldSec: p(900, 60, 7200, 60, 'Maximum holding period'),
  },
  entryCriteria: ['observed from launch', 'age within window', 'risk below stricter ceiling', 'data confidence above threshold', 'broad participation', 'positive momentum'],
  exitCriteria: ['shared exit policy'],
  evaluate(ctx, params) {
    const f = ctx.features;
    const t = ctx.token;
    const r = baseChecks(ctx, params);
    const age = t.createdAt ? (ctx.now - t.createdAt) / 1000 : null;
    if (!t.observedFromLaunch) r.push('not observed from launch');
    if (age === null || age > params.maxAgeSec! || age < params.minAgeSec!) r.push(`age ${age?.toFixed(0) ?? 'unknown'}s outside window`);
    if (ctx.risk.score > params.maxRiskScore!) r.push(`risk ${ctx.risk.score} > ${params.maxRiskScore}`);
    if (ctx.risk.dataConfidence < params.minDataConfidence!) r.push(`data confidence ${ctx.risk.dataConfidence}`);
    if (f.windows[1]!.uniqueTraders < params.minUniqueTraders!) r.push(`${f.windows[1]!.uniqueTraders} traders`);
    if (f.momentum5mPct === null || f.momentum5mPct < params.minMomentum5mPct!) r.push('insufficient momentum');
    if (!t.holders) r.push('requires on-chain holder snapshot');
    if (r.length) return reject(r);
    return {
      ok: true,
      signal: {
        strategy: 'early_launch',
        confidence: 0.5,
        thesis: `Launch ${Math.round(age!)}s old with ${f.windows[1]!.uniqueTraders} traders and risk ${ctx.risk.score}`,
        reasons: [],
        targetPct: params.targetPct!,
        stopPct: params.stopPct!,
        maxHoldSec: params.maxHoldSec!,
        trailingPct: params.trailingPct!,
        wantsHighRisk: false,
      },
    };
  },
};

export const pullbackStrategy: Strategy = {
  id: 'pullback',
  name: 'Pullback entry',
  description: 'Retracement after a confirmed move, entered only after stabilization (no fresh lows, buyers returning).',
  paramSpecs: {
    minLiquiditySol: p(10, 1, 80, 1, 'Minimum withdrawable SOL liquidity'),
    minPriorRunPct: p(40, 10, 300, 5, 'Required 1h run-up before the pullback'),
    minPullbackPct: p(15, 5, 50, 1, 'Minimum retracement from 1h peak'),
    maxPullbackPct: p(40, 15, 70, 1, 'Maximum retracement (deeper = broken)'),
    minStabilizationBuyShare: p(0.55, 0.5, 0.9, 0.05, 'Buy share of last minute'),
    targetPct: p(20, 5, 100, 5, 'Profit target'),
    stopPct: p(12, 3, 40, 1, 'Invalidation distance'),
    trailingPct: p(10, 3, 40, 1, 'Trailing stop'),
    maxHoldSec: p(1200, 60, 7200, 60, 'Maximum holding period'),
  },
  entryCriteria: ['prior 1h run-up', 'retracement within band', '1m momentum >= 0 (stabilized)', 'last-minute buys dominate', 'liquidity not declining'],
  exitCriteria: ['shared exit policy'],
  evaluate(ctx, params) {
    const f = ctx.features;
    const w1 = f.windows[0]!;
    const h1 = f.windows[3]!;
    const r = baseChecks(ctx, params);
    const run = h1.priceChangePct !== null && f.drawdownFromPeakPct !== null ? ((1 + h1.priceChangePct / 100) / (1 + f.drawdownFromPeakPct / 100) - 1) * 100 : null;
    if (run === null || run < params.minPriorRunPct!) r.push(`prior run ${run?.toFixed(0) ?? 'n/a'}% < ${params.minPriorRunPct}%`);
    const dd = f.drawdownFromPeakPct === null ? null : -f.drawdownFromPeakPct;
    if (dd === null || dd < params.minPullbackPct! || dd > params.maxPullbackPct!) r.push(`pullback ${dd?.toFixed(0) ?? 'n/a'}% outside band`);
    if (f.momentum1mPct === null || f.momentum1mPct < 0) r.push('not stabilized (1m momentum negative)');
    const bs = w1.volumeSol > 0 ? w1.buyVolumeSol / w1.volumeSol : 0;
    if (bs < params.minStabilizationBuyShare!) r.push('buyers not returning');
    if (f.liquidityChange5mPct !== null && f.liquidityChange5mPct < -10) r.push('liquidity declining');
    if (r.length) return reject(r);
    return {
      ok: true,
      signal: {
        strategy: 'pullback',
        confidence: 0.5,
        thesis: `Pullback ${dd!.toFixed(0)}% after a ${run!.toFixed(0)}% run; stabilizing with ${(bs * 100).toFixed(0)}% buys`,
        reasons: [],
        targetPct: params.targetPct!,
        stopPct: params.stopPct!,
        maxHoldSec: params.maxHoldSec!,
        trailingPct: params.trailingPct!,
        wantsHighRisk: false,
      },
    };
  },
};

export const ENTRY_STRATEGIES: Strategy[] = [momentumStrategy, volumeAccelerationStrategy, earlyLaunchStrategy, pullbackStrategy];
