import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The Pump SDK's ESM build imports a named export that @coral-xyz/anchor only provides
// in CommonJS, so tests resolve the SDK's CommonJS entry points (as the server does).
const sdk = path.resolve(__dirname, 'node_modules/@pump-fun/pump-sdk/dist');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pump-fun\/pump-sdk\/swap$/, replacement: path.join(sdk, 'swap/index.js') },
      { find: /^@pump-fun\/pump-sdk$/, replacement: path.join(sdk, 'index.js') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
  },
});
