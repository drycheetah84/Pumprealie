import { createContext, useContext, useEffect, useState, type ReactElement } from 'react';
import type { Alert, PortfolioSummary, SystemStatus } from '../shared/types';
import { api, ApiError, getToken, openStream, setToken, type StreamMessage } from './api';
import { ConfirmModal } from './components/ui';
import { useAction, useHashRoute } from './hooks';
import { OverviewPage } from './pages/Overview';
import { PortfolioPage } from './pages/Portfolio';
import { RiskPage } from './pages/Risk';
import { ScannerPage } from './pages/Scanner';
import { StrategiesPage } from './pages/Strategies';
import { TokenPage } from './pages/Token';
import { TradesPage } from './pages/Trades';

interface Live {
  status: SystemStatus | null;
  portfolio: PortfolioSummary | null;
  alerts: Alert[];
  connected: boolean;
  lastMessage: StreamMessage | null;
  refreshStatus: () => void;
}

const LiveCtx = createContext<Live>({ status: null, portfolio: null, alerts: [], connected: false, lastMessage: null, refreshStatus: () => undefined });
export const useLive = () => useContext(LiveCtx);

const NAV = [
  ['/overview', 'Overview'],
  ['/scanner', 'Token scanner'],
  ['/portfolio', 'Portfolio'],
  ['/trades', 'Trade history'],
  ['/strategies', 'Strategy lab'],
  ['/risk', 'Risk controls'],
] as const;

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#141b22" stroke="#26313d" />
      <path d="M7 22 L13 14 L18 18 L25 9" stroke="#f0b429" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="9" r="2.2" fill="#f0b429" />
    </svg>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const { busy, error, run } = useAction();
  return (
    <div className="login">
      <div className="panel">
        <div className="panel-h">
          <Logo /> Pumpraelie · operator sign-in
        </div>
        <div className="panel-b" style={{ display: 'grid', gap: 12 }}>
          <div className="muted small">
            Enter the dashboard API token (DASHBOARD_API_TOKEN, or the generated file in DATA_DIR/dashboard-token). This token controls the dashboard only — never paste a wallet
            seed phrase or private key here.
          </div>
          <input type="password" autoFocus placeholder="Dashboard API token" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && document.getElementById('login-btn')?.click()} />
          {error && <div className="banner danger small">{error}</div>}
          <button
            id="login-btn"
            className="primary"
            disabled={busy || value.length < 8}
            onClick={() =>
              run(async () => {
                setToken(value.trim());
                try {
                  await api.get('/api/status');
                  onDone();
                } catch (e) {
                  setToken(null);
                  throw e instanceof ApiError && e.status === 401 ? new Error('Invalid token') : e;
                }
              })
            }
          >
            Sign in
          </button>
        </div>
      </div>
    </div>
  );
}

export function ModePill({ status }: { status: SystemStatus | null }) {
  if (!status) return <span className="mode-pill mode-offline"><span className="led" />…</span>;
  const m = status.mode;
  const label = m === 'live' ? (status.liveArmed ? 'LIVE TRADING' : 'LIVE · DISARMED') : m === 'paper' ? 'PAPER TRADING' : 'OFFLINE';
  return (
    <span className={`mode-pill mode-${m === 'live' && !status.liveArmed ? 'offline' : m}`} title={m === 'live' ? 'Real transactions' : 'No real transactions are sent'}>
      <span className="led" />
      {label}
    </span>
  );
}

