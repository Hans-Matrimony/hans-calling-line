'use client';
import { useEffect, useRef, useState } from 'react';
import { useDialer, type Me } from '../lib/useDialer';
import { prettyPhone } from '../lib/format';
import CallCard from './CallCard';
import Handset from './Handset';
import Campaign from './Campaign';
import UpNext from './UpNext';
import Activity from './Activity';
import { Dialpad, Play, Layers, Clock, List, LogOut, Upload } from './icons';

type Tab = 'dialer' | 'auto' | 'burst' | 'activity' | 'upnext';
type IconC = React.ComponentType<{ size?: number }>;
const TAB_IDS: Tab[] = ['dialer', 'auto', 'burst', 'activity', 'upnext'];
const TABS: { id: Tab; label: string; icon: IconC }[] = [
  { id: 'dialer', label: 'Dialer', icon: Dialpad },
  { id: 'auto', label: 'Auto dial', icon: Play },
  { id: 'burst', label: 'Burst dial', icon: Layers },
  { id: 'activity', label: 'Activity', icon: Clock },
  { id: 'upnext', label: 'Up next', icon: List },
];

/** Per-viewer UI preference: which tab was open. Never critical: falls back to the dialer. */
function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTabState] = useState<Tab>('dialer');
  useEffect(() => { try { const s = localStorage.getItem('eazybe.tab'); if (TAB_IDS.includes(s as Tab)) setTabState(s as Tab); } catch { /* private mode etc. */ } }, []);
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem('eazybe.tab', t); } catch { /* ignore */ } };
  return [tab, setTab];
}

export default function Console({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const d = useDialer(me);
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useTab();

  // Audio on by default: connect the softphone as soon as the console loads. If the mic is blocked or
  // the connect fails, useDialer surfaces the error and the "Connect" button stays for a manual retry.
  const autoConnect = useRef(false);
  useEffect(() => {
    if (autoConnect.current) return;
    autoConnect.current = true;
    d.connect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A call is never hidden behind a tab: dialing or a live lead brings the dialer forward so the card and outcome
  // are in view - unless the rep is on Auto dial / Burst dial, which show the call themselves.
  useEffect(() => {
    if (d.phase !== 'ringing' && d.phase !== 'live') return;
    const target: Tab = d.run ? d.run.mode : (tab === 'auto' || tab === 'burst') ? tab : 'dialer';
    if (tab !== target) setTab(target);
  }, [d.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tap-to-dial from Up next / Activity: the number lands in the handset, the rep presses Call.
  const dialFrom = (phone: string) => { d.setPrefill(phone); setTab('dialer'); };

  const s = d.stats;
  const rate = s && s.dialed_today ? Math.round((100 * s.connected_today) / s.dialed_today) : null;
  const audio = d.rep === 'connected' ? { lamp: 'green', text: 'Audio on' } : d.rep === 'ringing' ? { lamp: 'amber', text: 'Connecting…' } : { lamp: '', text: 'Audio off' };
  const calls = d.feed.filter((e) => e.kind !== 'sys').length;

  return (
    <div className="app">
      <nav className="side" aria-label="Main">
        <div className="brand"><span className="brand-name">Eazybe</span><span className="brand-sub">dialer</span></div>
        {TABS.map((t) => (
          <button key={t.id} className={'nav' + (tab === t.id ? ' on' : '')} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <t.icon /><span>{t.label}</span>
            {t.id === 'activity' && calls > 0 && <b>{calls}</b>}
            {t.id === 'upnext' && s != null && <b>{s.queued}</b>}
          </button>
        ))}
      </nav>

      <div className="console">
        <header className="topbar">
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

          <button className="btn btn-ghost who" onClick={onLogout} title="Sign out"><LogOut /><span>{me.email}</span></button>
        </header>

        {tab === 'dialer' && (
          <div className={'dialer' + (d.phase !== 'idle' ? ' in-call' : '')}>
            {d.phase !== 'idle' && <CallCard d={d} />}
            <div className="handset"><Handset d={d} /></div>
            {d.err && d.err !== d.softphone.error && <p className="err">{d.err}</p>}
            {d.softphone.error && <p className="err">{d.softphone.error}</p>}
          </div>
        )}
        {tab === 'auto' && <div className="page wide"><Campaign d={d} mode="auto" /></div>}
        {tab === 'burst' && <div className="page wide"><Campaign d={d} mode="burst" /></div>}
        {tab === 'activity' && <div className="page"><Activity feed={d.feed} loaded={d.feedLoaded} onDial={dialFrom} /></div>}
        {tab === 'upnext' && <div className="page"><UpNext queue={d.queue} onDial={dialFrom} onExpand={d.expandGroup} hubspot={s?.hubspot} onSync={d.syncNow} busy={d.busy} /></div>}

        {(tab === 'activity' || tab === 'upnext') && (
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
              <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={d.busy}><Upload />Upload CSV</button>
            </div>
          </footer>
        )}
      </div>

      {/* The softphone attaches the rep leg's audio here. */}
      <audio id="remoteMedia" autoPlay />
    </div>
  );
}
