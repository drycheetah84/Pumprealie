import type { PortfolioSummary, TokenSummary } from '../../shared/types';
import { useLive } from '../App';
import { LineChart } from '../components/charts';
import { ActionBadge, ErrorBox, Panel, RiskBadge, Stat } from '../components/ui';
import { ago, cls, pct, sol, time } from '../format';
import { usePoll } from '../hooks';

interface PortfolioResp {
  summary: PortfolioSummary;
  equity: Array<{ at: number; equity: number; drawdownPct: number }>;
}

export function OverviewPage() {
  const { status, portfolio, alerts } = useLive();
  const pf = usePoll<PortfolioResp>('/api/portfolio', 10_000);
  const opps = usePoll<{ tokens: TokenSummary[] }>('/api/tokens?sort=opportunity&limit=8', 5000);
  const s = portfolio ?? pf.data?.summary ?? null;
  const live = status?.mode === 'live';

  return (
    <>
      {status?.killSwitch.active && (
        <div className="banner danger">
          <b>Kill switch active</b> — {status.killSwitch.reason ?? 'no reason given'} (since {time(status.killSwitch.changedAt)}). New entries are blocked in every mode.
        </div>
      )}
      {status && status.mode !== 'live' && (
        <div className="banner info small">
          {status.mode === 'paper' ? 'Paper trading: fills are simulated against live on-chain liquidity. No real transactions are sent.' : 'Offline: market data and analysis run; no orders are placed.'}
        </div>
      )}
      {live && (
        <div className={`banner ${status?.liveArmed ? 'danger' : 'warn'}`}>
          {status?.liveArmed ? `LIVE TRADING with wallet ${status.walletPublicKey}. Real funds at risk.` : 'Live mode is selected but disarmed: no new live entries until re-confirmed on the Risk controls page.'}
        </div>
      )}
      <ErrorBox error={pf.error} />
      <div className="grid g6">
        <Stat label={live ? 'Wallet SOL' : 'Cash (paper)'} value={sol(live ? (s?.walletSol ?? null) : (s?.cashSol ?? null), 3)} hint={`available ${sol(s?.availableSol, 3)} · reserved ${sol(s?.reservedSol, 3)}`} />
        <Stat label="Portfolio value" value={sol(s?.equitySol, 3)} hint="cash + executable exit value" />
        <Stat label="Realized P&L" value={sol(s?.realizedPnlSol, 4)} tone={cls(s?.realizedPnlSol)} hint={`fees ${sol(s?.feesPaidSol, 4)}`} />
        <Stat label="Unrealized (exec.)" value={sol(s?.unrealizedPnlSol, 4)} tone={cls(s?.unrealizedPnlSol)} hint={`indicative ${sol((s?.indicativeValueSol ?? 0) - (s?.openExposureSol ?? 0), 4)}`} />
        <Stat label="Today P&L" value={sol(s?.todayPnlSol, 4)} tone={cls(s?.todayPnlSol)} hint={`from ${sol(s?.dayStartEquitySol, 3)} at 00:00 UTC`} />
        <Stat label="Drawdown" value={pct(s?.drawdownPct ?? null, 2, false)} tone={(s?.drawdownPct ?? 0) > 2 ? 'down' : ''} hint={`peak ${sol(s?.peakEquitySol, 3)}`} />
      </div>
      <div className="grid g4">
        <Stat label="Open positions" value={s?.openPositions ?? '—'} hint={`exposure ${sol(s?.openExposureSol, 3)} SOL`} />
        <Stat label="Settled trades" value={s?.tradeCount ?? '—'} hint={`${s?.consecutiveLosses ?? 0} consecutive losses`} />
        <Stat label="Entries" value={status?.entriesBlocked ? 'Blocked' : 'Allowed'} tone={status?.entriesBlocked ? 'down' : 'up'} hint={status?.entryBlockReasons[0] ?? 'all gates passing'} />
        <Stat label="Paper → live gate" value={`${status?.paperTradesClosed ?? 0} / ${status?.minPaperTradesForLive ?? '—'}`} hint="closed paper trades required" />
      </div>
      <div className="grid g2">
        <Panel title="Equity" sub="executable valuation, sampled every 30s">
          <LineChart series={[{ label: 'equity', color: '#f0b429', area: true, points: (pf.data?.equity ?? []).map((e) => ({ x: e.at, y: e.equity })) }]} yFormat={(v) => v.toFixed(3)} height={210} />
          <div className="muted small">{s?.valuationMethod}</div>
        </Panel>
        <Panel title="Data providers">
          <table className="t">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Last success</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {status?.providers.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td>
                    <span className={`badge ${p.status === 'ok' ? 'up' : p.status === 'degraded' ? 'warn' : p.status === 'disabled' ? '' : 'down'}`}>{p.status}</span>
                  </td>
                  <td className="muted">{ago(p.lastSuccessAt)}</td>
                  <td className="small ellipsis" style={{ maxWidth: 280 }} title={p.lastError ?? p.detail}>
                    {p.detail || p.lastError}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <div className="grid g2">
        <Panel title="Top candidates" sub="by expected net return (after costs)" pad={false}>
          <table className="t">
            <thead>
              <tr>
                <th>Token</th>
                <th>Risk</th>
                <th className="r">Exp. net</th>
                <th>Action</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {(opps.data?.tokens ?? []).map((t) => (
                <tr key={t.mint} className="click" onClick={() => (location.hash = `/token/${t.mint}`)}>
                  <td>{t.symbol ?? t.mint.slice(0, 6)}</td>
                  <td>
                    <RiskBadge score={t.riskScore} tier={t.riskTier} />
                  </td>
                  <td className={`r num ${cls(t.expectedNetPct)}`}>{pct(t.expectedNetPct)}</td>
                  <td>
                    <ActionBadge action={t.action} />
                  </td>
                  <td className="small muted ellipsis" style={{ maxWidth: 260 }}>
                    {t.actionReason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Alerts" pad={false}>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            {alerts.length === 0 && <div className="empty">No alerts</div>}
            <table className="t">
              <tbody>
                {alerts.slice(0, 50).map((a) => (
                  <tr key={a.id}>
                    <td className="muted small">{time(a.createdAt)}</td>
                    <td>
                      <span className={`badge ${a.level === 'critical' ? 'down' : a.level === 'warning' ? 'warn' : 'info'}`}>{a.code}</span>
                    </td>
                    <td className="small" style={{ whiteSpace: 'normal' }}>
                      {a.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}
