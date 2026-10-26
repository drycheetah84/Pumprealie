import type { HolderSnapshot, MintInfo, TokenAssessment, Venue } from '../../shared/types';
import { Ring } from '../lib/util';
import { spotPriceSol, type LiquidityState } from './liquidity';
import { isSolQuote, type CreateEvent, type DexSnapshot, type MigrationEvent, type TradeEvent } from './types';

export interface LiquidityPoint {
  ts: number;
  realSol: number;
  priceSol: number | null;
}

export interface TokenState {
  mint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  creator: string | null;
  createdAt: number | null;
  /** True when we observed the create event, i.e. our trade history starts at launch. */
  observedFromLaunch: boolean;
  createSignature: string | null;
  tokenProgram: string | null;
  quoteMint: string | null;
  quoteVerified: boolean;
  isMayhem: boolean;
  isCashback: boolean;
  venue: Venue;
  complete: boolean;
  completedAt: number | null;
  pool: string | null;
  poolBaseVault: string | null;
  firstSeenAt: number;
  lastEventAt: number;
  sources: Set<string>;

  /** Latest liquidity state and where it came from. */
  liquidity: LiquidityState | null;
  /** Last authoritative on-chain read (used for reconciliation). */
  rpcLiquidity: LiquidityState | null;
  rpcCheckedAt: number | null;
  rpcMissing: boolean;
  /** Largest relative price disagreement between event-derived and RPC state (pct). */
  inconsistencyPct: number | null;
  feeBps: number | null;

  trades: Ring<TradeEvent>;
  liquidityHistory: Ring<LiquidityPoint>;
  seenTrades: Set<string>;
  /** Net raw token flow per trader since we started observing (buy +, sell -). */
  flows: Map<string, number>;
  creatorBoughtTokens: number;
  creatorSoldTokens: number;
  creatorSolIn: number;
  creatorSolOut: number;

  mintInfo: MintInfo | null;
  holders: HolderSnapshot | null;
  holdersAttemptedAt: number | null;
  dex: DexSnapshot | null;
  creatorActivity: { txLastHour: number; sampled: number; fetchedAt: number } | null;

  lastAssessment: TokenAssessment | null;
  pinned: boolean;
}

const TRADE_CAPACITY = 3000;

/**
 * Timing-independent consistency check between two observations of the same bonding curve.
 * Between trades the constant product k = vSol·vToken is (up to rounding) invariant, and the
 * virtual−real offsets of both reserves never change. Disagreement means one source is wrong.
 */
export function curveInvariantMismatchPct(a: LiquidityState, b: LiquidityState): number {
  const k1 = a.baseReserve * a.quoteReserve;
  const k2 = b.baseReserve * b.quoteReserve;
  if (!(k1 > 0 && k2 > 0)) return 100;
  const kDiff = Math.abs(k1 - k2) / k2;
  const solOffsetDiff = Math.abs(a.quoteReserve - a.realQuoteReserve - (b.quoteReserve - b.realQuoteReserve)) / b.quoteReserve;
  const tokOffsetDiff = Math.abs(a.baseReserve - a.realBaseReserve - (b.baseReserve - b.realBaseReserve)) / b.baseReserve;
  return Math.max(kDiff, solOffsetDiff, tokOffsetDiff) * 100;
}
const LIQ_CAPACITY = 600;

export function newTokenState(mint: string, at: number): TokenState {
  return {
    mint,
    name: null,
    symbol: null,
    uri: null,
    creator: null,
    createdAt: null,
    observedFromLaunch: false,
    createSignature: null,
    tokenProgram: null,
    quoteMint: null,
    quoteVerified: false,
    isMayhem: false,
    isCashback: false,
    venue: 'bonding_curve',
    complete: false,
    completedAt: null,
    pool: null,
    poolBaseVault: null,
    firstSeenAt: at,
    lastEventAt: at,
    sources: new Set(),
    liquidity: null,
    rpcLiquidity: null,
    rpcCheckedAt: null,
    rpcMissing: false,
    inconsistencyPct: null,
    feeBps: null,
    trades: new Ring(TRADE_CAPACITY),
    liquidityHistory: new Ring(LIQ_CAPACITY),
    seenTrades: new Set(),
    flows: new Map(),
    creatorBoughtTokens: 0,
    creatorSoldTokens: 0,
    creatorSolIn: 0,
    creatorSolOut: 0,
    mintInfo: null,
    holders: null,
    holdersAttemptedAt: null,
    dex: null,
    creatorActivity: null,
    lastAssessment: null,
    pinned: false,
  };
}

