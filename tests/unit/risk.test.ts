import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { bondingCurvePda } from '@pump-fun/pump-sdk';
import { pumpPoolAuthorityPda } from '@pump-fun/pump-sdk/swap';
import { computeFeatures } from '../../src/server/analysis/features';
import { assessRisk, holdersFromFlows, tierFor, type RiskContext } from '../../src/server/analysis/risk';
import { DEFAULT_RISK_WEIGHTS } from '../../src/server/config/riskSettings';
import { OnchainInspector } from '../../src/server/market/providers/onchain';
import { CREATOR, curveState, healthyToken, MINT, trade } from '../helpers/fixtures';

const NOW = 1_800_000_000_000;
const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
  now: NOW,
  staleMs: 20_000,
  settings: { riskWeights: { ...DEFAULT_RISK_WEIGHTS }, minExitLiquiditySol: 5, maxPriceImpactPct: 3 },
  referenceSizeSol: 0.01,
  creatorHistory: { launches: 1, graduated: 0, flagged: 0, launchesLast24h: 1 },
  providerProblems: [],
  ...over,
});

function assess(t = healthyToken(NOW), c = ctx()) {
  return assessRisk(t, computeFeatures(t, NOW), c);
}

describe('risk engine', () => {
  it('scores a healthy, verified token without critical flags', () => {
    const r = assess();
    expect(r.criticalFlags).toEqual([]);
    expect(r.score).toBeLessThan(45);
    expect(['lower', 'moderate']).toContain(r.tier);
    expect(r.calibrated).toBe(false);
    expect(r.categories).toHaveLength(6);
    for (const c of r.categories) for (const f of c.findings) {
      expect(f.source).toBeTruthy();
      expect(f.observedAt).toBeGreaterThan(0);
      expect(f.confidence).toBeGreaterThan(0);
    }
  });

  it('flags an active mint authority as critical and forces a high score', () => {
    const t = healthyToken(NOW);
    t.mintInfo = { ...t.mintInfo!, mintAuthority: CREATOR };
    const r = assess(t);
    expect(r.criticalFlags).toContain('MINT_AUTHORITY_ACTIVE');
    expect(r.score).toBeGreaterThanOrEqual(65);
  });

  it('flags freeze authority and restrictive Token-2022 extensions as transfer restrictions', () => {
    const t = healthyToken(NOW);
    t.mintInfo = { ...t.mintInfo!, freezeAuthority: CREATOR };
    expect(assess(t).criticalFlags).toContain('TRANSFER_RESTRICTION');
    const t2 = healthyToken(NOW);
    t2.mintInfo = { ...t2.mintInfo!, extensions: ['TransferHook'], riskyExtensions: ['TransferHook'] };
    expect(assess(t2).criticalFlags).toContain('TRANSFER_RESTRICTION');
  });

  it('treats missing mint data as critical missing data, never as safe', () => {
    const t = healthyToken(NOW);
    t.mintInfo = null;
    const r = assess(t);
    expect(r.criticalFlags).toContain('CRITICAL_DATA_MISSING');
    expect(r.missing).toContain('mint_account');
    expect(r.dataConfidence).toBeLessThan(assess().dataConfidence);
  });

  it('flags stale market data', () => {
    const t = healthyToken(NOW - 120_000);
    t.rpcCheckedAt = NOW - 120_000;
    expect(assess(t).criticalFlags).toContain('DATA_STALE');
  });

  it('blocks non-SOL quoted curves as an unavailable exit route', () => {
    const t = healthyToken(NOW);
    t.quoteMint = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
    const r = assess(t);
    expect(r.criticalFlags).toEqual(expect.arrayContaining(['UNSUPPORTED_QUOTE_ASSET', 'EXIT_ROUTE_UNAVAILABLE']));
  });

  it('detects creator dumping', () => {
    const t = healthyToken(NOW);
    t.creatorBoughtTokens = 1e13;
    t.creatorSoldTokens = 9e12;
    const r = assess(t);
    expect(r.criticalFlags).toContain('CREATOR_DUMPING');
  });

  it('detects a rapid liquidity drain', () => {
    const t = healthyToken(NOW);
    t.liquidityHistory.push({ ts: NOW - 60_000, realSol: 40, priceSol: null });
    const drained = curveState(10, NOW - 1000);
    t.liquidity = drained;
    t.liquidityHistory.push({ ts: NOW - 1000, realSol: 10, priceSol: null });
    const r = assess(t);
    expect(r.criticalFlags).toContain('SEVERE_LIQUIDITY_DETERIORATION');
  });

  it('flags an exit that cannot be filled for the reference size', () => {
    const t = healthyToken(NOW);
    t.liquidity = { ...curveState(0.002, NOW - 1000) };
    const r = assess(t, ctx({ referenceSizeSol: 5 }));
    expect(r.criticalFlags).toContain('EXTREME_EXIT_IMPACT');
  });

  it('flags data inconsistency between providers', () => {
    const t = healthyToken(NOW);
    t.inconsistencyPct = 12;
    expect(assess(t).criticalFlags).toContain('DATA_INCONSISTENT');
  });

  it('treats unknown holder distribution as risk', () => {
    const t = healthyToken(NOW);
    t.observedFromLaunch = false;
    t.holders = null;
    const r = assess(t);
    expect(r.missing).toContain('holder_distribution');
    const holderCat = r.categories.find((c) => c.category === 'holder_concentration')!;
    expect(holderCat.score).toBeGreaterThan(0);
  });

  it('penalizes creators with flagged history and serial deployment', () => {
    const clean = assess();
    const bad = assess(healthyToken(NOW), ctx({ creatorHistory: { launches: 12, graduated: 0, flagged: 2, launchesLast24h: 9 } }));
    expect(bad.score).toBeGreaterThan(clean.score);
    const cat = bad.categories.find((c) => c.category === 'creator_wallet')!;
    expect(cat.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['CREATOR_FLAGGED', 'SERIAL_DEPLOYER']));
  });

  it('flags mayhem-mode coins as non-standard mechanics', () => {
    const t = healthyToken(NOW);
    t.isMayhem = true;
    expect(assess(t).criticalFlags).toContain('NONSTANDARD_MECHANICS');
  });

  it('weights are configurable and change the score', () => {
    const t = healthyToken(NOW);
    t.holders = null;
    t.observedFromLaunch = false;
    const a = assess(t);
    const b = assess(t, ctx({ settings: { riskWeights: { ...DEFAULT_RISK_WEIGHTS, holder_concentration: 0.9 }, minExitLiquiditySol: 5, maxPriceImpactPct: 3 } }));
    expect(b.score).toBeGreaterThan(a.score);
  });

  it('maps scores to tiers at the configured boundaries', () => {
    expect(tierFor(0)).toBe('lower');
    expect(tierFor(24.9)).toBe('lower');
    expect(tierFor(25)).toBe('moderate');
    expect(tierFor(45)).toBe('high');
    expect(tierFor(65)).toBe('very_high');
    expect(tierFor(80)).toBe('extreme');
  });

  it('flags copycat identities and price collapses', () => {
    const t = healthyToken(NOW);
    const r = assess(t, ctx({ identityCollisions: 3 }));
    expect(r.categories.find((c) => c.category === 'trading_anomalies')!.findings.map((f) => f.code)).toContain('DUPLICATE_IDENTITY');
  });
});

