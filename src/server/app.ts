import type { Logger } from 'pino';
import type { TradingMode } from '../shared/types';
import { DEFAULT_COSTS, type CostModel } from './analysis/profitability';
import type { Env } from './config/env';
import { clampRiskSettings, defaultRiskSettings, hardLimitsFromEnv, riskSettingsSchema, type RiskSettings } from './config/riskSettings';
import { migrate, openDatabase, type DB } from './db/database';
import { Store } from './db/store';
import { ModeController } from './engine/modeController';
import { TradingEngine } from './engine/tradingEngine';
import { ExecutionService } from './execution/executionService';
import { LiveExecutor } from './execution/liveExecutor';
import { LiveReconciler } from './execution/liveReconciler';
import { OrderRepo } from './execution/orderRepo';
import { PaperExecutor } from './execution/paperExecutor';
import { LocalKeypairSigner, type TransactionSigner } from './execution/signer';
import type { Executor } from './execution/types';
import { EventBus } from './lib/events';
import { errMsg, sleep } from './lib/util';
import type { LiquidityState } from './market/liquidity';
import { MarketEngine } from './market/marketEngine';
import { ProviderHealthMonitor } from './market/providerHealth';
import { SolanaRpc } from './market/providers/solanaRpc';
import { Portfolio } from './portfolio/portfolio';
import { RiskManager } from './risk/riskManager';
import { StrategyRegistry } from './strategy/registry';
import { BacktestService } from './backtest/backtestService';

export const VERSION = '1.0.0';

export interface App {
  env: Env;
  log: Logger;
  db: DB;
  store: Store;
  bus: EventBus;
  health: ProviderHealthMonitor;
  rpc: SolanaRpc;
  market: MarketEngine;
  strategies: StrategyRegistry;
  risk: RiskManager;
  portfolio: Portfolio;
  orders: OrderRepo;
  execution: ExecutionService;
  engine: TradingEngine;
  modes: ModeController;
  signer: TransactionSigner | null;
  reconciler: LiveReconciler | null;
  backtests: BacktestService;
  startedAt: number;
  riskSettings(): RiskSettings;
  updateRiskSettings(patch: Partial<RiskSettings>, actor: string): { settings: RiskSettings; adjustments: string[] };
  costs(): CostModel;
  start(): void;
  stop(): Promise<void>;
}

