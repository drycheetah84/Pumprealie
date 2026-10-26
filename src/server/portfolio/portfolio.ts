import type { PortfolioSummary, PositionMeta, PositionRecord, TradingMode, Venue } from '../../shared/types';
import { json, type DB } from '../db/database';
import { utcDay } from '../lib/util';

/** Positions smaller than this many raw token units are treated as fully closed (dust). */
export const DUST_TOKENS = 1_000;

export interface BuyFill {
  mode: TradingMode;
  orderId: number;
  mint: string;
  symbol: string | null;
  strategy: string;
  venue: Venue;
  tokensRaw: number;
  /** SOL that left the wallet for the swap, protocol fees included. */
  solSpent: number;
  networkFeeSol: number;
  entryPriceSol: number;
  stopPct: number;
  targetPct: number;
  maxHoldSec: number;
  meta: PositionMeta;
  at: number;
}

export interface SellFill {
  positionId: number;
  orderId: number;
  tokensSoldRaw: number;
  /** SOL received from the swap, protocol fees already deducted. */
  solReceived: number;
  networkFeeSol: number;
  reason: string;
  at: number;
}

export interface StrategyStats {
  strategy: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnlSol: number;
  avgWinSol: number;
  avgLossSol: number;
  profitFactor: number | null;
  avgHoldSec: number;
  feesSol: number;
}

/**
 * Double-entry-style SOL ledger + position book, per trading mode. Paper and live books
 * never mix. Every fill is applied inside a single SQLite transaction together with
 * the order state change (see ExecutionService).
 */
export class Portfolio {
  constructor(private readonly db: DB) {}

  ensureFunded(mode: TradingMode, capitalSol: number) {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM ledger WHERE mode = ? AND kind = 'deposit'").get(mode) as { c: number };
    if (r.c === 0) this.ledger(mode, 'deposit', capitalSol, null, null, 'initial configured trading capital', Date.now());
  }

