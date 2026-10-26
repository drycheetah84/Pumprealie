import crypto from 'node:crypto';
import type { TradingMode } from '../../shared/types';
import type { Env } from '../config/env';
import type { RiskSettings } from '../config/riskSettings';
import type { Store } from '../db/store';
import type { EventBus } from '../lib/events';

export interface LiveChallenge {
  id: string;
  phrase: string;
  expiresAt: number;
  wallet: string;
  mode: TradingMode;
  limits: Pick<RiskSettings, 'maxPositionPct' | 'maxExposurePct' | 'maxDailyLossPct' | 'maxDrawdownPct' | 'maxSlippagePct' | 'maxRiskScore'> & {
    hardMaxPositionSol: number;
    capitalSol: number;
  };
  paperTradesClosed: number;
}

/**
 * Trading mode state machine. Paper/offline can be switched freely. Live requires:
 * LIVE_TRADING_ENABLED=true, a loaded signer, no kill switch, enough closed paper trades,
 * and a two-step confirmation (prepare → type the exact phrase within 2 minutes).
 * The "armed" flag is never restored after a restart: live must be re-confirmed.
 */
export class ModeController {
  private armed = false;
  private challenge: LiveChallenge | null = null;

  constructor(
    private readonly env: Env,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly deps: { walletPublicKey: () => string | null; paperTradesClosed: () => number; settings: () => RiskSettings },
  ) {
    const persisted = store.getState<TradingMode | null>('trading_mode', null);
    let mode: TradingMode = persisted ?? env.TRADING_MODE;
    if (mode === 'live' && (!env.LIVE_TRADING_ENABLED || !deps.walletPublicKey())) mode = 'paper';
    store.setState('trading_mode', mode);
    if (mode === 'live') {
      store.addAlert('warning', 'LIVE_DISARMED_ON_RESTART', 'Restarted in live mode: new live entries are disarmed until re-confirmed; exits and reconciliation continue.');
    }
  }

  get mode(): TradingMode {
    return this.store.getState<TradingMode>('trading_mode', 'paper');
  }

  get liveArmed(): boolean {
    return this.mode === 'live' && this.armed;
  }

  liveBlockers(): string[] {
    const r: string[] = [];
    if (!this.env.LIVE_TRADING_ENABLED) r.push('LIVE_TRADING_ENABLED is not true in the server environment');
    if (!this.deps.walletPublicKey()) r.push('no wallet signer configured (WALLET_KEYPAIR_PATH)');
    if (this.store.getKillSwitch().active) r.push('kill switch is active');
    const closed = this.deps.paperTradesClosed();
    if (closed < this.env.MIN_PAPER_TRADES_FOR_LIVE) r.push(`only ${closed} closed paper trades; ${this.env.MIN_PAPER_TRADES_FOR_LIVE} required`);
    return r;
  }

  setMode(mode: 'paper' | 'offline', actor: string, correlationId: string | null) {
    const prev = this.mode;
    this.armed = false;
    this.store.setState('trading_mode', mode);
    this.store.audit(actor, 'mode.set', correlationId, null, { from: prev, to: mode });
    this.bus.emit('status:changed', { reason: `mode ${mode}` });
  }

  prepareLive(actor: string, correlationId: string | null): LiveChallenge {
    const blockers = this.liveBlockers();
    if (blockers.length) throw new Error(`live trading cannot be enabled: ${blockers.join('; ')}`);
    const wallet = this.deps.walletPublicKey()!;
    const s = this.deps.settings();
    this.challenge = {
      id: crypto.randomUUID(),
      phrase: `ENABLE LIVE TRADING ${wallet.slice(0, 4)}${wallet.slice(-4)}`,
      expiresAt: Date.now() + 120_000,
      wallet,
      mode: this.mode,
      limits: {
        maxPositionPct: s.maxPositionPct,
        maxExposurePct: s.maxExposurePct,
        maxDailyLossPct: s.maxDailyLossPct,
        maxDrawdownPct: s.maxDrawdownPct,
        maxSlippagePct: s.maxSlippagePct,
        maxRiskScore: s.maxRiskScore,
        hardMaxPositionSol: this.env.HARD_MAX_POSITION_SOL,
        capitalSol: this.env.TRADING_CAPITAL_SOL,
      },
      paperTradesClosed: this.deps.paperTradesClosed(),
    };
    this.store.audit(actor, 'live.prepare', correlationId, null, { wallet, expiresAt: this.challenge.expiresAt });
    return this.challenge;
  }

  confirmLive(challengeId: string, phrase: string, actor: string, correlationId: string | null) {
    const c = this.challenge;
    if (!c || c.id !== challengeId) throw new Error('unknown or superseded challenge');
    if (Date.now() > c.expiresAt) {
      this.challenge = null;
      throw new Error('challenge expired');
    }
    if (phrase.trim() !== c.phrase) throw new Error('confirmation phrase does not match');
    const blockers = this.liveBlockers();
    if (blockers.length) throw new Error(`live trading cannot be enabled: ${blockers.join('; ')}`);
    this.challenge = null;
    this.store.setState('trading_mode', 'live');
    this.armed = true;
    this.store.audit(actor, 'live.confirm', correlationId, null, { wallet: c.wallet, limits: c.limits });
    this.store.addAlert('warning', 'LIVE_ENABLED', `Live trading armed for wallet ${c.wallet} by ${actor}`);
    this.bus.emit('status:changed', { reason: 'live armed' });
  }

  disarm(actor: string, reason: string) {
    if (!this.armed) return;
    this.armed = false;
    this.store.audit(actor, 'live.disarm', null, null, { reason });
    this.bus.emit('status:changed', { reason: 'live disarmed' });
  }
}