/**
 * In-memory rolling market state per token. Pure state transitions (no I/O) so the
 * same code drives live monitoring and historical replay.
 */
export class TokenRegistry {
  readonly tokens = new Map<string, TokenState>();

  constructor(private readonly maxTokens = 3000) {}

  get(mint: string): TokenState | undefined {
    return this.tokens.get(mint);
  }

  ensure(mint: string, at: number): TokenState {
    let t = this.tokens.get(mint);
    if (!t) {
      t = newTokenState(mint, at);
      this.tokens.set(mint, t);
    }
    return t;
  }

  applyCreate(c: CreateEvent): TokenState {
    const t = this.ensure(c.mint, c.createdAt);
    t.name = c.name ?? t.name;
    t.symbol = c.symbol ?? t.symbol;
    t.uri = c.uri ?? t.uri;
    t.creator = t.creator ?? c.creator;
    t.isMayhem = t.isMayhem || c.isMayhem;
    t.isCashback = t.isCashback || c.isCashback;
    t.sources.add(c.source);
    if (c.source === 'solana-rpc-logs') {
      t.createdAt = c.createdAt;
      t.observedFromLaunch = t.trades.length === 0 || t.observedFromLaunch;
      t.createSignature = c.signature;
      t.tokenProgram = c.tokenProgram;
      t.quoteMint = c.quoteMint;
      t.quoteVerified = true;
      if (c.vSol && c.vToken && c.realToken !== null) {
        this.setLiquidity(t, {
          venue: 'bonding_curve',
          baseReserve: c.vToken,
          quoteReserve: c.vSol,
          realBaseReserve: c.realToken,
          realQuoteReserve: 0,
          feeBps: t.feeBps ?? 125,
          observedAt: c.createdAt,
          source: 'event:create',
          slot: null,
        });
      }
    } else {
      t.createdAt = t.createdAt ?? c.createdAt;
      t.createSignature = t.createSignature ?? c.signature;
    }
    return t;
  }

  /** Returns false if the trade was a duplicate. */
  applyTrade(e: TradeEvent): boolean {
    const t = this.ensure(e.mint, e.ts);
    const key = e.source === 'pumpportal' ? `${e.signature}:${e.side}:${e.trader}` : `${e.signature}:${e.eventIndex}`;
    const altKey = `${e.signature}:${e.side}:${e.trader}`;
    if (t.seenTrades.has(key) || t.seenTrades.has(altKey)) return false;
    t.seenTrades.add(key);
    t.seenTrades.add(altKey);
    if (t.seenTrades.size > TRADE_CAPACITY * 4) t.seenTrades = new Set([...t.seenTrades].slice(-TRADE_CAPACITY * 2));

    t.sources.add(e.source);
    t.lastEventAt = Math.max(t.lastEventAt, e.ts);
    if (!t.quoteMint && e.source === 'solana-rpc-logs') {
      t.quoteMint = e.quoteMint;
      t.quoteVerified = true;
    }
    if (!t.creator && e.creator && e.venue === 'bonding_curve') t.creator = e.creator;
    if (e.feeBps && e.source === 'solana-rpc-logs') t.feeBps = e.feeBps;
    if (e.venue === 'pumpswap' && t.venue !== 'pumpswap') {
      t.venue = 'pumpswap';
      t.complete = true;
    }
    t.trades.push(e);

    const signed = e.side === 'buy' ? e.tokenAmount : -e.tokenAmount;
    t.flows.set(e.trader, (t.flows.get(e.trader) ?? 0) + signed);
    if (t.flows.size > 5000) {
      // keep the largest holders only
      t.flows = new Map([...t.flows.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2500));
    }
    if (t.creator && e.trader === t.creator) {
      if (e.side === 'buy') {
        t.creatorBoughtTokens += e.tokenAmount;
        t.creatorSolIn += e.solLamports;
      } else {
        t.creatorSoldTokens += e.tokenAmount;
        t.creatorSolOut += e.solLamports;
      }
    }

    if (e.venue === 'bonding_curve' && e.vSol !== null && e.vToken !== null && e.source === 'solana-rpc-logs') {
      this.setLiquidity(t, {
        venue: 'bonding_curve',
        baseReserve: e.vToken,
        quoteReserve: e.vSol,
        realBaseReserve: e.realToken ?? t.liquidity?.realBaseReserve ?? 0,
        realQuoteReserve: e.realSol ?? t.liquidity?.realQuoteReserve ?? 0,
        feeBps: t.feeBps ?? 125,
        observedAt: e.ts,
        source: 'event:trade',
        slot: e.slot,
      });
    } else {
      const p = e.tokenAmount > 0 ? e.solLamports / 1e9 / (e.tokenAmount / 1e6) : null;
      t.liquidityHistory.push({ ts: e.ts, realSol: (t.liquidity?.realQuoteReserve ?? 0) / 1e9, priceSol: p });
    }
    return true;
  }