export function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [route, go] = useHashRoute();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<StreamMessage | null>(null);
  const [killOpen, setKillOpen] = useState(false);
  const kill = useAction();

  const refreshStatus = () => {
    api
      .get<SystemStatus>('/api/status')
      .then(setStatus)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          setToken(null);
          setAuthed(false);
        }
      });
  };

  useEffect(() => {
    if (!authed) return;
    refreshStatus();
    api.get<{ alerts: Alert[] }>('/api/alerts').then((r) => setAlerts(r.alerts)).catch(() => undefined);
    api.get<{ summary: PortfolioSummary }>('/api/portfolio').then((r) => setPortfolio(r.summary)).catch(() => undefined);
    const close = openStream(
      (m) => {
        setLastMessage(m);
        if (m.type === 'status') setStatus(m.data as SystemStatus);
        else if (m.type === 'portfolio') setPortfolio(m.data as PortfolioSummary);
        else if (m.type === 'alert') setAlerts((a) => [m.data as Alert, ...a].slice(0, 200));
      },
      setConnected,
    );
    const id = setInterval(refreshStatus, 15_000);
    return () => {
      close();
      clearInterval(id);
    };
  }, [authed]);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const [path, arg] = (() => {
    const parts = route.split('/').filter(Boolean);
    return [`/${parts[0] ?? 'overview'}`, parts[1] ?? null];
  })();

  let page: ReactElement;
  switch (path) {
    case '/scanner':
      page = <ScannerPage />;
      break;
    case '/token':
      page = <TokenPage mint={arg ?? ''} />;
      break;
    case '/portfolio':
      page = <PortfolioPage />;
      break;
    case '/trades':
      page = <TradesPage />;
      break;
    case '/strategies':
      page = <StrategiesPage />;
      break;
    case '/risk':
      page = <RiskPage />;
      break;
    default:
      page = <OverviewPage />;
  }
  const title = path === '/token' ? 'Token details' : (NAV.find(([p]) => p === path)?.[1] ?? 'Overview');

  return (
    <LiveCtx.Provider value={{ status, portfolio, alerts, connected, lastMessage, refreshStatus }}>
      <div className="shell">
        <aside className="side">
          <div className="brand">
            <Logo />
            <div>
              Pumpraelie
              <small>risk-first trading agent</small>
            </div>
          </div>
          {NAV.map(([p, label]) => (
            <div key={p} className={`nav ${path === p || (p === '/scanner' && path === '/token') ? 'active' : ''}`} onClick={() => go(p)}>
              <span className="dot" />
              {label}
            </div>
          ))}
          <div className="side-foot">
            <div>
              Stream: <span className={connected ? 'up' : 'down'}>{connected ? 'connected' : 'disconnected'}</span>
            </div>
            <div>Tracked tokens: {status?.trackedTokens ?? '—'}</div>
            <div className="faint">v{status?.version ?? '…'}</div>
            <button
              className="ghost small"
              onClick={() => {
                setToken(null);
                setAuthed(false);
              }}
            >
              Sign out
            </button>
          </div>
        </aside>
        <main className="main">
          <div className="topbar">
            <h1>{title}</h1>
            <ModePill status={status} />
            {status?.killSwitch.active && <span className="badge down">KILL SWITCH ACTIVE</span>}
            {status && !status.killSwitch.active && status.entriesBlocked && (
              <span className="badge warn" title={status.entryBlockReasons.join('\n')}>
                entries blocked: {status.entryBlockReasons[0]}
                {status.entryBlockReasons.length > 1 ? ` (+${status.entryBlockReasons.length - 1})` : ''}
              </span>
            )}
            <div className="spacer" />
            {status?.providers.map((p) => (
              <span key={p.name} className={`badge ${p.status === 'ok' ? 'up' : p.status === 'disabled' ? '' : p.status === 'degraded' ? 'warn' : 'down'}`} title={`${p.detail}${p.lastError ? `\nlast error: ${p.lastError}` : ''}`}>
                {p.name}
              </span>
            ))}
            <button className="danger" disabled={status?.killSwitch.active} onClick={() => setKillOpen(true)}>
              Emergency stop
            </button>
          </div>
          <div className="content">{page}</div>
        </main>
      </div>
      {killOpen && (
        <ConfirmModal
          title="Activate kill switch"
          danger
          confirmLabel="Stop new entries now"
          busy={kill.busy}
          error={kill.error}
          onCancel={() => setKillOpen(false)}
          onConfirm={() =>
            kill.run(async () => {
              await api.command('POST', '/api/emergency/stop', { reason: 'operator emergency stop (dashboard)' });
              setKillOpen(false);
              refreshStatus();
            })
          }
        >
          <p>This immediately and persistently blocks all new entries (paper and live), cancels unsubmitted entry orders and disarms live trading. It survives restarts until explicitly cleared on the Risk controls page.</p>
          <p className="muted">Existing positions are not liquidated blindly; the exit policy keeps managing them.</p>
        </ConfirmModal>
      )}
    </LiveCtx.Provider>
  );
}
