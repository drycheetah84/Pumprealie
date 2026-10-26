import { z } from 'zod';
import type { Env } from './env';

/** Risk-score weights by category. Engineering defaults, not empirically validated. */
export const DEFAULT_RISK_WEIGHTS = {
  liquidity_exit: 0.25,
  holder_concentration: 0.2,
  creator_wallet: 0.2,
  trading_anomalies: 0.15,
  permissions_mechanics: 0.1,
  data_reliability: 0.1,
} as const;

export const riskSettingsSchema = z.object({
  maxPositionPct: z.number().positive(),
  maxExposurePct: z.number().positive(),
  maxDailyLossPct: z.number().positive(),
  maxDrawdownPct: z.number().positive(),
  maxSlippagePct: z.number().positive(),
  maxPriceImpactPct: z.number().positive(),
  minExitLiquiditySol: z.number().nonnegative(),
  maxRiskScore: z.number().min(0).max(100),
  minExpectedNetReturnPct: z.number(),
  minRewardToRisk: z.number().positive(),
  maxConsecutiveLosses: z.number().int().positive(),
  feeReserveSol: z.number().nonnegative(),
  priorityFeeMicroLamports: z.number().int().nonnegative(),
  maxTxFeeSol: z.number().positive(),
  allowHighRiskStrategies: z.array(z.string()),
  onePositionPerMint: z.boolean(),
  emergencyPolicy: z.enum(['reduce', 'hold']),
  enabledStrategies: z.array(z.string()),
  strategyAllocationPct: z.record(z.string(), z.number().min(0).max(100)),
  riskWeights: z.object({
    liquidity_exit: z.number().min(0),
    holder_concentration: z.number().min(0),
    creator_wallet: z.number().min(0),
    trading_anomalies: z.number().min(0),
    permissions_mechanics: z.number().min(0),
    data_reliability: z.number().min(0),
  }),
});

export type RiskSettings = z.infer<typeof riskSettingsSchema>;
export const riskSettingsPatchSchema = riskSettingsSchema.partial();

export interface HardLimits {
  maxPositionSol: number;
  maxPositionPct: number;
  maxExposurePct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxSlippagePct: number;
  maxRiskScore: number;
  maxTxFeeSol: number;
}

export function hardLimitsFromEnv(env: Env): HardLimits {
  return {
    maxPositionSol: env.HARD_MAX_POSITION_SOL,
    maxPositionPct: env.HARD_MAX_POSITION_PCT,
    maxExposurePct: env.HARD_MAX_EXPOSURE_PCT,
    maxDailyLossPct: env.HARD_MAX_DAILY_LOSS_PCT,
    maxDrawdownPct: env.HARD_MAX_DRAWDOWN_PCT,
    maxSlippagePct: env.HARD_MAX_SLIPPAGE_PCT,
    maxRiskScore: env.HARD_MAX_RISK_SCORE,
    maxTxFeeSol: env.MAX_TX_FEE_SOL,
  };
}

export function defaultRiskSettings(env: Env): RiskSettings {
  return clampRiskSettings(
    {
      maxPositionPct: env.MAX_POSITION_PCT,
      maxExposurePct: env.MAX_EXPOSURE_PCT,
      maxDailyLossPct: env.MAX_DAILY_LOSS_PCT,
      maxDrawdownPct: env.MAX_DRAWDOWN_PCT,
      maxSlippagePct: env.MAX_SLIPPAGE_PCT,
      maxPriceImpactPct: env.MAX_PRICE_IMPACT_PCT,
      minExitLiquiditySol: env.MIN_EXIT_LIQUIDITY_SOL,
      maxRiskScore: env.MAX_RISK_SCORE,
      minExpectedNetReturnPct: env.MIN_EXPECTED_NET_RETURN_PCT,
      minRewardToRisk: env.MIN_REWARD_TO_RISK,
      maxConsecutiveLosses: env.MAX_CONSECUTIVE_LOSSES,
      feeReserveSol: env.FEE_RESERVE_SOL,
      priorityFeeMicroLamports: env.PRIORITY_FEE_MICROLAMPORTS,
      maxTxFeeSol: env.MAX_TX_FEE_SOL,
      allowHighRiskStrategies: [],
      onePositionPerMint: true,
      emergencyPolicy: env.EMERGENCY_POLICY,
      enabledStrategies: env.ENABLED_STRATEGIES,
      strategyAllocationPct: {},
      riskWeights: { ...DEFAULT_RISK_WEIGHTS },
    },
    hardLimitsFromEnv(env),
  ).settings;
}

/**
 * Clamp runtime settings to the hard ceilings. Returns the clamped settings and a
 * list of human-readable adjustments so the API can tell the operator what changed.
 */
export function clampRiskSettings(s: RiskSettings, hard: HardLimits): { settings: RiskSettings; adjustments: string[] } {
  const adjustments: string[] = [];
  const out: RiskSettings = { ...s, riskWeights: { ...s.riskWeights } };
  const cap = (key: keyof RiskSettings, max: number) => {
    const v = out[key] as number;
    if (v > max) {
      adjustments.push(`${String(key)} ${v} exceeds hard limit ${max}; clamped`);
      (out as Record<string, unknown>)[key] = max;
    }
  };
  cap('maxPositionPct', hard.maxPositionPct);
  cap('maxExposurePct', hard.maxExposurePct);
  cap('maxDailyLossPct', hard.maxDailyLossPct);
  cap('maxDrawdownPct', hard.maxDrawdownPct);
  cap('maxSlippagePct', hard.maxSlippagePct);
  cap('maxRiskScore', hard.maxRiskScore);
  cap('maxTxFeeSol', hard.maxTxFeeSol);
  if (out.maxPositionPct > out.maxExposurePct) {
    adjustments.push('maxPositionPct cannot exceed maxExposurePct; clamped');
    out.maxPositionPct = out.maxExposurePct;
  }
  const wsum = Object.values(out.riskWeights).reduce((a, b) => a + b, 0);
  if (wsum <= 0) {
    adjustments.push('risk weights sum to zero; restored defaults');
    out.riskWeights = { ...DEFAULT_RISK_WEIGHTS };
  }
  return { settings: out, adjustments };
}
