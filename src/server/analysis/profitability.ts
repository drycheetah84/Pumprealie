import type { MarketFeatures, ProfitabilityEstimate, ScenarioResult } from '../../shared/types';
import { clamp } from '../lib/util';
import { applyBuy, drainLiquidity, quoteBuy, quoteSell, shiftPrice, spotPriceSol, type LiquidityState } from '../market/liquidity';

export interface CostModel {
  /** Base signature fee per transaction (lamports). */
  baseFeeLamports: number;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  /** Expected delay between decision and inclusion (ms). */
  latencyMs: number;
}

export interface TradePlan {
  sizeSol: number;
  targetPct: number;
  stopPct: number;
  maxHoldSec: number;
}

export const DEFAULT_COSTS: CostModel = {
  baseFeeLamports: 5000,
  priorityFeeMicroLamports: 100_000,
  computeUnitLimit: 250_000,
  latencyMs: 800,
};

export function txFeeLamports(c: CostModel): number {
  return c.baseFeeLamports + Math.ceil((c.priorityFeeMicroLamports * c.computeUnitLimit) / 1_000_000);
}

/**
 * Heuristic scenario probabilities. NOT calibrated: the rug probability rises with the
 * risk score, bull probability with opportunity quality. The backtester reports realized
 * outcome frequencies so these can be compared and tuned against history.
 */
export function scenarioProbabilities(riskScore: number, opportunityScore: number): Record<ScenarioResult['name'], number> {
  const rug = clamp(0.02 + (riskScore / 100) ** 2 * 0.6, 0.02, 0.6);
  const q = clamp(opportunityScore / 100, 0, 1);
  const rest = 1 - rug;
  const bull = rest * (0.2 + 0.25 * q);
  const bear = rest * (0.45 - 0.2 * q);
  return { bull, bear, base: rest - bull - bear, rug };
}

/**
 * Scenario-based net P&L for buying `plan.sizeSol` now and exiting under each scenario,
 * simulated against the constant-product state including our own price impact, protocol
 * fees, network fees and an adverse-selection drift during execution latency.
 */
export function estimateProfitability(
  liq: LiquidityState,
  f: MarketFeatures,
  plan: TradePlan,
  riskScore: number,
  opportunityScore: number,
  costs: CostModel = DEFAULT_COSTS,
): ProfitabilityEstimate {
  const assumptions: string[] = [];
  const budget = Math.round(plan.sizeSol * 1e9);
  const fee = txFeeLamports(costs);
  const spot = spotPriceSol(liq);

  // Adverse drift during latency: half of the 5m volatility scaled by sqrt(time).
  const vol = f.volatility5mPct ?? 30;
  const latencyDriftPct = 0.5 * vol * Math.sqrt(costs.latencyMs / 300_000);
  assumptions.push(`entry drift ${latencyDriftPct.toFixed(2)}% from ${costs.latencyMs}ms latency at ${vol.toFixed(0)}% 5m volatility`);
  const entryState = shiftPrice(liq, latencyDriftPct);
  const buy = quoteBuy(entryState, budget);
  const tokens = buy.tokensOut;
  const afterBuy = applyBuy(entryState, buy);
  const immediate = quoteSell(afterBuy, tokens);
  const protocolFeesSol = (buy.feeLamports + immediate.feeLamports) / 1e9;
  const costLamports = buy.quoteInLamports + fee; // entry tx fee
  const roundTripCostPct = budget > 0 ? ((costLamports + fee - immediate.quoteOutLamports) / budget) * 100 : 100;

  const probs = scenarioProbabilities(riskScore, opportunityScore);
  // Stops gap: assume we exit beyond the stop by part of the 5m volatility.
  const stopSlip = Math.min(30, 0.35 * vol);
  const defs: Array<{ name: ScenarioResult['name']; move: number; drain: number; explanation: string }> = [
    { name: 'bull', move: plan.targetPct, drain: 0, explanation: `price reaches +${plan.targetPct}% target; exit into post-move liquidity` },
    { name: 'base', move: -2, drain: 0, explanation: `no follow-through; time exit after ${plan.maxHoldSec}s with slight drift` },
    {
      name: 'bear',
      move: -(plan.stopPct + stopSlip),
      drain: 0,
      explanation: `thesis fails; stop at -${plan.stopPct}% gaps a further ${stopSlip.toFixed(1)}%`,
    },
    { name: 'rug', move: -85, drain: 0.85, explanation: 'liquidity drained / coordinated dump; exit into ~15% of current liquidity' },
  ];
  const scenarios: ScenarioResult[] = defs.map((d) => {
    let s = shiftPrice(afterBuy, d.move);
    if (d.drain > 0) s = drainLiquidity(s, d.drain);
    const out = quoteSell(s, tokens);
    const net = out.quoteOutLamports - costLamports - fee;
    return {
      name: d.name,
      probability: Math.round(probs[d.name] * 1000) / 1000,
      exitPriceChangePct: d.move,
      netPnlSol: net / 1e9,
      netPnlPct: budget > 0 ? (net / budget) * 100 : 0,
      explanation: d.explanation,
    };
  });
  const ev = scenarios.reduce((a, s) => a + s.probability * s.netPnlSol, 0);
  const gains = scenarios.reduce((a, s) => a + s.probability * Math.max(0, s.netPnlSol), 0);
  const losses = scenarios.reduce((a, s) => a + s.probability * Math.min(0, s.netPnlSol), 0);
  assumptions.push(`network fee ${(fee / 1e9).toFixed(6)} SOL per tx (base + priority); token account rent assumed recovered on close`);
  assumptions.push('scenario probabilities are heuristic and uncalibrated');
  if (buy.capped) assumptions.push('buy capped by remaining curve supply');

  return {
    sizeSol: plan.sizeSol,
    entryPriceSol: spot,
    expectedTokensRaw: String(tokens),
    entrySlippagePct: Math.round(latencyDriftPct * 100) / 100,
    entryImpactPct: Math.round(buy.impactPct * 100) / 100,
    exitImpactPct: Math.round(-immediate.impactPct * 100) / 100,
    roundTripCostPct: Math.round(roundTripCostPct * 100) / 100,
    networkFeesSol: (2 * fee) / 1e9,
    protocolFeesSol,
    scenarios,
    expectedNetSol: ev,
    expectedNetPct: budget > 0 ? (ev / plan.sizeSol) * 100 : 0,
    rewardToRisk: losses < 0 ? gains / -losses : null,
    probabilityExitBlocked: Math.round(probs.rug * 1000) / 1000,
    executableExitSol: immediate.quoteOutLamports / 1e9,
    expectedHoldSec: Math.round(plan.maxHoldSec * 0.6),
    assumptions,
  };
}
