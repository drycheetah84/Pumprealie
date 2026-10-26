export const sol = (v: number | null | undefined, d = 4) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(d)}`);

export const pct = (v: number | null | undefined, d = 1, sign = true) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${sign && v > 0 ? '+' : ''}${v.toFixed(d)}%`;

export const cls = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? '' : v > 0 ? 'up' : 'down');

export function price(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return '—';
  if (v >= 1) return v.toFixed(4);
  const e = Math.floor(Math.log10(v));
  return v.toFixed(Math.min(14, Math.max(2, -e + 3)));
}

export function compact(v: number | null | undefined, d = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(d)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(d)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(d)}K`;
  return v.toFixed(d);
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

export const time = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleTimeString() : '—');
export const dateTime = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : '—');

export const short = (s: string | null | undefined, n = 4) => (!s ? '—' : s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);

export const tokens = (raw: string | number | null | undefined) => (raw === null || raw === undefined ? '—' : compact(Number(raw) / 1e6, 2));

export function riskClass(tier: string | null | undefined): string {
  switch (tier) {
    case 'lower':
      return 'up';
    case 'moderate':
      return 'info';
    case 'high':
      return 'warn';
    case 'very_high':
    case 'extreme':
      return 'down';
    default:
      return '';
  }
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const solscanToken = (mint: string) => `https://solscan.io/token/${mint}`;
