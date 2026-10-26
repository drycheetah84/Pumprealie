import fs from 'node:fs';
import path from 'node:path';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { newTokenState, type TokenState } from '../../src/server/market/tokenRegistry';
import type { LiquidityState } from '../../src/server/market/liquidity';
import type { TradeEvent } from '../../src/server/market/types';
import type { MintInfo } from '../../src/shared/types';

const dir = path.join(__dirname, '..', 'fixtures');
export const pumpLogs = JSON.parse(fs.readFileSync(path.join(dir, 'pump-logs.json'), 'utf8')) as Record<string, { signature: string; slot: number; logs: string[] }>;
export const pumpAccounts = JSON.parse(fs.readFileSync(path.join(dir, 'pump-accounts.json'), 'utf8'));

export function accountInfo(a: { owner: string; lamports: number; data: string }): AccountInfo<Buffer> {
  return { data: Buffer.from(a.data, 'base64'), owner: new PublicKey(a.owner), lamports: a.lamports, executable: false, rentEpoch: 0 };
}

export function fixtureProtocol() {
  return {
    global: PUMP_SDK.decodeGlobal(accountInfo(pumpAccounts.global)),
    feeConfig: PUMP_SDK.decodeFeeConfig(accountInfo(pumpAccounts.feeConfig)),
    mayhemCurve: PUMP_SDK.decodeBondingCurve(accountInfo(pumpAccounts.bondingCurve)),
    standardCurve: PUMP_SDK.decodeBondingCurve(accountInfo(pumpAccounts.standardCurve)),
  };
}

export const MINT = 'BTS2jevT5QXCni96oHzAp66pYPMzMUAVKjndxuxEpump';
export const CREATOR = '2bRoascfGCKkRnyZLmzJh7cKpiD45zyEzUmg9XPZzueC';

/** A standard curve after `realSol` SOL has been bought in (constant product from the initial state). */
export function curveState(realSol: number, at = Date.now(), feeBps = 125): LiquidityState {
  const vs0 = 30_000_000_000;
  const vt0 = 1_073_000_000_000_000;
  const k = vs0 * vt0;
  const vs = vs0 + realSol * 1e9;
  const vt = Math.floor(k / vs);
  return {
    venue: 'bonding_curve',
    baseReserve: vt,
    quoteReserve: vs,
    realBaseReserve: 793_100_000_000_000 - (vt0 - vt),
    realQuoteReserve: realSol * 1e9,
    feeBps,
    observedAt: at,
    source: 'test',
    slot: null,
  };
}

export function cleanMintInfo(at = Date.now()): MintInfo {
  return {
    fetchedAt: at,
    source: 'test',
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    decimals: 6,
    supplyRaw: '1000000000000000',
    mintAuthority: null,
    freezeAuthority: null,
    extensions: ['MetadataPointer', 'TokenMetadata'],
    riskyExtensions: [],
  };
}

let sigN = 0;
export function trade(p: Partial<TradeEvent> & { ts: number; side: 'buy' | 'sell'; sol: number; trader?: string; state?: LiquidityState }): TradeEvent {
  const s = p.state;
  return {
    mint: p.mint ?? MINT,
    signature: p.signature ?? `sig${++sigN}`,
    eventIndex: 0,
    slot: null,
    ts: p.ts,
    side: p.side,
    solLamports: Math.round(p.sol * 1e9),
    tokenAmount: p.tokenAmount ?? Math.round(p.sol * 3e13),
    trader: p.trader ?? `trader${sigN % 50}`,
    venue: 'bonding_curve',
    vSol: s ? s.quoteReserve : null,
    vToken: s ? s.baseReserve : null,
    realSol: s ? s.realQuoteReserve : null,
    realToken: s ? s.realBaseReserve : null,
    feeLamports: null,
    feeBps: 125,
    quoteMint: '11111111111111111111111111111111',
    creator: CREATOR,
    source: 'solana-rpc-logs',
  };
}

/** A healthy-looking token with steady buying from many wallets. */
export function healthyToken(now: number, opts: { realSolStart?: number; minutes?: number; buyBias?: number } = {}): TokenState {
  const t = newTokenState(MINT, now - 20 * 60_000);
  t.creator = CREATOR;
  t.createdAt = now - 20 * 60_000;
  t.observedFromLaunch = true;
  t.quoteMint = '11111111111111111111111111111111';
  t.quoteVerified = true;
  t.mintInfo = cleanMintInfo(now);
  t.sources.add('solana-rpc-logs');
  let real = opts.realSolStart ?? 20;
  const minutes = opts.minutes ?? 10;
  const bias = opts.buyBias ?? 0.7;
  for (let i = 0; i < minutes * 12; i++) {
    const ts = now - minutes * 60_000 + i * 5000;
    const buy = (i * 7919) % 100 < bias * 100;
    const size = 0.05 + ((i * 31) % 17) / 40;
    real = Math.max(1, real + (buy ? size : -size));
    const st = curveState(real, ts);
    const e = trade({ ts, side: buy ? 'buy' : 'sell', sol: size, trader: `w${(i * 13) % 60}`, state: st });
    t.trades.push(e);
    t.flows.set(e.trader, (t.flows.get(e.trader) ?? 0) + (buy ? e.tokenAmount : -e.tokenAmount) / 50);
    t.liquidity = st;
    t.liquidityHistory.push({ ts, realSol: real, priceSol: st.quoteReserve / 1e9 / (st.baseReserve / 1e6) });
    t.lastEventAt = ts;
  }
  t.rpcLiquidity = t.liquidity;
  t.rpcCheckedAt = now - 1000;
  t.inconsistencyPct = 0;
  t.feeBps = 125;
  return t;
}
