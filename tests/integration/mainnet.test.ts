/**
 * Read-only integration tests against real services (Solana mainnet RPC, DexScreener).
 * Opt-in: PUMPRAELIE_INTEGRATION=1 npm run test:integration
 * No wallet is used and no transaction is ever sent.
 */
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import { silentLogger } from '../../src/server/lib/logger';
import { quoteBuy } from '../../src/server/market/liquidity';
import { parsePumpLogs, PUMP_PROGRAM } from '../../src/server/market/pumpEvents';
import { ProviderHealthMonitor } from '../../src/server/market/providerHealth';
import { DexScreenerClient } from '../../src/server/market/providers/dexScreener';
import { OnchainInspector } from '../../src/server/market/providers/onchain';
import { SolanaRpc } from '../../src/server/market/providers/solanaRpc';
import type { TradeEvent } from '../../src/server/market/types';

const enabled = process.env.PUMPRAELIE_INTEGRATION === '1';
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const WS = process.env.SOLANA_WS_URL ?? RPC.replace(/^http/, 'ws');

function collectTrades(ms: number): Promise<TradeEvent[]> {
  return new Promise((resolve, reject) => {
    const out: TradeEvent[] = [];
    const ws = new WebSocket(WS);
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }] })));
    ws.on('message', (m) => {
      const j = JSON.parse(String(m));
      if (!j.params || j.params.result.value.err) return;
      out.push(...parsePumpLogs(j.params.result.value.logs, j.params.result.value.signature, j.params.result.context.slot, Date.now()).trades);
    });
    ws.on('error', reject);
    setTimeout(() => {
      ws.close();
      resolve(out);
    }, ms);
  });
}

describe.skipIf(!enabled)('mainnet integration (read-only)', () => {
  const health = new ProviderHealthMonitor();
  const rpc = new SolanaRpc({ primary: RPC }, { maxRps: 4, timeoutMs: 15_000 }, health, silentLogger);
  const oc = new OnchainInspector(rpc);

  it('streams and decodes live Pump trade events', async () => {
    const trades = await collectTrades(15_000);
    expect(trades.length).toBeGreaterThan(5);
    expect(trades.every((t) => t.solLamports >= 0 && t.tokenAmount > 0)).toBe(true);
  }, 30_000);

  it('reconciles streamed curve state against on-chain accounts and the official SDK quote', async () => {
    const trades = (await collectTrades(10_000)).filter((t) => t.quoteMint === '11111111111111111111111111111111');
    const mints = [...new Set(trades.map((t) => t.mint))].slice(0, 20);
    const curves = await oc.fetchCurves(mints);
    const { global, feeConfig } = await oc.protocol();
    let compared = 0;
    for (const [, snap] of curves) {
      if (!snap || snap.complete || snap.isMayhem) continue;
      const sdk = Number(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: snap.curve.tokenTotalSupply, bondingCurve: snap.curve, amount: new BN(10_000_000), quoteMint: snap.curve.quoteMint }).toString());
      const mine = quoteBuy(snap.liquidity, 10_000_000).tokensOut;
      expect(Math.abs(mine - sdk) / sdk).toBeLessThan(1e-3);
      const sell = Number(getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: snap.curve.tokenTotalSupply, bondingCurve: snap.curve, amount: new BN(1_000_000) }).toString());
      expect(sell).toBeGreaterThanOrEqual(0);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  }, 60_000);

  it('reads mint accounts with authorities and extensions', async () => {
    const trades = await collectTrades(8_000);
    const mint = trades[0]!.mint;
    const infos = await oc.fetchMintInfos([mint]);
    const mi = infos.get(mint)!;
    expect(mi).not.toBeNull();
    expect(mi.decimals).toBe(6);
  }, 30_000);

  it('fetches DexScreener data for an active token (documented public API)', async () => {
    const trades = await collectTrades(8_000);
    const dex = new DexScreenerClient('https://api.dexscreener.com', health, silentLogger);
    const res = await dex.fetchTokens([...new Set(trades.map((t) => t.mint))].slice(0, 30));
    expect(health.get('dexscreener')!.lastSuccessAt).not.toBeNull();
    for (const s of res.values()) expect(s.source).toBe('dexscreener');
  }, 30_000);
});
