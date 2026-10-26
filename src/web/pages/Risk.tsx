import { useEffect, useState } from 'react';
import type { KillSwitchState } from '../../shared/types';
import { api } from '../api';
import { ModePill, useLive } from '../App';
import { ConfirmModal, ErrorBox, Panel } from '../components/ui';
import { dateTime } from '../format';
import { useAction, usePoll } from '../hooks';

interface RiskResp {
  settings: Record<string, unknown> & { enabledStrategies: string[]; riskWeights: Record<string, number>; emergencyPolicy: string };
  hardLimits: Record<string, number>;
  killSwitch: KillSwitchState;
  mode: string;
  liveArmed: boolean;
}

const NUMERIC: Array<[string, string, string]> = [
  ['maxPositionPct', 'Max position (% of capital)', 'maxPositionPct'],
  ['maxExposurePct', 'Max aggregate exposure (%)', 'maxExposurePct'],
  ['maxDailyLossPct', 'Max daily loss (%)', 'maxDailyLossPct'],
  ['maxDrawdownPct', 'Max drawdown before suspension (%)', 'maxDrawdownPct'],
  ['maxSlippagePct', 'Max slippage (%)', 'maxSlippagePct'],
  ['maxPriceImpactPct', 'Max price impact (%)', ''],
  ['minExitLiquiditySol', 'Min exit liquidity (SOL)', ''],
  ['maxRiskScore', 'Max risk score', 'maxRiskScore'],
  ['minExpectedNetReturnPct', 'Min expected net return (%)', ''],
  ['minRewardToRisk', 'Min reward/risk', ''],
  ['maxConsecutiveLosses', 'Max consecutive losses', ''],
  ['feeReserveSol', 'Fee reserve (SOL)', ''],
  ['priorityFeeMicroLamports', 'Priority fee (µlamports/CU)', ''],
  ['maxTxFeeSol', 'Max tx fee (SOL)', 'maxTxFeeSol'],
];
const STRATS = ['momentum', 'volume_acceleration', 'early_launch', 'pullback'];

