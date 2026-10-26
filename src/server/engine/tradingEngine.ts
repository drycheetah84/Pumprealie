import type { Logger } from 'pino';
import type { PortfolioSummary, PositionRecord, TokenAssessment, TradingMode } from '../../shared/types';
import { assessToken } from '../analysis/assessment';
import { txFeeLamports, type CostModel } from '../analysis/profitability';
import type { Env } from '../config/env';
import { dbHealthy, json, type DB } from '../db/database';
import type { Store } from '../db/store';
import type { ExecutionService } from '../execution/executionService';
import type { OrderRepo } from '../execution/orderRepo';
import type { EventBus } from '../lib/events';
import { errMsg } from '../lib/util';
import { quoteSell, spotPriceSol } from '../market/liquidity';
import type { MarketEngine } from '../market/marketEngine';
import type { ProviderHealthMonitor } from '../market/providerHealth';
import type { TokenState } from '../market/tokenRegistry';
import type { Portfolio } from '../portfolio/portfolio';
import type { RiskManager, SystemConditions } from '../risk/riskManager';
import { evaluateExit } from '../strategy/exitPolicy';
import type { StrategyRegistry } from '../strategy/registry';

export interface EngineDeps {
  env: Env;
  db: DB;
  store: Store;
  market: MarketEngine;
  health: ProviderHealthMonitor;
  strategies: StrategyRegistry;
  risk: RiskManager;
  portfolio: Portfolio;
  orders: OrderRepo;
  execution: ExecutionService;
  bus: EventBus;
  log: Logger;
  mode: () => TradingMode;
  liveArmed: () => boolean;
  walletSol: () => number | null;
  ledgerMismatch: () => boolean;
  costs: () => CostModel;
}

/**
 * The autonomous decision loop. Each tick: assess active tokens, value open positions
 * against executable quotes, apply exits and the emergency policy, then consider at most
 * one new entry — always through the shared risk manager and execution service.
 */
export class TradingEngine {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastPersist = new Map<string, number>();
  private flaggedCreators = new Set<string>();
  private exitInFlight = new Set<number>();
  private lastExitAttempt = new Map<number, number>();
  private entryInFlight = false;
  private lastSnapshotAt = 0;
  private emergencyActive = false;
  private lastEmit = new Map<string, number>();
  lastTickAt = 0;
  lastTickMs = 0;
  lastBlockers: string[] = [];
  lastPortfolio: PortfolioSummary | null = null;

