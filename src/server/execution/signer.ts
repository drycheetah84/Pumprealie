import fs from 'node:fs';
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, type VersionedTransaction } from '@solana/web3.js';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from '../market/pumpEvents';

export interface SignIntent {
  side: 'buy' | 'sell';
  mint: string;
  /** Maximum lamports allowed to leave the wallet (swap + rent), excluding network fees. */
  maxSpendLamports: number;
  maxPriorityMicroLamports: number;
}

export interface TransactionSigner {
  readonly publicKey: PublicKey;
  /** Sign only after the transaction passes the trading policy; throws otherwise. */
  sign(tx: VersionedTransaction, intent: SignIntent): VersionedTransaction;
}

export class PolicyViolation extends Error {}

const TOKEN_IX_SYNC_NATIVE = 17;
const TOKEN_IX_CLOSE_ACCOUNT = 9;
const SYSTEM_IX_TRANSFER = 2;

/**
 * Transaction policy enforced immediately before signing. It permits only the narrow set of
 * instructions Pumpraelie's own buy/sell builders produce, so the signer cannot be used to
 * sign arbitrary transactions (e.g. transfers to third parties) even if upstream code is buggy.
 */
export function enforceTradingPolicy(tx: VersionedTransaction, wallet: PublicKey, intent: SignIntent): void {
  const msg = tx.message;
  if (msg.addressTableLookups.length > 0) throw new PolicyViolation('address lookup tables are not allowed');
  const keys = msg.staticAccountKeys;
  if (!keys[0]?.equals(wallet)) throw new PolicyViolation('fee payer must be the trading wallet');
  const signers = keys.slice(0, msg.header.numRequiredSignatures);
  if (signers.length !== 1) throw new PolicyViolation('only the trading wallet may sign');
  const mint = new PublicKey(intent.mint);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true, TOKEN_PROGRAM_ID);
  let tradeIxs = 0;
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program) throw new PolicyViolation('unknown program index');
    const accounts = ix.accountKeyIndexes.map((i) => keys[i]!);
    const data = Buffer.from(ix.data);
    const p = program.toBase58();
    if (program.equals(ComputeBudgetProgram.programId)) {
      // SetComputeUnitPrice = 3 (u64 microLamports)
      if (data[0] === 3 && data.length >= 9 && data.readBigUInt64LE(1) > BigInt(intent.maxPriorityMicroLamports))
        throw new PolicyViolation('priority fee above configured maximum');
      continue;
    }
    if (p === PUMP_PROGRAM || p === PUMP_AMM_PROGRAM) {
      if (!accounts.some((a) => a.equals(mint))) throw new PolicyViolation('trade instruction does not reference the intended mint');
      tradeIxs++;
      continue;
    }
    if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // create / createIdempotent: [payer, ata, owner, mint, system, tokenProgram]
      if (!accounts[0]?.equals(wallet) || !accounts[2]?.equals(wallet)) throw new PolicyViolation('ATA creation must be paid by and owned by the wallet');
      if (!accounts[3]?.equals(mint) && !accounts[3]?.equals(NATIVE_MINT)) throw new PolicyViolation('ATA creation for unexpected mint');
      continue;
    }
    if (program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) {
      if (data[0] === TOKEN_IX_SYNC_NATIVE) continue;
      if (data[0] === TOKEN_IX_CLOSE_ACCOUNT) {
        // [account, destination, owner]
        if (!accounts[1]?.equals(wallet) || !accounts[2]?.equals(wallet)) throw new PolicyViolation('close account must return rent to the wallet');
        continue;
      }
      throw new PolicyViolation(`token instruction ${data[0]} not allowed`);
    }
    if (program.equals(SystemProgram.programId)) {
      // Only funding the wallet's own WSOL account for PumpSwap buys.
      if (data.readUInt32LE(0) !== SYSTEM_IX_TRANSFER) throw new PolicyViolation('system instruction not allowed');
      if (!accounts[0]?.equals(wallet) || !accounts[1]?.equals(wsolAta)) throw new PolicyViolation('SOL transfers only allowed into the wallet WSOL account');
      const lamports = Number(data.readBigUInt64LE(4));
      if (lamports > intent.maxSpendLamports) throw new PolicyViolation('WSOL funding exceeds spend limit');
      continue;
    }
    throw new PolicyViolation(`program ${p} not allowed`);
  }
  if (tradeIxs !== 1) throw new PolicyViolation(`expected exactly one trade instruction, found ${tradeIxs}`);
}

/**
 * Local keypair signer for a dedicated trading wallet. The secret key is read from a
 * solana-keygen JSON file, kept in memory only, never logged or exposed via the API.
 */
export class LocalKeypairSigner implements TransactionSigner {
  readonly publicKey: PublicKey;
  #kp: Keypair;

  private constructor(kp: Keypair) {
    this.#kp = kp;
    this.publicKey = kp.publicKey;
  }

  static fromFile(path: string, expectedPublicKey?: string): LocalKeypairSigner {
    const st = fs.statSync(path);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0)
      throw new Error(`wallet keypair file ${path} is accessible by group/others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${path}`);
    const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(raw) || raw.length !== 64) throw new Error('wallet keypair file must be a 64-byte JSON array (solana-keygen format)');
    const kp = Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
    if (expectedPublicKey && kp.publicKey.toBase58() !== expectedPublicKey) throw new Error('wallet keypair does not match WALLET_PUBLIC_KEY');
    return new LocalKeypairSigner(kp);
  }

  /** For tests only: wraps an ephemeral keypair. */
  static ephemeral(): LocalKeypairSigner {
    return new LocalKeypairSigner(Keypair.generate());
  }

  sign(tx: VersionedTransaction, intent: SignIntent): VersionedTransaction {
    enforceTradingPolicy(tx, this.publicKey, intent);
    tx.sign([this.#kp]);
    return tx;
  }

  toJSON() {
    return { publicKey: this.publicKey.toBase58() };
  }
}
