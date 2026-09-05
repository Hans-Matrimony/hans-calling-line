'use client';
import { useEffect, useRef, useState } from 'react';
import { useDialer, type Me } from '../lib/useDialer';
import { prettyPhone } from '../lib/format';
import Stage from './Stage';
import UpNext from './UpNext';
import ManualDial from './ManualDial';
import Activity from './Activity';

/** Per-viewer UI preference (which rail panels are open). Never critical: falls back to the default. */
function usePref(key: string, initial: boolean) {
  const [v, setV] = useState(initial);
  useEffect(() => { try { const s = localStorage.getItem(key); if (s != null) setV(s === '1'); } catch { /* private mode etc. */ } }, [key]);
  const set = (next: boolean) => { setV(next); try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* ignore */ } };
  return [v, set] as const;
}

export default function Console({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const d = useDialer(me);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dialOpen, setDialOpen] = usePref('eazybe.dial.open', true);
  const [feedOpen, setFeedOpen] = usePref('eazybe.feed.open', false);

  // Audio on by default: connect the softphone as soon as the console loads. If the mic is blocked or
  // the connect fails, useDialer surfaces the error and the "Connect" button stays for a manual retry.
  const autoConnect = useRef(false);
  useEffect(() => {
    if (autoConnect.current) return;
    autoConnect.current = true;
    d.connect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = d.stats;
  const rate = s && s.dialed_today ? Math.round((100 * s.connected_today) / s.dialed_today) : null;
  const audio = d.rep === 'connected' ? { lamp: 'green', text: 'Audio on' } : d.rep === 'ringing' ? { lamp: 'amber', text: 'Connecting…' } : { lamp: '', text: 'Audio off' };

  return (
    <div className="console">
      <header className="topbar">
        <div className="brand"><span className="brand-name">Eazybe</span><span className="brand-sub">dialer</span></div>

        <div className="audio" role="status">
          <span className={'lamp ' + audio.lamp} aria-hidden />
          <span>{audio.text}</span>
          {d.rep === 'disconnected'
            ? <button className="btn btn-blue" onClick={d.connect} disabled={d.busy}>Connect</button>
            : <button className="btn btn-ghost" onClick={d.disconnect} disabled={d.busy || d.phase === 'live'} title={d.phase === 'live' ? 'Hang up the call first' : 'Disconnect audio'}>Disconnect</button>}
        </div>

        <div className="stats" aria-label="Today">
          <div className="stat"><b>{s?.dialed_today ?? '…'}</b><span>dialed</span></div>
          <div className="stat"><b className="green">{s?.connected_today ?? '…'}</b><span>connected</span></div>
          <div className="stat"><b>{rate != null ? rate + '%' : s ? '–' : '…'}</b><span>rate</span></div>
          <div className="stat"><b>{s?.queued ?? '…'}</b><span>in queue</span></div>
        </div>

        <button className="btn btn-ghost who" onClick={onLogout} title="Sign out">{me.email} · sign out</button>
      </header>

      <div className="grid">
        <Stage d={d} />
        <aside className="rail">
          <ManualDial d={d} open={dialOpen} onToggle={() => setDialOpen(!dialOpen)} />
          <UpNext leads={d.upNext} queued={s?.queued} />
          <Activity feed={d.feed} loaded={d.feedLoaded} open={feedOpen} onToggle={() => setFeedOpen(!feedOpen)} />
        </aside>
      </div>

      <footer className="bottombar">
        {d.fromNumbers.map((n) => (
          <span className="num" key={n.number} title={`${n.usedToday} of ${n.cap} dials today from this caller ID`}>
            <span className="mono">{prettyPhone(n.number)}</span>
            <span className="cap"><i className={n.usedToday / n.cap > 0.8 ? 'hot' : ''} style={{ width: `${Math.min(100, (100 * n.usedToday) / n.cap)}%` }} /></span>
            <span className="mono">{n.usedToday}/{n.cap}</span>
          </span>
        ))}
        {!d.fromNumbers.length && <span>No caller IDs configured</span>}
        <div className="right">
          <input ref={fileRef} type="file" accept=".csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) d.upload(f); e.target.value = ''; }} />
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={d.busy}>Upload CSV</button>
        </div>
      </footer>

      {/* The softphone attaches the rep leg's audio here. */}
      <audio id="remoteMedia" autoPlay />
    </div>
  );
}
