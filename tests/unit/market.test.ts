import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/server/lib/util';
import { silentLogger } from '../../src/server/lib/logger';
import { ProviderHealthMonitor } from '../../src/server/market/providerHealth';
import { DexScreenerClient } from '../../src/server/market/providers/dexScreener';
import { RpcRateLimitError, SolanaRpc } from '../../src/server/market/providers/solanaRpc';
import { curveInvariantMismatchPct, TokenRegistry } from '../../src/server/market/tokenRegistry';
import { applyBuy, quoteBuy } from '../../src/server/market/liquidity';
import { curveState, MINT, trade } from '../helpers/fixtures';

describe('provider health', () => {
  it('reports ok, degraded and down', () => {
    let t = 1_000_000;
    const h = new ProviderHealthMonitor(() => t);
    h.register('x', { critical: true, downAfterMs: 60_000 });
    expect(h.get('x')!.status).toBe('degraded'); // never succeeded yet
    h.success('x', 50);
    expect(h.get('x')!.status).toBe('ok');
    h.failure('x', 'boom');
    expect(h.get('x')!.status).toBe('degraded');
    expect(h.criticalProblems()).toEqual(['x degraded']);
    t += 120_000;
    expect(h.get('x')!.status).toBe('down');
  });
});

describe('RPC rate limits and failover', () => {
  it('cools down a method after a 429 instead of hammering the endpoint', async () => {
    const h = new ProviderHealthMonitor();
    const rpc = new SolanaRpc({ primary: 'http://127.0.0.1:1' }, { maxRps: 100, timeoutMs: 1000 }, h, silentLogger);
    await expect(rpc.call('getTokenLargestAccounts', async () => { throw new Error('429 Too Many Requests: Too many requests for a specific RPC call'); })).rejects.toBeInstanceOf(RpcRateLimitError);
    expect(rpc.isCoolingDown('getTokenLargestAccounts')).toBe(true);
    let called = false;
    await expect(rpc.call('getTokenLargestAccounts', async () => { called = true; return 1; })).rejects.toThrow(/cooling down/);
    expect(called).toBe(false);
    // Rate limits on optional enrichment do not mark the core RPC as unhealthy.
    expect(h.get('solana-rpc')!.lastError).toBeNull();
    expect(h.get('solana-rpc')!.detail).toMatch(/rate-limited/);
    // ...but rate limits on core methods do.
    await expect(rpc.call('getMultipleAccountsInfo', async () => { throw new Error('429 Too Many Requests'); })).rejects.toBeInstanceOf(RpcRateLimitError);
    expect(h.get('solana-rpc')!.lastError).toMatch(/429/);
  });

  it('fails over to the backup endpoint', async () => {
    const h = new ProviderHealthMonitor();
    const rpc = new SolanaRpc({ primary: 'http://127.0.0.1:1', backup: 'http://127.0.0.1:2' }, { maxRps: 100, timeoutMs: 1000 }, h, silentLogger);
    let n = 0;
    const r = await rpc.call('getSlot', async () => {
      if (n++ === 0) throw new Error('connection refused');
      return 42;
    });
    expect(r).toBe(42);
    expect(rpc.endpointName).toBe('backup');
  });

  it('token bucket limits throughput', async () => {
    const rl = new RateLimiter(20, 1);
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 5 }, () => rl.acquire()));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });
});

describe('DexScreener parsing', () => {
  it('prefers the SOL PumpSwap pair and ignores other quotes/chains', () => {
    const m = DexScreenerClient.parsePairs(
      [MINT],
      [
        { chainId: 'solana', dexId: 'raydium', pairAddress: 'r', baseToken: { address: MINT }, quoteToken: { address: 'So11111111111111111111111111111111111111112' }, liquidity: { usd: 99999 } },
        { chainId: 'solana', dexId: 'pumpswap', pairAddress: 'p', baseToken: { address: MINT }, quoteToken: { address: 'So11111111111111111111111111111111111111112' }, priceNative: '0.0000001', liquidity: { usd: 100 }, volume: { h1: 5 } },
        { chainId: 'solana', dexId: 'pumpswap', pairAddress: 'u', baseToken: { address: MINT }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
        { chainId: 'base', dexId: 'pumpswap', pairAddress: 'b', baseToken: { address: MINT }, quoteToken: { address: 'So11111111111111111111111111111111111111112' } },
      ],
    );
    const s = m.get(MINT)!;
    expect(s.pairAddress).toBe('p');
    expect(s.priceNative).toBe(1e-7);
    expect(s.volume.h24).toBeNull(); // missing fields stay unavailable, never invented
  });
});

describe('token registry', () => {
  it('deduplicates trades from overlapping sources', () => {
    const r = new TokenRegistry();
    const e = trade({ ts: 1000, side: 'buy', sol: 1, signature: 'S1', trader: 'w1' });
    expect(r.applyTrade(e)).toBe(true);
    expect(r.applyTrade({ ...e })).toBe(false);
    expect(r.applyTrade({ ...e, source: 'pumpportal', eventIndex: 1000 })).toBe(false);
    expect(r.get(MINT)!.trades.length).toBe(1);
  });

  it('curve invariant check tolerates trades in between but catches wrong data', () => {
    const a = curveState(30);
    const later = applyBuy(a, quoteBuy(a, 5e9));
    expect(curveInvariantMismatchPct(a, later)).toBeLessThan(0.01);
    expect(curveInvariantMismatchPct(a, { ...later, quoteReserve: later.quoteReserve * 1.2 })).toBeGreaterThan(5);
  });

  it('evicts idle tokens but keeps pinned ones (open positions)', () => {
    const r = new TokenRegistry();
    r.applyTrade(trade({ ts: 0, side: 'buy', sol: 1, mint: 'A', signature: 'a' }));
    r.applyTrade(trade({ ts: 0, side: 'buy', sol: 1, mint: 'B', signature: 'b' }));
    r.get('B')!.pinned = true;
    expect(r.evict(10_000_000, 60_000)).toEqual(['A']);
    expect(r.get('B')).toBeDefined();
  });
});
