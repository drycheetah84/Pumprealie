import type { Logger } from 'pino';
import { buildApp, type App } from '../../src/server/app';
import { loadEnv, type Env } from '../../src/server/config/env';
import { migrate, openDatabase, type DB } from '../../src/server/db/database';
import { silentLogger } from '../../src/server/lib/logger';

export const TEST_TOKEN = 'test-dashboard-token-0123456789abcdef-XYZ';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv(
    {
      APP_ENV: 'test',
      DATABASE_PATH: ':memory:',
      DATA_DIR: '/tmp/pumpraelie-test',
      DASHBOARD_API_TOKEN: TEST_TOKEN,
      ONCHAIN_STREAM_ENABLED: 'false',
      PUMPPORTAL_ENABLED: 'false',
      DEXSCREENER_ENABLED: 'false',
      WALLET_KEYPAIR_PATH: '',
      LIVE_TRADING_ENABLED: 'false',
      TRADING_MODE: 'paper',
      ...overrides,
    },
    false,
  );
}

/** Full application wired against an in-memory database. Background loops are NOT started. */
export function testApp(overrides: Record<string, string> = {}, log: Logger = silentLogger): App {
  return buildApp(testEnv(overrides), log);
}

export function memDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}
