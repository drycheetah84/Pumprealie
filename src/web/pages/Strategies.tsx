import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, Panel } from '../components/ui';
import { dateTime, pct, sol } from '../format';
import { useAction, usePoll } from '../hooks';

interface ParamSpec {
  default: number;
  min: number;
  max: number;
  step: number;
  description: string;
}
interface StrategyView {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  allocationPct: number | null;
  entryCriteria: string[];
  exitCriteria: string[];
  paramSpecs: Record<string, ParamSpec>;
  params: Record<string, number>;
  history: Array<{ version: number; createdAt: number; createdBy: string; knownGood: boolean; note: string | null; active: boolean }>;
  performance: { trades: number; winRate: number; netPnlSol: number; avgWinSol: number; avgLossSol: number; profitFactor: number | null; avgHoldSec: number; feesSol: number } | null;
}
interface Metrics {
  trades: number;
  netReturnSol: number;
  netReturnPct: number;
  realizedPnlSol: number;
  openExecutableSol: number;
  openMarkSol: number;
  winRate: number;
  avgWinSol: number;
  avgLossSol: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  sharpe: number | null;
  returnOnDeployedPct: number;
  feesSol: number;
  avgHoldSec: number;
  maxExposureSol: number;
  failedEntries: number;
  failedExits: number;
  unexecutableExitRate: number;
  meanQuotedExpectedPct: number | null;
  meanRealizedPct: number | null;
  byStrategy: Record<string, { trades: number; winRate: number; netPnlSol: number }>;
  byRiskTier: Record<string, { trades: number; winRate: number; netPnlSol: number }>;
  byLaunchAge: Record<string, { trades: number; winRate: number; netPnlSol: number }>;
  byMarketRegime: Record<string, { trades: number; winRate: number; netPnlSol: number }>;
}
interface Backtest {
  id: number;
  createdAt: number;
  status: string;
  error: string | null;
  params: Record<string, unknown>;
  results: { period: { from: number; to: number; split: number }; inSample: Metrics; outOfSample: Metrics; assumptions: string[]; tokensSeen: number; events: number } | null;
}
interface Proposal {
  id: number;
  createdAt: number;
  strategy: string;
  current: Record<string, number>;
  proposed: Record<string, number>;
  evaluation: { recommendation?: string; reasons?: string[]; baseline?: { outOfSample: Metrics }; proposed?: { outOfSample: Metrics | null } | null };
  status: string;
}

