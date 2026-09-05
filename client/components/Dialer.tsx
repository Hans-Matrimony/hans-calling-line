'use client';
import { useRef, useState } from 'react';
import { useDialer, type Me } from '../lib/useDialer';
import Keypad from './Keypad';

export default function Dialer({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const d = useDialer(me);
  const [laterAt, setLaterAt] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const canStart = d.rep === 'connected' && d.phase === 'idle' && !d.busy;

  return (
    <main className="dialer">
      <header>
        <h1>Eazybe Dialer</h1>
        <div className="stats">
          <span><b>{d.stats?.dialed_today ?? '-'}</b> dialed today</span>
          <span><b>{d.stats?.connected_today ?? '-'}</b> connected</span>
          <span><b>{d.stats?.queued ?? '-'}</b> in queue</span>
        </div>
        <button className="ghost" onClick={onLogout}>{me.email} · sign out</button>
      </header>

      <div className="cols">
        <section className="left">
          <section className="card main">
            {d.phase === 'idle' && <button className="primary big" onClick={d.startCalling} disabled={!canStart}>Start calling</button>}
            {d.phase === 'idle' && d.rep !== 'connected' && <p className="warn">Connect your audio first (status menu on the right).</p>}
            {d.phase === 'ringing' && <p className="ringing">Dialing {d.legs.map((l) => l.name ?? l.phone).join(' + ') || '...'}</p>}
            {d.card && (
              <div className="lead">
                <div className="name">{d.card.name ?? d.card.phone}</div>
                <div className="meta">{d.card.phone} · {d.card.country ?? 'country ?'} · {d.card.segment}</div>
                <div className="meta">attempt #{d.card.attempt} · last outcome: {d.card.lastOutcome ?? 'none'}</div>
                <div className={'state ' + d.phase}>
                  {d.phase === 'live' ? 'On the line' : 'Call ended' + (d.duration != null ? ' after ' + d.duration + 's' : '')}
                </div>
                <div className="dispo">
                  <button onClick={() => d.disposition('connected')} disabled={d.busy}>Connected</button>
                  <button onClick={() => d.disposition('no_answer')} disabled={d.busy}>No answer</button>
                  <input type="datetime-local" value={laterAt} onChange={(e) => setLaterAt(e.target.value)} />
                  <button onClick={() => { d.disposition('later', laterAt); setLaterAt(''); }} disabled={d.busy || !laterAt}>Call later</button>
                </div>
              </div>
            )}
            {d.err && d.err !== d.softphone.error && <p className="err">{d.err}</p>}
          </section>

          <footer>
            <input ref={fileRef} type="file" accept=".csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) d.upload(f); e.target.value = ''; }} />
            <button className="ghost" onClick={() => fileRef.current?.click()} disabled={d.busy}>Upload leads CSV</button>
            <ul className="log">{d.log.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </footer>
        </section>

        <Keypad d={d} />
      </div>
      {/* Remote audio for browser mode; the softphone attaches the rep leg's stream here. */}
      <audio id="remoteMedia" autoPlay />
    </main>
  );
}
