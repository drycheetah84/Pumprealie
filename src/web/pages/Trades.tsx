import { useState } from 'react';
import type { OrderRecord, PositionRecord } from '../../shared/types';
import { ErrorBox, Panel } from '../components/ui';
import { dateTime, short, sol, solscanTx, time, tokens } from '../format';
import { usePoll } from '../hooks';

const STATUS_CLASS: Record<string, string> = {
  SETTLED: 'up',
  FAILED: 'down',
  EXPIRED: 'down',
  REJECTED: 'down',
  CANCELLED: '',
  RECONCILING: 'warn',
  SUBMITTED: 'info',
  CONFIRMED: 'info',
  VALIDATED: 'info',
  CREATED: 'info',
};

function OrderDetail({ id }: { id: number }) {
  const { data, error } = usePoll<{ order: OrderRecord; events: Array<{ at: number; from: string | null; to: string; detail: unknown }>; position: PositionRecord | null }>(`/api/trades/${id}`, 5000);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="muted">Loading…</div>;
  const o = data.order;
  return (
    <div className="grid g2">
      <dl className="kv">
        <dt>Idempotency key</dt>
        <dd>{o.idempotencyKey}</dd>
        <dt>Mint</dt>
        <dd>
          <a href={`#/token/${o.mint}`}>{o.mint}</a>
        </dd>
        <dt>Requested</dt>
        <dd>{o.side === 'buy' ? `${sol(o.requestedSol, 5)} SOL` : `${tokens(o.requestedTokensRaw)} tokens`}</dd>
        <dt>Quoted</dt>
        <dd>
          {tokens(o.quotedTokensRaw)} tokens · {sol(o.quotedSol, 6)} SOL
        </dd>
        <dt>Filled</dt>
        <dd>
          {tokens(o.filledTokensRaw)} tokens · {sol(o.filledSol, 6)} SOL
        </dd>
        <dt>Network fee</dt>
        <dd>{sol(o.feeSol, 6)} SOL</dd>
        <dt>Max slippage</dt>
        <dd>{o.maxSlippagePct}%</dd>
        <dt>Signature</dt>
        <dd>{o.signature ? o.mode === 'live' ? <a href={solscanTx(o.signature)} target="_blank" rel="noreferrer">{o.signature}</a> : `${o.signature} (simulated)` : '—'}</dd>
        <dt>Attempts</dt>
        <dd>{o.attempts}</dd>
        <dt>Error</dt>
        <dd className={o.error ? 'down' : ''}>{o.error ?? '—'}</dd>
        <dt>Reason</dt>
        <dd style={{ fontFamily: 'var(--sans)' }}>{o.reason}</dd>
      </dl>
      <div>
        <div className="muted small" style={{ marginBottom: 6 }}>
          Lifecycle
        </div>
        <div className="list">
          {data.events.map((e, i) => (
            <div key={i} className="finding small">
              <span className={`badge ${STATUS_CLASS[e.to] ?? ''}`}>{e.to}</span>
              <span className="pre">{e.detail ? JSON.stringify(e.detail) : ''}</span>
              <span className="meta">{time(e.at)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TradesPage() {
  const [mode, setMode] = useState<'' | 'paper' | 'live'>('');
  const [selected, setSelected] = useState<number | null>(null);
  const { data, error } = usePoll<{ orders: OrderRecord[] }>(`/api/trades?limit=500${mode ? `&mode=${mode}` : ''}`, 5000);
  const orders = data?.orders ?? [];
  return (
    <>
      <div className="toolbar">
        <label className="field">
          Book
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="">all</option>
            <option value="paper">paper</option>
            <option value="live">live</option>
          </select>
        </label>
        <span className="muted small">Lifecycle: CREATED → VALIDATED → SUBMITTED → CONFIRMED → SETTLED, with FAILED / EXPIRED / REJECTED / CANCELLED / RECONCILING.</span>
      </div>
      <ErrorBox error={error} />
      {selected !== null && (
        <Panel title={`Order #${selected}`} right={<button onClick={() => setSelected(null)}>Close</button>}>
          <OrderDetail id={selected} />
        </Panel>
      )}
      <section className="panel">
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>#</th>
                <th>Created</th>
                <th>Book</th>
                <th>Side</th>
                <th>Token</th>
                <th>Strategy</th>
                <th>Status</th>
                <th className="r">Requested</th>
                <th className="r">Filled SOL</th>
                <th className="r">Fee</th>
                <th>Signature</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="click" onClick={() => setSelected(o.id)}>
                  <td className="muted">{o.id}</td>
                  <td className="muted small">{dateTime(o.createdAt)}</td>
                  <td>
                    <span className={`badge ${o.mode === 'live' ? 'down' : 'info'}`}>{o.mode}</span>
                  </td>
                  <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side}</td>
                  <td className="mono small">{short(o.mint)}</td>
                  <td>{o.strategy}</td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[o.status] ?? ''}`}>{o.status}</span>
                  </td>
                  <td className="r num">{o.side === 'buy' ? sol(o.requestedSol, 4) : tokens(o.requestedTokensRaw)}</td>
                  <td className="r num">{sol(o.filledSol, 5)}</td>
                  <td className="r num muted">{sol(o.feeSol, 6)}</td>
                  <td className="mono small">{o.signature ? short(o.signature, 5) : '—'}</td>
                  <td className="small muted ellipsis" style={{ maxWidth: 280 }} title={o.error ?? o.reason}>
                    {o.error ?? o.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!orders.length && <div className="empty">No orders yet</div>}
        </div>
      </section>
    </>
  );
}
