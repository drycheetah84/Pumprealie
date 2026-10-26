import type { Logger } from 'pino';
import type { Env } from '../config/env';
import type { Store, TradeRow } from '../db/store';
import { errMsg } from '../lib/util';
import { spotPriceSol } from './liquidity';
import { DexScreenerClient } from './providers/dexScreener';
import { OnchainInspector } from './providers/onchain';
import { PumpLogStream } from './providers/pumpLogStream';
import { PumpPortalClient } from './providers/pumpPortal';
import { RpcRateLimitError, type SolanaRpc } from './providers/solanaRpc';
import type { ProviderHealthMonitor } from './providerHealth';
import { TokenRegistry, type TokenState } from './tokenRegistry';
import { isSolQuote, type CreateEvent, type MigrationEvent, type TradeEvent } from './types';

export interface MarketEngineOptions {
  env: Env;
  rpc: SolanaRpc;
  store: Store;
  health: ProviderHealthMonitor;
  log: Logger;
}

/**
 * Orchestrates live market data: on-chain log stream (primary), PumpPortal (secondary
 * discovery), periodic on-chain reconciliation of curve/pool state, enrichment of the most
 * active candidates (mint authorities, holders, creator activity), and DexScreener stats.
 */
export class MarketEngine {
  readonly registry: TokenRegistry;
  readonly onchain: OnchainInspector;
  readonly dex: DexScreenerClient;
  private stream: PumpLogStream | null = null;
  private portal: PumpPortalClient | null = null;
  private timers: NodeJS.Timeout[] = [];
  private pendingTrades: TradeRow[] = [];
  private enrichInFlight = new Set<string>();
  private running = false;
  /** Mints the trading engine wants refreshed with priority (open positions, candidates). */
  private priority = new Set<string>();
  stats = { tradesSeen: 0, tradesPersisted: 0, createsSeen: 0, migrations: 0, reconciliations: 0, enrichments: 0 };

  constructor(private readonly o: MarketEngineOptions) {
    this.registry = new TokenRegistry(o.env.MAX_TRACKED_TOKENS);
    this.onchain = new OnchainInspector(o.rpc);
    this.dex = new DexScreenerClient(o.env.DEXSCREENER_BASE_URL, o.health, o.log, o.env.DEXSCREENER_ENABLED);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const { env, health, log } = this.o;
    if (env.ONCHAIN_STREAM_ENABLED) {
      this.stream = new PumpLogStream(
        env.wsUrl,
        {
          onTrades: (t) => t.forEach((e) => this.onTrade(e)),
          onCreates: (c) => c.forEach((e) => this.onCreate(e)),
          onMigrations: (m) => m.forEach((e) => this.onMigration(e)),
        },
        health,
        log,
      );
      this.stream.start();
    }
    if (env.PUMPPORTAL_ENABLED) {
      this.portal = new PumpPortalClient(
        env.PUMPPORTAL_WS_URL,
        env.PUMPPORTAL_API_KEY,
        { onCreate: (c) => this.onCreate(c), onMigration: (m) => this.onMigration(m), onTrade: (t) => this.onTrade(t) },
        health,
        log,
      );
      this.portal.start();
    }
    this.onchain.protocol().catch((e) => log.warn({ err: errMsg(e) }, 'initial protocol fetch failed'));
    this.every(1000, () => this.flush());
    this.every(4000, () => this.reconcileLoop());
    this.every(1500, () => this.enrichLoop());
    this.every(30_000, () => this.dexLoop());
    this.every(60_000, () => this.evict());
  }

  async stop() {
    this.running = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.stream?.stop();
    this.portal?.stop();
    this.flush();
  }

