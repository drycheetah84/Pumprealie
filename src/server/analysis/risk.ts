import type {
  CategoryScore,
  CriticalFlag,
  Finding,
  HolderSnapshot,
  MarketFeatures,
  RiskAssessment,
  RiskCategory,
  RiskTier,
  Severity,
} from '../../shared/types';
import type { RiskSettings } from '../config/riskSettings';
import { applyBuy, quoteBuy, quoteSell } from '../market/liquidity';
import type { TokenState } from '../market/tokenRegistry';
import { isSolQuote } from '../market/types';

export interface CreatorHistory {
  launches: number;
  graduated: number;
  flagged: number;
  launchesLast24h: number;
}

export interface RiskContext {
  now: number;
  staleMs: number;
  settings: Pick<RiskSettings, 'riskWeights' | 'minExitLiquiditySol' | 'maxPriceImpactPct'>;
  /** Position size used to measure exit impact (SOL). */
  referenceSizeSol: number;
  creatorHistory: CreatorHistory | null;
  /** Critical providers currently unhealthy (e.g. "pump-log-stream down"). */
  providerProblems: string[];
}

export const TIER_THRESHOLDS: Array<{ min: number; tier: RiskTier }> = [
  { min: 80, tier: 'extreme' },
  { min: 65, tier: 'very_high' },
  { min: 45, tier: 'high' },
  { min: 25, tier: 'moderate' },
  { min: 0, tier: 'lower' },
];

export function tierFor(score: number): RiskTier {
  return TIER_THRESHOLDS.find((t) => score >= t.min)!.tier;
}

const TRANSFER_RESTRICTING = new Set(['TransferHook', 'PermanentDelegate', 'NonTransferable', 'DefaultAccountState', 'PausableConfig', 'PermissionedBurn']);

