'use client';
import { useState, type MouseEvent } from 'react';

/** Grouped columns on one scale: thin marks, 4px rounded caps, a 2px surface gap, hairline grid, hover
 *  tooltip on the whole band. Two series by default (dials blue, connects green); one for spend. */
export type Series = { key: string; label: string; color: string };
export type Band = { key: string; label: string; tip: string; values: Record<string, number>; emphasis?: boolean; dim?: boolean };

export default function Columns({ bands, series, yMax, ticks, height = 230, bw = 22, labelEvery = 1, shift, fmt = (v) => String(v) }: {
  bands: Band[]; series: Series[]; yMax: number; ticks: number[]; height?: number; bw?: number; labelEvery?: number;
  shift?: [number, number]; fmt?: (v: number) => string;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; band: Band } | null>(null);
  const W = 640, H = height, l = 40, r = 12, t = 16, b = 28;
  const pw = W - l - r, ph = H - t - b, n = Math.max(1, bands.length), band = pw / n;
  const y = (v: number) => t + ph - (Math.min(v, yMax) / yMax) * ph;
  const groupW = series.length * bw + (series.length - 1) * 2;
  const bar = (x: number, v: number, color: string, key: string) => {
    const h = Math.max(0, y(0) - y(v)); if (v <= 0) return null;
    const rad = Math.min(4, h);
    return <path key={key} fill={color} d={`M${x} ${y(0)} v${-(h - rad)} a${rad} ${rad} 0 0 1 ${rad} ${-rad} h${bw - 2 * rad} a${rad} ${rad} 0 0 1 ${rad} ${rad} v${h - rad} z`} />;
  };
  const move = (e: MouseEvent, bd: Band) => setTip({ x: e.clientX, y: e.clientY - 12, band: bd });
  return (
    <>
      <svg className="ad-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.label).join(' and ')}>
        {shift && <rect className="shift" x={l + shift[0] * band} y={t} width={(shift[1] - shift[0] + 1) * band} height={ph} />}
        {ticks.map((v) => <g key={v}><line className="grid" x1={l} x2={W - r} y1={y(v)} y2={y(v)} /><text x={l - 8} y={y(v) + 4} textAnchor="end">{fmt(v)}</text></g>)}
        <line className="ax" x1={l} x2={W - r} y1={y(0)} y2={y(0)} />
        {bands.map((bd, i) => {
          const x0 = l + i * band + (band - groupW) / 2;
          return (
            <g key={bd.key} className={'band' + (bd.dim ? ' dim' : '')} onMouseEnter={(e) => move(e, bd)} onMouseMove={(e) => move(e, bd)} onMouseLeave={() => setTip(null)}>
              {series.map((s, j) => bar(x0 + j * (bw + 2), bd.values[s.key] ?? 0, s.color, s.key))}
              {bd.emphasis && series.map((s, j) => (bd.values[s.key] ?? 0) > 0 && (
                <text key={'l' + s.key} className="lab" x={x0 + j * (bw + 2) + bw / 2} y={y(bd.values[s.key] ?? 0) - 5} textAnchor="middle">{fmt(bd.values[s.key] ?? 0)}</text>))}
              {i % labelEvery === 0 && <text x={l + i * band + band / 2} y={H - 8} textAnchor="middle">{bd.label}</text>}
              <rect className="hit" x={l + i * band} y={t} width={band} height={ph} />
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="ad-tip" style={{ left: tip.x, top: tip.y }}>
          <div>{tip.band.tip}</div>
          {series.map((s) => <div key={s.key}><span className="k" style={{ background: s.color }} /><b>{fmt(tip.band.values[s.key] ?? 0)}</b> {s.label.toLowerCase()}</div>)}
        </div>
      )}
    </>
  );
}

export const DIALS_CONNECTS: Series[] = [{ key: 'dials', label: 'Dials', color: 'var(--blue)' }, { key: 'connects', label: 'Connects', color: 'var(--green)' }];
/** Round the axis top to a clean number and give 3–4 ticks. */
export function scale(max: number): { yMax: number; ticks: number[] } {
  const m = Math.max(1, max);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => m / s <= 4) ?? Math.pow(10, Math.ceil(Math.log10(m / 4)));
  const yMax = Math.ceil(m / step) * step;
  const ticks = []; for (let v = 0; v <= yMax; v += step) ticks.push(v);
  return { yMax: yMax * 1.12, ticks };
}
