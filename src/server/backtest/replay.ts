import type { HolderSnapshot, MintInfo, PortfolioSummary, PositionRecord, RiskTier, TokenAssessment } from '../../shared/types';
import { assessToken } from '../analysis/assessment';
import { txFeeLamports, type CostModel } from '../analysis/profitability';
import type { HardLimits, RiskSettings } from '../config/riskSettings';
import { seededRandom } from '../execution/paperExecutor';
import { quoteBuy, quoteSell, spotPriceSol, type LiquidityState } from '../market/liquidity';
import { TokenRegistry, type TokenState } from '../market/tokenRegistry';
import type { TradeEvent } from '../market/types';
import { RiskManager } from '../risk/riskManager';
import { evaluateExit } from '../strategy/exitPolicy';
import type { StrategyRegistry } from '../strategy/registry';
import type { EntrySignal, StrategyParams } from '../strategy/types';

export interface ReplayTokenMeta {
  mint: string;
  creator: string | null;
  createdAt: number | null;
  quoteMint: string | null;
  tokenProgram: string | null;
  isMayhem: boolean;
  name: string | null;
  symbol: string | null;
}

/** Point-in-time data access for replay; every method must only return data observed at or before `asOf`. */
export interface ReplayDataSource {
  trades(fromTs: number, toTs: number): Iterable<TradeEvent>;
  tokenMeta(mint: string): ReplayTokenMeta | null;
  mintInfoAsOf(mint: string, asOf: number): MintInfo | null;
  holdersAsOf(mint: string, asOf: number): HolderSnapshot | null;
  creatorLaunchesBetween(creator: string, fromTs: number, toTs: number): number;
}

export interface ReplayConfig {
  fromTs: number;
  toTs: number;
  capitalSol: number;
  settings: RiskSettings;
  hard: HardLimits;
  costs: CostModel;
  /** Per-strategy parameter overrides (otherwise the registry's active params). */
  paramOverrides?: Record<string, StrategyParams>;
  evalIntervalMs: number;
  latencyMs: number;
  failureRate: number;
  seed: number;
  /**
   * Documented assumption: when no mint snapshot exists at decision time, assume a standard
   * Pump mint (authorities revoked, no restrictive extensions). Recorded in results.
   */
  assumeStandardMintWhenUnknown: boolean;
  staleMs: number;
  yieldEvery?: number;
}

export interface SimTrade {
  mint: string;
  strategy: string;
  entryAt: number;
  exitAt: number | null;
  costSol: number;
  proceedsSol: number;
  feesSol: number;
  pnlSol: number;
  pnlPct: number;
  holdSec: number;
  riskTier: RiskTier;
  riskScore: number;
  launchAgeSec: number | null;
  quotedExpectedNetPct: number | null;
  closeReason: string;
  unexecutableExit: boolean;
  marketRegime: 'quiet' | 'normal' | 'busy';
}

export interface ReplayResult {
  config: Omit<ReplayConfig, 'settings' | 'hard' | 'costs'> & { settings: Partial<RiskSettings> };
  trades: SimTrade[];
  equityCurve: Array<{ at: number; equity: number; exposure: number }>;
  failedEntries: number;
  failedExits: number;
  unexecutableExitEvents: number;
  decisions: Array<{ at: number; mint: string; strategy: string; sizeSol: number }>;
  tokensSeen: number;
  eventsProcessed: number;
  openAtEnd: Array<{ mint: string; markSol: number; executableSol: number; costSol: number }>;
  assumptions: string[];
}

interface SimPosition {
  id: number;
  mint: string;
  strategy: string;
  tokens: number;
  costSol: number;
  initialCost: number;
  proceedsSol: number;
  feesSol: number;
  entryAt: number;
  peakValue: number;
  signal: EntrySignal;
  partialTaken: boolean;
  exitFailures: number;
  riskTier: RiskTier;
  riskScore: number;
  launchAgeSec: number | null;
  quotedNet: number | null;
  regime: SimTrade['marketRegime'];
}

interface PendingFill {
  at: number;
  kind: 'buy' | 'sell';
  mint: string;
  sizeSol: number;
  tokens: number;
  decisionState: LiquidityState;
  positionId?: number;
  fraction?: number;
  reason?: string;
  signal?: EntrySignal;
  assessment?: TokenAssessment;
}

