'use client';
import { useEffect, useRef, useState } from 'react';
import { useDialer, type Me } from '../lib/useDialer';
import Campaign, { CallerCapacity } from './Campaign';
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
  useEffect(() => { try { const s = localStorage.getItem('hans.tab'); if (TAB_IDS.includes(s as Tab)) setTabState(s as Tab); } catch { /* private mode etc. */ } }, []);
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem('hans.tab', t); } catch { /* ignore */ } };
  return [tab, setTab];
}

export default function Console({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const d = useDialer(me);
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useTab();
  const [importMessage, setImportMessage] = useState('');

  // Audio on by default: connect the softphone as soon as the console loads. If the mic is blocked or
  // the connect fails, useDialer surfaces the error and the "Connect" button stays for a manual retry.
  const autoConnect = useRef(false);
  useEffect(() => {
    if (autoConnect.current || !d.recovered) return;
    autoConnect.current = true;
    if (d.phase === 'idle') d.connect();
  }, [d.recovered]); // eslint-disable-line react-hooks/exhaustive-deps

  // A call is never hidden behind a tab: dialing or a live lead brings the dialer forward so the card and outcome
  // are in view - unless the rep is on Auto dial / Burst dial, which show the call themselves.
  useEffect(() => {
    if (d.phase !== 'ringing' && d.phase !== 'live' && d.phase !== 'ended') return;
    const target: Tab = d.run ? d.run.mode : (tab === 'auto' || tab === 'burst') ? tab : 'dialer';
    if (tab !== target) setTab(target);
  }, [d.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tap-to-dial from Up next / Activity: the number lands in the handset, the rep presses Call.
  const dialFrom = (phone: string) => { d.dismissSaved(); d.setPrefill(phone); setTab('dialer'); };

  const s = d.stats;
  const rate = s && s.dialed_today ? Math.round((100 * s.connected_today) / s.dialed_today) : null;
  const audio = d.rep === 'connected' ? { lamp: 'green', text: 'Audio on' } : d.rep === 'ringing' ? { lamp: 'amber', text: 'Connecting…' } : { lamp: '', text: 'Audio off' };
  const calls = d.feed.filter((e) => e.kind !== 'sys').length;

  return (
    <div className="app rep-app">
      <a className="cw-skip" href="#workspace-main">Skip to workspace</a>
      <nav className="side" aria-label="Main">
        <div className="brand"><span className="brand-name">Hans</span><span className="brand-sub">dialer</span></div>
        <span className="cw-nav-label">Workspace</span>
        {TABS.map((t) => (
          <button key={t.id} className={'nav' + (tab === t.id ? ' on' : '')} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <t.icon /><span>{t.label}</span>
            {t.id === 'activity' && calls > 0 && <b>{calls}</b>}
            {t.id === 'upnext' && s != null && <b>{s.queued}</b>}
          </button>
        ))}
        <div className="cw-account"><span className="cw-mini-avatar" aria-hidden>{me.email.slice(0, 1).toUpperCase()}</span><div><b>{me.email.split('@')[0]}</b><span title={me.email}>{me.email}</span></div><button className="btn btn-ghost" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button></div>
      </nav>

      <div className="console">
        <header className="topbar">
          <div className="cw-breadcrumb">Workspace <span>/</span><b>{TABS.find((t) => t.id === tab)?.label}</b></div>
          <div className="stats" aria-label="Today">
            <span className="cw-overline">Today</span>
            <div className="stat"><b>{s?.dialed_today ?? '…'}</b><span>dialed</span></div>
            <div className="stat"><b className="green">{s?.connected_today ?? '…'}</b><span>connected</span></div>
            <div className="stat"><b>{rate != null ? rate + '%' : s ? '–' : '…'}</b><span>rate</span></div>
          </div>
          <div className="audio" role="status">
            <span className={'lamp ' + audio.lamp} aria-hidden />
            <span>{audio.text}</span>
            {d.rep === 'disconnected'
              ? <button className="btn btn-blue" onClick={d.connect} disabled={d.busy}>Connect</button>
              : <button className="btn btn-ghost" onClick={d.disconnect} disabled={d.busy || d.phase === 'live' || d.phase === 'ringing'} title={d.phase === 'live' || d.phase === 'ringing' ? 'End the call first' : 'Disconnect audio'}>Disconnect</button>}
          </div>
        </header>
        <main id="workspace-main" className="cw-workspace" tabIndex={-1}>
          <div className="cw-page-heading"><div><span className="cw-overline">Calling workspace</span><h1>{TABS.find((t) => t.id === tab)?.label}<span>{tab === 'burst' ? 'First answer. Full focus.' : tab === 'auto' ? 'One conversation at a time.' : tab === 'dialer' ? 'Your next conversation starts here.' : tab === 'activity' ? 'Every conversation, in view.' : 'The right time for every lead.'}</span></h1></div>
            <input ref={fileRef} type="file" accept=".csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { const result = await d.upload(f); if (result) setImportMessage(`Imported ${result.inserted} new · ${result.updated} updated · ${result.skipped.length} skipped · ${result.warnings.length} need a timezone. Details in Activity.`); } }} />
            <button className="btn" onClick={() => { setImportMessage(''); fileRef.current?.click(); }} disabled={d.busy}><Upload size={15} />Import CSV</button>
          </div>
          {importMessage && <p className="cw-notice" role="status">{importMessage}</p>}
          {d.inbound && (
            <div className="cw-active-banner inbound-ring" role="alert">
              <span>Incoming callback — <b>{d.inbound.phone}</b></span>
              <button className="btn btn-blue" onClick={d.acceptInbound}>Answer</button>
              <button className="btn" onClick={d.rejectInbound}>Reject — send to queue</button>
            </div>
          )}
          {d.inboundLive && (
            <div className="cw-active-banner" role="status">
              <span>On the line — <b>{d.inboundLive.phone}</b> (incoming callback)</span>
              <button className="btn" onClick={d.softphone.toggleMute} disabled={d.softphone.status !== 'in_call'}>{d.softphone.muted ? 'Unmute' : 'Mute'}</button>
              <button className="btn" onClick={d.endInbound}>End call</button>
            </div>
          )}
          {(d.err || d.softphone.error) && <div className="cw-error" role="alert">{d.err || d.softphone.error}</div>}
          {d.loadError && <div className="cw-error" role="alert">{d.loadError} Displayed queue data may be out of date. <button className="cw-link" onClick={d.retryLoad}>Retry loading</button></div>}
          {(d.phase !== 'idle') && (tab === 'activity' || tab === 'upnext') && <div className="cw-active-banner"><span>{d.phase === 'ended' ? 'This call needs an outcome.' : 'You have a call in progress.'}</span><button className="btn btn-blue" onClick={() => setTab(d.run?.mode || 'dialer')}>Return to call</button></div>}
          {(tab === 'dialer' || tab === 'auto' || tab === 'burst') && <Campaign d={d} mode={tab} onQueue={() => setTab('upnext')} />}
          {tab === 'activity' && <Activity feed={d.feed} loaded={d.feedLoaded} onDial={dialFrom} />}
          {tab === 'upnext' && <UpNext queue={d.queue} onDial={dialFrom} onExpand={d.expandGroup} hubspot={s?.hubspot} onSync={d.syncNow} busy={d.busy} />}
          {(tab === 'activity' || tab === 'upnext') && <CallerCapacity d={d} />}
        </main>
      </div>

      {/* The softphone attaches the rep leg's audio here. */}
      <audio id="remoteMedia" autoPlay />
    </div>
  );
}
