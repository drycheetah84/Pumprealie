import { useState } from 'react';
import type { CriticalFlag, PortfolioSummary, PositionRecord } from '../../shared/types';
import { api } from '../api';
import { useLive } from '../App';
import { LineChart } from '../components/charts';
import { ConfirmModal, ErrorBox, Flags, Panel, Stat } from '../components/ui';
import { ago, cls, dateTime, pct, price, sol, tokens } from '../format';
import { useAction, usePoll } from '../hooks';

type OpenPos = PositionRecord & { liquiditySol: number | null; riskScore: number | null; criticalFlags: CriticalFlag[] };

export function PortfolioPage() {
  const { portfolio } = useLive();
  const pf = usePoll<{ summary: PortfolioSummary; equity: Array<{ at: number; equity: number; drawdownPct: number }> }>('/api/portfolio', 10_000);
  const open = usePoll<{ positions: OpenPos[] }>('/api/positions', 4000);
  const closed = usePoll<{ positions: PositionRecord[] }>('/api/positions?status=closed', 15_000);
  const [closing, setClosing] = useState<OpenPos | null>(null);
  const [writeOff, setWriteOff] = useState<OpenPos | null>(null);
  const [woReason, setWoReason] = useState('');
  const act = useAction();
  const s = portfolio ?? pf.data?.summary ?? null;

  return (
    <>
      <div className="grid g6">
        <Stat label="Equity (executable)" value={sol(s?.equitySol, 4)} />
        <Stat label="Indicative value" value={sol(s?.indicativeValueSol, 4)} hint="mid-price mark — not realizable" />
        <Stat label="Executable value" value={sol(s?.executableValueSol, 4)} hint="simulated full sell, fees incl." />
        <Stat label="Exposure (cost)" value={sol(s?.openExposureSol, 4)} />
        <Stat label="Unrealized" value={sol(s?.unrealizedPnlSol, 4)} tone={cls(s?.unrealizedPnlSol)} />
        <Stat label="Realized" value={sol(s?.realizedPnlSol, 4)} tone={cls(s?.realizedPnlSol)} />
      </div>
      <ErrorBox error={open.error ?? act.error} />
      <Panel title="Open positions" sub="valued at executable sell quotes against current on-chain reserves" pad={false}>
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="t">
            <thead>
              <tr>
                <th>Token</th>
                <th>Strategy</th>
                <th>Status</th>
                <th className="r">Tokens</th>
                <th className="r">Entry price</th>
                <th className="r">Cost</th>
                <th className="r">Indicative</th>
                <th className="r">Executable</th>
                <th className="r">P&L (exec.)</th>
                <th className="r">Stop / target</th>
                <th>Held</th>
                <th>Liquidity · risk</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(open.data?.positions ?? []).map((p) => {
                const pnl = p.lastExecutableValueSol === null ? null : p.lastExecutableValueSol - p.costBasisSol;
                return (
                  <tr key={p.id}>
                    <td>
                      <a href={`#/token/${p.mint}`}>{p.symbol ?? p.mint.slice(0, 6)}</a>
                      <div className="faint small">{p.mode}</div>
                    </td>
                    <td>{p.strategy}</td>
                    <td>
                      <span className={`badge ${p.status === 'stuck' ? 'down' : p.status === 'closing' ? 'warn' : 'info'}`}>{p.status}</span>
                      {p.meta.lastExitError && <div className="small down ellipsis" style={{ maxWidth: 160 }} title={p.meta.lastExitError}>{p.meta.lastExitError}</div>}
                    </td>
                    <td className="r num">{tokens(p.tokenAmountRaw)}</td>
                    <td className="r num">{price(p.entryPriceSol)}</td>
                    <td className="r num">{sol(p.costBasisSol, 4)}</td>
                    <td className="r num muted">{sol(p.lastIndicativeValueSol, 4)}</td>
                    <td className="r num">{p.lastExecutableValueSol === null ? <span className="down">no quote</span> : sol(p.lastExecutableValueSol, 4)}</td>
                    <td className={`r num ${cls(pnl)}`}>
                      {sol(pnl, 4)} <span className="small">{pnl === null ? '' : pct((pnl / p.costBasisSol) * 100)}</span>
                    </td>
                    <td className="r num muted">
                      -{p.stopPct}% / +{p.targetPct}%
                    </td>
                    <td className="muted">{ago(p.entryAt)}</td>
                    <td className="small">
                      {sol(p.liquiditySol, 1)} SOL · {p.riskScore?.toFixed(0) ?? '—'} <Flags flags={p.criticalFlags} />
                    </td>
                    <td>
                      <button disabled={p.status === 'closing'} onClick={() => setClosing(p)}>
                        Close
                      </button>{' '}
                      {p.status === 'stuck' && (
                        <button className="ghost" onClick={() => setWriteOff(p)}>
                          Write off
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!open.data?.positions.length && <div className="empty">No open positions</div>}
        </div>
      </Panel>
      <div className="grid g2">
        <Panel title="Equity & drawdown">
          <LineChart series={[{ label: 'equity', color: '#f0b429', area: true, points: (pf.data?.equity ?? []).map((e) => ({ x: e.at, y: e.equity })) }]} yFormat={(v) => v.toFixed(3)} height={200} />
          <LineChart series={[{ label: 'drawdown %', color: '#ef5f6b', points: (pf.data?.equity ?? []).map((e) => ({ x: e.at, y: -e.drawdownPct })) }]} yFormat={(v) => `${v.toFixed(1)}%`} height={120} />
        </Panel>
        <Panel title="Closed positions" sub="realized results" pad={false}>
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Closed</th>
                  <th>Token</th>
                  <th>Strategy</th>
                  <th className="r">Proceeds</th>
                  <th className="r">Realized</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {(closed.data?.positions ?? []).map((p) => (
                  <tr key={p.id}>
                    <td className="muted small">{dateTime(p.exitAt)}</td>
                    <td>
                      <a href={`#/token/${p.mint}`}>{p.symbol ?? p.mint.slice(0, 6)}</a>
                    </td>
                    <td>{p.strategy}</td>
                    <td className="r num">{sol(p.proceedsSol, 4)}</td>
                    <td className={`r num ${cls(p.realizedPnlSol)}`}>{sol(p.realizedPnlSol, 5)}</td>
                    <td className="small muted ellipsis" style={{ maxWidth: 240 }} title={p.closeReason ?? ''}>
                      {p.closeReason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!closed.data?.positions.length && <div className="empty">No closed positions yet</div>}
          </div>
        </Panel>
      </div>
      {closing && (
        <ConfirmModal
          title={`Close ${closing.symbol ?? closing.mint.slice(0, 6)}`}
          confirmLabel="Sell entire position"
          danger={closing.mode === 'live'}
          busy={act.busy}
          error={act.error}
          onCancel={() => setClosing(null)}
          onConfirm={() =>
            act.run(async () => {
              await api.command('POST', `/api/positions/${closing.id}/close`, { fraction: 1 });
              setClosing(null);
              open.reload();
            })
          }
        >
          <p>
            Submits a {closing.mode === 'live' ? <b className="down">real on-chain</b> : 'simulated'} sell using a fresh quote. Current executable value: {sol(closing.lastExecutableValueSol, 4)} SOL. The fill may be
            worse than this estimate; it fails rather than exceeding the configured slippage.
          </p>
        </ConfirmModal>
      )}
      {writeOff && (
        <ConfirmModal
          title="Write off stuck position"
          danger
          confirmLabel="Write off (record total loss)"
          busy={act.busy}
          error={act.error}
          disabled={woReason.length < 3}
          onCancel={() => setWriteOff(null)}
          onConfirm={() =>
            act.run(async () => {
              await api.command('POST', `/api/positions/${writeOff.id}/write-off`, { confirm: 'WRITE OFF', reason: woReason });
              setWriteOff(null);
              open.reload();
            })
          }
        >
          <p>Records the remaining cost basis as a realized loss. Use only when the token cannot be sold (e.g. liquidity removed). This does not move any tokens.</p>
          <input placeholder="Reason" value={woReason} onChange={(e) => setWoReason(e.target.value)} />
        </ConfirmModal>
      )}
    </>
  );
}
