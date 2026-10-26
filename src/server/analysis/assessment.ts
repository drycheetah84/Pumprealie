import type { RecommendedAction, RiskAssessment, TokenAssessment, TokenSummary } from '../../shared/types';
import type { RiskSettings } from '../config/riskSettings';
import type { TokenState } from '../market/tokenRegistry';
import type { StrategyRegistry } from '../strategy/registry';
import type { EntrySignal } from '../strategy/types';
import { computeFeatures } from './features';
import { scoreOpportunity } from './opportunity';
import { estimateProfitability, type CostModel } from './profitability';
import { assessRisk, holdersFromFlows, type CreatorHistory } from './risk';

export interface AssessmentContext {
  now: number;
  staleMs: number;
  settings: RiskSettings;
  referenceSizeSol: number;
  creatorHistory: CreatorHistory | null;
  providerProblems: string[];
  costs: CostModel;
  strategies: StrategyRegistry;
  enabledStrategies: string[];
}

export interface AssessmentResult {
  assessment: TokenAssessment;
  signal: EntrySignal | null;
  strategyRejections: Record<string, string[]>;
}

/** Policy for whether a risk assessment permits *considering* a new position. */
export function riskPermitsEntry(risk: RiskAssessment, settings: RiskSettings, signal: EntrySignal | null): { ok: boolean; reason: string } {
  if (risk.criticalFlags.length) return { ok: false, reason: `critical: ${risk.criticalFlags.join(', ')}` };
  if (risk.tier === 'extreme' || risk.tier === 'very_high') return { ok: false, reason: `risk tier ${risk.tier} (${risk.score})` };
  if (risk.tier === 'high') {
    const allowed = signal && signal.wantsHighRisk && settings.allowHighRiskStrategies.includes(signal.strategy);
    if (!allowed) return { ok: false, reason: `risk tier high (${risk.score}); no strategy explicitly allowed for high risk` };
  }
  if (risk.score > settings.maxRiskScore) return { ok: false, reason: `risk ${risk.score} > max ${settings.maxRiskScore}` };
  return { ok: true, reason: 'risk acceptable' };
}

/** Full token analysis: features → risk → opportunity → strategy signals → profitability → recommendation. */
export function assessToken(t: TokenState, ctx: AssessmentContext): AssessmentResult {
  const features = computeFeatures(t, ctx.now);
  const risk = assessRisk(t, features, {
    now: ctx.now,
    staleMs: ctx.staleMs,
    settings: ctx.settings,
    referenceSizeSol: ctx.referenceSizeSol,
    creatorHistory: ctx.creatorHistory,
    providerProblems: ctx.providerProblems,
  });
  const opportunity = scoreOpportunity(features, ctx.now);

  const rejections: Record<string, string[]> = {};
  let best: EntrySignal | null = null;
  for (const s of ctx.strategies.strategies) {
    if (!ctx.enabledStrategies.includes(s.id)) continue;
    const r = s.evaluate({ token: t, features, risk, opportunityScore: opportunity.score, now: ctx.now }, ctx.strategies.params(s.id));
    if (r.ok) {
      if (!best || r.signal.confidence > best.confidence) best = r.signal;
    } else rejections[s.id] = r.reasons;
  }

  const plan = best ?? { targetPct: 20, stopPct: 12, maxHoldSec: 900 };
  const profitability = t.liquidity
    ? estimateProfitability(t.liquidity, features, { sizeSol: ctx.referenceSizeSol, targetPct: plan.targetPct, stopPct: plan.stopPct, maxHoldSec: plan.maxHoldSec }, risk.score, opportunity.score, ctx.costs)
    : null;

  const reasons: string[] = [];
  let action: RecommendedAction = 'skip';
  const gate = riskPermitsEntry(risk, ctx.settings, best);
  if (!gate.ok) reasons.push(gate.reason);
  if (!best) reasons.push('no strategy signal');
  if (profitability) {
    if (profitability.expectedNetPct < ctx.settings.minExpectedNetReturnPct)
      reasons.push(`expected net ${profitability.expectedNetPct.toFixed(1)}% < ${ctx.settings.minExpectedNetReturnPct}%`);
    if ((profitability.rewardToRisk ?? 0) < ctx.settings.minRewardToRisk) reasons.push(`reward/risk ${(profitability.rewardToRisk ?? 0).toFixed(2)} < ${ctx.settings.minRewardToRisk}`);
    if (profitability.exitImpactPct > ctx.settings.maxPriceImpactPct) reasons.push(`exit impact ${profitability.exitImpactPct}% > ${ctx.settings.maxPriceImpactPct}%`);
  } else reasons.push('no executable quote');
  if (reasons.length === 0) {
    action = 'buy';
    reasons.push(best!.thesis, `expected net ${profitability!.expectedNetPct.toFixed(1)}%, reward/risk ${profitability!.rewardToRisk?.toFixed(2)}`);
  } else if (gate.ok && opportunity.score >= 30) action = 'watch';

  const holders = t.holders ?? holdersFromFlows(t, ctx.now);
  const w = features.windows;
  const summary: TokenSummary = {
    mint: t.mint,
    name: t.name,
    symbol: t.symbol,
    creator: t.creator,
    createdAt: t.createdAt,
    venue: t.venue,
    quoteMint: t.quoteMint,
    complete: t.complete,
    priceSol: features.priceSol,
    marketCapSol: features.marketCapSol,
    realSolReserves: features.realSolReserves,
    bondingProgressPct: features.bondingProgressPct,
    volume5mSol: w[1]!.volumeSol,
    volume1hSol: w[3]!.volumeSol,
    momentum5mPct: features.momentum5mPct,
    riskScore: risk.score,
    riskTier: risk.tier,
    dataConfidence: risk.dataConfidence,
    criticalFlags: risk.criticalFlags,
    expectedNetPct: profitability?.expectedNetPct ?? null,
    exitLiquiditySol: profitability?.executableExitSol ?? null,
    action,
    actionReason: reasons[0] ?? '',
    strategy: best?.strategy ?? null,
    lastUpdate: ctx.now,
  };
  return {
    assessment: {
      mint: t.mint,
      assessedAt: ctx.now,
      summary,
      features,
      risk,
      opportunity,
      profitability,
      holders,
      mintInfo: t.mintInfo,
      recommendation: { action, reasons, strategy: best?.strategy ?? null },
    },
    signal: action === 'buy' ? best : null,
    strategyRejections: rejections,
  };
}
