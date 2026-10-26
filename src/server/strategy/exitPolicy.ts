import type { CriticalFlag } from '../../shared/types';
import type { ExitContext, ExitDecision } from './types';

const EXIT_NOW_FLAGS: CriticalFlag[] = ['SEVERE_LIQUIDITY_DETERIORATION', 'CREATOR_DUMPING', 'TRANSFER_RESTRICTION', 'MINT_AUTHORITY_ACTIVE', 'EXTREME_EXIT_IMPACT'];

/**
 * Shared exit & position-protection policy. Stop levels are evaluated against the
 * *executable* sell quote (simulated against current reserves, fees included), never
 * against an indicative mark — and a stop is never assumed to fill at its level.
 */
export function evaluateExit(ctx: ExitContext): ExitDecision {
  const p = ctx.position;
  const hold = (reason: string): ExitDecision => ({ action: 'hold', fraction: 0, reason, urgent: false });
  const sell = (reason: string, urgent = false): ExitDecision => ({ action: 'sell', fraction: 1, reason, urgent });

  if (ctx.executableValueSol === null) {
    // No reliable quote: do not sell blind. The caller raises an alert and retries.
    return hold('no executable quote available; holding and retrying (no blind sells)');
  }
  const flags = ctx.risk?.criticalFlags ?? [];
  if (flags.includes('DATA_STALE') || flags.includes('DATA_INCONSISTENT')) return hold('market data stale/inconsistent; awaiting fresh quote');

  const urgentFlag = flags.find((f) => EXIT_NOW_FLAGS.includes(f));
  if (urgentFlag) return sell(`risk escalation: ${urgentFlag}`, true);
  if (ctx.emergency) return sell('emergency risk-reduction policy (loss/drawdown limit breached)', true);

  const value = ctx.executableValueSol;
  const pnlPct = ((value - p.costBasisSol) / p.costBasisSol) * 100;
  const heldSec = (ctx.now - p.entryAt) / 1000;
  const trailing = p.meta.trailingPct ?? 10;

  if (pnlPct <= -p.stopPct) return sell(`stop: executable P&L ${pnlPct.toFixed(1)}% <= -${p.stopPct}%`, true);
  if (ctx.risk && ctx.risk.score >= 80) return sell(`risk score ${ctx.risk.score} reached extreme tier`, true);
  if (ctx.features?.liquidityChange5mPct !== null && ctx.features?.liquidityChange5mPct !== undefined && ctx.features.liquidityChange5mPct <= -30)
    return sell(`liquidity down ${ctx.features.liquidityChange5mPct.toFixed(0)}% in 5m`, true);
  if (pnlPct >= p.targetPct && !p.meta.partialTaken) return { action: 'reduce', fraction: 0.5, reason: `target +${p.targetPct}% reached (executable +${pnlPct.toFixed(1)}%): taking half`, urgent: false };
  const peak = Math.max(p.peakValueSol, value);
  if (peak > p.costBasisSol * 1.05 && value <= peak * (1 - trailing / 100))
    return sell(`trailing stop: value ${value.toFixed(4)} is ${trailing}% below peak ${peak.toFixed(4)}`);
  if (heldSec >= p.maxHoldSec) return sell(`max holding period ${p.maxHoldSec}s reached`);
  if (ctx.risk && ctx.risk.tier === 'very_high' && !p.meta.partialTaken) return { action: 'reduce', fraction: 0.5, reason: 'risk tier escalated to very high', urgent: false };
  return hold(`within plan: P&L ${pnlPct.toFixed(1)}%, held ${Math.round(heldSec)}s`);
}
