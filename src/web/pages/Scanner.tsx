import { useEffect, useMemo, useState } from 'react';
import type { TokenSummary } from '../../shared/types';
import { useLive } from '../App';
import { ScoreBar } from '../components/charts';
import { ActionBadge, ErrorBox, Flags, Panel } from '../components/ui';
import { ago, cls, pct, price, sol } from '../format';
import { usePoll } from '../hooks';

const COLS: Array<[string, string, string?]> = [
  ['token', 'Token'],
  ['age', 'Age', 'age'],
  ['price', 'Price (SOL)'],
  ['liquidity', 'Liquidity / curve', 'liquidity'],
  ['volume', 'Vol 5m · 1h', 'volume'],
  ['momentum', 'Mom. 5m', 'momentum'],
  ['risk', 'Risk', 'risk'],
  ['conf', 'Data conf.'],
  ['opportunity', 'Exp. net', 'opportunity'],
  ['exit', 'Exit liq.'],
  ['action', 'Action'],
  ['reason', 'Reason'],
];

export function ScannerPage() {
  const { lastMessage } = useLive();
  const [sort, setSort] = useState('volume');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [maxRisk, setMaxRisk] = useState('');
  const [minLiq, setMinLiq] = useState('');
  const [minMom, setMinMom] = useState('');
  const [maxAge, setMaxAge] = useState('');
  const [strategy, setStrategy] = useState('');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const qs = new URLSearchParams({ sort, dir, limit: '300' });
  if (maxRisk) qs.set('maxRisk', maxRisk);
  if (minLiq) qs.set('minLiquidity', minLiq);
  if (minMom) qs.set('minMomentum', minMom);
  if (maxAge) qs.set('maxAgeMin', maxAge);
  if (strategy) qs.set('strategy', strategy);
  if (action) qs.set('action', action);
  if (q) qs.set('q', q);
  const { data, error } = usePoll<{ tokens: TokenSummary[] }>(`/api/tokens?${qs.toString()}`, 4000);
  const [rows, setRows] = useState<TokenSummary[]>([]);
  useEffect(() => {
    if (data) setRows(data.tokens);
  }, [data]);
  // Merge streamed updates for rows already displayed (filters are re-applied on the next poll).
  useEffect(() => {
    if (lastMessage?.type !== 'tokens') return;
    const upd = new Map((lastMessage.data as TokenSummary[]).map((t) => [t.mint, t]));
    setRows((r) => r.map((x) => upd.get(x.mint) ?? x));
  }, [lastMessage]);

  const counts = useMemo(() => {
    const c = { buy: 0, watch: 0, skip: 0 };
    for (const r of rows) if (r.action in c) c[r.action as keyof typeof c]++;
    return c;
  }, [rows]);

  const toggle = (k?: string) => {
    if (!k) return;
    if (k === sort) setDir(dir === 'desc' ? 'asc' : 'desc');
    else {
      setSort(k);
      setDir(k === 'risk' ? 'asc' : 'desc');
    }
  };

  return (
    <>
      <Panel title="Filters" sub={`${rows.length} tokens · ${counts.buy} buy · ${counts.watch} watch · ${counts.skip} skip`}>
        <div className="toolbar">
          <label className="field">
            Search
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="symbol, name or mint" style={{ width: 200 }} />
          </label>
          <label className="field">
            Max risk
            <input value={maxRisk} onChange={(e) => setMaxRisk(e.target.value)} placeholder="0-100" style={{ width: 80 }} />
          </label>
          <label className="field">
            Min liquidity (SOL)
            <input value={minLiq} onChange={(e) => setMinLiq(e.target.value)} style={{ width: 110 }} />
          </label>
          <label className="field">
            Min 5m momentum %
            <input value={minMom} onChange={(e) => setMinMom(e.target.value)} style={{ width: 110 }} />
          </label>
          <label className="field">
            Max age (min)
            <input value={maxAge} onChange={(e) => setMaxAge(e.target.value)} style={{ width: 90 }} />
          </label>
          <label className="field">
            Strategy
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <option value="">any</option>
              <option value="momentum">momentum</option>
              <option value="volume_acceleration">volume acceleration</option>
              <option value="early_launch">early launch</option>
              <option value="pullback">pullback</option>
            </select>
          </label>
          <label className="field">
            Action
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">any</option>
              <option value="buy">buy</option>
              <option value="watch">watch</option>
              <option value="skip">skip</option>
            </select>
          </label>
        </div>
      </Panel>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                {COLS.map(([k, label, sk]) => (
                  <th key={k} className={`${sk ? 'sortable' : ''} ${['price', 'volume', 'momentum', 'opportunity', 'exit'].includes(k) ? 'r' : ''}`} onClick={() => toggle(sk)}>
                    {label}
                    {sk === sort ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.mint} className="click" onClick={() => (location.hash = `/token/${t.mint}`)}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{t.symbol ?? '—'}</div>
                    <div className="faint mono small">{t.mint.slice(0, 4)}…{t.mint.slice(-4)}</div>
                  </td>
                  <td className="muted">{t.createdAt ? ago(t.createdAt) : '—'}</td>
                  <td className="r num">{price(t.priceSol)}</td>
                  <td>
                    <div className="num">
                      {sol(t.realSolReserves, 2)} SOL {t.venue === 'pumpswap' ? <span className="badge info">pool</span> : null}
                    </div>
                    {t.bondingProgressPct !== null && t.venue === 'bonding_curve' && (
                      <div style={{ width: 90, marginTop: 3 }}>
                        <ScoreBar value={t.bondingProgressPct} color="var(--accent)" />
                      </div>
                    )}
                  </td>
                  <td className="r num">
                    {sol(t.volume5mSol, 1)} · <span className="muted">{sol(t.volume1hSol, 0)}</span>
                  </td>
                  <td className={`r num ${cls(t.momentum5mPct)}`}>{pct(t.momentum5mPct)}</td>
                  <td style={{ minWidth: 110 }}>
                    <div className="num small">
                      {t.riskScore?.toFixed(0) ?? '—'} <span className="muted">{t.riskTier?.replace('_', ' ')}</span>
                    </div>
                    {t.riskScore !== null && <ScoreBar value={t.riskScore} />}
                  </td>
                  <td className="num muted">{t.dataConfidence !== null ? `${Math.round(t.dataConfidence * 100)}%` : '—'}</td>
                  <td className={`r num ${cls(t.expectedNetPct)}`}>{pct(t.expectedNetPct)}</td>
                  <td className="r num">{sol(t.exitLiquiditySol, 4)}</td>
                  <td>
                    <ActionBadge action={t.action} />
                  </td>
                  <td className="small" style={{ maxWidth: 340, whiteSpace: 'normal' }}>
                    {t.criticalFlags.length ? <Flags flags={t.criticalFlags} /> : <span className="muted">{t.actionReason}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">Waiting for market data… tokens appear after their first observed trades.</div>}
        </div>
      </section>
      <div className="muted small">
        Liquidity = withdrawable SOL on the curve/pool. Exp. net = scenario-weighted net return after fees, impact and latency for the reference position size. Exit liq. = proceeds of an
        immediate full exit of that position. Risk scores are heuristic, not probabilities.
      </div>
    </>
  );
}
