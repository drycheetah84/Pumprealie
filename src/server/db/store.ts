import type { Alert, KillSwitchState } from '../../shared/types';
import { json, type DB } from './database';

export interface TradeRow {
  mint: string;
  signature: string;
  eventIndex: number;
  slot: number | null;
  ts: number;
  side: 'buy' | 'sell';
  solLamports: number;
  tokenAmount: string;
  trader: string;
  venue: string;
  vSol: number | null;
  vToken: string | null;
  realSol: number | null;
  realToken: string | null;
  feeLamports: number | null;
  source: string;
}

export interface TokenRow {
  mint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  creator: string | null;
  createdAt: number | null;
  createSignature: string | null;
  tokenProgram: string | null;
  quoteMint: string | null;
  isMayhem: boolean;
  venue: string;
  complete: boolean;
  graduatedAt: number | null;
  pool: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  source: string;
}

/**
 * Persistence for system state, settings, audit, alerts and market observations.
 * Order/position persistence lives in their own repositories.
 */
export class Store {
  constructor(readonly db: DB) {}

  // ---- system state / settings -------------------------------------------------
  getState<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as { value: string } | undefined;
    return json.parse(r?.value, fallback);
  }

  setState(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, json.str(value), Date.now());
  }

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return json.parse(r?.value, fallback);
  }

  setSetting(key: string, value: unknown, by: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(key, json.str(value), Date.now(), by);
  }

  // ---- kill switch -------------------------------------------------------------
  getKillSwitch(): KillSwitchState {
    return this.getState<KillSwitchState>('kill_switch', { active: false, reason: null, changedAt: null, changedBy: null });
  }

  /** Persists synchronously (SQLite commit) before returning, so callers can acknowledge safely. */
  setKillSwitch(active: boolean, reason: string | null, by: string): KillSwitchState {
    const state: KillSwitchState = { active, reason, changedAt: Date.now(), changedBy: by };
    this.db.transaction(() => {
      this.setState('kill_switch', state);
      this.audit(by, active ? 'kill_switch.activate' : 'kill_switch.clear', null, null, { reason });
    })();
    return state;
  }

  // ---- audit / alerts / nonces -------------------------------------------------
  audit(actor: string, action: string, correlationId: string | null, ip: string | null, detail: unknown): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, correlation_id, ip, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), actor, action, correlationId, ip, json.str(detail ?? null));
  }

  listAudit(limit = 200): Array<{ id: number; at: number; actor: string; action: string; correlationId: string | null; detail: unknown }> {
    return (
      this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as Array<{
        id: number;
        at: number;
        actor: string;
        action: string;
        correlation_id: string | null;
        detail: string;
      }>
    ).map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, correlationId: r.correlation_id, detail: json.parse(r.detail, null) }));
  }

  addAlert(level: Alert['level'], code: string, message: string, mint: string | null = null): Alert {
    const createdAt = Date.now();
    const r = this.db
      .prepare('INSERT INTO alerts (level, code, message, mint, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(level, code, message, mint, createdAt);
    return { id: Number(r.lastInsertRowid), level, code, message, mint, createdAt };
  }

  listAlerts(limit = 100): Alert[] {
    return (
      this.db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(limit) as Array<{
        id: number;
        level: Alert['level'];
        code: string;
        message: string;
        mint: string | null;
        created_at: number;
      }>
    ).map((r) => ({ id: r.id, level: r.level, code: r.code, message: r.message, mint: r.mint, createdAt: r.created_at }));
  }

  /** Returns false if the nonce has already been used (replayed command). */
  consumeNonce(nonce: string): boolean {
    try {
      this.db.prepare('INSERT INTO command_nonces (nonce, at) VALUES (?, ?)').run(nonce, Date.now());
      return true;
    } catch {
      return false;
    }
  }

  // ---- market observations -----------------------------------------------------
  upsertToken(t: TokenRow): void {
    this.db
      .prepare(
        `INSERT INTO tokens (mint, name, symbol, uri, creator, created_at, create_signature, token_program, quote_mint,
           is_mayhem, venue, complete, graduated_at, pool, first_seen_at, last_seen_at, source)
         VALUES (@mint, @name, @symbol, @uri, @creator, @createdAt, @createSignature, @tokenProgram, @quoteMint,
           @isMayhem, @venue, @complete, @graduatedAt, @pool, @firstSeenAt, @lastSeenAt, @source)
         ON CONFLICT(mint) DO UPDATE SET
           name = COALESCE(excluded.name, tokens.name),
           symbol = COALESCE(excluded.symbol, tokens.symbol),
           uri = COALESCE(excluded.uri, tokens.uri),
           creator = COALESCE(tokens.creator, excluded.creator),
           created_at = COALESCE(tokens.created_at, excluded.created_at),
           create_signature = COALESCE(tokens.create_signature, excluded.create_signature),
           token_program = COALESCE(excluded.token_program, tokens.token_program),
           quote_mint = COALESCE(excluded.quote_mint, tokens.quote_mint),
           is_mayhem = MAX(tokens.is_mayhem, excluded.is_mayhem),
           venue = excluded.venue,
           complete = MAX(tokens.complete, excluded.complete),
           graduated_at = COALESCE(tokens.graduated_at, excluded.graduated_at),
           pool = COALESCE(excluded.pool, tokens.pool),
           last_seen_at = MAX(tokens.last_seen_at, excluded.last_seen_at)`,
      )
      .run({ ...t, isMayhem: t.isMayhem ? 1 : 0, complete: t.complete ? 1 : 0 });
  }

  getToken(mint: string): TokenRow | null {
    const r = this.db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint) as Record<string, unknown> | undefined;
    return r ? rowToToken(r) : null;
  }

  insertTrades(rows: TradeRow[]): number {
    if (!rows.length) return 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO trades (mint, signature, event_index, slot, ts, side, sol_lamports, token_amount, trader, venue,
         v_sol, v_token, real_sol, real_token, fee_lamports, source)
       VALUES (@mint, @signature, @eventIndex, @slot, @ts, @side, @solLamports, @tokenAmount, @trader, @venue,
         @vSol, @vToken, @realSol, @realToken, @feeLamports, @source)`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const r of rows) n += stmt.run(r).changes;
    })();
    return n;
  }

  tradesForMint(mint: string, sinceTs: number, limit = 5000): TradeRow[] {
    return (
      this.db
        .prepare('SELECT * FROM trades WHERE mint = ? AND ts >= ? ORDER BY ts ASC, id ASC LIMIT ?')
        .all(mint, sinceTs, limit) as Array<Record<string, unknown>>
    ).map(rowToTrade);
  }

  /** Streams trades in time order for historical replay. */
  *iterateTrades(fromTs: number, toTs: number): Generator<TradeRow> {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE ts >= ? AND ts < ? ORDER BY ts ASC, id ASC');
    for (const r of stmt.iterate(fromTs, toTs) as Iterable<Record<string, unknown>>) yield rowToTrade(r);
  }

  tradeTimeRange(): { from: number | null; to: number | null; count: number } {
    const r = this.db.prepare('SELECT MIN(ts) AS f, MAX(ts) AS t, COUNT(*) AS c FROM trades').get() as {
      f: number | null;
      t: number | null;
      c: number;
    };
    return { from: r.f, to: r.t, count: r.c };
  }

  upsertCandle(c: {
    mint: string;
    minute: number;
    price: number;
    volumeSol: number;
    side: 'buy' | 'sell';
    realSol: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO candles (mint, minute, open, high, low, close, volume_sol, buys, sells, real_sol)
         VALUES (@mint, @minute, @price, @price, @price, @price, @volumeSol, @buys, @sells, @realSol)
         ON CONFLICT(mint, minute) DO UPDATE SET
           high = MAX(candles.high, excluded.high),
           low = MIN(candles.low, excluded.low),
           close = excluded.close,
           volume_sol = candles.volume_sol + excluded.volume_sol,
           buys = candles.buys + excluded.buys,
           sells = candles.sells + excluded.sells,
           real_sol = COALESCE(excluded.real_sol, candles.real_sol)`,
      )
      .run({ ...c, buys: c.side === 'buy' ? 1 : 0, sells: c.side === 'sell' ? 1 : 0 });
  }

  candles(mint: string, sinceMinute: number): Array<{
    minute: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volumeSol: number;
    buys: number;
    sells: number;
    realSol: number | null;
  }> {
    return (
      this.db
        .prepare('SELECT * FROM candles WHERE mint = ? AND minute >= ? ORDER BY minute ASC')
        .all(mint, sinceMinute) as Array<Record<string, number | null>>
    ).map((r) => ({
      minute: r.minute as number,
      open: r.open as number,
      high: r.high as number,
      low: r.low as number,
      close: r.close as number,
      volumeSol: r.volume_sol as number,
      buys: r.buys as number,
      sells: r.sells as number,
      realSol: r.real_sol ?? null,
    }));
  }

  addSnapshot(mint: string, kind: 'holders' | 'mint' | 'curve' | 'dex', source: string, data: unknown, at = Date.now()): void {
    this.db
      .prepare('INSERT INTO token_snapshots (mint, kind, observed_at, source, data) VALUES (?, ?, ?, ?, ?)')
      .run(mint, kind, at, source, json.str(data));
  }

  /** Latest snapshot observed at or before `asOf` — used by replay to avoid look-ahead. */
  snapshotAsOf<T>(mint: string, kind: string, asOf: number): { observedAt: number; data: T } | null {
    const r = this.db
      .prepare(
        'SELECT observed_at, data FROM token_snapshots WHERE mint = ? AND kind = ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT 1',
      )
      .get(mint, kind, asOf) as { observed_at: number; data: string } | undefined;
    return r ? { observedAt: r.observed_at, data: json.parse<T>(r.data, null as T) } : null;
  }

  // ---- creators ----------------------------------------------------------------
  recordCreatorLaunch(address: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO creators (address, launches, first_seen, last_seen) VALUES (?, 1, ?, ?)
         ON CONFLICT(address) DO UPDATE SET launches = creators.launches + 1, last_seen = MAX(creators.last_seen, excluded.last_seen)`,
      )
      .run(address, at, at);
  }

  recordCreatorGraduation(address: string): void {
    this.db.prepare('UPDATE creators SET graduated = graduated + 1 WHERE address = ?').run(address);
  }

  flagCreator(address: string, note: string): void {
    const at = Date.now();
    this.db
      .prepare(
        `INSERT INTO creators (address, launches, flagged, first_seen, last_seen, notes) VALUES (?, 0, 1, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET flagged = creators.flagged + 1, notes = excluded.notes`,
      )
      .run(address, at, at, json.str({ last: note, at }));
  }

  getCreator(address: string): { launches: number; graduated: number; flagged: number; firstSeen: number; lastSeen: number } | null {
    const r = this.db.prepare('SELECT * FROM creators WHERE address = ?').get(address) as
      | { launches: number; graduated: number; flagged: number; first_seen: number; last_seen: number }
      | undefined;
    return r ? { launches: r.launches, graduated: r.graduated, flagged: r.flagged, firstSeen: r.first_seen, lastSeen: r.last_seen } : null;
  }

  countRecentLaunchesByCreator(address: string, sinceTs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM tokens WHERE creator = ? AND COALESCE(created_at, first_seen_at) >= ?')
      .get(address, sinceTs) as { c: number };
    return r.c;
  }

  // ---- provider health ---------------------------------------------------------
  recordProviderHealth(name: string, status: string, latencyMs: number | null, detail: string): void {
    this.db
      .prepare('INSERT INTO provider_health (name, at, status, latency_ms, detail) VALUES (?, ?, ?, ?, ?)')
      .run(name, Date.now(), status, latencyMs, detail);
  }

  // ---- retention ---------------------------------------------------------------
  applyRetention(opts: { rawTradesHours: number; candleDays: number; assessmentDays: number }): Record<string, number> {
    const t = Date.now();
    const res: Record<string, number> = {};
    res.trades = this.db.prepare('DELETE FROM trades WHERE ts < ?').run(t - opts.rawTradesHours * 3600_000).changes;
    res.candles = this.db.prepare('DELETE FROM candles WHERE minute < ?').run(Math.floor((t - opts.candleDays * 86400_000) / 60_000)).changes;
    res.assessments = this.db
      .prepare('DELETE FROM assessments WHERE assessed_at < ? AND id NOT IN (SELECT assessment_id FROM decisions WHERE assessment_id IS NOT NULL AND approved = 1)')
      .run(t - opts.assessmentDays * 86400_000).changes;
    res.snapshots = this.db.prepare('DELETE FROM token_snapshots WHERE observed_at < ?').run(t - opts.candleDays * 86400_000).changes;
    res.providerHealth = this.db.prepare('DELETE FROM provider_health WHERE at < ?').run(t - 7 * 86400_000).changes;
    res.nonces = this.db.prepare('DELETE FROM command_nonces WHERE at < ?').run(t - 86400_000).changes;
    return res;
  }
}

function rowToTrade(r: Record<string, unknown>): TradeRow {
  return {
    mint: r.mint as string,
    signature: r.signature as string,
    eventIndex: r.event_index as number,
    slot: (r.slot as number | null) ?? null,
    ts: r.ts as number,
    side: r.side as 'buy' | 'sell',
    solLamports: r.sol_lamports as number,
    tokenAmount: r.token_amount as string,
    trader: r.trader as string,
    venue: r.venue as string,
    vSol: (r.v_sol as number | null) ?? null,
    vToken: (r.v_token as string | null) ?? null,
    realSol: (r.real_sol as number | null) ?? null,
    realToken: (r.real_token as string | null) ?? null,
    feeLamports: (r.fee_lamports as number | null) ?? null,
    source: r.source as string,
  };
}

function rowToToken(r: Record<string, unknown>): TokenRow {
  return {
    mint: r.mint as string,
    name: r.name as string | null,
    symbol: r.symbol as string | null,
    uri: r.uri as string | null,
    creator: r.creator as string | null,
    createdAt: r.created_at as number | null,
    createSignature: r.create_signature as string | null,
    tokenProgram: r.token_program as string | null,
    quoteMint: r.quote_mint as string | null,
    isMayhem: Boolean(r.is_mayhem),
    venue: r.venue as string,
    complete: Boolean(r.complete),
    graduatedAt: r.graduated_at as number | null,
    pool: r.pool as string | null,
    firstSeenAt: r.first_seen_at as number,
    lastSeenAt: r.last_seen_at as number,
    source: r.source as string,
  };
}
