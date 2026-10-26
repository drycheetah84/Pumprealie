import type { MarketFeatures, PositionRecord, RiskAssessment } from '../../shared/types';
import type { TokenState } from '../market/tokenRegistry';

export interface ParamSpec {
  default: number;
  min: number;
  max: number;
  description: string;
  /** Step used by the optimizer grid. */
  step: number;
}

export type StrategyParams = Record<string, number>;

export interface StrategyContext {
  token: TokenState;
  features: MarketFeatures;
  risk: RiskAssessment;
  opportunityScore: number;
  now: number;
}

export interface EntrySignal {
  strategy: string;
  confidence: number;
  thesis: string;
  reasons: string[];
  targetPct: number;
  stopPct: number;
  maxHoldSec: number;
  trailingPct: number;
  /** Allows "high" risk tier entries only if the operator explicitly allowed this strategy. */
  wantsHighRisk: boolean;
}

export type EntryEvaluation = { ok: true; signal: EntrySignal } | { ok: false; reasons: string[] };

/** A strategy only proposes entries. Sizing, gating and execution are owned by the risk manager. */
export interface Strategy {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly paramSpecs: Record<string, ParamSpec>;
  readonly entryCriteria: string[];
  readonly exitCriteria: string[];
  evaluate(ctx: StrategyContext, params: StrategyParams): EntryEvaluation;
}

export interface ExitContext {
  position: PositionRecord;
  token: TokenState | undefined;
  features: MarketFeatures | null;
  risk: RiskAssessment | null;
  /** Executable (simulated sell) value of the whole position in SOL; null if no quote. */
  executableValueSol: number | null;
  now: number;
  emergency: boolean;
}

export interface ExitDecision {
  action: 'hold' | 'sell' | 'reduce';
  fraction: number;
  reason: string;
  urgent: boolean;
}

export function defaultsOf(specs: Record<string, ParamSpec>): StrategyParams {
  return Object.fromEntries(Object.entries(specs).map(([k, v]) => [k, v.default]));
}

export function validateParams(specs: Record<string, ParamSpec>, params: StrategyParams): { ok: boolean; errors: string[]; params: StrategyParams } {
  const errors: string[] = [];
  const out: StrategyParams = {};
  for (const [k, spec] of Object.entries(specs)) {
    const v = params[k] ?? spec.default;
    if (typeof v !== 'number' || Number.isNaN(v)) errors.push(`${k} must be a number`);
    else if (v < spec.min || v > spec.max) errors.push(`${k}=${v} outside [${spec.min}, ${spec.max}]`);
    out[k] = v;
  }
  for (const k of Object.keys(params)) if (!(k in specs)) errors.push(`unknown parameter ${k}`);
  return { ok: errors.length === 0, errors, params: out };
}
