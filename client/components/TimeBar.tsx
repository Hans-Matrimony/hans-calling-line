'use client';
import { useEffect, useState } from 'react';
import { inWindow, localTime } from '../lib/format';

/** The lead's day as a 24h strip: calling window 10-19 highlighted, marker at their local hour now.
 *  Ticks once a minute so the marker moves during a long session. */
export default function TimeBar({ offset, showTime = true }: { offset: string | number | null | undefined; showTime?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t); }, []);
  const lt = localTime(offset, now);
  if (!lt) return <span className="small muted">unknown</span>;
  const ok = inWindow(lt.hour);
  const title = ok ? `${lt.text} their time — inside calling hours (10:00–19:00)` : `${lt.text} their time — outside calling hours (10:00–19:00)`;
  const bar = (
    <span className={'tbar' + (ok ? ' in' : '')} title={title} aria-label={title} role="img">
      <span className="win" />
      <span className="now" style={{ left: `${(lt.hour / 24) * 100}%` }} />
    </span>
  );
  if (!showTime) return bar;
  return <>{lt.text}{bar}</>;
}
