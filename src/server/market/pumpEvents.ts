import { PUMP_SDK } from '@pump-fun/pump-sdk';
import type { CreateEvent, MigrationEvent, TradeEvent } from './types';

/** Anchor event discriminators (sha256("event:<Name>")[0..8]) from the official pump IDLs. */
export const DISCRIMINATORS = {
  pumpTrade: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  pumpCreate: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  pumpComplete: Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]),
  ammBuy: Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]),
  ammSell: Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]),
} as const;

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export interface ParsedLogs {
  trades: TradeEvent[];
  creates: CreateEvent[];
  completes: MigrationEvent[];
  decodeErrors: number;
}

const num = (v: { toString(): string } | null | undefined): number => (v ? Number(v.toString()) : 0);

/**
 * Parse `Program data:` lines from a transaction's logs into normalized events.
 * `poolToMint` resolves PumpSwap pool addresses to base mints (AMM events carry only the pool).
 * Pure function: no I/O, so it can be fixture-tested.
 */
export function parsePumpLogs(
  logs: string[],
  signature: string,
  slot: number | null,
  receivedAt: number,
  poolToMint: (pool: string) => string | undefined = () => undefined,
): ParsedLogs {
  const out: ParsedLogs = { trades: [], creates: [], completes: [], decodeErrors: 0 };
  let eventIndex = 0;
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(14), 'base64');
    } catch {
      out.decodeErrors++;
      continue;
    }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);
    const body = buf.subarray(8);
    const idx = eventIndex++;
    try {
      if (disc.equals(DISCRIMINATORS.pumpTrade)) {
        const e = PUMP_SDK.decodeTradeEventBc(body);
        const quoteMint = e.quoteMint.toBase58();
        const tsSec = num(e.timestamp);
        out.trades.push({
          mint: e.mint.toBase58(),
          signature,
          eventIndex: idx,
          slot,
          ts: tsSec > 0 ? tsSec * 1000 : receivedAt,
          side: e.isBuy ? 'buy' : 'sell',
          solLamports: num(e.quoteAmount) || num(e.solAmount),
          tokenAmount: num(e.tokenAmount),
          trader: e.user.toBase58(),
          venue: 'bonding_curve',
          vSol: num(e.virtualQuoteReserves) || num(e.virtualSolReserves),
          vToken: num(e.virtualTokenReserves),
          realSol: num(e.realQuoteReserves) || num(e.realSolReserves),
          realToken: num(e.realTokenReserves),
          feeLamports: num(e.fee) + num(e.creatorFee),
          feeBps: num(e.feeBasisPoints) + num(e.creatorFeeBasisPoints),
          quoteMint,
          creator: e.creator.toBase58(),
          source: 'solana-rpc-logs',
        });
      } else if (disc.equals(DISCRIMINATORS.pumpCreate)) {
        const e = PUMP_SDK.decodeCreateEventBc(body);
        const tsSec = num(e.timestamp);
        out.creates.push({
          mint: e.mint.toBase58(),
          name: e.name || null,
          symbol: e.symbol || null,
          uri: e.uri || null,
          creator: e.creator.toBase58(),
          createdAt: tsSec > 0 ? tsSec * 1000 : receivedAt,
          signature,
          tokenProgram: e.tokenProgram.toBase58(),
          quoteMint: e.quoteMint.toBase58(),
          isMayhem: Boolean(e.isMayhemMode),
          isCashback: Boolean(e.isCashbackEnabled),
          vSol: num(e.virtualQuoteReserves) || num(e.virtualSolReserves),
          vToken: num(e.virtualTokenReserves),
          realToken: num(e.realTokenReserves),
          totalSupply: num(e.tokenTotalSupply),
          source: 'solana-rpc-logs',
        });
      } else if (disc.equals(DISCRIMINATORS.pumpComplete)) {
        const e = PUMP_SDK.decodeCompleteEventBc(body);
        out.completes.push({
          mint: e.mint.toBase58(),
          at: num(e.timestamp) * 1000 || receivedAt,
          signature,
          kind: 'complete',
          pool: null,
          source: 'solana-rpc-logs',
        });
      } else if (disc.equals(DISCRIMINATORS.ammBuy) || disc.equals(DISCRIMINATORS.ammSell)) {
        const isBuy = disc.equals(DISCRIMINATORS.ammBuy);
        const e = isBuy ? PUMP_SDK.decodeBuyEventAmm(body) : PUMP_SDK.decodeSellEventAmm(body);
        const pool = e.pool.toBase58();
        const mint = poolToMint(pool);
        if (!mint) continue;
        const tokenAmount = isBuy ? num((e as ReturnType<typeof PUMP_SDK.decodeBuyEventAmm>).baseAmountOut) : num((e as ReturnType<typeof PUMP_SDK.decodeSellEventAmm>).baseAmountIn);
        const sol = isBuy
          ? num((e as ReturnType<typeof PUMP_SDK.decodeBuyEventAmm>).userQuoteAmountIn)
          : num((e as ReturnType<typeof PUMP_SDK.decodeSellEventAmm>).userQuoteAmountOut);
        out.trades.push({
          mint,
          signature,
          eventIndex: idx,
          slot,
          ts: num(e.timestamp) * 1000 || receivedAt,
          side: isBuy ? 'buy' : 'sell',
          solLamports: sol,
          tokenAmount,
          trader: e.user.toBase58(),
          venue: 'pumpswap',
          // Pool events do not include the pool's virtual quote reserves, so reserves-based
          // pricing is left to the RPC pool refresh; trade price is derived from amounts.
          vSol: null,
          vToken: null,
          realSol: null,
          realToken: null,
          feeLamports: num(e.lpFee) + num(e.protocolFee) + num(e.coinCreatorFee),
          feeBps: num(e.lpFeeBasisPoints) + num(e.protocolFeeBasisPoints) + num(e.coinCreatorFeeBasisPoints),
          quoteMint: 'So11111111111111111111111111111111111111112',
          creator: e.coinCreator.toBase58(),
          source: 'solana-rpc-logs',
        });
      }
    } catch {
      out.decodeErrors++;
    }
  }
  return out;
}
