import type { Logger } from 'pino';
import type { HolderSnapshot, MintInfo } from '../../shared/types';
import { DEFAULT_COSTS } from '../analysis/profitability';
import type { Env } from '../config/env';
import { hardLimitsFromEnv, type RiskSettings } from '../config/riskSettings';
import { json, type DB } from '../db/database';
import type { Store } from '../db/store';
import { errMsg } from '../lib/util';
import type { TradeEvent } from '../market/types';
import type { StrategyRegistry } from '../strategy/registry';
import { validateParams, type StrategyParams } from '../strategy/types';
import { computeMetrics, objective, type BacktestMetrics } from './metrics';
import { runReplay, type ReplayConfig, type ReplayDataSource, type ReplayTokenMeta } from './replay';
import { seededRandom } from '../execution/paperExecutor';

export interface BacktestParams {
  fromTs?: number;
  toTs?: number;
  /** Fraction of the period used for in-sample; the rest is out-of-sample validation. */
  trainFraction: number;
  enabledStrategies?: string[];
  paramOverrides?: Record<string, StrategyParams>;
  latencyMs?: number;
  failureRate?: number;
  seed?: number;
  evalIntervalMs?: number;
  assumeStandardMintWhenUnknown?: boolean;
}

export interface BacktestRecord {
  id: number;
  createdAt: number;
  status: 'running' | 'completed' | 'failed';
  params: BacktestParams;
  results: { period: { from: number; to: number; split: number }; inSample: BacktestMetrics; outOfSample: BacktestMetrics; assumptions: string[]; tokensSeen: number; events: number } | null;
  error: string | null;
}

/** Point-in-time data source backed by the recorded SQLite dataset. */
export class DbReplaySource implements ReplayDataSource {
  constructor(
    private readonly db: DB,
    private readonly store: Store,
  ) {}

  *trades(fromTs: number, toTs: number): Iterable<TradeEvent> {
    for (const r of this.store.iterateTrades(fromTs, toTs)) {
      const vToken = r.vToken === null ? null : Number(r.vToken);
      yield {
        mint: r.mint,
        signature: r.signature,
        eventIndex: r.eventIndex,
        slot: r.slot,
        ts: r.ts,
        side: r.side,
        solLamports: r.solLamports,
        tokenAmount: Number(r.tokenAmount),
        trader: r.trader,
        venue: r.venue as TradeEvent['venue'],
        vSol: r.vSol,
        vToken,
        realSol: r.realSol,
        realToken: r.realToken === null ? null : Number(r.realToken),
        feeLamports: r.feeLamports,
        feeBps: r.feeLamports && r.solLamports ? Math.round((r.feeLamports / r.solLamports) * 10_000) : 125,
        quoteMint: '11111111111111111111111111111111',
        creator: null,
        source: r.source,
      };
    }
  }

  tokenMeta(mint: string): ReplayTokenMeta | null {
    const t = this.store.getToken(mint);
    if (!t) return null;
    return { mint, creator: t.creator, createdAt: t.createdAt, quoteMint: t.quoteMint, tokenProgram: t.tokenProgram, isMayhem: t.isMayhem, name: t.name, symbol: t.symbol };
  }

  mintInfoAsOf(mint: string, asOf: number): MintInfo | null {
    return this.store.snapshotAsOf<MintInfo>(mint, 'mint', asOf)?.data ?? null;
  }

  holdersAsOf(mint: string, asOf: number): HolderSnapshot | null {
    const s = this.store.snapshotAsOf<HolderSnapshot>(mint, 'holders', asOf);
    return s && asOf - s.observedAt < 600_000 ? s.data : null;
  }

  creatorLaunchesBetween(creator: string, fromTs: number, toTs: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM tokens WHERE creator = ? AND created_at >= ? AND created_at <= ?').get(creator, fromTs, toTs) as { c: number }).c;
  }
}

/**
 * Runs reproducible historical replays with an in-sample / out-of-sample split and a
 * parameter search that can only *propose* strategy changes (never safety limits).
 */
export class BacktestService {
  private running = 0;

