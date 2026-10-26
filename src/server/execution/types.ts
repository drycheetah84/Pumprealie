import type { OrderRecord, TradingMode, Venue } from '../../shared/types';
import type { LiquidityState } from '../market/liquidity';

export interface ExecutionRequest {
  order: OrderRecord;
  mint: string;
  side: 'buy' | 'sell';
  venue: Venue;
  /** Buy: total SOL budget for the swap (protocol fees included). */
  budgetSol: number | null;
  /** Sell: raw token amount to sell. */
  tokensRaw: number | null;
  maxSlippagePct: number;
  /** Liquidity state the decision was based on (used for slippage checks). */
  decisionState: LiquidityState;
  tokenProgram: string | null;
}

export type ExecutionStatus = 'SETTLED' | 'FAILED' | 'EXPIRED' | 'AMBIGUOUS';

export interface ExecutionResult {
  status: ExecutionStatus;
  tokensRaw: number;
  /** Buy: SOL that left the wallet for the swap. Sell: SOL received from the swap. Protocol fees inside. */
  solAmount: number;
  networkFeeSol: number;
  signature: string | null;
  error: string | null;
  quotedTokensRaw: number | null;
  quotedSol: number | null;
  detail?: Record<string, unknown>;
}

export interface ExecutionHooks {
  /** Called before broadcast so the signature/blockhash expiry are durable across restarts. */
  onSubmitted(signature: string, lastValidBlockHeight: number | null, quoted: { tokensRaw: number | null; sol: number | null }): void;
}

export interface Executor {
  readonly mode: TradingMode;
  execute(req: ExecutionRequest, hooks: ExecutionHooks): Promise<ExecutionResult>;
}