  private every(ms: number, fn: () => unknown) {
    let busy = false;
    this.timers.push(
      setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          await fn();
        } catch (e) {
          this.o.log.warn({ err: errMsg(e) }, 'market loop error');
        } finally {
          busy = false;
        }
      }, ms),
    );
  }

  pin(mint: string, pinned: boolean) {
    const t = this.registry.get(mint);
    if (t) t.pinned = pinned;
    if (pinned) this.priority.add(mint);
    else this.priority.delete(mint);
  }

  prioritize(mints: string[]) {
    for (const m of mints) this.priority.add(m);
  }

  get streamStats() {
    return { ...this.stream?.stats, lastMessageAt: this.stream?.lastMessageAt ?? null, pools: this.stream?.watchedPools ?? 0 };
  }

  /** Most recent time any market data arrived. */
  get lastDataAt(): number {
    return this.stream?.lastMessageAt ?? 0;
  }

  // ---------------------------------------------------------------------------------
  private onCreate(c: CreateEvent) {
    this.stats.createsSeen++;
    const t = this.registry.applyCreate(c);
    if (c.source === 'solana-rpc-logs' && c.creator) this.o.store.recordCreatorLaunch(c.creator, c.createdAt);
    this.persistToken(t, c.source);
  }

  private onTrade(e: TradeEvent) {
    this.stats.tradesSeen++;
    if (!this.registry.applyTrade(e)) return;
    const t = this.registry.get(e.mint)!;
    if (!isSolQuote(e.quoteMint) && e.source === 'solana-rpc-logs') return; // tracked but not recorded
    if (this.o.env.RECORD_ALL_TRADES || t.pinned) {
      this.pendingTrades.push({
        mint: e.mint,
        signature: e.signature,
        eventIndex: e.eventIndex,
        slot: e.slot,
        ts: e.ts,
        side: e.side,
        solLamports: e.solLamports,
        tokenAmount: String(e.tokenAmount),
        trader: e.trader,
        venue: e.venue,
        vSol: e.vSol,
        vToken: e.vToken === null ? null : String(e.vToken),
        realSol: e.realSol,
        realToken: e.realToken === null ? null : String(e.realToken),
        feeLamports: e.feeLamports,
        source: e.source,
      });
    }
  }

  private onMigration(m: MigrationEvent) {
    this.stats.migrations++;
    const t = this.registry.applyMigration(m);
    if (t.creator && m.kind === 'complete') this.o.store.recordCreatorGraduation(t.creator);
    this.persistToken(t, m.source);
    // Resolve the pool shortly after; the migration transaction may land a few slots later.
    setTimeout(() => this.resolvePool(t).catch(() => undefined), 8000);
  }

  private async resolvePool(t: TokenState) {
    const p = await this.onchain.fetchPool(t.mint);
    if (!p) return;
    t.pool = p.pool;
    t.poolBaseVault = p.baseVault;
    t.venue = 'pumpswap';
    t.complete = true;
    this.registry.applyRpcLiquidity(t, p.liquidity, Date.now());
    if (t.pinned || this.priority.has(t.mint)) this.stream?.watchPool(p.pool, t.mint);
    this.persistToken(t, 'solana-rpc');
  }

  private persistToken(t: TokenState, source: string) {
    try {
      this.o.store.upsertToken({
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        uri: t.uri,
        creator: t.creator,
        createdAt: t.createdAt,
        createSignature: t.createSignature,
        tokenProgram: t.tokenProgram,
        quoteMint: t.quoteMint,
        isMayhem: t.isMayhem,
        venue: t.venue,
        complete: t.complete,
        graduatedAt: t.completedAt,
        pool: t.pool,
        firstSeenAt: t.firstSeenAt,
        lastSeenAt: t.lastEventAt,
        source,
      });
    } catch (e) {
      this.o.log.warn({ err: errMsg(e), mint: t.mint }, 'persist token failed');
    }
  }

  /** Persist buffered trades and candles in one transaction. */
  flush() {
    if (!this.pendingTrades.length) return;
    const batch = this.pendingTrades;
    this.pendingTrades = [];
    try {
      const store = this.o.store;
      store.db.transaction(() => {
        const n = store.insertTrades(batch);
        this.stats.tradesPersisted += n;
        const seenTokens = new Set<string>();
        for (const r of batch) {
          const price = r.vSol && r.vToken ? spotPriceSol({ quoteReserve: r.vSol, baseReserve: Number(r.vToken) }) : Number(r.tokenAmount) > 0 ? r.solLamports / 1e9 / (Number(r.tokenAmount) / 1e6) : null;
          if (price) store.upsertCandle({ mint: r.mint, minute: Math.floor(r.ts / 60_000), price, volumeSol: r.solLamports / 1e9, side: r.side, realSol: r.realSol === null ? null : r.realSol / 1e9 });
          if (!seenTokens.has(r.mint)) {
            seenTokens.add(r.mint);
            const t = this.registry.get(r.mint);
            if (t && !store.getToken(r.mint)) this.persistToken(t, r.source);
          }
        }
      })();
    } catch (e) {
      this.o.log.error({ err: errMsg(e) }, 'trade flush failed');
    }
  }

  /** Tokens with recent SOL-quoted activity, most active first. */
  activeTokens(now: number, windowMs = 120_000, limit = 100): TokenState[] {
    const scored: Array<{ t: TokenState; v: number }> = [];
    for (const t of this.registry.tokens.values()) {
      if (now - t.lastEventAt > windowMs) continue;
      if (t.quoteVerified && !isSolQuote(t.quoteMint)) continue;
      let v = 0;
      const arr = t.trades.toArray();
      for (let i = arr.length - 1; i >= 0 && arr[i]!.ts >= now - windowMs; i--) v += arr[i]!.solLamports;
      scored.push({ t, v });
    }
    return scored.sort((a, b) => b.v - a.v).slice(0, limit).map((x) => x.t);
  }

  private async reconcileLoop() {
    const now = Date.now();
    const pri = [...this.priority].map((m) => this.registry.get(m)).filter((t): t is TokenState => Boolean(t));
    const active = this.activeTokens(now, 120_000, 100);
    const set = new Map<string, TokenState>();
    for (const t of [...pri, ...active]) set.set(t.mint, t);
    const curveMints = [...set.values()].filter((t) => t.venue === 'bonding_curve').map((t) => t.mint);
    if (curveMints.length) {
      const res = await this.onchain.fetchCurves(curveMints.slice(0, 200));
      const at = Date.now();
      for (const [mint, snap] of res) {
        const t = this.registry.get(mint);
        if (!t) continue;
        this.stats.reconciliations++;
        if (!snap) {
          this.registry.applyRpcLiquidity(t, null, at);
          continue;
        }
        t.quoteMint = snap.quoteMint;
        t.quoteVerified = true;
        t.isMayhem = snap.isMayhem;
        t.isCashback = snap.isCashback;
        if (!t.creator) t.creator = snap.curve.creator.toBase58();
        if (snap.complete) {
          if (!t.complete) this.onMigration({ mint, at, signature: null, kind: 'complete', pool: null, source: 'solana-rpc' });
          t.rpcCheckedAt = at;
          continue;
        }
        this.registry.applyRpcLiquidity(t, snap.liquidity, at);
      }
    }
    // Mint accounts (authorities, extensions, metadata) in batches; refreshed every 10 minutes.
    const needMint = [...set.values()].filter((t) => !t.mintInfo || Date.now() - t.mintInfo.fetchedAt > 600_000).map((t) => t.mint);
    if (needMint.length) {
      const infos = await this.onchain.fetchMintInfos(needMint.slice(0, 200));
      for (const [mint, mi] of infos) {
        const t = this.registry.get(mint);
        if (!t || !mi) continue;
        const { name, symbol, ...info } = mi;
        t.mintInfo = info;
        t.tokenProgram = info.tokenProgram;
        if (!t.name && name) t.name = name;
        if (!t.symbol && symbol) t.symbol = symbol;
        this.o.store.addSnapshot(mint, 'mint', info.source, info, info.fetchedAt);
      }
    }
    // Graduated tokens: pool reads are per-token; limit to priority + a few active ones.
    const pools = [...set.values()].filter((t) => t.venue === 'pumpswap').slice(0, 10);
    for (const t of pools) {
      const p = await this.onchain.fetchPool(t.mint).catch(() => null);
      if (p) {
        t.pool = p.pool;
        t.poolBaseVault = p.baseVault;
        this.registry.applyRpcLiquidity(t, p.liquidity, Date.now());
        if (t.pinned || this.priority.has(t.mint)) this.stream?.watchPool(p.pool, t.mint);
      } else this.registry.applyRpcLiquidity(t, null, Date.now());
    }
  }

  /**
   * Enrich the most promising tokens with mint authorities, holders and creator activity.
   * Budgeted to stay within public RPC limits; missing enrichment is treated as risk, not safety.
   */
  private async enrichLoop() {
    const now = Date.now();
    const pri = [...this.priority].map((m) => this.registry.get(m)).filter((t): t is TokenState => Boolean(t));
    const cands = [...pri, ...this.activeTokens(now, 120_000, 25)];
    for (const t of cands) {
      if (this.enrichInFlight.has(t.mint)) continue;
      if (t.quoteVerified && !isSolQuote(t.quoteMint)) continue;
      const needMint = !t.mintInfo || now - t.mintInfo.fetchedAt > 600_000;
      const holdersAge = t.holders ? now - t.holders.fetchedAt : Infinity;
      const wantsHolders =
        (this.priority.has(t.mint) || (t.lastAssessment?.summary.action ?? 'skip') !== 'skip' || (t.lastAssessment?.opportunity.score ?? 0) >= 40) &&
        holdersAge > 60_000 &&
        (!t.holdersAttemptedAt || now - t.holdersAttemptedAt > 30_000);
      const needCreator = Boolean(t.creator) && !t.creatorActivity && (t.lastAssessment?.opportunity.score ?? 0) >= 40;
      if (!needMint && !wantsHolders && !needCreator) continue;
      this.enrichInFlight.add(t.mint);
      try {
        if (needMint) {
          const mi = await this.onchain.fetchMintInfo(t.mint);
          if (mi) {
            t.mintInfo = mi;
            t.tokenProgram = mi.tokenProgram;
            this.o.store.addSnapshot(t.mint, 'mint', mi.source, mi, mi.fetchedAt);
          }
        }
        if (wantsHolders && !this.o.rpc.isCoolingDown('getTokenLargestAccounts')) {
          t.holdersAttemptedAt = now;
          const h = await this.onchain.fetchHolders(t.mint, {
            creator: t.creator,
            poolBaseVault: t.poolBaseVault,
            poolAddress: t.pool,
            supplyRaw: t.mintInfo?.supplyRaw ?? '1000000000000000',
          });
          t.holders = h;
          this.o.store.addSnapshot(t.mint, 'holders', h.source, h, h.fetchedAt);
        }
        if (needCreator && t.creator) {
          const a = await this.onchain.recentActivity(t.creator);
          t.creatorActivity = { ...a, fetchedAt: Date.now() };
        }
        this.stats.enrichments++;
      } catch (e) {
        if (!(e instanceof RpcRateLimitError)) this.o.log.debug({ err: errMsg(e), mint: t.mint }, 'enrichment failed');
      } finally {
        this.enrichInFlight.delete(t.mint);
      }
      return; // one token per tick keeps RPC usage bounded
    }
  }

  private async dexLoop() {
    const now = Date.now();
    const mints = [
      ...new Set([
        ...[...this.priority],
        ...this.activeTokens(now, 300_000, 60)
          .filter((t) => t.venue === 'pumpswap' || (t.lastAssessment?.opportunity.score ?? 0) >= 30)
          .map((t) => t.mint),
      ]),
    ].slice(0, 60);
    if (!mints.length) return;
    const res = await this.dex.fetchTokens(mints);
    for (const [mint, snap] of res) {
      const t = this.registry.get(mint);
      if (t) t.dex = snap;
    }
  }

  private evict() {
    const evicted = this.registry.evict(Date.now(), 30 * 60_000);
    for (const m of evicted) {
      this.priority.delete(m);
      this.portal?.unwatchTrades(m);
    }
  }
}