export function RiskPage() {
  const { status, refreshStatus } = useLive();
  const { data, error, reload } = usePoll<RiskResp>('/api/risk-controls', 10_000);
  const req = usePoll<{ blockers: string[]; wallet: string | null }>('/api/mode/live/requirements', 10_000);
  const [form, setForm] = useState<Record<string, string>>({});
  const [strategies, setStrategies] = useState<string[]>([]);
  const [policy, setPolicy] = useState('reduce');
  const [adjustments, setAdjustments] = useState<string[]>([]);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearText, setClearText] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; phrase: string; expiresAt: number; wallet: string; limits: Record<string, number>; paperTradesClosed: number } | null>(null);
  const [phrase, setPhrase] = useState('');
  const act = useAction();

  useEffect(() => {
    if (!data) return;
    setForm(Object.fromEntries(NUMERIC.map(([k]) => [k, String(data.settings[k])])));
    setStrategies(data.settings.enabledStrategies);
    setPolicy(data.settings.emergencyPolicy);
  }, [data]);

  const save = () =>
    act.run(async () => {
      const patch: Record<string, unknown> = Object.fromEntries(NUMERIC.map(([k]) => [k, Number(form[k])]));
      patch.enabledStrategies = strategies;
      patch.emergencyPolicy = policy;
      const r = await api.command<{ adjustments: string[] }>('PUT', '/api/risk-controls', patch);
      setAdjustments(r.adjustments);
      reload();
      refreshStatus();
    });

  return (
    <>
      <ErrorBox error={error ?? act.error} />
      <div className="grid g2">
        <Panel title="Trading mode" right={<ModePill status={status} />}>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button disabled={act.busy || status?.mode === 'paper'} onClick={() => act.run(async () => { await api.command('POST', '/api/mode', { mode: 'paper' }); refreshStatus(); })}>
                Paper trading
              </button>
              <button disabled={act.busy || status?.mode === 'offline'} onClick={() => act.run(async () => { await api.command('POST', '/api/mode', { mode: 'offline' }); refreshStatus(); })}>
                Offline (analysis only)
              </button>
              {status?.liveArmed ? (
                <button className="danger" disabled={act.busy} onClick={() => act.run(async () => { await api.command('POST', '/api/mode/live/disarm'); refreshStatus(); })}>
                  Disarm live trading
                </button>
              ) : (
                <button
                  className="danger"
                  disabled={act.busy || (req.data?.blockers.length ?? 1) > 0}
                  onClick={() =>
                    act.run(async () => {
                      const r = await api.command<{ challenge: NonNullable<typeof challenge> }>('POST', '/api/mode/live/prepare');
                      setPhrase('');
                      setChallenge(r.challenge);
                    })
                  }
                >
                  Enable live trading…
                </button>
              )}
            </div>
            {(req.data?.blockers.length ?? 0) > 0 && (
              <div className="banner warn small">
                <div>
                  Live trading unavailable:
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {req.data!.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <div className="muted small">Live activation requires LIVE_TRADING_ENABLED=true on the server, a configured local signer, enough closed paper trades and typing a confirmation phrase. It is never restored automatically after a restart.</div>
          </div>
        </Panel>
        <Panel title="Kill switch">
          {data?.killSwitch.active ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <div className="banner danger">
                Active since {dateTime(data.killSwitch.changedAt)} by {data.killSwitch.changedBy}: {data.killSwitch.reason}
              </div>
              <button onClick={() => setClearOpen(true)}>Clear kill switch…</button>
            </div>
          ) : (
            <div className="muted">Inactive. Use “Emergency stop” in the top bar to block all new entries immediately. The state is persisted before the command is acknowledged and survives restarts.</div>
          )}
          <div className="muted small" style={{ marginTop: 10 }}>
            Emergency policy on loss/drawdown breach:{' '}
            <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
              <option value="reduce">reduce — exit positions while quotes are executable</option>
              <option value="hold">hold — stop entries only</option>
            </select>
          </div>
        </Panel>
      </div>

      <Panel title="Risk limits" sub="runtime values are clamped to the server's hard limits (HARD_* environment variables)">
        <div className="grid g4">
          {NUMERIC.map(([k, label, hk]) => (
            <label key={k} className="field">
              {label}
              <input value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              {hk && data?.hardLimits[hk] !== undefined && <span className="faint">hard limit {data.hardLimits[hk]}</span>}
            </label>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="muted small" style={{ marginBottom: 6 }}>
            Allowed strategies
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {STRATS.map((s) => (
              <label key={s} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={strategies.includes(s)} onChange={(e) => setStrategies(e.target.checked ? [...strategies, s] : strategies.filter((x) => x !== s))} />
                {s}
              </label>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
          <button className="primary" disabled={act.busy} onClick={save}>
            Save risk controls
          </button>
          <span className="muted small">Hard ceilings: position {data?.hardLimits.maxPositionSol} SOL / {data?.hardLimits.maxPositionPct}% · every change is audit-logged.</span>
        </div>
        {adjustments.length > 0 && <div className="banner warn small" style={{ marginTop: 10 }}>Clamped: {adjustments.join('; ')}</div>}
      </Panel>

      <Panel title="Risk model weights" sub="initial engineering defaults — validate against history before changing">
        <div className="grid g6">
          {data &&
            Object.entries(data.settings.riskWeights).map(([k, v]) => (
              <div key={k} className="stat">
                <div className="label">{k.replace(/_/g, ' ')}</div>
                <div className="value">{(v * 100).toFixed(0)}%</div>
              </div>
            ))}
        </div>
      </Panel>

      {clearOpen && (
        <ConfirmModal
          title="Clear kill switch"
          confirmLabel="Clear"
          busy={act.busy}
          error={act.error}
          disabled={clearText !== 'CLEAR KILL SWITCH'}
          onCancel={() => setClearOpen(false)}
          onConfirm={() =>
            act.run(async () => {
              await api.command('POST', '/api/emergency/clear', { confirm: clearText });
              setClearOpen(false);
              setClearText('');
              reload();
              refreshStatus();
            })
          }
        >
          <p>Type CLEAR KILL SWITCH to allow new entries again (subject to all other risk gates).</p>
          <input value={clearText} onChange={(e) => setClearText(e.target.value)} placeholder="CLEAR KILL SWITCH" />
        </ConfirmModal>
      )}
      {challenge && (
        <ConfirmModal
          title="Enable LIVE trading"
          danger
          confirmLabel="Arm live trading"
          busy={act.busy}
          error={act.error}
          disabled={phrase !== challenge.phrase}
          onCancel={() => setChallenge(null)}
          onConfirm={() =>
            act.run(async () => {
              await api.command('POST', '/api/mode/live/confirm', { challengeId: challenge.id, phrase });
              setChallenge(null);
              refreshStatus();
            })
          }
        >
          <div className="banner danger small">Real transactions will be signed and sent from this wallet. Losses can be total; risk scores are not guarantees.</div>
          <dl className="kv">
            <dt>Wallet</dt>
            <dd>{challenge.wallet}</dd>
            <dt>Current mode</dt>
            <dd>{status?.mode}</dd>
            <dt>Configured capital</dt>
            <dd>{challenge.limits.capitalSol} SOL</dd>
            <dt>Max position</dt>
            <dd>
              {challenge.limits.maxPositionPct}% (hard cap {challenge.limits.hardMaxPositionSol} SOL)
            </dd>
            <dt>Max exposure</dt>
            <dd>{challenge.limits.maxExposurePct}%</dd>
            <dt>Daily loss / drawdown</dt>
            <dd>
              {challenge.limits.maxDailyLossPct}% / {challenge.limits.maxDrawdownPct}%
            </dd>
            <dt>Max slippage · risk</dt>
            <dd>
              {challenge.limits.maxSlippagePct}% · {challenge.limits.maxRiskScore}
            </dd>
            <dt>Closed paper trades</dt>
            <dd>{challenge.paperTradesClosed}</dd>
            <dt>Expires</dt>
            <dd>{new Date(challenge.expiresAt).toLocaleTimeString()}</dd>
          </dl>
          <div className="small">
            Type exactly: <span className="mono accent">{challenge.phrase}</span>
          </div>
          <input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={challenge.phrase} />
        </ConfirmModal>
      )}
    </>
  );
}