  constructor(
    private readonly db: DB,
    private readonly store: Store,
    private readonly strategies: StrategyRegistry,
    private readonly settings: () => RiskSettings,
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  private replayConfig(p: BacktestParams, fromTs: number, toTs: number, overrides?: Record<string, StrategyParams>): ReplayConfig {
    const settings = { ...this.settings() };
    if (p.enabledStrategies?.length) settings.enabledStrategies = p.enabledStrategies;
    return {
      fromTs,
      toTs,
      capitalSol: this.env.TRADING_CAPITAL_SOL,
      settings,
      hard: hardLimitsFromEnv(this.env),
      costs: { ...DEFAULT_COSTS, priorityFeeMicroLamports: settings.priorityFeeMicroLamports, computeUnitLimit: this.env.COMPUTE_UNIT_LIMIT, latencyMs: p.latencyMs ?? this.env.PAPER_LATENCY_MS },
      paramOverrides: overrides ?? p.paramOverrides,
      evalIntervalMs: p.evalIntervalMs ?? 5000,
      latencyMs: p.latencyMs ?? this.env.PAPER_LATENCY_MS,
      failureRate: p.failureRate ?? this.env.PAPER_FAILURE_RATE,
      seed: p.seed ?? 42,
      assumeStandardMintWhenUnknown: p.assumeStandardMintWhenUnknown ?? true,
      staleMs: this.env.STALE_DATA_MS,
    };
  }

  period(p: BacktestParams): { from: number; to: number; split: number } {
    const range = this.store.tradeTimeRange();
    if (!range.from || !range.to) throw new Error('no recorded trades: run the bot (paper or offline mode) to collect market data first');
    const from = Math.max(p.fromTs ?? range.from, range.from);
    const to = Math.min(p.toTs ?? range.to + 1, range.to + 1);
    if (to - from < 10 * 60_000) throw new Error('backtest period must cover at least 10 minutes of recorded data');
    return { from, to, split: Math.floor(from + (to - from) * p.trainFraction) };
  }

  async evaluate(p: BacktestParams, overrides?: Record<string, StrategyParams>) {
    const per = this.period(p);
    const src = new DbReplaySource(this.db, this.store);
    const ins = await runReplay(src, this.strategies, this.replayConfig(p, per.from, per.split, overrides));
    const oos = await runReplay(src, this.strategies, this.replayConfig(p, per.split, per.to, overrides));
    return {
      period: per,
      inSample: computeMetrics(ins, this.env.TRADING_CAPITAL_SOL),
      outOfSample: computeMetrics(oos, this.env.TRADING_CAPITAL_SOL),
      assumptions: ins.assumptions,
      tokensSeen: ins.tokensSeen + oos.tokensSeen,
      events: ins.eventsProcessed + oos.eventsProcessed,
    };
  }

  start(p: BacktestParams): number {
    if (this.running >= 1) throw new Error('a backtest is already running');
    const r = this.db.prepare('INSERT INTO backtests (created_at, status, params) VALUES (?, ?, ?)').run(Date.now(), 'running', json.str(p));
    const id = Number(r.lastInsertRowid);
    this.running++;
    void this.evaluate(p)
      .then((res) => this.db.prepare("UPDATE backtests SET status = 'completed', results = ? WHERE id = ?").run(json.str(res), id))
      .catch((e) => {
        this.log.warn({ err: errMsg(e) }, 'backtest failed');
        this.db.prepare("UPDATE backtests SET status = 'failed', error = ? WHERE id = ?").run(errMsg(e), id);
      })
      .finally(() => this.running--);
    return id;
  }

  get(id: number): BacktestRecord | null {
    const r = this.db.prepare('SELECT * FROM backtests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? rowToBacktest(r) : null;
  }

  list(limit = 50): BacktestRecord[] {
    return (this.db.prepare('SELECT * FROM backtests ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(rowToBacktest);
  }

  /**
   * Random search over one strategy's parameter space on the in-sample period; the best
   * candidates are then evaluated out-of-sample against the current (baseline) parameters.
   * Produces a *proposal* only — applying it is a separate, audited operator action.
   */
  async optimize(strategyId: string, p: BacktestParams & { candidates?: number }): Promise<number> {
    const s = this.strategies.get(strategyId);
    if (!s) throw new Error(`unknown strategy ${strategyId}`);
    const base = { ...p, enabledStrategies: [strategyId] };
    const current = this.strategies.params(strategyId);
    const rnd = seededRandom(p.seed ?? 7);
    const n = Math.min(40, p.candidates ?? 16);
    const per = this.period(base);
    const src = new DbReplaySource(this.db, this.store);
    const scoreIn = async (params: StrategyParams) => computeMetrics(await runReplay(src, this.strategies, this.replayConfig(base, per.from, per.split, { [strategyId]: params })), this.env.TRADING_CAPITAL_SOL);
    const scoreOut = async (params: StrategyParams) => computeMetrics(await runReplay(src, this.strategies, this.replayConfig(base, per.split, per.to, { [strategyId]: params })), this.env.TRADING_CAPITAL_SOL);

    const baselineIn = await scoreIn(current);
    const tried: Array<{ params: StrategyParams; m: BacktestMetrics }> = [];
    for (let i = 0; i < n; i++) {
      const cand: StrategyParams = {};
      for (const [k, spec] of Object.entries(s.paramSpecs)) {
        const steps = Math.floor((spec.max - spec.min) / spec.step);
        cand[k] = Math.round((spec.min + Math.floor(rnd() * (steps + 1)) * spec.step) * 1e6) / 1e6;
      }
      if (!validateParams(s.paramSpecs, cand).ok) continue;
      tried.push({ params: cand, m: await scoreIn(cand) });
    }
    tried.sort((a, b) => objective(b.m) - objective(a.m));
    const best = tried[0];
    const baselineOut = await scoreOut(current);
    const bestOut = best ? await scoreOut(best.params) : null;
    const reasons: string[] = [];
    if (!best || !bestOut) reasons.push('no valid candidate');
    else {
      if (objective(best.m) <= objective(baselineIn)) reasons.push('no in-sample improvement over baseline');
      if (bestOut.trades < 5) reasons.push('fewer than 5 out-of-sample trades');
      if (objective(bestOut) <= objective(baselineOut)) reasons.push('out-of-sample result does not beat baseline');
      if (bestOut.netReturnSol <= 0) reasons.push('out-of-sample net return is not positive');
      if ((best.m.largestTokenProfitShare ?? 0) > 0.4) reasons.push('in-sample profit concentrated in one token (overfitting risk)');
    }
    const evaluation = {
      period: per,
      objective: 'netReturnPct - 0.5 × maxDrawdownPct (min 5 trades)',
      candidatesTried: tried.length,
      baseline: { inSample: baselineIn, outOfSample: baselineOut },
      proposed: best ? { inSample: best.m, outOfSample: bestOut } : null,
      recommendation: reasons.length ? 'reject' : 'accept',
      reasons,
      note: 'Strategy parameters only. Safety limits are never modified by optimization.',
    };
    const r = this.db
      .prepare('INSERT INTO config_proposals (created_at, strategy, current_config, proposed_config, evaluation, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), strategyId, json.str(current), json.str(best?.params ?? current), json.str(evaluation), 'proposed');
    this.store.audit('system', 'optimizer.proposal', null, null, { strategyId, proposalId: Number(r.lastInsertRowid), recommendation: evaluation.recommendation });
    return Number(r.lastInsertRowid);
  }

  proposals(limit = 50) {
    return (this.db.prepare('SELECT * FROM config_proposals ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      createdAt: r.created_at as number,
      strategy: r.strategy as string,
      current: json.parse<StrategyParams>(r.current_config as string, {}),
      proposed: json.parse<StrategyParams>(r.proposed_config as string, {}),
      evaluation: json.parse<Record<string, unknown>>(r.evaluation as string, {}),
      status: r.status as string,
      decidedAt: r.decided_at as number | null,
      decidedBy: r.decided_by as string | null,
    }));
  }

  decide(id: number, accept: boolean, actor: string) {
    const prop = this.proposals(500).find((p) => p.id === id);
    if (!prop) throw new Error('proposal not found');
    if (prop.status !== 'proposed') throw new Error(`proposal already ${prop.status}`);
    if (accept) this.strategies.save(prop.strategy, prop.proposed, actor, `accepted optimizer proposal #${id}`);
    this.db.prepare('UPDATE config_proposals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(accept ? 'accepted' : 'rejected', Date.now(), actor, id);
    this.store.audit(actor, accept ? 'optimizer.accept' : 'optimizer.reject', null, null, { id, strategy: prop.strategy });
  }
}

function rowToBacktest(r: Record<string, unknown>): BacktestRecord {
  return {
    id: r.id as number,
    createdAt: r.created_at as number,
    status: r.status as BacktestRecord['status'],
    params: json.parse(r.params as string, {} as BacktestParams),
    results: json.parse(r.results as string | null, null),
    error: (r.error as string | null) ?? null,
  };
}
