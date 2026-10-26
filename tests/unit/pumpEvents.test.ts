import { describe, expect, it } from 'vitest';
import { parsePumpLogs } from '../../src/server/market/pumpEvents';
import { pumpLogs } from '../helpers/fixtures';

describe('parsePumpLogs (real mainnet log fixtures)', () => {
  it('decodes a bonding-curve trade event', () => {
    const f = pumpLogs.trade!;
    const r = parsePumpLogs(f.logs, f.signature, f.slot, 0);
    expect(r.decodeErrors).toBe(0);
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const t = r.trades[0]!;
    expect(t.venue).toBe('bonding_curve');
    expect(t.solLamports).toBeGreaterThan(0);
    expect(t.tokenAmount).toBeGreaterThan(0);
    expect(t.vSol).toBeGreaterThan(0);
    expect(t.ts).toBeGreaterThan(1.7e12);
    expect(t.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
  it('decodes a create event with SOL quote and Token-2022 program', () => {
    const f = pumpLogs.create!;
    const r = parsePumpLogs(f.logs, f.signature, f.slot, 0);
    expect(r.creates).toHaveLength(1);
    const c = r.creates[0]!;
    expect(c.quoteMint).toBe('11111111111111111111111111111111');
    expect(c.vSol).toBe(30_000_000_000);
    expect(c.totalSupply).toBe(1_000_000_000_000_000);
    expect(c.name).toBeTruthy();
  });
  it('decodes PumpSwap buy/sell only for known pools', () => {
    for (const k of ['ammBuy', 'ammSell'] as const) {
      const f = pumpLogs[k]!;
      expect(parsePumpLogs(f.logs, f.signature, f.slot, 0).trades).toHaveLength(0);
      const r = parsePumpLogs(f.logs, f.signature, f.slot, 0, () => 'MINT');
      expect(r.trades).toHaveLength(1);
      expect(r.trades[0]!.venue).toBe('pumpswap');
      expect(r.trades[0]!.side).toBe(k === 'ammBuy' ? 'buy' : 'sell');
      expect(r.trades[0]!.vSol).toBeNull();
    }
  });
  it('ignores garbage data lines without throwing', () => {
    const r = parsePumpLogs(['Program data: !!!notbase64', 'Program data: AAAAAAAAAAAAAAAA', 'Program log: hi'], 's', 1, 0);
    expect(r.trades).toHaveLength(0);
  });
});
