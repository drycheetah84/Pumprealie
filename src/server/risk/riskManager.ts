import type { PortfolioSummary, ProfitabilityEstimate, TokenAssessment, TradingMode } from '../../shared/types';
import type { HardLimits, RiskSettings } from '../config/riskSettings';
import { estimateProfitability, type CostModel } from '../analysis/profitability';
import { riskPermitsEntry } from '../analysis/assessment';
import { maxBuyForImpact, type LiquidityState } from '../market/liquidity';
import type { EntrySignal } from '../strategy/types';

export interface SystemConditions {
  mode: TradingMode;
  killSwitchActive: boolean;
  liveArmed: boolean;
  dbHealthy: boolean;
  providerProblems: string[];
  marketDataAgeMs: number;
  staleMs: number;
  /** Live only: wallet balances disagree with the internal ledger. */
  ledgerMismatch: boolean;
  /** Non-terminal orders whose outcome is not yet known. */
  ambiguousOrders: number;
}

export interface SizingResult {
  sizeSol: number;
  limitingFactor: string;
  caps: Record<string, number>;
}

export interface EntryDecision {
  approved: boolean;
  sizeSol: number;
  reasons: string[];
  sizing: SizingResult | null;
  profitability: ProfitabilityEstimate | null;
}

export const MIN_POSITION_SOL = 0.005;
const TIER_MULTIPLIER: Record<string, number> = { lower: 1, moderate: 0.6, high: 0.3, very_high: 0, extreme: 0 };

/**
 * Shared, strategy-independent risk manager. Strategies propose; only this class
 * decides whether an entry is permitted and how large it may be.
 */
export class RiskManager {
  constructor(
    private settings: RiskSettings,
    private readonly hard: HardLimits,
    private readonly configuredCapitalSol: number,
  ) {}

  updateSettings(s: RiskSettings) {
    this.settings = s;
  }

  get current(): RiskSettings {
    return this.settings;
  }

  /** Account-level conditions that block every new entry. */
  entryBlockers(sys: SystemConditions, pf: PortfolioSummary): string[] {
    const r: string[] = [];
    const s = this.settings;
    if (sys.killSwitchActive) r.push('kill switch active');
    if (sys.mode === 'offline') r.push('trading mode is offline');
    if (sys.mode === 'live' && !sys.liveArmed) r.push('live trading not armed');
    if (!sys.dbHealthy) r.push('database unavailable');
    if (sys.providerProblems.length) r.push(`provider health: ${sys.providerProblems.join(', ')}`);
    if (sys.marketDataAgeMs > sys.staleMs) r.push(`market data stale (${Math.round(sys.marketDataAgeMs / 1000)}s)`);
    if (sys.ledgerMismatch) r.push('wallet/ledger mismatch: reconciliation required');
    if (sys.ambiguousOrders > 0) r.push(`${sys.ambiguousOrders} order(s) awaiting reconciliation`);
    const dayLossPct = pf.dayStartEquitySol > 0 ? (-pf.todayPnlSol / pf.dayStartEquitySol) * 100 : 0;
    if (dayLossPct >= s.maxDailyLossPct) r.push(`daily loss ${dayLossPct.toFixed(2)}% ≥ limit ${s.maxDailyLossPct}%`);
    if (pf.drawdownPct >= s.maxDrawdownPct) r.push(`drawdown ${pf.drawdownPct.toFixed(2)}% ≥ limit ${s.maxDrawdownPct}% (trading suspended)`);
    if (pf.consecutiveLosses >= s.maxConsecutiveLosses) r.push(`${pf.consecutiveLosses} consecutive losses ≥ ${s.maxConsecutiveLosses}`);
    return r;
  }

  /** True when a loss/drawdown limit is breached and the emergency policy should run. */
  limitBreached(pf: PortfolioSummary): boolean {
    const dayLossPct = pf.dayStartEquitySol > 0 ? (-pf.todayPnlSol / pf.dayStartEquitySol) * 100 : 0;
    return dayLossPct >= this.settings.maxDailyLossPct || pf.drawdownPct >= this.settings.maxDrawdownPct;
  }

  /** Capital base for percentage limits: the smaller of configured capital and current equity. */
  capitalBase(pf: PortfolioSummary): number {
    return Math.max(0, Math.min(this.configuredCapitalSol, pf.equitySol));
  }

