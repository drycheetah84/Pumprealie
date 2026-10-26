import type { Logger } from 'pino';
import { errMsg, RateLimiter } from '../../lib/util';
import type { ProviderHealthMonitor } from '../providerHealth';
import type { DexSnapshot } from '../types';

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string };
  quoteToken: { address: string };
  priceNative?: string;
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: { m5?: { buys: number; sells: number }; h1?: { buys: number; sells: number } };
  priceChange?: { m5?: number; h1?: number };
  pairCreatedAt?: number;
}

const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * DexScreener public API (https://docs.dexscreener.com/api/reference):
 * `GET /tokens/v1/{chainId}/{tokenAddresses}` — up to 30 addresses, 300 requests/min.
 * Used for aggregated volume/liquidity on graduated tokens and as a cross-check.
 */
export class DexScreenerClient {
  private limiter = new RateLimiter(4, 4);
  readonly healthName = 'dexscreener';

  constructor(
    private readonly baseUrl: string,
    private readonly health: ProviderHealthMonitor,
    private readonly log: Logger,
    enabled = true,
  ) {
    health.register(this.healthName, { enabled, critical: false, downAfterMs: 300_000 });
  }

  static parsePairs(mints: string[], pairs: DexPair[], at = Date.now()): Map<string, DexSnapshot> {
    const out = new Map<string, DexSnapshot>();
    const want = new Set(mints);
    const ranks = new Map<string, number>();
    // Prefer SOL-quoted PumpSwap pairs, then the Pump bonding-curve pair, then highest liquidity.
    const rank = (p: DexPair) => (p.dexId === 'pumpswap' ? 3 : p.dexId === 'pumpfun' ? 2 : 1) * 1e12 + (p.liquidity?.usd ?? 0);
    for (const p of pairs) {
      if (p.chainId !== 'solana' || !want.has(p.baseToken.address)) continue;
      if (p.quoteToken.address !== WSOL) continue;
      const r = rank(p);
      if ((ranks.get(p.baseToken.address) ?? -1) >= r) continue;
      ranks.set(p.baseToken.address, r);
      const n = (v: unknown) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
      out.set(p.baseToken.address, {
        fetchedAt: at,
        source: 'dexscreener',
        pairAddress: p.pairAddress,
        dexId: p.dexId,
        priceNative: n(p.priceNative),
        priceUsd: n(p.priceUsd),
        liquidityUsd: n(p.liquidity?.usd),
        liquidityQuote: n(p.liquidity?.quote),
        fdv: n(p.fdv),
        marketCap: n(p.marketCap),
        volume: { m5: n(p.volume?.m5), h1: n(p.volume?.h1), h6: n(p.volume?.h6), h24: n(p.volume?.h24) },
        txns: { m5: p.txns?.m5 ?? null, h1: p.txns?.h1 ?? null },
        priceChange: { m5: n(p.priceChange?.m5), h1: n(p.priceChange?.h1) },
        pairCreatedAt: n(p.pairCreatedAt),
      });
    }
    return out;
  }

  async fetchTokens(mints: string[]): Promise<Map<string, DexSnapshot>> {
    const out = new Map<string, DexSnapshot>();
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      await this.limiter.acquire();
      const started = Date.now();
      try {
        const res = await fetch(`${this.baseUrl}/tokens/v1/solana/${chunk.join(',')}`, {
          signal: AbortSignal.timeout(10_000),
          headers: { accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as DexPair[];
        for (const [k, v] of DexScreenerClient.parsePairs(chunk, Array.isArray(body) ? body : [])) out.set(k, v);
        this.health.success(this.healthName, Date.now() - started, `${out.size} pairs`);
      } catch (e) {
        this.health.failure(this.healthName, errMsg(e));
        this.log.warn({ err: errMsg(e) }, 'dexscreener fetch failed');
      }
    }
    return out;
  }
}
