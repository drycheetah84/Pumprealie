import {
  bondingCurvePda,
  computeFeesBps,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_SDK,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '@pump-fun/pump-sdk';
import {
  canonicalPumpPoolPda,
  computeFeesBps as ammComputeFeesBps,
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_SDK,
  pumpPoolAuthorityPda,
  type GlobalConfig,
  type Pool,
} from '@pump-fun/pump-sdk/swap';
import { ExtensionType, getExtensionData, getExtensionTypes, unpackAccount, unpackMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { unpack as unpackTokenMetadata } from '@solana/spl-token-metadata';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import type { HolderEntry, HolderSnapshot, MintInfo } from '../../../shared/types';
import type { LiquidityState } from '../liquidity';
import type { SolanaRpc } from './solanaRpc';

/** Token-2022 extensions that can restrict, tax, claw back or freeze transfers. */
export const RISKY_EXTENSIONS: ReadonlySet<string> = new Set([
  'TransferFeeConfig',
  'TransferHook',
  'PermanentDelegate',
  'NonTransferable',
  'DefaultAccountState',
  'PausableConfig',
  'ConfidentialTransferMint',
  'PermissionedBurn',
]);

/** Extensions Pump itself sets on Token-2022 mints (metadata only). */
export const BENIGN_EXTENSIONS: ReadonlySet<string> = new Set(['MetadataPointer', 'TokenMetadata', 'ImmutableOwner']);

export interface CurveSnapshot {
  mint: string;
  curveAddress: string;
  curve: BondingCurve;
  quoteMint: string;
  liquidity: LiquidityState;
  complete: boolean;
  isMayhem: boolean;
  isCashback: boolean;
  slotContext: number | null;
}

export interface PoolSnapshot {
  mint: string;
  pool: string;
  quoteMint: string;
  liquidity: LiquidityState;
  baseVault: string;
  quoteVault: string;
  coinCreator: string;
}

/**
 * Direct on-chain reads via documented account layouts (decoded by the official Pump SDK).
 * This is the source of truth used to reconcile provider data before committing capital.
 */
export class OnchainInspector {
  private global: Global | null = null;
  private feeConfig: FeeConfig | null = null;
  private ammGlobal: GlobalConfig | null = null;
  private ammFeeConfig: unknown = null;
  private protocolFetchedAt = 0;

  constructor(private readonly rpc: SolanaRpc) {}

  /** Pump global + fee config; refreshed at most every 10 minutes. */
  async protocol(): Promise<{ global: Global; feeConfig: FeeConfig }> {
    if (!this.global || !this.feeConfig || Date.now() - this.protocolFetchedAt > 600_000) {
      const [g, f, ag, af] = await this.rpc.getMultipleAccountsInfo([GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA]);
      if (!g || !f) throw new Error('Pump global or fee config account not found');
      this.global = PUMP_SDK.decodeGlobal(g);
      this.feeConfig = PUMP_SDK.decodeFeeConfig(f);
      this.ammGlobal = ag ? PUMP_AMM_SDK.decodeGlobalConfig(ag) : null;
      this.ammFeeConfig = af ? PUMP_AMM_SDK.decodeFeeConfig(af) : null;
      this.protocolFetchedAt = Date.now();
    }
    return { global: this.global, feeConfig: this.feeConfig };
  }

  curveFeeBps(curve: BondingCurve): number {
    if (!this.global || !this.feeConfig || curve.virtualTokenReserves.isZero()) return 125;
    try {
      return this.curveFeeBpsUnsafe(curve);
    } catch {
      // Conservative fallback (current SOL schedule top tier is 95 + 30 bps).
      return 125;
    }
  }

  private curveFeeBpsUnsafe(curve: BondingCurve): number {
    const f = computeFeesBps({
      global: this.global!,
      feeConfig: this.feeConfig!,
      mintSupply: curve.tokenTotalSupply,
      virtualQuoteReserves: curve.virtualQuoteReserves,
      virtualTokenReserves: curve.virtualTokenReserves,
      quoteMint: curve.quoteMint,
      creatorFeeBps: curve.creatorFeeBps,
    } as Parameters<typeof computeFeesBps>[0]);
    return Number(f.protocolFeeBps.add(f.creatorFeeBps).toString());
  }

  static curveToLiquidity(curve: BondingCurve, feeBps: number, observedAt: number): LiquidityState {
    return {
      venue: 'bonding_curve',
      baseReserve: Number(curve.virtualTokenReserves.toString()),
      quoteReserve: Number(curve.virtualQuoteReserves.toString()),
      realBaseReserve: Number(curve.realTokenReserves.toString()),
      realQuoteReserve: Number(curve.realQuoteReserves.toString()),
      feeBps,
      observedAt,
      source: 'solana-rpc:bonding-curve',
      slot: null,
    };
  }

  /** Batch-read bonding curves (≤100 per RPC call). Missing curves map to null. */
  async fetchCurves(mints: string[]): Promise<Map<string, CurveSnapshot | null>> {
    const out = new Map<string, CurveSnapshot | null>();
    if (!mints.length) return out;
    await this.protocol();
    for (let i = 0; i < mints.length; i += 100) {
      const chunk = mints.slice(i, i + 100);
      const infos = await this.rpc.getMultipleAccountsInfo(chunk.map((m) => bondingCurvePda(m)));
      const at = Date.now();
      chunk.forEach((mint, j) => {
        const info = infos[j];
        if (!info) return out.set(mint, null);
        const curve = PUMP_SDK.decodeBondingCurveNullable(info);
        if (!curve) return out.set(mint, null);
        out.set(mint, {
          mint,
          curveAddress: bondingCurvePda(mint).toBase58(),
          curve,
          quoteMint: curve.quoteMint.toBase58(),
          liquidity: OnchainInspector.curveToLiquidity(curve, this.curveFeeBps(curve), at),
          complete: curve.complete,
          isMayhem: curve.isMayhemMode,
          isCashback: curve.isCashbackCoin,
          slotContext: null,
        });
      });
    }
    return out;
  }

  /** Read the canonical SOL-quoted PumpSwap pool for a graduated mint. */
  async fetchPool(mint: string): Promise<PoolSnapshot | null> {
    await this.protocol();
    const poolKey = canonicalPumpPoolPda(new PublicKey(mint));
    const info = await this.rpc.getAccountInfo(poolKey);
    if (!info) return null;
    const pool: Pool = PUMP_AMM_SDK.decodePool(info);
    const [baseInfo, quoteInfo, mintInfo] = await this.rpc.getMultipleAccountsInfo([
      pool.poolBaseTokenAccount,
      pool.poolQuoteTokenAccount,
      pool.baseMint,
    ]);
    if (!baseInfo || !quoteInfo || !mintInfo) return null;
    const baseAcc = unpackAccount(pool.poolBaseTokenAccount, baseInfo, baseInfo.owner);
    const quoteAcc = unpackAccount(pool.poolQuoteTokenAccount, quoteInfo, quoteInfo.owner);
    const baseReserve = Number(baseAcc.amount);
    const vault = Number(quoteAcc.amount);
    const buckets = Number(pool.protocolFees.add(pool.creatorFees).toString());
    let feeBps = 125;
    if (this.ammGlobal) {
      try {
        const supply = unpackMint(pool.baseMint, mintInfo, mintInfo.owner).supply;
        const f = ammComputeFeesBps({
          globalConfig: this.ammGlobal,
          feeConfig: this.ammFeeConfig as Parameters<typeof ammComputeFeesBps>[0]['feeConfig'],
          creator: pool.creator,
          baseMintSupply: new BN(supply.toString()),
          baseMint: pool.baseMint,
          baseReserve: new BN(baseReserve),
          quoteReserve: new BN(vault).add(pool.virtualQuoteReserves),
          quoteMint: pool.quoteMint,
          isMayhemMode: pool.isMayhemMode,
          creatorFeeBps: pool.creatorFeeBps,
        });
        feeBps = Number(f.lpFeeBps.add(f.protocolFeeBps).add(f.creatorFeeBps).toString());
      } catch {
        /* keep conservative default */
      }
    }
    return {
      mint,
      pool: poolKey.toBase58(),
      quoteMint: pool.quoteMint.toBase58(),
      baseVault: pool.poolBaseTokenAccount.toBase58(),
      quoteVault: pool.poolQuoteTokenAccount.toBase58(),
      coinCreator: pool.coinCreator.toBase58(),
      liquidity: {
        venue: 'pumpswap',
        baseReserve,
        quoteReserve: vault + Number(pool.virtualQuoteReserves.toString()),
        realBaseReserve: baseReserve,
        realQuoteReserve: Math.max(0, vault - buckets),
        feeBps,
        observedAt: Date.now(),
        source: 'solana-rpc:pumpswap-pool',
        slot: null,
      },
    };
  }

  static parseMint(mint: string, info: AccountInfo<Buffer>, at = Date.now()): MintInfo & { name?: string; symbol?: string } {
    const program = info.owner;
    const m = unpackMint(new PublicKey(mint), info, program);
    const extensions = program.equals(TOKEN_2022_PROGRAM_ID)
      ? getExtensionTypes(m.tlvData).map((t) => ExtensionType[t] ?? `Unknown(${t})`)
      : [];
    let name: string | undefined;
    let symbol: string | undefined;
    if (extensions.includes('TokenMetadata')) {
      try {
        const data = getExtensionData(ExtensionType.TokenMetadata, m.tlvData);
        if (data) {
          const md = unpackTokenMetadata(data);
          name = md.name.slice(0, 64);
          symbol = md.symbol.slice(0, 16);
        }
      } catch {
        /* metadata is informational only */
      }
    }
    return {
      name,
      symbol,
      fetchedAt: at,
      source: 'solana-rpc:mint-account',
      tokenProgram: program.toBase58(),
      decimals: m.decimals,
      supplyRaw: m.supply.toString(),
      mintAuthority: m.mintAuthority ? m.mintAuthority.toBase58() : null,
      freezeAuthority: m.freezeAuthority ? m.freezeAuthority.toBase58() : null,
      extensions,
      riskyExtensions: extensions.filter((e) => RISKY_EXTENSIONS.has(e)),
    };
  }

  /** Batch-read mint accounts (≤100 per call). */
  async fetchMintInfos(mints: string[]): Promise<Map<string, (MintInfo & { name?: string; symbol?: string }) | null>> {
    const out = new Map<string, (MintInfo & { name?: string; symbol?: string }) | null>();
    for (let i = 0; i < mints.length; i += 100) {
      const chunk = mints.slice(i, i + 100);
      const infos = await this.rpc.getMultipleAccountsInfo(chunk.map((m) => new PublicKey(m)));
      chunk.forEach((m, j) => {
        const info = infos[j];
        if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) return out.set(m, null);
        try {
          out.set(m, OnchainInspector.parseMint(m, info));
        } catch {
          out.set(m, null);
        }
      });
    }
    return out;
  }

  async fetchMintInfo(mint: string): Promise<MintInfo | null> {
    const info = await this.rpc.getAccountInfo(new PublicKey(mint));
    if (!info) return null;
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error(`mint ${mint} owned by unexpected program ${info.owner.toBase58()}`);
    }
    return OnchainInspector.parseMint(mint, info);
  }

  /**
   * Largest holders (RPC returns the top 20 token accounts) with protocol accounts labelled,
   * so concentration is not inflated by the bonding curve or pool vault.
   */
  async fetchHolders(
    mint: string,
    ctx: { creator: string | null; poolBaseVault?: string | null; poolAddress?: string | null; supplyRaw: string },
  ): Promise<HolderSnapshot> {
    const largest = await this.rpc.getTokenLargestAccounts(new PublicKey(mint));
    const infos = largest.length ? await this.rpc.getMultipleAccountsInfo(largest.map((l) => l.address)) : [];
    return OnchainInspector.buildHolderSnapshot(
      mint,
      largest.map((l, i) => {
        const info = infos[i];
        let owner: string | null = null;
        if (info) {
          try {
            owner = unpackAccount(l.address, info, info.owner).owner.toBase58();
          } catch {
            owner = null;
          }
        }
        return { tokenAccount: l.address.toBase58(), owner, amountRaw: l.amount };
      }),
      ctx,
    );
  }

  static buildHolderSnapshot(
    mint: string,
    rows: Array<{ tokenAccount: string; owner: string | null; amountRaw: string }>,
    ctx: { creator: string | null; poolBaseVault?: string | null; poolAddress?: string | null; supplyRaw: string },
    at = Date.now(),
  ): HolderSnapshot {
    const supply = Number(ctx.supplyRaw) || 1;
    const curve = bondingCurvePda(mint).toBase58();
    const poolAuthority = pumpPoolAuthorityPda(new PublicKey(mint)).toBase58();
    const holders: HolderEntry[] = rows.map((r) => {
      const pct = (Number(r.amountRaw) / supply) * 100;
      let label: HolderEntry['label'] = r.owner ? 'holder' : 'unknown';
      if (r.owner === curve) label = 'bonding_curve';
      else if (
        (ctx.poolBaseVault && r.tokenAccount === ctx.poolBaseVault) ||
        (ctx.poolAddress && r.owner === ctx.poolAddress) ||
        r.owner === poolAuthority
      )
        label = 'amm_pool';
      else if (ctx.creator && r.owner === ctx.creator) label = 'creator';
      return { tokenAccount: r.tokenAccount, owner: r.owner, amountRaw: r.amountRaw, pct, label };
    });
    const protocol = holders.filter((h) => h.label === 'bonding_curve' || h.label === 'amm_pool');
    // Aggregate by owner so one wallet with several token accounts counts once.
    const byOwner = new Map<string, number>();
    for (const h of holders) {
      if (h.label === 'bonding_curve' || h.label === 'amm_pool') continue;
      const k = h.owner ?? h.tokenAccount;
      byOwner.set(k, (byOwner.get(k) ?? 0) + h.pct);
    }
    const sorted = [...byOwner.values()].sort((a, b) => b - a);
    const creatorPct = ctx.creator ? (byOwner.get(ctx.creator) ?? 0) : null;
    return {
      fetchedAt: at,
      source: 'solana-rpc:getTokenLargestAccounts',
      supplyRaw: ctx.supplyRaw,
      holders,
      top1Pct: sorted[0] ?? 0,
      top10Pct: sorted.slice(0, 10).reduce((a, b) => a + b, 0),
      creatorPct,
      protocolPct: protocol.reduce((a, h) => a + h.pct, 0),
    };
  }

  /** Number of transactions signed by `address` in the last hour (from up to 100 recent signatures). */
  async recentActivity(address: string): Promise<{ txLastHour: number; sampled: number }> {
    const sigs = await this.rpc.getSignaturesForAddress(new PublicKey(address), 100);
    const cutoff = Date.now() / 1000 - 3600;
    return { txLastHour: sigs.filter((s) => (s.blockTime ?? 0) >= cutoff).length, sampled: sigs.length };
  }
}