function MetricsTable({ ins, oos }: { ins: Metrics; oos: Metrics }) {
  const rows: Array<[string, (m: Metrics) => string]> = [
    ['Trades', (m) => String(m.trades)],
    ['Net return', (m) => `${sol(m.netReturnSol, 4)} (${pct(m.netReturnPct, 2)})`],
    ['Realized P&L', (m) => sol(m.realizedPnlSol, 4)],
    ['Open at end: executable / mark', (m) => `${sol(m.openExecutableSol, 4)} / ${sol(m.openMarkSol, 4)}`],
    ['Win rate', (m) => pct(m.winRate * 100, 1, false)],
    ['Avg win / loss', (m) => `${sol(m.avgWinSol, 4)} / ${sol(m.avgLossSol, 4)}`],
    ['Profit factor', (m) => m.profitFactor?.toFixed(2) ?? '—'],
    ['Max drawdown', (m) => pct(m.maxDrawdownPct, 2, false)],
    ['Sharpe (hourly, ann.)', (m) => m.sharpe?.toFixed(2) ?? 'n/a (<24h)'],
    ['Return on deployed', (m) => pct(m.returnOnDeployedPct, 2)],
    ['Fees', (m) => sol(m.feesSol, 5)],
    ['Avg hold', (m) => `${Math.round(m.avgHoldSec)}s`],
    ['Max exposure', (m) => sol(m.maxExposureSol, 3)],
    ['Failed entries / exits', (m) => `${m.failedEntries} / ${m.failedExits}`],
    ['Unexecutable exit rate', (m) => pct(m.unexecutableExitRate * 100, 1, false)],
    ['Quoted exp. vs realized', (m) => `${pct(m.meanQuotedExpectedPct)} vs ${pct(m.meanRealizedPct)}`],
  ];
  return (
    <table className="t">
      <thead>
        <tr>
          <th>Metric</th>
          <th className="r">In-sample</th>
          <th className="r">Out-of-sample</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, f]) => (
          <tr key={k}>
            <td className="muted">{k}</td>
            <td className="r num">{f(ins)}</td>
            <td className="r num">{f(oos)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Breakdown({ title, data }: { title: string; data: Record<string, { trades: number; winRate: number; netPnlSol: number }> }) {
  const entries = Object.entries(data);
  if (!entries.length) return null;
  return (
    <div>
      <div className="muted small" style={{ margin: '8px 0 4px' }}>
        {title}
      </div>
      <table className="t">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="r num">{v.trades}</td>
              <td className="r num">{pct(v.winRate * 100, 0, false)}</td>
              <td className={`r num ${v.netPnlSol > 0 ? 'up' : v.netPnlSol < 0 ? 'down' : ''}`}>{sol(v.netPnlSol, 4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StrategiesPage() {
  const s = usePoll<{ strategies: StrategyView[]; exitPolicy: { name: string; rules: string[] } }>('/api/strategies', 15_000);
  const b = usePoll<{ backtests: Backtest[]; dataset: { from: number | null; to: number | null; count: number } }>('/api/backtests', 5000);
  const p = usePoll<{ proposals: Proposal[] }>('/api/proposals', 8000);
  const act = useAction();
  const [edit, setEdit] = useState<Record<string, Record<string, string>>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [trainFraction, setTrainFraction] = useState('0.7');
  const sel = b.data?.backtests.find((x) => x.id === selected) ?? b.data?.backtests.find((x) => x.status === 'completed') ?? null;

  return (
    <>
      <ErrorBox error={s.error ?? act.error} />
      <Panel title="Backtesting" sub={b.data?.dataset.count ? `${b.data.dataset.count.toLocaleString()} recorded trades · ${dateTime(b.data.dataset.from)} → ${dateTime(b.data.dataset.to)}` : 'no recorded market data yet'}>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <label className="field">
            In-sample fraction
            <input value={trainFraction} onChange={(e) => setTrainFraction(e.target.value)} style={{ width: 90 }} />
          </label>
          <button
            className="primary"
            disabled={act.busy}
            onClick={() =>
              act.run(async () => {
                const r = await api.command<{ id: number }>('POST', '/api/backtests', { trainFraction: Number(trainFraction) });
                setSelected(r.id);
                b.reload();
              })
            }
          >
            Run backtest (all enabled strategies)
          </button>
          <span className="muted small">Replays recorded on-chain trades in time order with the live risk manager, strategies, fees and latency. No look-ahead: decisions use only past data.</span>
        </div>
        <div className="grid g2">
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Started</th>
                  <th>Status</th>
                  <th className="r">OOS trades</th>
                  <th className="r">OOS net</th>
                </tr>
              </thead>
              <tbody>
                {(b.data?.backtests ?? []).map((x) => (
                  <tr key={x.id} className="click" onClick={() => setSelected(x.id)}>
                    <td>{x.id}</td>
                    <td className="muted small">{dateTime(x.createdAt)}</td>
                    <td>
                      <span className={`badge ${x.status === 'completed' ? 'up' : x.status === 'failed' ? 'down' : 'info'}`}>{x.status}</span>
                    </td>
                    <td className="r num">{x.results?.outOfSample.trades ?? '—'}</td>
                    <td className="r num">{x.results ? pct(x.results.outOfSample.netReturnPct, 2) : (x.error ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            {sel?.results ? (
              <>
                <div className="muted small" style={{ marginBottom: 6 }}>
                  Backtest #{sel.id}: in-sample {dateTime(sel.results.period.from)} → {dateTime(sel.results.period.split)}, out-of-sample → {dateTime(sel.results.period.to)} · {sel.results.tokensSeen} tokens ·{' '}
                  {sel.results.events.toLocaleString()} events
                </div>
                <MetricsTable ins={sel.results.inSample} oos={sel.results.outOfSample} />
              </>
            ) : (
              <div className="empty">{sel?.status === 'running' ? 'Running…' : (sel?.error ?? 'Select a completed backtest')}</div>
            )}
          </div>
        </div>
        {sel?.results && (
          <div className="grid g4" style={{ marginTop: 10 }}>
            <Breakdown title="Out-of-sample by strategy" data={sel.results.outOfSample.byStrategy} />
            <Breakdown title="by risk tier" data={sel.results.outOfSample.byRiskTier} />
            <Breakdown title="by launch age" data={sel.results.outOfSample.byLaunchAge} />
            <Breakdown title="by market regime" data={sel.results.outOfSample.byMarketRegime} />
          </div>
        )}
        {sel?.results && <div className="muted small" style={{ marginTop: 8 }}>Assumptions: {sel.results.assumptions.join(' · ')}</div>}
      </Panel>

      {(p.data?.proposals.length ?? 0) > 0 && (
        <Panel title="Optimizer proposals" sub="strategy parameters only — safety limits are never changed by optimization" pad={false}>
          <table className="t">
            <thead>
              <tr>
                <th>#</th>
                <th>Strategy</th>
                <th>Recommendation</th>
                <th className="r">Baseline OOS</th>
                <th className="r">Proposed OOS</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.data!.proposals.map((x) => (
                <tr key={x.id}>
                  <td>{x.id}</td>
                  <td>{x.strategy}</td>
                  <td className="small" style={{ whiteSpace: 'normal' }}>
                    <span className={`badge ${x.evaluation.recommendation === 'accept' ? 'up' : 'down'}`}>{x.evaluation.recommendation}</span> {x.evaluation.reasons?.join('; ')}
                  </td>
                  <td className="r num">{x.evaluation.baseline ? pct(x.evaluation.baseline.outOfSample.netReturnPct, 2) : '—'}</td>
                  <td className="r num">{x.evaluation.proposed?.outOfSample ? pct(x.evaluation.proposed.outOfSample.netReturnPct, 2) : '—'}</td>
                  <td>{x.status}</td>
                  <td>
                    {x.status === 'proposed' && (
                      <>
                        <button disabled={act.busy} onClick={() => act.run(async () => { await api.command('POST', `/api/proposals/${x.id}/decision`, { accept: true }); p.reload(); s.reload(); })}>
                          Accept
                        </button>{' '}
                        <button className="ghost" disabled={act.busy} onClick={() => act.run(async () => { await api.command('POST', `/api/proposals/${x.id}/decision`, { accept: false }); p.reload(); })}>
                          Reject
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {s.data?.strategies.map((st) => {
        const e = edit[st.id] ?? {};
        const changed = Object.keys(e).length > 0;
        return (
          <Panel
            key={st.id}
            title={st.name}
            sub={`${st.id} · ${st.enabled ? 'enabled' : 'disabled'}${st.allocationPct !== null ? ` · allocation ${st.allocationPct}%` : ''}`}
            right={
              <span style={{ display: 'flex', gap: 6 }}>
                <button disabled={act.busy} onClick={() => act.run(async () => { await api.command('POST', `/api/strategies/${st.id}/optimize`, { trainFraction: Number(trainFraction), candidates: 12 }); })}>
                  Optimize (propose)
                </button>
                <button disabled={act.busy} onClick={() => act.run(async () => { await api.command('POST', `/api/strategies/${st.id}/known-good`); s.reload(); })}>
                  Mark known-good
                </button>
                <button disabled={act.busy} onClick={() => act.run(async () => { await api.command('POST', `/api/strategies/${st.id}/revert`); s.reload(); })}>
                  Revert to known-good
                </button>
              </span>
            }
          >
            <div className="grid g3">
              <div>
                <div className="muted small">{st.description}</div>
                <div className="muted small" style={{ marginTop: 8 }}>
                  Entry criteria
                </div>
                <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
                  {st.entryCriteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <div className="muted small">Exit: {st.exitCriteria.join('; ')}</div>
              </div>
              <div>
                <div className="muted small" style={{ marginBottom: 4 }}>
                  Parameters (v{st.history.find((h) => h.active)?.version ?? '?'})
                </div>
                <table className="t">
                  <tbody>
                    {Object.entries(st.paramSpecs).map(([k, spec]) => (
                      <tr key={k} title={spec.description}>
                        <td className="small">{k}</td>
                        <td className="r">
                          <input
                            style={{ width: 90, textAlign: 'right' }}
                            value={e[k] ?? String(st.params[k])}
                            onChange={(ev) => setEdit({ ...edit, [st.id]: { ...e, [k]: ev.target.value } })}
                          />
                        </td>
                        <td className="faint small">
                          {spec.min}–{spec.max}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {changed && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button
                      className="primary"
                      disabled={act.busy}
                      onClick={() =>
                        act.run(async () => {
                          await api.command('PUT', `/api/strategies/${st.id}/params`, { params: Object.fromEntries(Object.entries(e).map(([k, v]) => [k, Number(v)])), note: 'dashboard edit' });
                          setEdit({ ...edit, [st.id]: {} });
                          s.reload();
                        })
                      }
                    >
                      Save as new version
                    </button>
                    <button onClick={() => setEdit({ ...edit, [st.id]: {} })}>Discard</button>
                  </div>
                )}
              </div>
              <div>
                <div className="muted small" style={{ marginBottom: 4 }}>
                  Forward performance (closed positions)
                </div>
                {st.performance ? (
                  <dl className="kv">
                    <dt>Trades</dt>
                    <dd>{st.performance.trades}</dd>
                    <dt>Win rate</dt>
                    <dd>{pct(st.performance.winRate * 100, 0, false)}</dd>
                    <dt>Net P&L</dt>
                    <dd className={st.performance.netPnlSol >= 0 ? 'up' : 'down'}>{sol(st.performance.netPnlSol, 4)}</dd>
                    <dt>Avg win / loss</dt>
                    <dd>
                      {sol(st.performance.avgWinSol, 4)} / {sol(st.performance.avgLossSol, 4)}
                    </dd>
                    <dt>Profit factor</dt>
                    <dd>{st.performance.profitFactor?.toFixed(2) ?? '—'}</dd>
                    <dt>Avg hold</dt>
                    <dd>{Math.round(st.performance.avgHoldSec)}s</dd>
                  </dl>
                ) : (
                  <div className="muted small">No closed trades yet.</div>
                )}
                <div className="muted small" style={{ margin: '8px 0 4px' }}>
                  Version history
                </div>
                {st.history.slice(0, 5).map((h) => (
                  <div key={h.version} className="small">
                    v{h.version} {h.active && <span className="badge accent">active</span>} {h.knownGood && <span className="badge up">known-good</span>} <span className="muted">{h.note} · {h.createdBy}</span>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        );
      })}
      {s.data && (
        <Panel title={s.data.exitPolicy.name}>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {s.data.exitPolicy.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