export function buildApp(env: Env, log: Logger): App {
  const db = openDatabase(env.databasePath);
  const ran = migrate(db);
  if (ran.length) log.info({ migrations: ran }, 'database migrated');
  const store = new Store(db);
  const bus = new EventBus();
  const health = new ProviderHealthMonitor();
  const rpc = new SolanaRpc({ primary: env.SOLANA_RPC_URL, backup: env.SOLANA_RPC_BACKUP_URL }, { maxRps: env.RPC_MAX_RPS, timeoutMs: env.RPC_TIMEOUT_MS }, health, log);
  const market = new MarketEngine({ env, rpc, store, health, log });
  const strategies = new StrategyRegistry(db);
  const hard = hardLimitsFromEnv(env);

  const loadSettings = (): RiskSettings => {
    const stored = store.getSetting<Partial<RiskSettings> | null>('risk_settings', null);
    const merged = { ...defaultRiskSettings(env), ...(stored ?? {}) };
    const parsed = riskSettingsSchema.safeParse(merged);
    return clampRiskSettings(parsed.success ? parsed.data : defaultRiskSettings(env), hard).settings;
  };
  let settings = loadSettings();
  const risk = new RiskManager(settings, hard, env.TRADING_CAPITAL_SOL);
  const portfolio = new Portfolio(db);
  portfolio.ensureFunded('paper', env.TRADING_CAPITAL_SOL);
  const orders = new OrderRepo(db);

  const costs = (): CostModel => ({
    ...DEFAULT_COSTS,
    priorityFeeMicroLamports: settings.priorityFeeMicroLamports,
    computeUnitLimit: env.COMPUTE_UNIT_LIMIT,
    latencyMs: env.PAPER_LATENCY_MS,
  });

  // Paper fills are priced against a fresh on-chain read when possible (falls back to the
  // latest streamed state if it is recent); they never touch a signer.
  const paperStateAt = async (mint: string): Promise<LiquidityState | null> => {
    const t = market.registry.get(mint);
    try {
      if (t?.venue === 'pumpswap') {
        const p = await market.onchain.fetchPool(mint);
        if (p) return p.liquidity;
      } else {
        const r = await market.onchain.fetchCurves([mint]);
        const snap = r.get(mint);
        if (snap && !snap.complete) return snap.liquidity;
        if (snap?.complete) return null;
      }
    } catch (e) {
      log.debug({ err: errMsg(e), mint }, 'paper fill: fresh read failed, using streamed state');
    }
    return t?.liquidity ?? null;
  };
  const paper = new PaperExecutor({
    latencyMs: env.PAPER_LATENCY_MS,
    failureRate: env.PAPER_FAILURE_RATE,
    costs: costs(),
    maxQuoteAgeMs: env.STALE_DATA_MS,
    now: Date.now,
    sleep,
    stateAt: paperStateAt,
    random: Math.random,
  });

  let signer: TransactionSigner | null = null;
  if (env.WALLET_KEYPAIR_PATH) {
    try {
      signer = LocalKeypairSigner.fromFile(env.WALLET_KEYPAIR_PATH, env.WALLET_PUBLIC_KEY);
      log.info({ wallet: signer.publicKey.toBase58() }, 'trading wallet signer loaded');
    } catch (e) {
      log.error({ err: errMsg(e) }, 'wallet signer not loaded; live trading unavailable');
    }
  }
  const executors: Partial<Record<TradingMode, Executor>> = { paper };
  let liveExecutor: LiveExecutor | null = null;
  if (signer) {
    liveExecutor = new LiveExecutor(
      rpc,
      signer,
      {
        computeUnitLimit: env.COMPUTE_UNIT_LIMIT,
        priorityFeeMicroLamports: () => settings.priorityFeeMicroLamports,
        maxPriorityMicroLamports: Math.floor(((env.MAX_TX_FEE_SOL * 1e9 - 5000) * 1e6) / env.COMPUTE_UNIT_LIMIT),
        ataRentLamports: 2_100_000,
        pollMs: 2000,
        sleep,
      },
      log,
    );
    executors.live = liveExecutor;
  }

  const modes = new ModeController(env, store, bus, {
    walletPublicKey: () => signer?.publicKey.toBase58() ?? null,
    paperTradesClosed: () => portfolio.closedCount('paper'),
    settings: () => settings,
  });
  const execution = new ExecutionService(
    db,
    orders,
    portfolio,
    store,
    hard,
    executors,
    { killSwitchActive: () => store.getKillSwitch().active, liveArmed: () => modes.liveArmed },
    bus,
    log,
  );
  const reconciler = liveExecutor ? new LiveReconciler(rpc, liveExecutor, orders, execution, portfolio, store, bus, log) : null;

  const engine = new TradingEngine({
    env,
    db,
    store,
    market,
    health,
    strategies,
    risk,
    portfolio,
    orders,
    execution,
    bus,
    log,
    mode: () => modes.mode,
    liveArmed: () => modes.liveArmed,
    walletSol: () => reconciler?.walletSol ?? null,
    ledgerMismatch: () => reconciler?.mismatch ?? false,
    costs,
  });
  const backtests = new BacktestService(db, store, strategies, () => settings, env, log);

  let retentionTimer: NodeJS.Timeout | null = null;
  const app: App = {
    env,
    log,
    db,
    store,
    bus,
    health,
    rpc,
    market,
    strategies,
    risk,
    portfolio,
    orders,
    execution,
    engine,
    modes,
    signer,
    reconciler,
    backtests,
    startedAt: Date.now(),
    riskSettings: () => settings,
    updateRiskSettings(patch, actor) {
      const candidate = riskSettingsSchema.parse({ ...settings, ...patch });
      const { settings: clamped, adjustments } = clampRiskSettings(candidate, hard);
      store.setSetting('risk_settings', clamped, actor);
      store.audit(actor, 'risk_settings.update', null, null, { patch, adjustments });
      settings = clamped;
      risk.updateSettings(clamped);
      bus.emit('status:changed', { reason: 'risk settings updated' });
      return { settings: clamped, adjustments };
    },
    costs,
    start() {
      const recovered = execution.recoverPaperOrders();
      if (recovered) log.warn({ recovered }, 'recovered interrupted paper orders');
      // Re-pin open positions so their markets are monitored immediately after restart.
      for (const m of ['paper', 'live'] as const) for (const p of portfolio.openPositions(m)) market.pin(p.mint, true);
      market.start();
      engine.start();
      reconciler?.start();
      const retention = () => {
        try {
          const r = store.applyRetention({ rawTradesHours: env.RETENTION_RAW_TRADES_HOURS, candleDays: env.RETENTION_CANDLES_DAYS, assessmentDays: env.RETENTION_ASSESSMENTS_DAYS });
          log.info({ deleted: r }, 'retention applied');
        } catch (e) {
          log.warn({ err: errMsg(e) }, 'retention failed');
        }
      };
      retentionTimer = setInterval(retention, 3600_000);
      setTimeout(retention, 60_000).unref();
    },
    async stop() {
      if (retentionTimer) clearInterval(retentionTimer);
      reconciler?.stop();
      await engine.stop();
      await market.stop();
      db.close();
    },
  };
  return app;
}