/** Build a lower-confidence holder snapshot from observed buy/sell flows (transfers are invisible). */
export function holdersFromFlows(t: TokenState, at: number): HolderSnapshot | null {
  if (!t.observedFromLaunch || t.flows.size === 0) return null;
  const supply = t.mintInfo ? Number(t.mintInfo.supplyRaw) : 1_000_000_000_000_000;
  const rows = [...t.flows.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const pct = (v: number) => (v / supply) * 100;
  return {
    fetchedAt: at,
    source: 'derived:observed-trade-flows',
    supplyRaw: String(supply),
    holders: rows.slice(0, 20).map(([owner, v]) => ({
      tokenAccount: '',
      owner,
      amountRaw: String(Math.round(v)),
      pct: pct(v),
      label: owner === t.creator ? 'creator' : 'holder',
    })),
    top1Pct: rows[0] ? pct(rows[0][1]) : 0,
    top10Pct: rows.slice(0, 10).reduce((a, [, v]) => a + pct(v), 0),
    creatorPct: t.creator ? pct(Math.max(0, t.flows.get(t.creator) ?? 0)) : null,
    protocolPct: 0,
  };
}

class Collector {
  findings: Record<RiskCategory, Finding[]> = {
    liquidity_exit: [],
    holder_concentration: [],
    creator_wallet: [],
    trading_anomalies: [],
    permissions_mechanics: [],
    data_reliability: [],
  };
  flags = new Set<CriticalFlag>();
  missing: string[] = [];

  constructor(private readonly now: number) {}

  add(category: RiskCategory, code: string, points: number, severity: Severity, message: string, source: string, confidence = 0.9, observedAt = this.now) {
    this.findings[category].push({ code, category, severity, message, points, source, observedAt, confidence });
  }
}

/**
 * Multi-signal, explainable risk assessment. The score is a weighted sum of category
 * scores (each capped at 100). It is a heuristic ranking, NOT a calibrated probability.
 * Critical flags are evaluated independently and always block new entries.
 */
export function assessRisk(t: TokenState, f: MarketFeatures, ctx: RiskContext): RiskAssessment {
  const c = new Collector(ctx.now);
  const liq = t.liquidity;
  const liqSrc = liq?.source ?? 'none';

  // ---------- liquidity & exit -----------------------------------------------------
  if (t.quoteVerified && !isSolQuote(t.quoteMint)) {
    c.flags.add('UNSUPPORTED_QUOTE_ASSET');
    c.flags.add('EXIT_ROUTE_UNAVAILABLE');
    c.add('liquidity_exit', 'NON_SOL_QUOTE', 100, 'critical', `Curve is quoted in ${t.quoteMint}, not SOL; Pumpraelie only trades SOL routes`, 'solana-rpc-logs');
  }
  if (!t.quoteVerified) c.missing.push('quote_mint_onchain');
  if (t.complete && t.venue === 'bonding_curve') {
    c.flags.add('MIGRATION_IN_PROGRESS');
    c.add('liquidity_exit', 'MIGRATING', 60, 'critical', 'Curve is complete; liquidity is migrating to PumpSwap and the curve no longer trades', liqSrc);
  }
  if (t.rpcMissing) {
    c.flags.add('EXIT_ROUTE_UNAVAILABLE');
    c.add('liquidity_exit', 'ROUTE_ACCOUNT_MISSING', 100, 'critical', 'Bonding curve / pool account not found on-chain', 'solana-rpc');
  }
  if (!liq) {
    c.missing.push('liquidity_state');
    c.add('liquidity_exit', 'NO_LIQUIDITY_STATE', 60, 'high', 'No liquidity state available; exit cannot be evaluated', 'none', 1);
  } else {
    const realSol = liq.realQuoteReserve / 1e9;
    if (realSol < 1) c.add('liquidity_exit', 'LIQUIDITY_TINY', 50, 'high', `Only ${realSol.toFixed(3)} SOL withdrawable liquidity`, liqSrc);
    else if (realSol < ctx.settings.minExitLiquiditySol)
      c.add('liquidity_exit', 'LIQUIDITY_LOW', 30, 'medium', `Withdrawable liquidity ${realSol.toFixed(2)} SOL below minimum ${ctx.settings.minExitLiquiditySol}`, liqSrc);

    const refLamports = Math.max(1, Math.round(ctx.referenceSizeSol * 1e9));
    const buy = quoteBuy(liq, refLamports);
    const exit = quoteSell(applyBuy(liq, buy), buy.tokensOut);
    const exitImpact = -exit.impactPct;
    if (buy.tokensOut === 0 || exit.capped) {
      c.flags.add('EXTREME_EXIT_IMPACT');
      c.add('liquidity_exit', 'EXIT_NOT_FILLABLE', 80, 'critical', `A ${ctx.referenceSizeSol} SOL position could not be fully exited`, liqSrc);
    } else if (exitImpact > ctx.settings.maxPriceImpactPct * 3) {
      c.flags.add('EXTREME_EXIT_IMPACT');
      c.add('liquidity_exit', 'EXIT_IMPACT_EXTREME', 60, 'critical', `Exit impact ${exitImpact.toFixed(1)}% for ${ctx.referenceSizeSol} SOL`, liqSrc);
    } else if (exitImpact > ctx.settings.maxPriceImpactPct)
      c.add('liquidity_exit', 'EXIT_IMPACT_HIGH', 30, 'medium', `Exit impact ${exitImpact.toFixed(2)}% exceeds ${ctx.settings.maxPriceImpactPct}%`, liqSrc);
  }
  if (f.liquidityChange5mPct !== null) {
    if (f.liquidityChange5mPct <= -50) {
      c.flags.add('SEVERE_LIQUIDITY_DETERIORATION');
      c.add('liquidity_exit', 'LIQUIDITY_COLLAPSE', 70, 'critical', `Liquidity fell ${f.liquidityChange5mPct.toFixed(0)}% in 5m`, liqSrc);
    } else if (f.liquidityChange5mPct <= -25) c.add('liquidity_exit', 'LIQUIDITY_FALLING', 35, 'high', `Liquidity fell ${f.liquidityChange5mPct.toFixed(0)}% in 5m`, liqSrc);
  }
  const w5 = f.windows[1];
  if (w5 && w5.sellVolumeSol > 2 * w5.buyVolumeSol && w5.sellVolumeSol > 1)
    c.add('liquidity_exit', 'SELL_PRESSURE', 20, 'medium', `5m sell volume ${w5.sellVolumeSol.toFixed(2)} SOL is >2× buy volume`, 'solana-rpc-logs');

  // ---------- holders & supply -----------------------------------------------------
  const holders = t.holders ?? holdersFromFlows(t, ctx.now);
  const holderConf = t.holders ? 0.9 : 0.5;
  if (!holders) {
    c.missing.push('holder_distribution');
    c.add('holder_concentration', 'HOLDERS_UNKNOWN', 45, 'medium', 'Holder distribution unavailable (not treated as safe)', 'none', 1);
  } else {
    const src = holders.source;
    if (!t.holders) c.add('holder_concentration', 'HOLDERS_ESTIMATED', 10, 'info', 'Holder distribution estimated from observed trades (transfers not visible)', src, 0.5);
    if (holders.top1Pct > 20) c.add('holder_concentration', 'TOP1_EXTREME', 50, 'high', `Largest non-protocol holder owns ${holders.top1Pct.toFixed(1)}%`, src, holderConf);
    else if (holders.top1Pct > 10) c.add('holder_concentration', 'TOP1_HIGH', 25, 'medium', `Largest non-protocol holder owns ${holders.top1Pct.toFixed(1)}%`, src, holderConf);
    if (holders.top10Pct > 50) c.add('holder_concentration', 'TOP10_EXTREME', 40, 'high', `Top 10 holders own ${holders.top10Pct.toFixed(1)}% (protocol accounts excluded)`, src, holderConf);
    else if (holders.top10Pct > 35) c.add('holder_concentration', 'TOP10_HIGH', 20, 'medium', `Top 10 holders own ${holders.top10Pct.toFixed(1)}%`, src, holderConf);
    if (holders.creatorPct !== null && holders.creatorPct > 10) c.add('holder_concentration', 'CREATOR_HOLDS_LARGE', 30, 'high', `Creator holds ${holders.creatorPct.toFixed(1)}%`, src, holderConf);
    else if (holders.creatorPct !== null && holders.creatorPct > 5) c.add('holder_concentration', 'CREATOR_HOLDS', 15, 'low', `Creator holds ${holders.creatorPct.toFixed(1)}%`, src, holderConf);
  }
  // Early buyers who bought within 10s of launch and still hold a large share (sniper / bundle risk).
  if (t.observedFromLaunch && t.createdAt) {
    const early = new Set(t.trades.toArray().filter((e) => e.side === 'buy' && e.ts - t.createdAt! <= 10_000 && e.trader !== t.creator).map((e) => e.trader));
    const earlyHeld = [...early].reduce((a, k) => a + Math.max(0, t.flows.get(k) ?? 0), 0) / 1e15 * 100;
    if (earlyHeld > 25) c.add('holder_concentration', 'SNIPER_CLUSTER', 30, 'high', `${early.size} wallets that bought within 10s of launch still hold ~${earlyHeld.toFixed(1)}%`, 'derived:observed-trade-flows', 0.6);
    else if (earlyHeld > 12) c.add('holder_concentration', 'SNIPER_PRESENCE', 15, 'medium', `Launch-window buyers hold ~${earlyHeld.toFixed(1)}%`, 'derived:observed-trade-flows', 0.6);
  }
  // Large holders selling together in the last 2 minutes.
  const topHolders = [...t.flows.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  const recentSellers = new Set(t.trades.toArray().filter((e) => e.side === 'sell' && e.ts >= ctx.now - 120_000 && e.ts <= ctx.now).map((e) => e.trader));
  const topSelling = topHolders.filter((k) => recentSellers.has(k)).length;
  if (topSelling >= 3) c.add('holder_concentration', 'TOP_HOLDERS_EXITING', 35, 'high', `${topSelling} of the largest holders sold in the last 2 minutes`, 'solana-rpc-logs', 0.7);

  // ---------- creator & wallets ----------------------------------------------------
  if (!t.creator) {
    c.missing.push('creator');
    c.add('creator_wallet', 'CREATOR_UNKNOWN', 30, 'medium', 'Creator wallet unknown', 'none', 1);
  } else {
    if (f.creatorSoldTokensPct !== null && t.creatorSoldTokens > 0) {
      if (f.creatorSoldTokensPct >= 80) {
        c.flags.add('CREATOR_DUMPING');
        c.add('creator_wallet', 'CREATOR_DUMPED', 70, 'critical', `Creator sold ${f.creatorSoldTokensPct.toFixed(0)}% of their tokens`, 'solana-rpc-logs');
      } else if (f.creatorSoldTokensPct >= 20)
        c.add('creator_wallet', 'CREATOR_SELLING', 35, 'high', `Creator sold ${f.creatorSoldTokensPct.toFixed(0)}% of their tokens`, 'solana-rpc-logs');
    }
    const h = ctx.creatorHistory;
    if (!h) c.missing.push('creator_history');
    else {
      if (h.flagged > 0) c.add('creator_wallet', 'CREATOR_FLAGGED', 45, 'high', `Creator linked to ${h.flagged} previously flagged launch(es) observed by Pumpraelie`, 'pumpraelie:creator-history', 0.8);
      if (h.launchesLast24h >= 5) c.add('creator_wallet', 'SERIAL_DEPLOYER', 40, 'high', `Creator launched ${h.launchesLast24h} tokens in 24h`, 'pumpraelie:creator-history', 0.8);
      else if (h.launchesLast24h >= 2) c.add('creator_wallet', 'REPEAT_DEPLOYER', 15, 'low', `Creator launched ${h.launchesLast24h} tokens in 24h`, 'pumpraelie:creator-history', 0.8);
      if (h.launches >= 3 && h.graduated === 0) c.add('creator_wallet', 'NO_GRADUATIONS', 10, 'low', `${h.launches} observed launches, none graduated`, 'pumpraelie:creator-history', 0.6);
    }
    if (t.creatorActivity && t.creatorActivity.txLastHour >= 60)
      c.add('creator_wallet', 'CREATOR_HYPERACTIVE', 20, 'medium', `Creator signed ${t.creatorActivity.txLastHour}+ transactions in the last hour`, 'solana-rpc:getSignaturesForAddress', 0.7);
  }

  // ---------- trading anomalies ----------------------------------------------------
  if (f.topTraderVolumeShare !== null && f.topTraderVolumeShare > 0.6 && f.tradeCount >= 10)
    c.add('trading_anomalies', 'VOLUME_CONCENTRATED', 30, 'medium', `Top 3 wallets produced ${(f.topTraderVolumeShare * 100).toFixed(0)}% of 15m volume`, 'solana-rpc-logs', 0.8);
  if (f.roundTripTraderShare !== null && f.roundTripTraderShare > 0.5 && f.tradeCount >= 10)
    c.add('trading_anomalies', 'ROUND_TRIPPING', 30, 'medium', `${(f.roundTripTraderShare * 100).toFixed(0)}% of volume from wallets both buying and selling (possible wash trading)`, 'solana-rpc-logs', 0.6);
  if (f.repeatedSizeShare !== null && f.repeatedSizeShare > 0.4)
    c.add('trading_anomalies', 'REPETITIVE_SIZES', 25, 'medium', `${(f.repeatedSizeShare * 100).toFixed(0)}% of trades share repeated sizes (bot pattern)`, 'solana-rpc-logs', 0.6);
  if (f.tradesPerTrader !== null && f.tradesPerTrader > 6) c.add('trading_anomalies', 'FEW_ACTIVE_WALLETS', 15, 'low', `${f.tradesPerTrader.toFixed(1)} trades per wallet in 15m`, 'solana-rpc-logs', 0.6);
  const realSol = f.realSolReserves ?? 0;
  if (f.volatility5mPct !== null && f.volatility5mPct > 60 && realSol < 20)
    c.add('trading_anomalies', 'VOLATILITY_VS_LIQUIDITY', 20, 'medium', `5m volatility ${f.volatility5mPct.toFixed(0)}% on ${realSol.toFixed(1)} SOL liquidity`, 'solana-rpc-logs');
  if (w5 && realSol > 0 && w5.volumeSol > realSol * 3)
    c.add('trading_anomalies', 'VOLUME_EXCEEDS_LIQUIDITY', 20, 'medium', `5m volume ${w5.volumeSol.toFixed(1)} SOL is >3× liquidity`, 'solana-rpc-logs');
  if (f.momentum5mPct !== null && f.momentum5mPct > 300) c.add('trading_anomalies', 'PARABOLIC', 20, 'medium', `Price +${f.momentum5mPct.toFixed(0)}% in 5m`, 'solana-rpc-logs');

  // ---------- permissions & mechanics ----------------------------------------------
  const mi = t.mintInfo;
  if (!mi) {
    c.missing.push('mint_account');
    c.flags.add('CRITICAL_DATA_MISSING');
    c.add('permissions_mechanics', 'MINT_UNVERIFIED', 40, 'high', 'Mint account not yet verified on-chain (authorities/extensions unknown)', 'none', 1);
  } else {
    if (mi.mintAuthority) {
      c.flags.add('MINT_AUTHORITY_ACTIVE');
      c.add('permissions_mechanics', 'MINT_AUTHORITY', 100, 'critical', `Mint authority ${mi.mintAuthority} can increase supply`, mi.source);
    }
    if (mi.freezeAuthority) {
      c.flags.add('TRANSFER_RESTRICTION');
      c.add('permissions_mechanics', 'FREEZE_AUTHORITY', 100, 'critical', `Freeze authority ${mi.freezeAuthority} can freeze holder accounts`, mi.source);
    }
    const restricting = mi.riskyExtensions.filter((e) => TRANSFER_RESTRICTING.has(e));
    if (restricting.length) {
      c.flags.add('TRANSFER_RESTRICTION');
      c.add('permissions_mechanics', 'RESTRICTIVE_EXTENSIONS', 100, 'critical', `Token-2022 extensions can restrict transfers: ${restricting.join(', ')}`, mi.source);
    }
    if (mi.riskyExtensions.includes('TransferFeeConfig')) {
      c.flags.add('TRANSFER_RESTRICTION');
      c.add('permissions_mechanics', 'TRANSFER_TAX', 80, 'critical', 'Token charges a transfer fee (tax) on every transfer', mi.source);
    }
    if (mi.decimals !== 6) c.add('permissions_mechanics', 'NONSTANDARD_DECIMALS', 30, 'medium', `Mint has ${mi.decimals} decimals (Pump standard is 6)`, mi.source);
  }
  if (t.isMayhem) c.add('permissions_mechanics', 'MAYHEM_MODE', 60, 'high', 'Mayhem-mode coin: non-standard curve parameters and protocol agent trading', 'solana-rpc', 0.9);
  if (t.isCashback) c.add('permissions_mechanics', 'CASHBACK_COIN', 5, 'info', 'Cashback coin: creator fee is routed to traders', 'solana-rpc', 0.9);

  // ---------- data reliability -----------------------------------------------------
  const freshest = Math.max(t.lastEventAt, t.rpcCheckedAt ?? 0);
  if (ctx.now - freshest > ctx.staleMs) {
    c.flags.add('DATA_STALE');
    c.add('data_reliability', 'STALE', 60, 'critical', `No market update for ${Math.round((ctx.now - freshest) / 1000)}s`, 'internal');
  }
  if (t.inconsistencyPct !== null && t.inconsistencyPct > 5) {
    c.flags.add('DATA_INCONSISTENT');
    c.add('data_reliability', 'PROVIDER_MISMATCH', 60, 'critical', `Event-derived price differs from on-chain state by ${t.inconsistencyPct.toFixed(1)}%`, 'reconciliation');
  } else if (t.inconsistencyPct !== null && t.inconsistencyPct > 1)
    c.add('data_reliability', 'PROVIDER_DRIFT', 20, 'low', `Event vs on-chain price drift ${t.inconsistencyPct.toFixed(1)}%`, 'reconciliation');
  if (!t.rpcCheckedAt) {
    c.missing.push('onchain_reconciliation');
    c.add('data_reliability', 'UNRECONCILED', 30, 'medium', 'Liquidity not yet reconciled against an on-chain account read', 'none', 1);
  }
  if (f.tradeCount < 10) c.add('data_reliability', 'THIN_HISTORY', 20, 'low', `Only ${f.tradeCount} trades observed`, 'solana-rpc-logs');
  if (!t.observedFromLaunch) c.add('data_reliability', 'PARTIAL_HISTORY', 10, 'info', 'Trade history does not start at launch', 'internal');
  if (ctx.providerProblems.length) c.add('data_reliability', 'PROVIDER_UNHEALTHY', 40, 'high', `Providers degraded: ${ctx.providerProblems.join(', ')}`, 'provider-health');
  if (c.missing.includes('liquidity_state') || c.missing.includes('mint_account')) c.flags.add('CRITICAL_DATA_MISSING');

  // ---------- aggregate -------------------------------------------------------------
  const weights = ctx.settings.riskWeights;
  const wsum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const categories: CategoryScore[] = (Object.keys(c.findings) as RiskCategory[]).map((cat) => ({
    category: cat,
    score: Math.min(100, c.findings[cat].reduce((a, x) => a + x.points * Math.max(0.5, x.confidence), 0)),
    weight: weights[cat] / wsum,
    findings: c.findings[cat],
  }));
  let score = categories.reduce((a, x) => a + x.score * x.weight, 0);
  // Any critical flag guarantees at least "very high" so the score cannot look benign.
  if (c.flags.size > 0) score = Math.max(score, 65);
  score = Math.round(Math.min(100, score) * 10) / 10;
  const relScore = categories.find((x) => x.category === 'data_reliability')!.score;
  const dataConfidence = Math.max(0, Math.min(1, 1 - relScore / 100 - c.missing.length * 0.05));

  return {
    score,
    tier: tierFor(score),
    categories,
    criticalFlags: [...c.flags],
    dataConfidence: Math.round(dataConfidence * 100) / 100,
    missing: c.missing,
    calibrated: false,
  };
}
