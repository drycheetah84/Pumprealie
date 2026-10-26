import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { LocalKeypairSigner, PolicyViolation, type SignIntent } from '../../src/server/execution/signer';
import { PUMP_PROGRAM } from '../../src/server/market/pumpEvents';

const MINT = new PublicKey('BTS2jevT5QXCni96oHzAp66pYPMzMUAVKjndxuxEpump');

function tx(payer: PublicKey, ixs: TransactionInstruction[]) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message());
}
const pumpIx = (user: PublicKey, mint = MINT) =>
  new TransactionInstruction({ programId: new PublicKey(PUMP_PROGRAM), keys: [{ pubkey: mint, isSigner: false, isWritable: false }, { pubkey: user, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });
const intent: SignIntent = { side: 'buy', mint: MINT.toBase58(), maxSpendLamports: 50_000_000, maxPriorityMicroLamports: 1_000_000 };

describe('signer transaction policy', () => {
  const signer = LocalKeypairSigner.ephemeral();
  const me = signer.publicKey;

  it('signs a standard Pump buy (compute budget + ATA + one trade instruction)', () => {
    const ata = getAssociatedTokenAddressSync(MINT, me, true, TOKEN_2022_PROGRAM_ID);
    const t = tx(me, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      createAssociatedTokenAccountIdempotentInstruction(me, ata, me, MINT, TOKEN_2022_PROGRAM_ID),
      pumpIx(me),
    ]);
    expect(() => signer.sign(t, intent)).not.toThrow();
    expect(t.signatures[0]!.some((b) => b !== 0)).toBe(true);
  });

  it('refuses SOL transfers to third parties (no wallet-draining)', () => {
    const thief = Keypair.generate().publicKey;
    const t = tx(me, [SystemProgram.transfer({ fromPubkey: me, toPubkey: thief, lamports: 1 }), pumpIx(me)]);
    expect(() => signer.sign(t, intent)).toThrow(PolicyViolation);
  });

  it('allows funding only the wallet’s own WSOL account, within the spend limit', () => {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, me, true);
    expect(() => signer.sign(tx(me, [SystemProgram.transfer({ fromPubkey: me, toPubkey: wsol, lamports: 10_000_000 }), pumpIx(me)]), intent)).not.toThrow();
    expect(() => signer.sign(tx(me, [SystemProgram.transfer({ fromPubkey: me, toPubkey: wsol, lamports: 99_000_000 }), pumpIx(me)]), intent)).toThrow(/spend limit/);
  });

  it('refuses unknown programs, missing/duplicate trade instructions and wrong mints', () => {
    const rogue = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(1) });
    expect(() => signer.sign(tx(me, [rogue, pumpIx(me)]), intent)).toThrow(/not allowed/);
    expect(() => signer.sign(tx(me, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })]), intent)).toThrow(/exactly one trade/);
    expect(() => signer.sign(tx(me, [pumpIx(me), pumpIx(me)]), intent)).toThrow(/exactly one trade/);
    expect(() => signer.sign(tx(me, [pumpIx(me, Keypair.generate().publicKey)]), intent)).toThrow(/intended mint/);
  });

  it('refuses a priority fee above the configured maximum and foreign fee payers', () => {
    expect(() => signer.sign(tx(me, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 }), pumpIx(me)]), intent)).toThrow(/priority fee/);
    const other = Keypair.generate().publicKey;
    expect(() => signer.sign(tx(other, [pumpIx(me)]), intent)).toThrow(PolicyViolation);
  });

  it('never exposes the secret key through serialization', () => {
    expect(JSON.stringify(signer)).toBe(JSON.stringify({ publicKey: me.toBase58() }));
    expect(Object.keys(signer)).not.toContain('secretKey');
  });
});

describe('keypair file loading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpraelie-signer-'));
  const kp = Keypair.generate();
  const file = path.join(dir, 'wallet.json');
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));

  it('refuses keypair files readable by group/others', () => {
    fs.chmodSync(file, 0o644);
    expect(() => LocalKeypairSigner.fromFile(file)).toThrow(/chmod 600/);
  });
  it('loads a 0600 keypair and checks the expected public key', () => {
    fs.chmodSync(file, 0o600);
    expect(LocalKeypairSigner.fromFile(file, kp.publicKey.toBase58()).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(() => LocalKeypairSigner.fromFile(file, Keypair.generate().publicKey.toBase58())).toThrow(/does not match/);
  });
});