const standardMint = (at: number, program: string | null): MintInfo => ({
  fetchedAt: at,
  source: 'backtest-assumption:standard-pump-mint',
  tokenProgram: program ?? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  decimals: 6,
  supplyRaw: '1000000000000000',
  mintAuthority: null,
  freezeAuthority: null,
  extensions: [],
  riskyExtensions: [],
});

/**
 * Event-driven historical replay. Market state is rebuilt strictly from events with
 * ts ≤ simulated time; decisions run on a fixed clock; fills execute after `latencyMs`
 * against the state at fill time (so the market can move against us), with the same
 * risk manager, strategies, exit policy and liquidity math used live.
 */
export async function runReplay(src: ReplayDataSource, strategies: StrategyRegistry, cfg: ReplayConfig): Promise<ReplayResult> {
  const registry = new TokenRegistry(1_000_000);
  const risk = new RiskManager(cfg.settings, cfg.hard, cfg.capitalSol);
  const rnd = seededRandom(cfg.seed);
  const fee = txFeeLamports(cfg.costs) / 1e9;
  const params = (id: string) => cfg.paramOverrides?.[id] ?? strategies.params(id);
  const stratView = { strategies: strategies.strategies, params } as unknown as StrategyRegistry;
  const assumptions: string[] = [
    'liquidity state is taken from on-chain trade events (reserves after each trade)',
    'scenario probabilities in profitability estimates are heuristic and uncalibrated',
    `execution latency ${cfg.latencyMs}ms, random transaction failure rate ${(cfg.failureRate * 100).toFixed(1)}%`,
  ];
  if (cfg.assumeStandardMintWhenUnknown) assumptions.push('tokens without a mint snapshot at decision time are assumed to be standard Pump mints (authorities revoked)');

  let cash = cfg.capitalSol;
  let peak = cash;
  let dayStart = cash;
  let day = Math.floor(cfg.fromTs / 86_400_000);
  const positions = new Map<number, SimPosition>();
  const closed: SimTrade[] = [];
  const pending: PendingFill[] = [];
  const equityCurve: ReplayResult['equityCurve'] = [];
  const decisions: ReplayResult['decisions'] = [];
  const flaggedCreators = new Set<string>();
  let nextId = 1;
  let failedEntries = 0;
  let failedExits = 0;
  let unexecutable = 0;
  let events = 0;
  let nextEval = cfg.fromTs + cfg.evalIntervalMs;
  const globalVolume: Array<{ ts: number; sol: number }> = [];
  let consecutiveLosses = 0;
  const metaCache = new Map<string, ReplayTokenMeta | null>();

  const prepareToken = (mint: string, at: number): TokenState => {
    const t = registry.ensure(mint, at);
    if (!metaCache.has(mint)) {
      const m = src.tokenMeta(mint);
      metaCache.set(mint, m);
      if (m) {
        t.creator = m.creator;
        t.name = m.name;
        t.symbol = m.symbol;
        t.isMayhem = m.isMayhem;
        t.tokenProgram = m.tokenProgram;
        // Only claim launch-time knowledge if creation precedes our first observation.
        if (m.createdAt !== null && m.createdAt <= at) {
          t.createdAt = m.createdAt;
          t.observedFromLaunch = m.createdAt >= cfg.fromTs;
        }
      }
    }
    return t;
  };

  const executable = (p: SimPosition): number | null => {
    const t = registry.get(p.mint);
    if (!t?.liquidity) return null;
    return quoteSell(t.liquidity, p.tokens).quoteOutLamports / 1e9;
  };

  const regimeAt = (ts: number): SimTrade['marketRegime'] => {
    while (globalVolume.length && globalVolume[0]!.ts < ts - 600_000) globalVolume.shift();
    const v = globalVolume.reduce((a, x) => a + x.sol, 0);
    return v < 200 ? 'quiet' : v < 2000 ? 'normal' : 'busy';
  };

  const summary = (now: number): PortfolioSummary => {
    let exec = 0;
    let exposure = 0;
    for (const p of positions.values()) {
      exec += executable(p) ?? 0;
      exposure += p.costSol;
    }
    const equity = cash + exec;
    if (Math.floor(now / 86_400_000) !== day) {
      day = Math.floor(now / 86_400_000);
      dayStart = equity;
    }
    peak = Math.max(peak, equity);
    return {
      mode: 'paper',
      configuredCapitalSol: cfg.capitalSol,
      cashSol: cash,
      walletSol: null,
      reservedSol: cfg.settings.feeReserveSol,
      availableSol: Math.max(0, cash - cfg.settings.feeReserveSol - pending.filter((f) => f.kind === 'buy').reduce((a, f) => a + f.sizeSol, 0)),
      openExposureSol: exposure,
      indicativeValueSol: exec,
      executableValueSol: exec,
      equitySol: equity,
      realizedPnlSol: closed.reduce((a, c) => a + c.pnlSol, 0),
      unrealizedPnlSol: exec - exposure,
      todayPnlSol: equity - dayStart,
      dayStartEquitySol: dayStart,
      peakEquitySol: peak,
      drawdownPct: peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0,
      feesPaidSol: 0,
      openPositions: positions.size,
      tradeCount: closed.length,
      consecutiveLosses,
      valuationMethod: 'replay executable value',
    };
  };

  const closePosition = (p: SimPosition, at: number, reason: string, unexec: boolean) => {
    positions.delete(p.id);
    const pnl = p.proceedsSol - p.initialCost - (p.feesSol - fee);
    closed.push({
      mint: p.mint,
      strategy: p.strategy,
      entryAt: p.entryAt,
      exitAt: at,
      costSol: p.initialCost,
      proceedsSol: p.proceedsSol,
      feesSol: p.feesSol,
      pnlSol: pnl,
      pnlPct: (pnl / p.initialCost) * 100,
      holdSec: (at - p.entryAt) / 1000,
      riskTier: p.riskTier,
      riskScore: p.riskScore,
      launchAgeSec: p.launchAgeSec,
      quotedExpectedNetPct: p.quotedNet,
      closeReason: reason,
      unexecutableExit: unexec,
      marketRegime: p.regime,
    });
    consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
  };

  const processFills = (now: number) => {
    for (let i = 0; i < pending.length; ) {
      const f = pending[i]!;
      if (f.at > now) {
        i++;
        continue;
      }
      pending.splice(i, 1);
      const t = registry.get(f.mint);
      const state = t?.liquidity;
      const failedTx = rnd() < cfg.failureRate;
      if (f.kind === 'buy') {
        const q = state ? quoteBuy(state, Math.round(f.sizeSol * 1e9)) : null;
        const expected = quoteBuy(f.decisionState, Math.round(f.sizeSol * 1e9)).tokensOut;
        if (!state || !q || failedTx || q.capped || q.tokensOut < expected * (1 - cfg.settings.maxSlippagePct / 100)) {
          failedEntries++;
          if (failedTx || (q && !q.capped)) cash -= fee;
          continue;
        }
        cash -= q.quoteInLamports / 1e9 + fee;
        const a = f.assessment!;
        positions.set(nextId, {
          id: nextId++,
          mint: f.mint,
          strategy: f.signal!.strategy,
          tokens: q.tokensOut,
          costSol: q.quoteInLamports / 1e9 + fee,
          initialCost: q.quoteInLamports / 1e9 + fee,
          proceedsSol: 0,
          feesSol: fee,
          entryAt: f.at,
          peakValue: q.quoteInLamports / 1e9 + fee,
          signal: f.signal!,
          partialTaken: false,
          exitFailures: 0,
          riskTier: a.risk.tier,
          riskScore: a.risk.score,
          launchAgeSec: t?.createdAt ? (f.at - t.createdAt) / 1000 : null,
          quotedNet: a.profitability?.expectedNetPct ?? null,
          regime: regimeAt(f.at),
        });
      } else {
        const p = positions.get(f.positionId!);
        if (!p) continue;
        const tokens = f.fraction! >= 0.999 ? p.tokens : Math.floor(p.tokens * f.fraction!);
        const q = state ? quoteSell(state, tokens) : null;
        const expected = quoteSell(f.decisionState, tokens).quoteOutLamports;
        const slip = Math.min(cfg.hard.maxSlippagePct, cfg.settings.maxSlippagePct * 2);
        if (!state || !q || failedTx || q.capped || q.quoteOutLamports < expected * (1 - slip / 100)) {
          failedExits++;
          p.exitFailures++;
          if (failedTx || (q && !q.capped)) {
            cash -= fee;
            p.feesSol += fee;
          }
          if (!state || q?.capped) unexecutable++;
          continue;
        }
        const proceeds = q.quoteOutLamports / 1e9;
        cash += proceeds - fee;
        p.proceedsSol += proceeds;
        p.feesSol += fee;
        const frac = tokens / p.tokens;
        p.costSol -= p.costSol * frac;
        p.tokens -= tokens;
        if (p.tokens <= 1000) closePosition(p, f.at, f.reason!, false);
        else p.partialTaken = true;
      }
    }
  };

  const evaluate = (now: number) => {
    processFills(now);
    const pf = summary(now);
    const breached = risk.limitBreached(pf);
    // Exits
    for (const p of positions.values()) {
      if (pending.some((f) => f.kind === 'sell' && f.positionId === p.id)) continue;
      const t = registry.get(p.mint);
      const exec = executable(p);
      if (exec !== null) p.peakValue = Math.max(p.peakValue, exec);
      const pos: PositionRecord = {
        id: p.id,
        mode: 'paper',
        mint: p.mint,
        symbol: null,
        strategy: p.strategy,
        status: 'open',
        venue: 'bonding_curve',
        tokenAmountRaw: String(p.tokens),
        costBasisSol: p.costSol,
        entryPriceSol: 0,
        entryAt: p.entryAt,
        exitAt: null,
        realizedPnlSol: 0,
        proceedsSol: p.proceedsSol,
        feesSol: p.feesSol,
        peakValueSol: p.peakValue,
        stopPct: p.signal.stopPct,
        targetPct: p.signal.targetPct,
        maxHoldSec: p.signal.maxHoldSec,
        lastIndicativeValueSol: null,
        lastExecutableValueSol: exec,
        lastValuationAt: now,
        closeReason: null,
        meta: { partialTaken: p.partialTaken, trailingPct: p.signal.trailingPct },
      };
      // A token whose state went stale keeps its last assessment; exit policy holds rather than selling blind.
      const d = evaluateExit({
        position: pos,
        token: t,
        features: t?.lastAssessment?.features ?? null,
        risk: t?.lastAssessment?.risk ?? null,
        executableValueSol: exec,
        now,
        emergency: breached && cfg.settings.emergencyPolicy === 'reduce',
      });
      if (d.action !== 'hold' && t?.liquidity) pending.push({ at: now + cfg.latencyMs, kind: 'sell', mint: p.mint, sizeSol: 0, tokens: p.tokens, decisionState: t.liquidity, positionId: p.id, fraction: d.fraction, reason: d.reason });
      if (exec === null && now - p.entryAt > cfg.staleMs && p.exitFailures === 0) unexecutable++;
    }
    // Entries
    const blockers = risk.entryBlockers(
      { mode: 'paper', killSwitchActive: false, liveArmed: false, dbHealthy: true, providerProblems: [], marketDataAgeMs: 0, staleMs: cfg.staleMs, ledgerMismatch: false, ambiguousOrders: 0 },
      pf,
    );
    const candidates: Array<{ t: TokenState; a: TokenAssessment; s: EntrySignal }> = [];
    for (const t of registry.tokens.values()) {
      if (now - t.lastEventAt > 120_000) continue;
      if (!t.mintInfo || now - t.mintInfo.fetchedAt > 3600_000) {
        const mi = src.mintInfoAsOf(t.mint, now);
        t.mintInfo = mi ?? (cfg.assumeStandardMintWhenUnknown ? standardMint(now, t.tokenProgram) : null);
      }
      const h = src.holdersAsOf(t.mint, now);
      if (h) t.holders = h;
      t.rpcCheckedAt = t.liquidity?.observedAt ?? null;
      t.inconsistencyPct = 0;
      const { assessment, signal } = assessToken(t, {
        now,
        staleMs: cfg.staleMs,
        settings: cfg.settings,
        referenceSizeSol: Math.max(0.01, (cfg.capitalSol * cfg.settings.maxPositionPct) / 100),
        creatorHistory: t.creator
          ? { launches: 0, graduated: 0, flagged: flaggedCreators.has(t.creator) ? 1 : 0, launchesLast24h: src.creatorLaunchesBetween(t.creator, now - 86_400_000, now) }
          : null,
        providerProblems: [],
        costs: cfg.costs,
        strategies: stratView,
        enabledStrategies: cfg.settings.enabledStrategies,
      });
      t.lastAssessment = assessment;
      if (assessment.risk.criticalFlags.includes('CREATOR_DUMPING') && t.creator) flaggedCreators.add(t.creator);
      if (signal) candidates.push({ t, a: assessment, s: signal });
    }
    if (!blockers.length && candidates.length) {
      candidates.sort((x, y) => (y.a.profitability?.expectedNetPct ?? 0) - (x.a.profitability?.expectedNetPct ?? 0));
      for (const c of candidates.slice(0, 3)) {
        const hasPos = [...positions.values()].some((p) => p.mint === c.t.mint);
        const hasOrder = pending.some((f) => f.mint === c.t.mint);
        const stratExp = [...positions.values()].filter((p) => p.strategy === c.s.strategy).reduce((a, p) => a + p.costSol, 0);
        const d = risk.evaluateEntry({
          signal: c.s,
          assessment: c.a,
          liquidity: c.t.liquidity,
          portfolio: pf,
          system: { mode: 'paper', killSwitchActive: false, liveArmed: false, dbHealthy: true, providerProblems: [], marketDataAgeMs: 0, staleMs: cfg.staleMs, ledgerMismatch: false, ambiguousOrders: 0 },
          hasActivePosition: hasPos,
          hasActiveOrder: hasOrder,
          strategyExposureSol: stratExp,
          costs: cfg.costs,
          onchainVerifiedAgeMs: c.t.liquidity ? now - c.t.liquidity.observedAt : null,
        });
        if (!d.approved) continue;
        const sizeSol = Math.min(d.sizeSol, cfg.hard.maxPositionSol);
        decisions.push({ at: now, mint: c.t.mint, strategy: c.s.strategy, sizeSol });
        pending.push({ at: now + cfg.latencyMs, kind: 'buy', mint: c.t.mint, sizeSol, tokens: 0, decisionState: c.t.liquidity!, signal: c.s, assessment: c.a });
        break;
      }
    }
    equityCurve.push({ at: now, equity: pf.equitySol, exposure: pf.openExposureSol });
  };

  const yieldEvery = cfg.yieldEvery ?? 5000;
  for (const e of src.trades(cfg.fromTs, cfg.toTs)) {
    while (e.ts >= nextEval) {
      evaluate(nextEval);
      nextEval += cfg.evalIntervalMs;
    }
    processFills(e.ts);
    const t = prepareToken(e.mint, e.ts);
    if (!t.quoteMint) {
      t.quoteMint = e.quoteMint;
      t.quoteVerified = true;
    }
    registry.applyTrade(e);
    if (e.source !== 'solana-rpc-logs' && t.liquidity) t.liquidity = { ...t.liquidity, observedAt: e.ts };
    globalVolume.push({ ts: e.ts, sol: e.solLamports / 1e9 });
    if (++events % yieldEvery === 0) await new Promise((r) => setImmediate(r));
  }
  while (nextEval <= cfg.toTs) {
    evaluate(nextEval);
    nextEval += cfg.evalIntervalMs;
  }
  processFills(cfg.toTs + cfg.latencyMs);

  const openAtEnd = [...positions.values()].map((p) => {
    const t = registry.get(p.mint);
    const mark = t?.liquidity ? ((spotPriceSol(t.liquidity) ?? 0) * p.tokens) / 1e6 : 0;
    return { mint: p.mint, markSol: mark, executableSol: executable(p) ?? 0, costSol: p.costSol };
  });
  return {
    config: { ...cfg, settings: { enabledStrategies: cfg.settings.enabledStrategies, maxRiskScore: cfg.settings.maxRiskScore, maxPositionPct: cfg.settings.maxPositionPct } } as ReplayResult['config'],
    trades: closed,
    equityCurve,
    failedEntries,
    failedExits,
    unexecutableExitEvents: unexecutable,
    decisions,
    tokensSeen: registry.tokens.size,
    eventsProcessed: events,
    openAtEnd,
    assumptions,
  };
}