  applyMigration(m: MigrationEvent): TokenState {
    const t = this.ensure(m.mint, m.at);
    t.complete = true;
    t.completedAt = t.completedAt ?? m.at;
    t.sources.add(m.source);
    if (m.kind === 'migrated') t.venue = 'pumpswap';
    if (m.pool) t.pool = m.pool;
    return t;
  }

  setLiquidity(t: TokenState, l: LiquidityState) {
    if (t.liquidity && l.observedAt < t.liquidity.observedAt && l.source.startsWith('event')) return;
    t.liquidity = l;
    t.liquidityHistory.push({ ts: l.observedAt, realSol: l.realQuoteReserve / 1e9, priceSol: spotPriceSol(l) });
  }

  /** Apply an authoritative RPC read and measure disagreement with event-derived state. */
  applyRpcLiquidity(t: TokenState, l: LiquidityState | null, at: number) {
    t.rpcCheckedAt = at;
    if (!l) {
      t.rpcMissing = true;
      return;
    }
    t.rpcMissing = false;
    const prev = t.liquidity;
    if (t.isMayhem) {
      // Mayhem-mode curves have their virtual reserves adjusted by the protocol outside of
      // trades, so neither invariant nor timing comparisons are meaningful.
      t.inconsistencyPct = null;
    } else if (prev && prev.venue === l.venue && prev.venue === 'bonding_curve' && prev.source.startsWith('event')) {
      t.inconsistencyPct = curveInvariantMismatchPct(prev, l);
    } else if (prev && prev.venue === l.venue && Math.abs(at - prev.observedAt) < 2_000) {
      const p1 = spotPriceSol(prev);
      const p2 = spotPriceSol(l);
      t.inconsistencyPct = p1 && p2 ? (Math.abs(p1 - p2) / p2) * 100 : null;
    }
    t.rpcLiquidity = l;
    t.feeBps = l.feeBps;
    if (!prev || l.observedAt >= prev.observedAt || prev.venue !== l.venue) this.setLiquidity(t, l);
  }

  isTradableQuote(t: TokenState): boolean {
    return t.quoteVerified && isSolQuote(t.quoteMint);
  }

  /** Evict inactive, unpinned tokens beyond capacity or idle for `idleMs`. */
  evict(at: number, idleMs: number): string[] {
    const evicted: string[] = [];
    for (const [mint, t] of this.tokens) {
      if (t.pinned) continue;
      if (at - t.lastEventAt > idleMs) {
        this.tokens.delete(mint);
        evicted.push(mint);
      }
    }
    if (this.tokens.size > this.maxTokens) {
      const victims = [...this.tokens.values()]
        .filter((t) => !t.pinned)
        .sort((a, b) => a.lastEventAt - b.lastEventAt)
        .slice(0, this.tokens.size - this.maxTokens);
      for (const v of victims) {
        this.tokens.delete(v.mint);
        evicted.push(v.mint);
      }
    }
    return evicted;
  }
}
