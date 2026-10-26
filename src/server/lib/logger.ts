import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

/** Field paths that must never be written to logs. */
export const REDACT_PATHS = [
  'secretKey',
  'privateKey',
  'seed',
  'seedPhrase',
  'mnemonic',
  'keypair',
  '*.secretKey',
  '*.privateKey',
  '*.seed',
  '*.mnemonic',
  'headers.authorization',
  'req.headers.authorization',
  'authorization',
  'token',
  'apiKey',
  '*.apiKey',
];

export function createLogger(opts: { level: string; file?: string; name?: string }): Logger {
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
  if (opts.file) {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    streams.push({ stream: pino.destination({ dest: opts.file, mkdir: true, sync: false }) });
  }
  return pino(
    {
      name: opts.name ?? 'pumpraelie',
      level: opts.level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
}

export const silentLogger: Logger = pino({ level: 'silent' });