  constructor(private readonly d: EngineDeps) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.d.env.EVALUATION_INTERVAL_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Wait for in-flight work so state is consistent before the DB closes.
    for (let i = 0; i < 100 && (this.ticking || this.exitInFlight.size || this.entryInFlight); i++) await new Promise((r) => setTimeout(r, 100));
  }

  get assessments(): TokenAssessment[] {
    return [...this.d.market.registry.tokens.values()].map((t) => t.lastAssessment).filter((a): a is TokenAssessment => Boolean(a));
  }

  systemConditions(now: number): SystemConditions {
    const { env } = this.d;
    return {
      mode: this.d.mode(),
      killSwitchActive: this.d.store.getKillSwitch().active,
      liveArmed: this.d.liveArmed(),
      dbHealthy: dbHealthy(this.d.db),
      providerProblems: this.d.health.criticalProblems(),
      marketDataAgeMs: now - this.d.market.lastDataAt,
      staleMs: env.STALE_DATA_MS,
      ledgerMismatch: this.d.mode() === 'live' && this.d.ledgerMismatch(),
      ambiguousOrders: this.d.orders.listActive(this.d.mode()).filter((o) => o.status === 'RECONCILING').length,
    };
  }

  portfolioSummary(now: number): PortfolioSummary {
    const mode = this.d.mode() === 'offline' ? 'paper' : this.d.mode();
    const pendingEntrySol = this.d.orders
      .listActive(mode)
      .filter((o) => o.side === 'buy')
      .reduce((a, o) => a + (o.requestedSol ?? 0), 0);
    return this.d.portfolio.summary(mode, {
      configuredCapitalSol: this.d.env.TRADING_CAPITAL_SOL,
      feeReserveSol: this.d.risk.current.feeReserveSol,
      walletSol: mode === 'live' ? this.d.walletSol() : null,
      now,
      pendingEntrySol,
    });
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    const started = Date.now();
    try {
      await this.runTick(started);
    } catch (e) {
      this.d.log.error({ err: errMsg(e) }, 'engine tick failed');
    } finally {
      this.ticking = false;
      this.lastTickAt = started;
      this.lastTickMs = Date.now() - started;
    }
  }

  private async runTick(now: number) {
    const { market, store, env } = this.d;
    const mode = this.d.mode();
    const bookMode: TradingMode = mode === 'offline' ? 'paper' : mode;
    const settings = this.d.risk.current;
    const providerProblems = this.d.health.criticalProblems();
    const costs = this.d.costs();

    // 1. Keep open positions pinned & prioritized for reconciliation.
    const open = this.d.portfolio.openPositions(bookMode);
    for (const p of open) {
      market.registry.ensure(p.mint, p.entryAt);
      market.pin(p.mint, true);
    }

    // 2. Assess active tokens.
    const active = market.activeTokens(now, 120_000, 80);
    const pinned = open.map((p) => market.registry.get(p.mint)).filter((t): t is TokenState => Boolean(t));
    const set = new Map<string, TokenState>();
    for (const t of [...pinned, ...active]) set.set(t.mint, t);
    const refSize = Math.min(this.d.env.HARD_MAX_POSITION_SOL, (env.TRADING_CAPITAL_SOL * settings.maxPositionPct) / 100);
    // Identity collisions: active tokens sharing a symbol/name (copycats of trending launches).
    const identity = new Map<string, number>();
    const idKeys = (t: TokenState) => [t.symbol, t.name].filter((x): x is string => Boolean(x)).map((x) => x.trim().toLowerCase());
    for (const t of market.activeTokens(now, 3600_000, 2000)) for (const k of new Set(idKeys(t))) identity.set(k, (identity.get(k) ?? 0) + 1);
    const buyCandidates: Array<{ t: TokenState; a: TokenAssessment; signal: NonNullable<ReturnType<typeof assessToken>['signal']> }> = [];
    for (const t of set.values()) {
      const creator = t.creator ? store.getCreator(t.creator) : null;
      const { assessment, signal } = assessToken(t, {
        now,
        staleMs: env.STALE_DATA_MS,
        settings,
        referenceSizeSol: Math.max(0.01, refSize),
        creatorHistory: t.creator
          ? {
              launches: creator?.launches ?? 0,
              graduated: creator?.graduated ?? 0,
              flagged: creator?.flagged ?? 0,
              launchesLast24h: store.countRecentLaunchesByCreator(t.creator, now - 86_400_000),
            }
          : null,
        providerProblems,
        identityCollisions: Math.max(0, ...idKeys(t).map((k) => (identity.get(k) ?? 1) - 1)),
        costs,
        strategies: this.d.strategies,
        enabledStrategies: settings.enabledStrategies,
      });
      t.lastAssessment = assessment;
      this.maybePersist(assessment, now);
      this.maybeEmit(assessment, now);
      if (assessment.risk.criticalFlags.includes('CREATOR_DUMPING') && t.creator && !this.flaggedCreators.has(t.mint)) {
        this.flaggedCreators.add(t.mint);
        store.flagCreator(t.creator, `creator dumped ${t.mint}`);
      }
      if (signal) buyCandidates.push({ t, a: assessment, signal });
      if (assessment.recommendation.action !== 'skip') market.prioritize([t.mint]);
    }

    // 3. Value open positions with executable quotes.
    for (const p of open) {
      const t = market.registry.get(p.mint);
      const liq = t?.liquidity ?? null;
      const tokens = Number(p.tokenAmountRaw);
      if (!liq || tokens <= 0 || now - liq.observedAt > env.STALE_DATA_MS) {
        this.d.portfolio.updateValuation(p.id, p.lastIndicativeValueSol, null, now);
        continue;
      }
      const spot = spotPriceSol(liq) ?? 0;
      const q = quoteSell(liq, tokens);
            // A capped quote means only part of the position can currently be sold; value that part only.
      this.d.portfolio.updateValuation(p.id, (tokens / 1e6) * spot, q.quoteOutLamports / 1e9, now);
    }

    // 4. Portfolio + emergency policy.
    const pf = this.portfolioSummary(now);
    this.lastPortfolio = pf;
    const breached = this.d.risk.limitBreached(pf);
    if (breached && !this.emergencyActive) {
      this.emergencyActive = true;
      const n = this.d.execution.cancelPendingEntries(bookMode, 'loss/drawdown limit breached');
      const alert = store.addAlert('critical', 'LIMIT_BREACHED', `Loss/drawdown limit breached: entries suspended, ${n} pending entries cancelled, policy=${settings.emergencyPolicy}`);
      this.d.bus.emit('alert', alert);
      store.audit('system', 'risk.limit_breached', null, null, { drawdownPct: pf.drawdownPct, todayPnlSol: pf.todayPnlSol, policy: settings.emergencyPolicy });
    } else if (!breached && this.emergencyActive) this.emergencyActive = false;

    // 5. Exits (allowed in every mode with an executor, including under the kill switch).
    if (mode !== 'offline') {
      for (const p of this.d.portfolio.openPositions(bookMode)) {
        if (p.status === 'closing' || this.exitInFlight.has(p.id)) continue;
        if (this.d.orders.activeFor(bookMode, p.mint, 'sell')) continue;
        // Positions that repeatedly failed to exit are retried at most once a minute.
        if (p.status === 'stuck' && now - (this.lastExitAttempt.get(p.id) ?? 0) < 60_000) continue;
        const t = market.registry.get(p.mint);
        const decision = evaluateExit({
          position: p,
          token: t,
          features: t?.lastAssessment?.features ?? null,
          risk: t?.lastAssessment?.risk ?? null,
          executableValueSol: p.lastExecutableValueSol,
          now,
          emergency: this.emergencyActive && settings.emergencyPolicy === 'reduce',
        });
        if (decision.action === 'hold') {
          if (p.lastExecutableValueSol === null && now - p.entryAt > 30_000 && !p.meta.lastExitError) {
            this.d.portfolio.patchMeta(p.id, { lastExitError: 'no executable quote' });
            this.d.bus.emit('alert', store.addAlert('warning', 'NO_EXIT_QUOTE', `No executable quote for open position ${p.mint}; holding (no blind sells)`, p.mint));
          }
          continue;
        }
        this.lastExitAttempt.set(p.id, now);
        this.launchExit(p, t, decision.fraction, decision.reason, decision.urgent);
      }
    }

    // 6. Entries: at most one per tick, best expected value first.
    const sys = this.systemConditions(now);
    this.lastBlockers = this.d.risk.entryBlockers(sys, pf);
    if (!this.entryInFlight && this.lastBlockers.length === 0 && buyCandidates.length) {
      buyCandidates.sort((x, y) => (y.a.profitability?.expectedNetPct ?? 0) - (x.a.profitability?.expectedNetPct ?? 0));
      for (const c of buyCandidates.slice(0, 3)) {
        const stratExposure = this.d.portfolio.openPositions(bookMode).filter((p) => p.strategy === c.signal.strategy).reduce((a, p) => a + p.costBasisSol, 0);
        const decision = this.d.risk.evaluateEntry({
          signal: c.signal,
          assessment: c.a,
          liquidity: c.t.liquidity,
          portfolio: pf,
          system: sys,
          hasActivePosition: Boolean(this.d.portfolio.activePosition(bookMode, c.t.mint)),
          hasActiveOrder: Boolean(this.d.orders.activeFor(bookMode, c.t.mint)),
          strategyExposureSol: stratExposure,
          costs,
          onchainVerifiedAgeMs: c.t.rpcCheckedAt ? now - c.t.rpcCheckedAt : null,
        });
        const decisionId = this.recordDecision(bookMode, c.t.mint, c.signal.strategy, decision.approved, decision.sizeSol, decision.reasons, c.a, now);
        if (!decision.approved) continue;
        this.launchEntry(bookMode, c.t, c.signal, decision.sizeSol, decisionId, pf, costs);
        break;
      }
    }

    // 7. Periodic equity snapshot.
    if (now - this.lastSnapshotAt > 30_000) {
      this.lastSnapshotAt = now;
      this.d.portfolio.snapshotEquity(bookMode, pf, now);
    }
  }

  private launchEntry(mode: TradingMode, t: TokenState, signal: NonNullable<ReturnType<typeof assessToken>['signal']>, sizeSol: number, decisionId: number, pf: PortfolioSummary, costs: CostModel) {
    this.entryInFlight = true;
    this.d.market.pin(t.mint, true);
    const settings = this.d.risk.current;
    void this.d.execution
      .submitEntry({
        mode,
        mint: t.mint,
        symbol: t.symbol,
        venue: t.venue,
        strategy: signal.strategy,
        sizeSol,
        maxSlippagePct: settings.maxSlippagePct,
        decisionId,
        decisionState: t.liquidity!,
        tokenProgram: t.tokenProgram,
        plan: { stopPct: signal.stopPct, targetPct: signal.targetPct, maxHoldSec: signal.maxHoldSec, trailingPct: signal.trailingPct, thesis: signal.thesis },
        reason: signal.thesis,
        estNetworkFeeSol: txFeeLamports(costs) / 1e9,
        capitalBaseSol: this.d.risk.capitalBase(pf),
      })
      .then((o) => {
        if (o.status !== 'SETTLED' && !this.d.portfolio.activePosition(mode, t.mint)) this.d.market.pin(t.mint, false);
      })
      .catch((e) => this.d.log.error({ err: errMsg(e), mint: t.mint }, 'entry failed'))
      .finally(() => {
        this.entryInFlight = false;
      });
  }

  private launchExit(p: PositionRecord, t: TokenState | undefined, fraction: number, reason: string, urgent: boolean) {
    if (!t?.liquidity) return;
    this.exitInFlight.add(p.id);
    const settings = this.d.risk.current;
    // Urgent exits accept more slippage (bounded by the hard limit); a failed sell is retried
    // on later ticks only after the order reached a terminal state (no blind duplicate sells).
    const slip = urgent ? Math.min(this.d.env.HARD_MAX_SLIPPAGE_PCT, settings.maxSlippagePct * 2) : settings.maxSlippagePct;
    void this.d.execution
      .submitExit({ mode: p.mode, position: p, fraction, reason, maxSlippagePct: slip, decisionState: t.liquidity, tokenProgram: t.tokenProgram })
      .then((o) => {
        const after = this.d.portfolio.position(p.id);
        if (after?.status === 'closed') this.d.market.pin(p.mint, false);
        this.d.log.info({ mint: p.mint, status: o.status, reason }, 'exit processed');
      })
      .catch((e) => this.d.log.error({ err: errMsg(e), mint: p.mint }, 'exit failed'))
      .finally(() => this.exitInFlight.delete(p.id));
  }

  private recordDecision(mode: TradingMode, mint: string, strategy: string, approved: boolean, sizeSol: number, reasons: string[], a: TokenAssessment, now: number): number {
    const assessmentId = this.persistAssessment(a);
    const r = this.d.db
      .prepare('INSERT INTO decisions (mode, mint, decided_at, strategy, action, approved, size_sol, reasons, assessment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(mode, mint, now, strategy, 'buy', approved ? 1 : 0, sizeSol, json.str(reasons), assessmentId);
    return Number(r.lastInsertRowid);
  }

  private persistAssessment(a: TokenAssessment): number {
    const r = this.d.db
      .prepare('INSERT INTO assessments (mint, assessed_at, risk_score, tier, action, strategy, expected_net_pct, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.mint, a.assessedAt, a.risk.score, a.risk.tier, a.recommendation.action, a.recommendation.strategy, a.profitability?.expectedNetPct ?? null, json.str(a));
    return Number(r.lastInsertRowid);
  }

  /** Persist assessments for non-skip tokens (and a periodic sample of others) — bounded by retention. */
  private maybePersist(a: TokenAssessment, now: number) {
    const last = this.lastPersist.get(a.mint) ?? 0;
    const interval = a.recommendation.action === 'skip' ? 300_000 : 30_000;
    if (now - last < interval) return;
    this.lastPersist.set(a.mint, now);
    if (this.lastPersist.size > 20_000) this.lastPersist.clear();
    try {
      this.persistAssessment(a);
    } catch (e) {
      this.d.log.warn({ err: errMsg(e) }, 'persist assessment failed');
    }
  }

  private maybeEmit(a: TokenAssessment, now: number) {
    const last = this.lastEmit.get(a.mint) ?? 0;
    if (now - last < 2000) return;
    this.lastEmit.set(a.mint, now);
    if (this.lastEmit.size > 20_000) this.lastEmit.clear();
    this.d.bus.emit('token:update', a.summary);
  }
}
