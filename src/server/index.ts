import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app';
import { buildServer } from './api/server';
import { resolveDashboardToken } from './api/auth';
import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { errMsg } from './lib/util';

async function main() {
  const env = loadEnv();
  const log = createLogger({ level: env.LOG_LEVEL, file: env.LOG_FILE });
  const app = buildApp(env, log);
  const { token, generatedFile } = resolveDashboardToken(env.DASHBOARD_API_TOKEN, env.DATA_DIR);
  if (generatedFile) log.warn({ file: generatedFile }, 'DASHBOARD_API_TOKEN not set: using generated token stored in this file (development only)');
  // Built dashboard: dist/web (next to dist/server when compiled; repo root when run via tsx).
  const webRoot = [path.resolve(__dirname, '..', '..', 'web'), path.resolve('dist/web')].find((p) => fs.existsSync(path.join(p, 'index.html'))) ?? null;
  const server = await buildServer(app, { token, webRoot });
  if (env.API_HOST !== '127.0.0.1' && env.API_HOST !== 'localhost' && env.API_HOST !== '::1')
    log.warn({ host: env.API_HOST }, 'API bound to a non-loopback interface: ensure HTTPS, firewalling and a strong DASHBOARD_API_TOKEN (see SECURITY.md)');
  app.start();
  await server.listen({ host: env.API_HOST, port: env.API_PORT });
  log.info({ url: `http://${env.API_HOST}:${env.API_PORT}`, mode: app.modes.mode, liveAllowed: env.LIVE_TRADING_ENABLED }, 'Pumpraelie started');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down gracefully');
    const force = setTimeout(() => {
      log.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 20_000);
    try {
      await server.close();
      await app.stop();
    } catch (e) {
      log.error({ err: errMsg(e) }, 'error during shutdown');
    }
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error({ err: errMsg(e) }, 'unhandled rejection'));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`Pumpraelie failed to start: ${errMsg(e)}`);
  process.exit(1);
});
