'use client';
import type { ReactNode } from 'react';
import { secs } from '../../lib/admin';

export type Delta = { text: string; dir: 'up' | 'down' | '' };

/** "+17 vs yesterday", coloured by direction × whether up is good. `prev` null = no earlier period. */
export function deltaOf(cur: number, prev: number | null | undefined, o: { vs: string; unit?: 'n' | 'pts' | 's' | 'x'; upGood?: boolean; neutral?: boolean } ): Delta {
  if (prev == null) return { text: 'no earlier period', dir: '' };
  const diff = cur - prev;
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
  const abs = Math.abs(diff);
  const v = o.unit === 'pts' ? abs.toFixed(1) + ' pts' : o.unit === 's' ? secs(abs) : o.unit === 'x' ? abs.toFixed(2) : String(Math.round(abs));
  const dir: Delta['dir'] = o.neutral || diff === 0 ? '' : (diff > 0) === (o.upGood ?? true) ? 'up' : 'down';
  return { text: `${sign}${v} vs ${o.vs}`, dir };
}

export function Kpi({ label, value, unit, delta, note, hero, sub, tone }: {
  label: string; value: ReactNode; unit?: string; delta?: Delta; note?: string; hero?: boolean; sub?: ReactNode; tone?: 'good' | 'bad';
}) {
  return (
    <div className={'ad-kpi' + (hero ? ' hero' : '')}>
      <div className="l">{label}</div>
      <div className={'v' + (tone ? ' ' + tone : '')}>{value}{unit && <small>{unit}</small>}</div>
      {delta && <div className={'d ' + delta.dir}>{delta.text}</div>}
      {note && !delta && <div className="d">{note}</div>}
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
