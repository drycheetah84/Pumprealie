import {
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  OnlinePumpSdk,
  PUMP_SDK,
} from '@pump-fun/pump-sdk';
import { canonicalPumpPoolPda, OnlinePumpAmmSdk, PUMP_AMM_SDK } from '@pump-fun/pump-sdk/swap';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, createCloseAccountInstruction } from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import type { Logger } from 'pino';
import type { OrderRecord } from '../../shared/types';
import { errMsg } from '../lib/util';
import { quoteBuy, quoteSell } from '../market/liquidity';
import type { SolanaRpc } from '../market/providers/solanaRpc';
import { isSolQuote } from '../market/types';
import type { TransactionSigner } from './signer';
import type { ExecutionHooks, ExecutionRequest, ExecutionResult, Executor } from './types';

export interface LiveExecutorOptions {
  computeUnitLimit: number;
  priorityFeeMicroLamports: () => number;
  maxPriorityMicroLamports: number;
  /** Rent for a new token account; counted against the spend limit. */
  ataRentLamports: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
}

const WSOL = NATIVE_MINT;

/**
 * Live Solana execution for Pump bonding curves and canonical PumpSwap pools, built with the
 * official Pump SDK instruction builders. Lifecycle per attempt:
 *  fresh on-chain state → re-quote & slippage check → build → simulate (spend check) →
 *  policy-checked signing → persist signature (hooks.onSubmitted) → broadcast/rebroadcast until
 *  confirmed or blockhash expiry → settle from the confirmed transaction's balance changes.
 * A submitted transaction is never treated as a fill until it is confirmed and parsed.
 */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  private readonly pumpOnline: OnlinePumpSdk;
  private readonly ammOnline: OnlinePumpAmmSdk;

  constructor(
    private readonly rpc: SolanaRpc,
    private readonly signer: TransactionSigner,
    private readonly o: LiveExecutorOptions,
    private readonly log: Logger,
  ) {
    this.pumpOnline = new OnlinePumpSdk(rpc.connection);
    this.ammOnline = new OnlinePumpAmmSdk(rpc.connection);
  }

  get wallet(): PublicKey {
    return this.signer.publicKey;
  }

  private fail(error: string, extra: Partial<ExecutionResult> = {}): ExecutionResult {
    return { status: 'FAILED', tokensRaw: 0, solAmount: 0, networkFeeSol: 0, signature: null, error, quotedTokensRaw: null, quotedSol: null, ...extra };
  }

  async execute(req: ExecutionRequest, hooks: ExecutionHooks): Promise<ExecutionResult> {
    const user = this.signer.publicKey;
    const mint = new PublicKey(req.mint);
    const mintInfo = await this.rpc.getAccountInfo(mint);
    if (!mintInfo) return this.fail('mint account not found');
    const tokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    if (req.tokenProgram && req.tokenProgram !== tokenProgram.toBase58()) return this.fail('token program mismatch between analysis and chain');

    let built: { ixs: TransactionInstruction[]; quotedTokens: number; quotedSol: number; maxSpend: number };
    try {
      built = req.venue === 'pumpswap' ? await this.buildAmm(req, user, mint) : await this.buildCurve(req, user, mint, tokenProgram);
    } catch (e) {
      return this.fail(`build failed: ${errMsg(e)}`);
    }

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.o.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.min(this.o.priorityFeeMicroLamports(), this.o.maxPriorityMicroLamports) }),
      ...built.ixs,
    ];
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());

    // Simulate and verify the wallet's SOL change is within the spend limit.
    const preLamports = await this.rpc.getBalance(user);
    const sim = await this.rpc.simulate(tx, [user]);
    if (sim.err) return this.fail(`simulation failed: ${JSON.stringify(sim.err)} ${(sim.logs ?? []).slice(-3).join(' | ')}`, { quotedTokensRaw: built.quotedTokens, quotedSol: built.quotedSol });
    const post = sim.accounts?.[0]?.lamports;
    if (post === undefined || post === null) return this.fail('simulation did not return wallet balance; refusing to sign');
    const simulatedSpend = preLamports - post;
    if (simulatedSpend > built.maxSpend + this.o.ataRentLamports + 2_000_000)
      return this.fail(`simulated spend ${simulatedSpend} lamports exceeds limit ${built.maxSpend}`);

    let signed: VersionedTransaction;
    try {
      signed = this.signer.sign(tx, {
        side: req.side,
        mint: req.mint,
        maxSpendLamports: built.maxSpend + this.o.ataRentLamports,
        maxPriorityMicroLamports: this.o.maxPriorityMicroLamports,
      });
    } catch (e) {
      return this.fail(`signing refused: ${errMsg(e)}`);
    }
    const signature = bs58.encode(signed.signatures[0]!);
    // Persist BEFORE broadcasting so a crash cannot lose track of a possibly-landed transaction.
    hooks.onSubmitted(signature, lastValidBlockHeight, { tokensRaw: built.quotedTokens, sol: built.quotedSol });
    const raw = signed.serialize();
    const outcome = await this.confirm(signature, raw, lastValidBlockHeight);
    if (outcome === 'expired') return this.fail('blockhash expired before confirmation; transaction did not land', { status: 'EXPIRED', signature });
    if (outcome === 'unknown') return { ...this.fail('confirmation status unknown'), status: 'AMBIGUOUS', signature };
    return this.settleFromChain(signature, req.side, req.mint, built.quotedTokens, built.quotedSol);
  }

  private async buildCurve(req: ExecutionRequest, user: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
    const global = await this.pumpOnline.fetchGlobal();
    const feeConfig = await this.pumpOnline.fetchFeeConfig();
    const slip = req.maxSlippagePct;
    if (req.side === 'buy') {
      const st = await this.pumpOnline.fetchBuyState(mint, user, tokenProgram);
      const bc = st.bondingCurve;
      if (bc.complete) throw new Error('bonding curve complete (migrated); route unavailable');
      if (!isSolQuote(bc.quoteMint.toBase58())) throw new Error('curve not quoted in SOL');
      const budget = Math.floor((req.budgetSol ?? 0) * 1e9);
      // SDK sets maxSolCost = solAmount × (1 + slippage); size solAmount so the cap equals our budget.
      const solAmount = new BN(Math.floor(budget / (1 + slip / 100)));
      const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: solAmount, quoteMint: st.quoteMint, quoteTransferFee: st.quoteTransferFee });
      const decisionTokens = quoteBuy(req.decisionState, solAmount.toNumber()).tokensOut;
      if (amount.toNumber() < decisionTokens * (1 - slip / 100)) throw new Error(`price moved beyond ${slip}% since decision`);
      const ixs = await PUMP_SDK.buyInstructions({
        global,
        bondingCurveAccountInfo: st.bondingCurveAccountInfo,
        bondingCurve: bc,
        associatedUserAccountInfo: st.associatedUserAccountInfo,
        mint,
        user,
        amount,
        solAmount,
        slippage: slip,
        tokenProgram,
      });
      return { ixs, quotedTokens: amount.toNumber(), quotedSol: budget / 1e9, maxSpend: budget };
    }
    const st = await this.pumpOnline.fetchSellState(mint, user, tokenProgram);
    const bc = st.bondingCurve;
    if (bc.complete) throw new Error('bonding curve complete (migrated); sell via pool');
    const ata = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
    const ataInfo = await this.rpc.getAccountInfo(ata);
    if (!ataInfo) throw new Error('token account not found');
    const balance = Number(unpackAccount(ata, ataInfo, tokenProgram).amount);
    const amountNum = Math.min(balance, req.tokensRaw ?? 0);
    if (amountNum <= 0) throw new Error('no token balance to sell');
    const amount = new BN(amountNum);
    const solOut = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount });
    const ixs = await PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo: st.bondingCurveAccountInfo,
      bondingCurve: bc,
      mint,
      user,
      amount,
      solAmount: solOut,
      slippage: slip,
      tokenProgram,
      mayhemMode: bc.isMayhemMode,
      cashback: bc.isCashbackCoin,
    });
    if (amountNum === balance) ixs.push(createCloseAccountInstruction(ata, user, user, [], tokenProgram));
    return { ixs, quotedTokens: amountNum, quotedSol: solOut.toNumber() / 1e9, maxSpend: 0 };
  }

  private async buildAmm(req: ExecutionRequest, user: PublicKey, mint: PublicKey) {
    const pool = canonicalPumpPoolPda(mint);
    const state = await this.ammOnline.swapSolanaState(pool, user);
    if (!state.pool.baseMint.equals(mint) || !state.pool.quoteMint.equals(WSOL)) throw new Error('pool is not the SOL pool for this mint');
    const slip = req.maxSlippagePct;
    if (req.side === 'buy') {
      const budget = Math.floor((req.budgetSol ?? 0) * 1e9);
      const quote = new BN(Math.floor(budget / (1 + slip / 100)));
      const decisionTokens = quoteBuy(req.decisionState, quote.toNumber()).tokensOut;
      const ixs = await PUMP_AMM_SDK.buyQuoteInput(state, quote, slip);
      const fresh = quoteBuy({ ...req.decisionState, baseReserve: state.poolBaseAmount.toNumber(), quoteReserve: state.poolQuoteAmount.add(state.pool.virtualQuoteReserves).toNumber() }, quote.toNumber()).tokensOut;
      if (fresh < decisionTokens * (1 - slip / 100)) throw new Error(`price moved beyond ${slip}% since decision`);
      return { ixs, quotedTokens: fresh, quotedSol: budget / 1e9, maxSpend: budget };
    }
    const balance = state.userBaseAccountInfo ? Number(unpackAccount(state.userBaseTokenAccount, state.userBaseAccountInfo, state.baseTokenProgram).amount) : 0;
    const amountNum = Math.min(balance, req.tokensRaw ?? 0);
    if (amountNum <= 0) throw new Error('no token balance to sell');
    const ixs = await PUMP_AMM_SDK.sellBaseInput(state, new BN(amountNum), slip);
    const expected = quoteSell(req.decisionState, amountNum).quoteOutLamports / 1e9;
    return { ixs, quotedTokens: amountNum, quotedSol: expected, maxSpend: 0 };
  }

  /** Poll status and rebroadcast the identical signed bytes until confirmed or expired. */
  private async confirm(signature: string, raw: Uint8Array, lastValidBlockHeight: number): Promise<'confirmed' | 'expired' | 'unknown'> {
    let unknownStreak = 0;
    for (let i = 0; i < 120; i++) {
      try {
        if (i % 2 === 0) await this.rpc.sendRaw(raw).catch(() => undefined);
        const [st] = await this.rpc.getSignatureStatuses([signature]);
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return 'confirmed';
        const height = await this.rpc.getBlockHeight();
        if (height > lastValidBlockHeight) {
          // Final check after expiry: if still unknown, the transaction can no longer land.
          const [final] = await this.rpc.getSignatureStatuses([signature]);
          return final ? 'confirmed' : 'expired';
        }
        unknownStreak = 0;
      } catch (e) {
        if (++unknownStreak >= 10) {
          this.log.error({ signature, err: errMsg(e) }, 'cannot determine transaction status');
          return 'unknown';
        }
      }
      await this.o.sleep(this.o.pollMs);
    }
    return 'unknown';
  }

  /** Read the confirmed transaction and derive actual fills from balance deltas. */
  async settleFromChain(signature: string, side: 'buy' | 'sell', mint: string, quotedTokens: number | null, quotedSol: number | null): Promise<ExecutionResult> {
    const tx = await this.rpc.getParsedTransaction(signature);
    if (!tx || !tx.meta) return { ...this.fail('confirmed transaction not yet retrievable'), status: 'AMBIGUOUS', signature };
    const fee = tx.meta.fee / 1e9;
    if (tx.meta.err) return this.fail(`transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`, { signature, networkFeeSol: fee, quotedTokensRaw: quotedTokens, quotedSol });
    const wallet = this.signer.publicKey.toBase58();
    const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === wallet);
    if (idx < 0) return { ...this.fail('wallet not found in transaction'), status: 'AMBIGUOUS', signature };
    const solDelta = (tx.meta.postBalances[idx]! - tx.meta.preBalances[idx]!) / 1e9;
    const tokenBal = (arr: typeof tx.meta.preTokenBalances) =>
      (arr ?? []).filter((b) => b.mint === mint && b.owner === wallet).reduce((a, b) => a + Number(b.uiTokenAmount.amount), 0);
    const tokenDelta = tokenBal(tx.meta.postTokenBalances) - tokenBal(tx.meta.preTokenBalances);
    // solDelta includes the network fee (charged to the fee payer); separate it out.
    const swapSol = side === 'buy' ? -(solDelta + fee) : solDelta + fee;
    return {
      status: 'SETTLED',
      tokensRaw: Math.abs(tokenDelta),
      solAmount: Math.max(0, swapSol),
      networkFeeSol: fee,
      signature,
      error: null,
      quotedTokensRaw: quotedTokens,
      quotedSol,
      detail: { slot: tx.slot, solDelta, tokenDelta },
    };
  }

  /** Resolve an order whose outcome is unknown (e.g. after a restart). Never resubmits. */
  async reconcile(order: OrderRecord): Promise<ExecutionResult | null> {
    if (!order.signature) return this.fail('no signature recorded; transaction was never broadcast');
    const [st] = await this.rpc.getSignatureStatuses([order.signature]);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      return this.settleFromChain(order.signature, order.side, order.mint, order.quotedTokensRaw ? Number(order.quotedTokensRaw) : null, order.quotedSol);
    }
    if (st?.err) return this.settleFromChain(order.signature, order.side, order.mint, null, null);
    const height = await this.rpc.getBlockHeight();
    if (order.lastValidBlockHeight !== null && height > order.lastValidBlockHeight + 10) {
      const [final] = await this.rpc.getSignatureStatuses([order.signature]);
      if (!final) return { ...this.fail('blockhash expired; transaction never landed'), status: 'EXPIRED', signature: order.signature };
      return this.settleFromChain(order.signature, order.side, order.mint, null, null);
    }
    return null; // still pending: check again later
  }
}
