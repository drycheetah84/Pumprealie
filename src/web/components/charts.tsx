import { useMemo, useState } from 'react';

export interface Series {
  points: Array<{ x: number; y: number }>;
  color: string;
  label: string;
  area?: boolean;
}

function niceTicks(min: number, max: number, n = 4): number[] {
  if (!(max > min)) return [min];
  const step = (max - min) / n;
  return Array.from({ length: n + 1 }, (_, i) => min + step * i);
}

/** Lightweight responsive SVG line/area chart with hover readout. */
export function LineChart({
  series,
  height = 220,
  yFormat = (v: number) => v.toFixed(4),
  xFormat = (v: number) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  bars,
  logScale = false,
}: {
  series: Series[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  bars?: { points: Array<{ x: number; y: number; up?: boolean }>; label: string };
  logScale?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 800;
  const padL = 64;
  const padR = 12;
  const padT = 10;
  const barsH = bars ? 44 : 0;
  const padB = 22 + barsH;
  const all = series.flatMap((s) => s.points);
  const geo = useMemo(() => {
    if (!all.length) return null;
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => (logScale ? Math.log10(Math.max(1e-18, p.y)) : p.y));
    let minY = Math.min(...ys);
    let maxY = Math.max(...ys);
    if (minY === maxY) {
      minY -= Math.abs(minY) * 0.05 || 1;
      maxY += Math.abs(maxY) * 0.05 || 1;
    }
    const pad = (maxY - minY) * 0.06;
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: minY - pad, maxY: maxY + pad };
  }, [all, logScale]);
  if (!geo) return <div className="empty">No data yet</div>;
  const sx = (x: number) => padL + ((x - geo.minX) / Math.max(1, geo.maxX - geo.minX)) * (width - padL - padR);
  const sy = (y: number) => {
    const v = logScale ? Math.log10(Math.max(1e-18, y)) : y;
    return padT + (1 - (v - geo.minY) / (geo.maxY - geo.minY)) * (height - padT - padB);
  };
  const yTicks = niceTicks(geo.minY, geo.maxY);
  const xTicks = niceTicks(geo.minX, geo.maxX, 5);
  const plotH = height - padT - padB;
  const barMax = bars ? Math.max(1e-12, ...bars.points.map((b) => b.y)) : 1;
  const barW = bars && bars.points.length ? Math.max(1, ((width - padL - padR) / bars.points.length) * 0.7) : 0;
  const first = series[0]?.points ?? [];
  const hp = hover !== null ? first[hover] : undefined;
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      preserveAspectRatio="none"
      style={{ height }}
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * width;
        if (!first.length) return;
        let best = 0;
        let bd = Infinity;
        first.forEach((p, i) => {
          const d = Math.abs(sx(p.x) - x);
          if (d < bd) {
            bd = d;
            best = i;
          }
        });
        setHover(best);
      }}
    >
      {yTicks.map((t, i) => {
        const y = padT + (1 - (t - geo.minY) / (geo.maxY - geo.minY)) * plotH;
        return (
          <g key={i}>
            <line className="grid-line" x1={padL} x2={width - padR} y1={y} y2={y} />
            <text x={padL - 6} y={y + 3} textAnchor="end">
              {yFormat(logScale ? 10 ** t : t)}
            </text>
          </g>
        );
      })}
      {xTicks.map((t, i) => (
        <text key={i} x={sx(t)} y={height - 6} textAnchor="middle">
          {xFormat(t)}
        </text>
      ))}
      {bars &&
        bars.points.map((b, i) => {
          const h = (b.y / barMax) * (barsH - 6);
          return <rect key={i} x={sx(b.x) - barW / 2} y={height - 22 - h} width={barW} height={h} fill={b.up === false ? 'rgba(239,95,107,0.45)' : 'rgba(52,201,138,0.45)'} />;
        })}
      {series.map((s, si) => {
        if (!s.points.length) return null;
        const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
        return (
          <g key={si}>
            {s.area && <path d={`${d} L${sx(s.points[s.points.length - 1]!.x)},${padT + plotH} L${sx(s.points[0]!.x)},${padT + plotH} Z`} fill={s.color} opacity={0.08} />}
            <path d={d} fill="none" stroke={s.color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
      {hp && (
        <g>
          <line x1={sx(hp.x)} x2={sx(hp.x)} y1={padT} y2={padT + plotH} stroke="#3a4756" strokeDasharray="3 3" />
          <circle cx={sx(hp.x)} cy={sy(hp.y)} r={3} fill={series[0]!.color} />
          <rect x={padL + 6} y={padT + 4} width={250} height={18} rx={3} fill="#0d1217" stroke="#26313d" />
          <text x={padL + 12} y={padT + 16} style={{ fill: '#d5dce4' }}>
            {xFormat(hp.x)} · {series[0]!.label} {yFormat(hp.y)}
          </text>
        </g>
      )}
    </svg>
  );
}

export function ScoreBar({ value, max = 100, color }: { value: number; max?: number; color?: string }) {
  const pctv = Math.max(0, Math.min(100, (value / max) * 100));
  const c = color ?? (value >= 65 ? 'var(--down)' : value >= 45 ? 'var(--warn)' : value >= 25 ? 'var(--info)' : 'var(--up)');
  return (
    <div className="bar" title={value.toFixed(1)}>
      <span style={{ width: `${pctv}%`, background: c }} />
    </div>
  );
}
