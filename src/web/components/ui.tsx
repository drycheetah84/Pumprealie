import type { ReactNode } from 'react';
import type { CriticalFlag, RiskTier } from '../../shared/types';
import { riskClass } from '../format';

export function Panel({ title, sub, right, children, pad = true }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-h">
        {title}
        {sub && <span className="sub">{sub}</span>}
        <span className="spacer" />
        {right}
      </div>
      {pad ? <div className="panel-b">{children}</div> : children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <div className="panel stat">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ''}`}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function RiskBadge({ score, tier }: { score: number | null; tier: RiskTier | null }) {
  if (score === null || tier === null) return <span className="badge">—</span>;
  return (
    <span className={`badge ${riskClass(tier)}`} title="Heuristic risk score (0-100), not a calibrated probability">
      {score.toFixed(0)} · {tier.replace('_', ' ')}
    </span>
  );
}

export function Flags({ flags }: { flags: CriticalFlag[] }) {
  if (!flags.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {flags.map((f) => (
        <span key={f} className="badge down">
          {f.replace(/_/g, ' ').toLowerCase()}
        </span>
      ))}
    </span>
  );
}

export function ActionBadge({ action }: { action: string }) {
  const c = action === 'buy' ? 'accent' : action === 'watch' ? 'info' : action === 'sell' || action === 'reduce' ? 'down' : '';
  return <span className={`badge ${c}`}>{action}</span>;
}

export function ConfirmModal({
  title,
  children,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  danger,
  busy,
  error,
  disabled,
}: {
  title: string;
  children: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  disabled?: boolean;
}) {
  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="panel modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-h">{title}</div>
        <div className="panel-b" style={{ display: 'grid', gap: 10 }}>
          {children}
          {error && <div className="banner danger small">{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onCancel}>Cancel</button>
            <button className={danger ? 'danger' : 'primary'} disabled={busy || disabled} onClick={onConfirm}>
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="banner danger small">{error}</div> : null;
}
