/* eslint-disable no-console */
// Run a historical replay from the command line.
// Usage: npm run backtest -- [--train 0.7] [--strategies momentum,pullback] [--hours 24] [--seed 42]
import { BacktestService } from '../backtest/backtestService';
import { loadEnv } from '../config/env';
import { clampRiskSettings, defaultRiskSettings, hardLimitsFromEnv, riskSettingsSchema, type RiskSettings } from '../config/riskSettings';
import { migrate, openDatabase } from '../db/database';
import { Store } from '../db/store';
import { createLogger } from '../lib/logger';
import { StrategyRegistry } from '../strategy/registry';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const env = loadEnv();
  const log = createLogger({ level: 'warn' });
  const db = openDatabase(env.databasePath);
  migrate(db);
  const store = new Store(db);
  const stored = store.getSetting<Partial<RiskSettings> | null>('risk_settings', null);
  const parsed = riskSettingsSchema.safeParse({ ...defaultRiskSettings(env), ...(stored ?? {}) });
  const settings = clampRiskSettings(parsed.success ? parsed.data : defaultRiskSettings(env), hardLimitsFromEnv(env)).settings;
  const svc = new BacktestService(db, store, new StrategyRegistry(db), () => settings, env, log);
  const hours = arg('hours') ? Number(arg('hours')) : undefined;
  const range = store.tradeTimeRange();
  const params = {
    trainFraction: Number(arg('train') ?? 0.7),
    enabledStrategies: arg('strategies')?.split(','),
    seed: arg('seed') ? Number(arg('seed')) : undefined,
    fromTs: hours && range.to ? range.to - hours * 3600_000 : undefined,
  };
  const per = svc.period(params);
  console.log(`Dataset: ${range.count} trades. Period ${new Date(per.from).toISOString()} → ${new Date(per.to).toISOString()} (split ${new Date(per.split).toISOString()})`);
  const res = await svc.evaluate(params);
  const show = (label: string, m: typeof res.inSample) =>
    console.log(
      `${label.padEnd(14)} trades=${m.trades} net=${m.netReturnSol.toFixed(5)} SOL (${m.netReturnPct.toFixed(2)}%) realized=${m.realizedPnlSol.toFixed(5)} winRate=${(m.winRate * 100).toFixed(0)}% PF=${m.profitFactor?.toFixed(2) ?? '—'} maxDD=${m.maxDrawdownPct.toFixed(2)}% fees=${m.feesSol.toFixed(5)} unexecutableExits=${m.unexecutableExitEvents}`,
    );
  show('in-sample', res.inSample);
  show('out-of-sample', res.outOfSample);
  console.log('Assumptions:', res.assumptions.join(' | '));
  db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