  size(signal: EntrySignal, a: TokenAssessment, liq: LiquidityState, pf: PortfolioSummary, strategyExposureSol: number): SizingResult {
    const s = this.settings;
    const base = this.capitalBase(pf);
    const caps: Record<string, number> = {};
    caps.maxPosition = (base * s.maxPositionPct) / 100;
    caps.hardMaxPosition = Math.min(this.hard.maxPositionSol, (base * this.hard.maxPositionPct) / 100);
    const rtCost = (a.profitability?.roundTripCostPct ?? 3) / 100;
    caps.riskBudget = (base * (s.maxPositionPct / 100) * 0.25) / Math.max(0.02, signal.stopPct / 100 + rtCost);
    caps.liquidity = maxBuyForImpact(liq, s.maxPriceImpactPct, Math.round(caps.maxPosition * 1e9 * 2)) / 1e9;
    caps.exposure = (base * s.maxExposurePct) / 100 - pf.openExposureSol;
    caps.cash = pf.availableSol;
    const alloc = s.strategyAllocationPct[signal.strategy];
    if (alloc !== undefined) caps.strategyAllocation = (base * alloc) / 100 - strategyExposureSol;
    let size = Math.min(...Object.values(caps));
    const limiting = Object.entries(caps).find(([, v]) => v === size)?.[0] ?? 'unknown';
    size *= TIER_MULTIPLIER[a.risk.tier] ?? 0;
    const vol = a.features.volatility5mPct ?? 0;
    if (vol > 50) size *= 0.7;
    size = Math.max(0, Math.floor(size * 1e6) / 1e6);
    return { sizeSol: size, limitingFactor: limiting, caps };
  }

  /**
   * Full pre-trade decision: account blockers, risk policy, sizing, and re-estimated
   * profitability at the actual size. Any failure rejects the entry.
   */
  evaluateEntry(args: {
    signal: EntrySignal;
    assessment: TokenAssessment;
    liquidity: LiquidityState | null;
    portfolio: PortfolioSummary;
    system: SystemConditions;
    hasActivePosition: boolean;
    hasActiveOrder: boolean;
    strategyExposureSol: number;
    costs: CostModel;
    onchainVerifiedAgeMs: number | null;
  }): EntryDecision {
    const s = this.settings;
    const reasons = this.entryBlockers(args.system, args.portfolio);
    const a = args.assessment;
    if (!s.enabledStrategies.includes(args.signal.strategy)) reasons.push(`strategy ${args.signal.strategy} disabled`);
    if (s.onePositionPerMint && args.hasActivePosition) reasons.push('position already open for this mint');
    if (args.hasActiveOrder) reasons.push('order already pending for this mint');
    const gate = riskPermitsEntry(a.risk, s, args.signal);
    if (!gate.ok) reasons.push(gate.reason);
    if (args.onchainVerifiedAgeMs === null || args.onchainVerifiedAgeMs > 15_000) reasons.push('liquidity not reconciled on-chain in the last 15s');
    if (!args.liquidity) reasons.push('no liquidity state');
    if (reasons.length || !args.liquidity) return { approved: false, sizeSol: 0, reasons, sizing: null, profitability: null };

    const sizing = this.size(args.signal, a, args.liquidity, args.portfolio, args.strategyExposureSol);
    if (sizing.sizeSol < MIN_POSITION_SOL) {
      return { approved: false, sizeSol: 0, reasons: [`position size ${sizing.sizeSol.toFixed(4)} SOL below minimum ${MIN_POSITION_SOL} (limited by ${sizing.limitingFactor})`], sizing, profitability: null };
    }
    const prof = estimateProfitability(
      args.liquidity,
      a.features,
      { sizeSol: sizing.sizeSol, targetPct: args.signal.targetPct, stopPct: args.signal.stopPct, maxHoldSec: args.signal.maxHoldSec },
      a.risk.score,
      a.opportunity.score,
      args.costs,
    );
    if (prof.expectedNetPct < s.minExpectedNetReturnPct) reasons.push(`expected net ${prof.expectedNetPct.toFixed(2)}% < ${s.minExpectedNetReturnPct}%`);
    if ((prof.rewardToRisk ?? 0) < s.minRewardToRisk) reasons.push(`reward/risk ${(prof.rewardToRisk ?? 0).toFixed(2)} < ${s.minRewardToRisk}`);
    if (prof.entryImpactPct > s.maxPriceImpactPct) reasons.push(`entry impact ${prof.entryImpactPct}% > ${s.maxPriceImpactPct}%`);
    if (prof.exitImpactPct > s.maxPriceImpactPct) reasons.push(`exit impact ${prof.exitImpactPct}% > ${s.maxPriceImpactPct}%`);
    if (prof.executableExitSol < sizing.sizeSol * 0.5) reasons.push('executable exit below 50% of position');
    if ((a.features.realSolReserves ?? 0) < s.minExitLiquiditySol) reasons.push(`exit liquidity ${(a.features.realSolReserves ?? 0).toFixed(2)} < ${s.minExitLiquiditySol} SOL`);
    const fee = prof.networkFeesSol / 2;
    if (fee > s.maxTxFeeSol || fee > this.hard.maxTxFeeSol) reasons.push(`tx fee ${fee} SOL exceeds limit`);
    return { approved: reasons.length === 0, sizeSol: reasons.length ? 0 : sizing.sizeSol, reasons, sizing, profitability: prof };
  }
}
