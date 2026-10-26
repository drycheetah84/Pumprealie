import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { computeFeesBps, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import { applyBuy, drainLiquidity, maxBuyForImpact, quoteBuy, quoteSell, shiftPrice, spotPriceSol } from '../../src/server/market/liquidity';
import { OnchainInspector } from '../../src/server/market/providers/onchain';
import { curveState, fixtureProtocol } from '../helpers/fixtures';

describe('liquidity math vs official Pump SDK (real mainnet account fixture)', () => {
  const { global, feeConfig, standardCurve, mayhemCurve } = fixtureProtocol();
  for (const [name, curve] of [['standard', standardCurve], ['mayhem', mayhemCurve]] as const) {
    const f = computeFeesBps({ global, feeConfig, mintSupply: curve.tokenTotalSupply, virtualQuoteReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves } as Parameters<typeof computeFeesBps>[0]);
    const feeBps = Number(f.protocolFeeBps.add(f.creatorFeeBps).toString());
    const state = OnchainInspector.curveToLiquidity(curve, feeBps, Date.now());
    for (const lamports of [1_000_000, 10_000_000, 50_000_000]) {
      it(`${name} curve buy ${lamports} lamports matches SDK within 0.01%`, () => {
        const sdk = Number(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: new BN(lamports), quoteMint: curve.quoteMint }).toString());
        const mine = quoteBuy(state, lamports).tokensOut;
        expect(Math.abs(mine - sdk) / sdk).toBeLessThan(1e-4);
      });
    }
    it(`${name} curve sell (within real reserves) matches SDK`, () => {
      const tokens = Math.floor(state.realBaseReserve > 0 ? Math.min(state.realBaseReserve / 1000, 1e12) : 1e9);
      const bought = quoteBuy(state, 20_000_000);
      const after = applyBuy(state, bought);
      const sdkCurve = { ...curve, virtualTokenReserves: new BN(after.baseReserve), virtualQuoteReserves: new BN(after.quoteReserve), realTokenReserves: new BN(after.realBaseReserve), realQuoteReserves: new BN(after.realQuoteReserve) };
      const sell = Math.min(tokens, bought.tokensOut);
      const sdk = Number(getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: sdkCurve, amount: new BN(sell) }).toString());
      const mine = quoteSell(after, sell).quoteOutLamports;
      expect(Math.abs(mine - sdk)).toBeLessThanOrEqual(Math.max(2, sdk * 1e-4));
    });
  }
});

describe('liquidity model properties', () => {
  const s = curveState(30);
  it('spot price is positive and buy impact grows with size', () => {
    expect(spotPriceSol(s)).toBeGreaterThan(0);
    expect(quoteBuy(s, 5e9).impactPct).toBeGreaterThan(quoteBuy(s, 1e8).impactPct);
  });
  it('round trip loses at least the fees', () => {
    const b = quoteBuy(s, 1e9);
    const back = quoteSell(applyBuy(s, b), b.tokensOut);
    expect(back.quoteOutLamports).toBeLessThanOrEqual(Math.ceil((1e9 / 1.0125) * (1 - 0.0125)));
  });
  it('sell payouts are capped by real reserves', () => {
    const drained = drainLiquidity(s, 0.95);
    const q = quoteSell(drained, 5e15);
    expect(q.quoteOutLamports).toBeLessThanOrEqual(drained.realQuoteReserve);
    expect(q.capped).toBe(true);
  });
  it('shiftPrice moves spot price by the requested percent', () => {
    const p0 = spotPriceSol(s)!;
    expect(spotPriceSol(shiftPrice(s, 50))! / p0).toBeCloseTo(1.5, 6);
    expect(spotPriceSol(shiftPrice(s, -30))! / p0).toBeCloseTo(0.7, 6);
  });
  it('buy is capped by remaining curve supply', () => {
    const nearlyDone = curveState(84);
    const q = quoteBuy(nearlyDone, 50e9);
    expect(q.capped).toBe(true);
    expect(q.tokensOut).toBeLessThanOrEqual(nearlyDone.realBaseReserve);
  });
  it('maxBuyForImpact respects the impact ceiling', () => {
    const max = maxBuyForImpact(s, 2, 50e9);
    const q = quoteBuy(s, max);
    expect(q.impactPct).toBeLessThanOrEqual(2.0001);
    expect(quoteBuy(s, max * 1.5).impactPct).toBeGreaterThan(2);
  });
});