  ledger(mode: TradingMode, kind: string, amountSol: number, orderId: number | null, positionId: number | null, note: string, at: number) {
    this.db.prepare('INSERT INTO ledger (mode, at, kind, amount_sol, order_id, position_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(mode, at, kind, amountSol, orderId, positionId, note);
  }

  cash(mode: TradingMode): number {
    return (this.db.prepare('SELECT COALESCE(SUM(amount_sol), 0) AS s FROM ledger WHERE mode = ?').get(mode) as { s: number }).s;
  }

  applyBuy(f: BuyFill): PositionRecord {
    const cost = f.solSpent + f.networkFeeSol;
    const r = this.db
      .prepare(
        `INSERT INTO positions (mode, mint, symbol, strategy, status, venue, token_amount_raw, cost_basis_sol, entry_price_sol, entry_at,
           fees_sol, peak_value_sol, stop_pct, target_pct, max_hold_sec, meta)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.mode, f.mint, f.symbol, f.strategy, f.venue, String(Math.round(f.tokensRaw)), cost, f.entryPriceSol, f.at, f.networkFeeSol, cost, f.stopPct, f.targetPct, f.maxHoldSec, json.str({ ...f.meta, initialCostSol: cost, initialTokensRaw: Math.round(f.tokensRaw) }));
    const id = Number(r.lastInsertRowid);
    this.ledger(f.mode, 'buy', -f.solSpent, f.orderId, id, `buy ${f.mint}`, f.at);
    if (f.networkFeeSol > 0) this.ledger(f.mode, 'fee', -f.networkFeeSol, f.orderId, id, 'network fee', f.at);
    return this.position(id)!;
  }

  applySell(f: SellFill): PositionRecord {
    const p = this.position(f.positionId);
    if (!p) throw new Error(`position ${f.positionId} not found`);
    const held = Number(p.tokenAmountRaw);
    const sold = Math.min(held, Math.round(f.tokensSoldRaw));
    const fraction = held > 0 ? sold / held : 1;
    const costPortion = p.costBasisSol * fraction;
    const realized = f.solReceived - f.networkFeeSol - costPortion;
    const remaining = held - sold;
    const closed = remaining <= DUST_TOKENS;
    this.db
      .prepare(
        `UPDATE positions SET token_amount_raw = ?, cost_basis_sol = ?, realized_pnl_sol = realized_pnl_sol + ?, proceeds_sol = proceeds_sol + ?,
           fees_sol = fees_sol + ?, status = ?, exit_at = ?, close_reason = ?, meta = ? WHERE id = ?`,
      )
      .run(
        String(closed ? 0 : remaining),
        closed ? 0 : p.costBasisSol - costPortion,
        realized,
        f.solReceived,
        f.networkFeeSol,
        closed ? 'closed' : 'open',
        closed ? f.at : null,
        closed ? f.reason : p.closeReason,
        json.str({ ...p.meta, partialTaken: p.meta.partialTaken || !closed, exitAttempts: 0, lastExitError: undefined }),
        p.id,
      );
    this.ledger(p.mode, 'sell', f.solReceived, f.orderId, p.id, `sell ${p.mint}: ${f.reason}`, f.at);
    if (f.networkFeeSol > 0) this.ledger(p.mode, 'fee', -f.networkFeeSol, f.orderId, p.id, 'network fee', f.at);
    return this.position(p.id)!;
  }

  setStatus(id: number, status: PositionRecord['status'], meta?: Partial<PositionMeta>) {
    const p = this.position(id);
    if (!p) return;
    this.db.prepare('UPDATE positions SET status = ?, meta = ? WHERE id = ?').run(status, json.str({ ...p.meta, ...(meta ?? {}) }), id);
  }

  patchMeta(id: number, meta: Partial<PositionMeta>) {
    const p = this.position(id);
    if (p) this.db.prepare('UPDATE positions SET meta = ? WHERE id = ?').run(json.str({ ...p.meta, ...meta }), id);
  }

  /** Close a position the operator confirms is worthless or was transferred out (no proceeds). */
  writeOff(id: number, reason: string, at: number) {
    const p = this.position(id);
    if (!p) return;
    this.db
      .prepare("UPDATE positions SET status = 'closed', token_amount_raw = '0', realized_pnl_sol = realized_pnl_sol - cost_basis_sol, cost_basis_sol = 0, exit_at = ?, close_reason = ? WHERE id = ?")
      .run(at, `write-off: ${reason}`, id);
  }

  updateValuation(id: number, indicativeSol: number | null, executableSol: number | null, at: number) {
    this.db
      .prepare(
        `UPDATE positions SET last_indicative_value_sol = ?, last_executable_value_sol = ?, last_valuation_at = ?,
           peak_value_sol = MAX(peak_value_sol, COALESCE(?, 0)) WHERE id = ?`,
      )
      .run(indicativeSol, executableSol, at, executableSol, id);
  }

  position(id: number): PositionRecord | null {
    const r = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? rowToPosition(r) : null;
  }

  activePosition(mode: TradingMode, mint: string): PositionRecord | null {
    const r = this.db.prepare("SELECT * FROM positions WHERE mode = ? AND mint = ? AND status IN ('open','closing','stuck')").get(mode, mint) as Record<string, unknown> | undefined;
    return r ? rowToPosition(r) : null;
  }

  openPositions(mode: TradingMode): PositionRecord[] {
    return (this.db.prepare("SELECT * FROM positions WHERE mode = ? AND status IN ('open','closing','stuck') ORDER BY entry_at").all(mode) as Record<string, unknown>[]).map(rowToPosition);
  }

  closedPositions(mode: TradingMode, limit = 500): PositionRecord[] {
    return (this.db.prepare("SELECT * FROM positions WHERE mode = ? AND status = 'closed' ORDER BY exit_at DESC LIMIT ?").all(mode, limit) as Record<string, unknown>[]).map(rowToPosition);
  }

  closedCount(mode: TradingMode): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM positions WHERE mode = ? AND status = 'closed'").get(mode) as { c: number }).c;
  }

  consecutiveLosses(mode: TradingMode): number {
    const rows = this.db.prepare("SELECT realized_pnl_sol AS p FROM positions WHERE mode = ? AND status = 'closed' ORDER BY exit_at DESC LIMIT 50").all(mode) as { p: number }[];
    let n = 0;
    for (const r of rows) {
      if (r.p < 0) n++;
      else break;
    }
    return n;
  }

  realizedToday(mode: TradingMode, now: number): number {
    const start = Date.parse(`${utcDay(now)}T00:00:00Z`);
    return (this.db.prepare("SELECT COALESCE(SUM(realized_pnl_sol), 0) AS s FROM positions WHERE mode = ? AND exit_at >= ?").get(mode, start) as { s: number }).s;
  }

  dayStartEquity(mode: TradingMode, now: number, currentEquity: number): number {
    const day = utcDay(now);
    this.db.prepare('INSERT OR IGNORE INTO daily_stats (mode, day, start_equity_sol) VALUES (?, ?, ?)').run(mode, day, currentEquity);
    return (this.db.prepare('SELECT start_equity_sol AS e FROM daily_stats WHERE mode = ? AND day = ?').get(mode, day) as { e: number }).e;
  }

  peakEquity(mode: TradingMode): number | null {
    return (this.db.prepare('SELECT MAX(equity_sol) AS m FROM equity_snapshots WHERE mode = ?').get(mode) as { m: number | null }).m;
  }

  snapshotEquity(mode: TradingMode, s: PortfolioSummary, at: number) {
    this.db
      .prepare('INSERT INTO equity_snapshots (mode, at, equity_sol, cash_sol, indicative_sol, executable_sol, exposure_sol, drawdown_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(mode, at, s.equitySol, s.cashSol, s.indicativeValueSol, s.executableValueSol, s.openExposureSol, s.drawdownPct);
  }

  equityHistory(mode: TradingMode, sinceTs: number): Array<{ at: number; equity: number; drawdownPct: number }> {
    return (this.db.prepare('SELECT at, equity_sol, drawdown_pct FROM equity_snapshots WHERE mode = ? AND at >= ? ORDER BY at').all(mode, sinceTs) as Array<{ at: number; equity_sol: number; drawdown_pct: number }>).map((r) => ({
      at: r.at,
      equity: r.equity_sol,
      drawdownPct: r.drawdown_pct,
    }));
  }

  /**
   * Portfolio summary. Equity is valued conservatively: cash + *executable* (simulated sell)
   * value of open positions; positions with no executable quote contribute zero.
   */
  summary(mode: TradingMode, opts: { configuredCapitalSol: number; feeReserveSol: number; walletSol: number | null; now: number; pendingEntrySol: number }): PortfolioSummary {
    const open = this.openPositions(mode);
    const cash = mode === 'live' && opts.walletSol !== null ? opts.walletSol : this.cash(mode);
    const exposure = open.reduce((a, p) => a + p.costBasisSol, 0);
    const indicative = open.reduce((a, p) => a + (p.lastIndicativeValueSol ?? 0), 0);
    const executable = open.reduce((a, p) => a + (p.lastExecutableValueSol ?? 0), 0);
    const equity = cash + executable;
    const realized = (this.db.prepare('SELECT COALESCE(SUM(realized_pnl_sol), 0) AS s FROM positions WHERE mode = ?').get(mode) as { s: number }).s;
    const fees = -(this.db.prepare("SELECT COALESCE(SUM(amount_sol), 0) AS s FROM ledger WHERE mode = ? AND kind = 'fee'").get(mode) as { s: number }).s;
    const dayStart = this.dayStartEquity(mode, opts.now, equity);
    const peak = Math.max(this.peakEquity(mode) ?? equity, equity, mode === 'paper' ? opts.configuredCapitalSol : 0);
    const trades = (this.db.prepare("SELECT COUNT(*) AS c FROM orders WHERE mode = ? AND status = 'SETTLED'").get(mode) as { c: number }).c;
    const reserved = opts.feeReserveSol + opts.pendingEntrySol;
    return {
      mode,
      configuredCapitalSol: opts.configuredCapitalSol,
      cashSol: cash,
      walletSol: opts.walletSol,
      reservedSol: reserved,
      availableSol: Math.max(0, cash - reserved),
      openExposureSol: exposure,
      indicativeValueSol: indicative,
      executableValueSol: executable,
      equitySol: equity,
      realizedPnlSol: realized,
      unrealizedPnlSol: executable - exposure,
      todayPnlSol: equity - dayStart,
      dayStartEquitySol: dayStart,
      peakEquitySol: peak,
      drawdownPct: peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0,
      feesPaidSol: fees,
      openPositions: open.length,
      tradeCount: trades,
      consecutiveLosses: this.consecutiveLosses(mode),
      valuationMethod: 'cash + executable value (simulated full sell against current on-chain reserves, protocol fees included; positions without a quote valued at 0)',
    };
  }

  strategyStats(mode: TradingMode, sinceTs = 0): StrategyStats[] {
    const rows = this.db
      .prepare("SELECT strategy, realized_pnl_sol AS p, fees_sol AS f, entry_at AS e, exit_at AS x FROM positions WHERE mode = ? AND status = 'closed' AND exit_at >= ?")
      .all(mode, sinceTs) as Array<{ strategy: string; p: number; f: number; e: number; x: number }>;
    const by = new Map<string, typeof rows>();
    for (const r of rows) by.set(r.strategy, [...(by.get(r.strategy) ?? []), r]);
    return [...by.entries()].map(([strategy, rs]) => {
      const wins = rs.filter((r) => r.p > 0);
      const losses = rs.filter((r) => r.p <= 0);
      const gw = wins.reduce((a, r) => a + r.p, 0);
      const gl = -losses.reduce((a, r) => a + r.p, 0);
      return {
        strategy,
        trades: rs.length,
        wins: wins.length,
        losses: losses.length,
        winRate: rs.length ? wins.length / rs.length : 0,
        netPnlSol: gw - gl,
        avgWinSol: wins.length ? gw / wins.length : 0,
        avgLossSol: losses.length ? -gl / losses.length : 0,
        profitFactor: gl > 0 ? gw / gl : null,
        avgHoldSec: rs.length ? rs.reduce((a, r) => a + (r.x - r.e) / 1000, 0) / rs.length : 0,
        feesSol: rs.reduce((a, r) => a + r.f, 0),
      };
    });
  }
}

export function rowToPosition(r: Record<string, unknown>): PositionRecord {
  return {
    id: r.id as number,
    mode: r.mode as TradingMode,
    mint: r.mint as string,
    symbol: r.symbol as string | null,
    strategy: r.strategy as string,
    status: r.status as PositionRecord['status'],
    venue: r.venue as Venue,
    tokenAmountRaw: r.token_amount_raw as string,
    costBasisSol: r.cost_basis_sol as number,
    entryPriceSol: r.entry_price_sol as number,
    entryAt: r.entry_at as number,
    exitAt: r.exit_at as number | null,
    realizedPnlSol: r.realized_pnl_sol as number,
    proceedsSol: r.proceeds_sol as number,
    feesSol: r.fees_sol as number,
    peakValueSol: r.peak_value_sol as number,
    stopPct: r.stop_pct as number,
    targetPct: r.target_pct as number,
    maxHoldSec: r.max_hold_sec as number,
    lastIndicativeValueSol: r.last_indicative_value_sol as number | null,
    lastExecutableValueSol: r.last_executable_value_sol as number | null,
    lastValuationAt: r.last_valuation_at as number | null,
    closeReason: r.close_reason as string | null,
    meta: json.parse<PositionMeta>(r.meta as string | null, {}),
  };
}
