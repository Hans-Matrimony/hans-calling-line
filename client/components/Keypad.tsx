'use client';
import { useEffect, useState } from 'react';
import type { useDialer, FromNumber } from '../lib/useDialer';

const KEYS: [string, string][] = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
// Windows has no flag emoji, so a text code stands in for the flag.
const REGION: Record<FromNumber['region'], { code: string; name: string }> = {
  india: { code: 'IN', name: 'India' }, eu: { code: 'UK', name: 'United Kingdom' }, us: { code: 'US', name: 'United States' },
};
// +1 is the only 1-digit country code we dial from; everything else gets a 2-digit code.
const pretty = (n: string) =>
  n.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 $1 $2 $3').replace(/^\+(\d{2})(\d{5})(\d+)$/, '+$1 $2 $3');
const Handset = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden>
    <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8z" />
  </svg>
);

/** Softphone panel (CallHippo-style): status/connect header, last call, number display, keypad,
 *  round call button, caller-ID picker. State lives in useDialer; this is markup + local input. */
export default function Keypad({ d }: { d: ReturnType<typeof useDialer> }) {
  const [num, setNum] = useState('+');
  const [from, setFrom] = useState('');
  const [menu, setMenu] = useState(false);
  const inCall = d.phase !== 'idle';
  const canDial = d.rep === 'connected' && !inCall && !d.busy && /^\+\d{7,15}$/.test(num.replace(/[\s()-]/g, ''));

  useEffect(() => { // default caller ID: first number still under its cap
    if (!from && d.fromNumbers.length) setFrom(d.fromNumbers.find((n) => n.available)?.number ?? d.fromNumbers[0].number);
  }, [d.fromNumbers, from]);

  const status = d.rep === 'connected' ? 'Available' : d.rep === 'ringing' ? 'Ringing...' : 'Disconnected';
  const sp = d.softphone;

  return (
    <aside className="keypad">
      <div className="kp-head">
        <button className={'pill ' + d.rep} onClick={() => setMenu((m) => !m)} disabled={d.busy}>
          <span className={'dot ' + d.rep} /> {status} ▾
        </button>
        {d.mode === 'browser' && sp.status === 'in_call' && (
          <button className={'icon' + (sp.muted ? ' on' : '')} title={sp.muted ? 'Unmute' : 'Mute'} onClick={sp.toggleMute}>{sp.muted ? '🔇' : '🎙️'}</button>
        )}
        <span className="mode">{d.mode === 'browser' ? 'Browser' : 'Phone'}</span>
      </div>
      {menu && (
        <div className="menu">
          {d.rep === 'disconnected' ? (
            <>
              <button onClick={() => { d.setMode('browser'); setMenu(false); }} className={d.mode === 'browser' ? 'sel' : ''}>Audio in browser</button>
              <button onClick={() => { d.setMode('phone'); setMenu(false); }} className={d.mode === 'phone' ? 'sel' : ''}>Audio on my phone</button>
              {d.mode === 'phone' && <input placeholder="+91 98765 43210" value={d.phone} onChange={(e) => d.setPhone(e.target.value)} />}
              <button className="primary" onClick={() => { setMenu(false); d.connect(); }} disabled={d.busy || (d.mode === 'phone' && !d.phone)}>Connect me</button>
            </>
          ) : (
            <button onClick={() => { setMenu(false); d.disconnect(); }} disabled={d.busy}>Hang up audio leg</button>
          )}
        </div>
      )}
      {d.rep === 'ringing' && d.mode === 'phone' && <p className="muted small">Answer your phone and keep the call open.</p>}
      {sp.error && <p className="err small">{sp.error}</p>}

      <div className="last">
        <div className="muted small">Last call activity</div>
        {d.lastCall ? (
          <><b>{pretty(d.lastCall.phone)}</b><div className="muted small">Via {pretty(d.lastCall.from)} at {d.lastCall.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} Outgoing ↗</div></>
        ) : <div className="muted small">—</div>}
      </div>

      <div className="display">
        <input value={num} onChange={(e) => setNum(e.target.value)} onFocus={(e) => e.target.select()} spellCheck={false} />
        <button className="icon" onClick={() => setNum((n) => (n.length > 1 ? n.slice(0, -1) : '+'))} title="Backspace">⌫</button>
      </div>

      <div className="keys">
        {KEYS.map(([k, sub]) => (
          <button key={k} onClick={() => setNum((n) => n + k)}><span>{k}</span><small>{sub}</small></button>
        ))}
      </div>

      {inCall
        ? <button className="callbtn hang" onClick={d.hangupLead} disabled={d.busy || d.phase === 'ended'} title="Hang up"><Handset /></button>
        : <button className="callbtn" onClick={() => d.manualDial(num, from)} disabled={!canDial} title="Call"><Handset /></button>}

      <select className="callerid" value={from} onChange={(e) => setFrom(e.target.value)} disabled={inCall}>
        {!d.fromNumbers.length && <option value="">No caller IDs configured</option>}
        {d.fromNumbers.map((n) => (
          <option key={n.number} value={n.number} disabled={!n.available}>
            {REGION[n.region].code} · {REGION[n.region].name} ({pretty(n.number)}) · {n.usedToday}/{n.cap}{n.available ? '' : ' full'}
          </option>
        ))}
      </select>
    </aside>
  );
}
