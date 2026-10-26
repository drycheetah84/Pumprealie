import type { Logger } from 'pino';
import type { ProviderHealthMonitor } from '../providerHealth';
import type { CreateEvent, MigrationEvent, TradeEvent } from '../types';
import { ReconnectingWs } from './reconnectingWs';

/**
 * PumpPortal Data API (https://pumpportal.fun/data-api/real-time).
 * Free tier: `subscribeNewToken` and `subscribeMigration` are used as a secondary,
 * independent discovery/migration source. With a funded API key, per-token
 * `subscribeTokenTrade` is also available and used as a redundant trade feed.
 *
 * PumpPortal values (e.g. `vSolInBondingCurve`) are provider-reported; they are never
 * used for pricing without on-chain reconciliation. Note: for curves quoted in assets
 * other than SOL the "SOL" fields are not SOL amounts.
 */
export class PumpPortalClient {
  private ws: ReconnectingWs;
  private tradeKeys = new Set<string>();
  readonly healthName = 'pumpportal';
  readonly tradesEnabled: boolean;

  constructor(
    url: string,
    apiKey: string | undefined,
    private readonly handlers: {
      onCreate: (c: CreateEvent) => void;
      onMigration: (m: MigrationEvent) => void;
      onTrade?: (t: TradeEvent) => void;
    },
    private readonly health: ProviderHealthMonitor,
    private readonly log: Logger,
  ) {
    this.tradesEnabled = Boolean(apiKey);
    const fullUrl = apiKey ? `${url}?api-key=${encodeURIComponent(apiKey)}` : url;
    health.register(this.healthName, { critical: false, downAfterMs: 180_000 });
    this.ws = new ReconnectingWs(
      'pumpportal',
      fullUrl,
      {
        onOpen: () => {
          this.ws.send({ method: 'subscribeNewToken' });
          this.ws.send({ method: 'subscribeMigration' });
          if (this.tradesEnabled && this.tradeKeys.size) this.ws.send({ method: 'subscribeTokenTrade', keys: [...this.tradeKeys] });
        },
        onMessage: (d) => this.onMessage(d),
        onStateChange: (s, detail) => {
          if (s !== 'open') health.failure(this.healthName, `${s}${detail ? `: ${detail}` : ''}`);
        },
      },
      log,
      { silenceTimeoutMs: 120_000 },
    );
  }

  start() {
    this.ws.start();
  }

  stop() {
    this.ws.stop();
  }

  watchTrades(mint: string) {
    if (!this.tradesEnabled || this.tradeKeys.has(mint)) return;
    this.tradeKeys.add(mint);
    this.ws.send({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  unwatchTrades(mint: string) {
    if (!this.tradeKeys.delete(mint)) return;
    this.ws.send({ method: 'unsubscribeTokenTrade', keys: [mint] });
  }

  private onMessage(raw: string) {
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (typeof m.message === 'string') {
      if (/only available|error|invalid/i.test(m.message)) this.health.failure(this.healthName, m.message);
      else this.health.success(this.healthName, null, m.message);
      return;
    }
    const txType = m.txType as string | undefined;
    const mint = m.mint as string | undefined;
    if (!mint) return;
    this.health.success(this.healthName, null, this.tradesEnabled ? 'discovery + trades' : 'discovery + migrations (no API key: trades via RPC only)');
    if (txType === 'create') {
      this.handlers.onCreate({
        mint,
        name: (m.name as string) ?? null,
        symbol: (m.symbol as string) ?? null,
        uri: (m.uri as string) ?? null,
        creator: (m.traderPublicKey as string) ?? null,
        createdAt: Date.now(),
        signature: (m.signature as string) ?? null,
        tokenProgram: null,
        quoteMint: null, // not reported reliably; resolved on-chain
        isMayhem: Boolean(m.is_mayhem_mode),
        isCashback: false,
        vSol: null,
        vToken: null,
        realToken: null,
        totalSupply: null,
        source: 'pumpportal',
      });
    } else if (txType === 'migrate' || m.pool === 'pump-amm') {
      this.handlers.onMigration({
        mint,
        at: Date.now(),
        signature: (m.signature as string) ?? null,
        kind: 'migrated',
        pool: null,
        source: 'pumpportal',
      });
    } else if ((txType === 'buy' || txType === 'sell') && this.handlers.onTrade) {
      const sol = Number(m.solAmount ?? 0);
      this.handlers.onTrade({
        mint,
        signature: String(m.signature ?? ''),
        eventIndex: 1000, // distinct from on-chain indices; dedup is by signature+side+amount in the registry
        slot: null,
        ts: Date.now(),
        side: txType,
        solLamports: Math.round(sol * 1e9),
        tokenAmount: Math.round(Number(m.tokenAmount ?? 0) * 1e6),
        trader: String(m.traderPublicKey ?? ''),
        venue: m.pool === 'pump' ? 'bonding_curve' : 'pumpswap',
        vSol: m.vSolInBondingCurve !== undefined ? Math.round(Number(m.vSolInBondingCurve) * 1e9) : null,
        vToken: m.vTokensInBondingCurve !== undefined ? Math.round(Number(m.vTokensInBondingCurve) * 1e6) : null,
        realSol: null,
        realToken: null,
        feeLamports: null,
        feeBps: null,
        quoteMint: '11111111111111111111111111111111',
        creator: null,
        source: 'pumpportal',
      });
    }
  }
}
