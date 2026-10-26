/* eslint-disable no-console */
// Verifies the trading wallet configuration without printing or transmitting secrets.
import { PublicKey } from '@solana/web3.js';
import { loadEnv } from '../config/env';
import { LocalKeypairSigner } from '../execution/signer';
import { silentLogger } from '../lib/logger';
import { ProviderHealthMonitor } from '../market/providerHealth';
import { SolanaRpc } from '../market/providers/solanaRpc';

async function main() {
  const env = loadEnv();
  if (!env.WALLET_KEYPAIR_PATH) {
    console.log('WALLET_KEYPAIR_PATH is not set: live trading is unavailable (paper trading works without a wallet).');
    return;
  }
  const signer = LocalKeypairSigner.fromFile(env.WALLET_KEYPAIR_PATH, env.WALLET_PUBLIC_KEY);
  console.log(`Keypair file permissions OK. Public key: ${signer.publicKey.toBase58()}`);
  const rpc = new SolanaRpc({ primary: env.SOLANA_RPC_URL }, { maxRps: 2, timeoutMs: 15_000 }, new ProviderHealthMonitor(), silentLogger);
  const lamports = await rpc.getBalance(new PublicKey(signer.publicKey));
  console.log(`Balance: ${(lamports / 1e9).toFixed(6)} SOL (configured trading capital ${env.TRADING_CAPITAL_SOL} SOL, fee reserve ${env.FEE_RESERVE_SOL} SOL)`);
  if (lamports / 1e9 < env.FEE_RESERVE_SOL) console.log('WARNING: balance below the fee reserve; entries will be blocked.');
  console.log(`LIVE_TRADING_ENABLED=${env.LIVE_TRADING_ENABLED}. Live trading must still be armed from the dashboard after paper trading requirements are met.`);
}

main().catch((e) => {
  console.error(`Wallet check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