describe('holder concentration: protocol accounts are not counted as holders', () => {
  const curve = bondingCurvePda(MINT).toBase58();
  const poolAuth = pumpPoolAuthorityPda(new PublicKey(MINT)).toBase58();
  it('excludes the bonding curve and pool vault from concentration', () => {
    const snap = OnchainInspector.buildHolderSnapshot(
      MINT,
      [
        { tokenAccount: 'curveAta', owner: curve, amountRaw: String(700e12) },
        { tokenAccount: 'poolVault', owner: poolAuth, amountRaw: String(100e12) },
        { tokenAccount: 'a1', owner: 'holderA', amountRaw: String(30e12) },
        { tokenAccount: 'a2', owner: 'holderB', amountRaw: String(20e12) },
        { tokenAccount: 'a3', owner: 'holderA', amountRaw: String(10e12) },
        { tokenAccount: 'c', owner: CREATOR, amountRaw: String(5e12) },
      ],
      { creator: CREATOR, supplyRaw: String(1e15) },
    );
    expect(snap.protocolPct).toBeCloseTo(80, 5);
    expect(snap.top1Pct).toBeCloseTo(4, 5); // holderA aggregated across two accounts
    expect(snap.top10Pct).toBeCloseTo(6.5, 5);
    expect(snap.creatorPct).toBeCloseTo(0.5, 5);
    expect(snap.holders.find((h) => h.owner === curve)!.label).toBe('bonding_curve');
    expect(snap.holders.find((h) => h.owner === poolAuth)!.label).toBe('amm_pool');
  });

  it('derives a lower-confidence estimate from flows only when observed from launch', () => {
    const t = healthyToken(NOW);
    expect(holdersFromFlows(t, NOW)?.source).toBe('derived:observed-trade-flows');
    t.observedFromLaunch = false;
    expect(holdersFromFlows(t, NOW)).toBeNull();
  });
});

describe('features: no look-ahead', () => {
  it('ignores trades after the evaluation time', () => {
    const t = healthyToken(NOW);
    const before = computeFeatures(t, NOW);
    t.trades.push(trade({ ts: NOW + 60_000, side: 'buy', sol: 50, state: curveState(80, NOW + 60_000) }));
    const after = computeFeatures(t, NOW);
    expect(after.windows).toEqual(before.windows);
    expect(after.tradeCount).toBe(before.tradeCount);
  });
});
