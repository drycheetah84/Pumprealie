import type { Venue } from '../../shared/types';

/** A single executed trade observed on-chain (or from a provider that mirrors on-chain events). */
export interface TradeEvent {
  mint: string;
  signature: string;
  eventIndex: number;
  slot: number | null;
  /** Milliseconds since epoch. On-chain event timestamps have 1s resolution. */
  ts: number;
  side: 'buy' | 'sell';
  solLamports: number;
  tokenAmount: number;
  trader: string;
  venue: Venue;
  /** Price-setting reserves after the trade (virtual for the curve, effective for pools). */
  vSol: number | null;
  vToken: number | null;
  /** Withdrawable reserves after the trade. */
  realSol: number | null;
  realToken: number | null;
  feeLamports: number | null;
  feeBps: number | null;
  quoteMint: string;
  creator: string | null;
  source: string;
}

export interface CreateEvent {
  mint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  creator: string | null;
  createdAt: number;
  signature: string | null;
  tokenProgram: string | null;
  quoteMint: string | null;
  isMayhem: boolean;
  isCashback: boolean;
  vSol: number | null;
  vToken: number | null;
  realToken: number | null;
  totalSupply: number | null;
  source: string;
}

export interface MigrationEvent {
  mint: string;
  at: number;
  signature: string | null;
  kind: 'complete' | 'migrated';
  pool: string | null;
  source: string;
}

export interface DexSnapshot {
  fetchedAt: number;
  source: 'dexscreener';
  pairAddress: string;
  dexId: string;
  priceNative: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  liquidityQuote: number | null;
  fdv: number | null;
  marketCap: number | null;
  volume: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  txns: { m5: { buys: number; sells: number } | null; h1: { buys: number; sells: number } | null };
  priceChange: { m5: number | null; h1: number | null };
  pairCreatedAt: number | null;
}

export const SOL_QUOTE_MINTS = new Set([
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
]);

export const isSolQuote = (quoteMint: string | null | undefined): boolean =>
  quoteMint !== null && quoteMint !== undefined && SOL_QUOTE_MINTS.has(quoteMint);
