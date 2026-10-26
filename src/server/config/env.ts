import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const splitList = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const list = z.string().default('').transform(splitList);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

/**
 * Static process configuration. Every variable here is documented in `.env.example`.
 * Risk limits defined here are *defaults and hard ceilings*; runtime risk settings
 * (editable from the dashboard) are always clamped to the HARD_* values.
 */
export const envSchema = z.object({
  APP_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FILE: optionalString,
  DATA_DIR: z.string().default('./data'),
  DATABASE_PATH: optionalString,

  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  SOLANA_WS_URL: optionalString,
  SOLANA_RPC_BACKUP_URL: optionalString,
  SOLANA_WS_BACKUP_URL: optionalString,
  RPC_MAX_RPS: z.coerce.number().positive().default(8),
  RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ONCHAIN_STREAM_ENABLED: bool.default(true),

  PUMPPORTAL_ENABLED: bool.default(true),
  PUMPPORTAL_WS_URL: z.string().default('wss://pumpportal.fun/api/data'),
  PUMPPORTAL_API_KEY: optionalString,
  DEXSCREENER_ENABLED: bool.default(true),
  DEXSCREENER_BASE_URL: z.string().url().default('https://api.dexscreener.com'),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DASHBOARD_API_TOKEN: optionalString,
  CORS_ORIGINS: list,
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(240),

  TRADING_MODE: z.enum(['offline', 'paper']).default('paper'),
  LIVE_TRADING_ENABLED: bool.default(false),
  WALLET_KEYPAIR_PATH: optionalString,
  WALLET_PUBLIC_KEY: optionalString,

  TRADING_CAPITAL_SOL: z.coerce.number().positive().default(1),
  MAX_POSITION_PCT: z.coerce.number().positive().default(1),
  MAX_EXPOSURE_PCT: z.coerce.number().positive().default(10),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(3),
  MAX_DRAWDOWN_PCT: z.coerce.number().positive().default(5),
  MAX_SLIPPAGE_PCT: z.coerce.number().positive().default(3),
  MAX_PRICE_IMPACT_PCT: z.coerce.number().positive().default(3),
  MIN_EXIT_LIQUIDITY_SOL: z.coerce.number().nonnegative().default(5),
  MAX_RISK_SCORE: z.coerce.number().min(0).max(100).default(44),
  MIN_EXPECTED_NET_RETURN_PCT: z.coerce.number().default(3),
  MIN_REWARD_TO_RISK: z.coerce.number().positive().default(1.5),
  MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().positive().default(5),
  FEE_RESERVE_SOL: z.coerce.number().nonnegative().default(0.02),
  PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().nonnegative().default(100_000),
  COMPUTE_UNIT_LIMIT: z.coerce.number().int().positive().default(250_000),
  MAX_TX_FEE_SOL: z.coerce.number().positive().default(0.002),
  EMERGENCY_POLICY: z.enum(['reduce', 'hold']).default('reduce'),

  HARD_MAX_POSITION_SOL: z.coerce.number().positive().default(0.05),
  HARD_MAX_POSITION_PCT: z.coerce.number().positive().default(5),
  HARD_MAX_EXPOSURE_PCT: z.coerce.number().positive().default(25),
  HARD_MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(10),
  HARD_MAX_DRAWDOWN_PCT: z.coerce.number().positive().default(15),
  HARD_MAX_SLIPPAGE_PCT: z.coerce.number().positive().default(10),
  HARD_MAX_RISK_SCORE: z.coerce.number().min(0).max(100).default(64),

  ENABLED_STRATEGIES: z.string().default('momentum,volume_acceleration,pullback').transform(splitList),
  PAPER_LATENCY_MS: z.coerce.number().int().nonnegative().default(800),
  PAPER_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.03),
  MIN_PAPER_TRADES_FOR_LIVE: z.coerce.number().int().nonnegative().default(20),

  RECORD_ALL_TRADES: bool.default(true),
  RETENTION_RAW_TRADES_HOURS: z.coerce.number().positive().default(48),
  RETENTION_CANDLES_DAYS: z.coerce.number().positive().default(30),
  RETENTION_ASSESSMENTS_DAYS: z.coerce.number().positive().default(14),
  MAX_TRACKED_TOKENS: z.coerce.number().int().positive().default(3000),
  STALE_DATA_MS: z.coerce.number().int().positive().default(20_000),
  EVALUATION_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),
});

export type Env = z.infer<typeof envSchema> & { databasePath: string; wsUrl: string };

export function deriveWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  return u.toString();
}

export function loadEnv(overrides: Record<string, string | undefined> = {}, loadDotenv = true): Env {
  if (loadDotenv) dotenv.config({ quiet: true });
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  if (e.DASHBOARD_API_TOKEN && e.DASHBOARD_API_TOKEN.length < 32) {
    throw new Error('DASHBOARD_API_TOKEN must be at least 32 characters');
  }
  if (e.APP_ENV === 'production' && !e.DASHBOARD_API_TOKEN) {
    throw new Error('DASHBOARD_API_TOKEN is required when APP_ENV=production');
  }
  return {
    ...e,
    databasePath: e.DATABASE_PATH ?? path.join(e.DATA_DIR, 'pumpraelie.db'),
    wsUrl: e.SOLANA_WS_URL ?? deriveWsUrl(e.SOLANA_RPC_URL),
  };
}
