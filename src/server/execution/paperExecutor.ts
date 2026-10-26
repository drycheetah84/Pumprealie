import { txFeeLamports, type CostModel } from '../analysis/profitability';
import { quoteBuy, quoteSell, type LiquidityState } from '../market/liquidity';
import type { ExecutionHooks, ExecutionRequest, ExecutionResult, Executor } from './types';

export interface PaperExecutorOptions {
  latencyMs: number;
  failureRate: number;
  costs: CostModel;
  /** Max age of the fill-time quote before the simulated transaction is treated as failed. */
  maxQuoteAgeMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Liquidity state at (simulated) inclusion time. Live paper: latest observed; replay: state at t. */
  stateAt: (mint: string, at: number) => LiquidityState | null | Promise<LiquidityState | null>;
  random: () => number;
}

/**
 * Simulated execution against observed market state. It has NO RPC or signer dependency:
 * paper trading cannot submit real transactions by construction.
 *
 * Models: execution latency (market moves before inclusion), price impact and protocol fees
 * against real reserves, slippage-tolerance failures, random transaction failures (network fee
 * still charged, as on Solana), stale quotes, and exits blocked by missing/insufficient liquidity.
 */
export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;
  private seq = 0;

  constructor(private readonly o: PaperExecutorOptions) {}

  async execute(req: ExecutionRequest, hooks: ExecutionHooks): Promise<ExecutionResult> {
    const fee = txFeeLamports(this.o.costs) / 1e9;
    const sig = `paper-${req.order.id}-${++this.seq}`;
    const fail = (error: string, charged = true): ExecutionResult => ({
      status: 'FAILED',
      tokensRaw: 0,
      solAmount: 0,
      networkFeeSol: charged ? fee : 0,
      signature: charged ? sig : null,
      error,
      quotedTokensRaw: null,
      quotedSol: null,
    });

    // Decision-time quote (what the bot expects) — used for slippage limits.
    const dq =
      req.side === 'buy' ? quoteBuy(req.decisionState, Math.round((req.budgetSol ?? 0) * 1e9)) : quoteSell(req.decisionState, req.tokensRaw ?? 0);
    const quotedTokens = req.side === 'buy' ? (dq as ReturnType<typeof quoteBuy>).tokensOut : (req.tokensRaw ?? 0);
    const quotedSol = req.side === 'buy' ? (req.budgetSol ?? 0) : (dq as ReturnType<typeof quoteSell>).quoteOutLamports / 1e9;
    hooks.onSubmitted(sig, null, { tokensRaw: quotedTokens, sol: quotedSol });

    await this.o.sleep(this.o.latencyMs);
    const at = this.o.now();
    const state = await this.o.stateAt(req.mint, at);
    if (!state) return fail('route unavailable: no liquidity state at fill time', false);
    if (at - state.observedAt > this.o.maxQuoteAgeMs) return fail(`quote stale (${Math.round((at - state.observedAt) / 1000)}s old)`, false);
    if (state.venue !== req.venue && req.venue !== 'unknown') return fail(`venue changed (${req.venue} → ${state.venue}); route must be re-evaluated`, false);
    if (this.o.random() < this.o.failureRate) return fail('simulated transaction failure (dropped/reverted); network fee charged');

    if (req.side === 'buy') {
      const q = quoteBuy(state, Math.round((req.budgetSol ?? 0) * 1e9));
      if (q.capped) return fail('curve supply insufficient for full buy');
      if (q.tokensOut <= 0) return fail('zero tokens out');
      const minTokens = quotedTokens * (1 - req.maxSlippagePct / 100);
      if (q.tokensOut < minTokens) return fail(`slippage exceeded: ${q.tokensOut} < min ${Math.floor(minTokens)}`);
      return {
        status: 'SETTLED',
        tokensRaw: q.tokensOut,
        solAmount: q.quoteInLamports / 1e9,
        networkFeeSol: fee,
        signature: sig,
        error: null,
        quotedTokensRaw: quotedTokens,
        quotedSol,
        detail: { impactPct: q.impactPct, protocolFeeSol: q.feeLamports / 1e9, fillAt: at },
      };
    }
    const tokens = req.tokensRaw ?? 0;
    const q = quoteSell(state, tokens);
    if (q.capped) return fail('insufficient withdrawable liquidity for sell');
    if (q.quoteOutLamports <= 0) return fail('sell returns nothing');
    const minOut = quotedSol * (1 - req.maxSlippagePct / 100);
    if (q.quoteOutLamports / 1e9 < minOut) return fail(`slippage exceeded: ${(q.quoteOutLamports / 1e9).toFixed(6)} < min ${minOut.toFixed(6)}`);
    return {
      status: 'SETTLED',
      tokensRaw: tokens,
      solAmount: q.quoteOutLamports / 1e9,
      networkFeeSol: fee,
      signature: sig,
      error: null,
      quotedTokensRaw: tokens,
      quotedSol,
      detail: { impactPct: q.impactPct, protocolFeeSol: q.feeLamports / 1e9, fillAt: at },
    };
  }
}

/** Deterministic PRNG (mulberry32) for reproducible simulations. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
