'use client';
import { useEffect, useState } from 'react';
import type { useDialer } from '../lib/useDialer';
import { OUTCOME_LABEL, mmss, prettyPhone, splitName } from '../lib/format';
import TimeBar from './TimeBar';

type D = ReturnType<typeof useDialer>;

function Timer({ since, frozen }: { since: Date | null; frozen: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => { if (!since || frozen != null) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [since, frozen]);
  const secs = frozen ?? (since ? Math.max(0, Math.floor((Date.now() - since.getTime()) / 1000)) : 0);
  return (
    <div className={'timer' + (frozen == null && since ? ' live' : '')}>
      {mmss(secs)}
      <small>{frozen != null ? 'ended' : 'on the line'}</small>
    </div>
  );
}

/** The centre: what is happening right now, in one word; the legs while ringing; the card once someone answers. */
export default function Stage({ d }: { d: D }) {
  const [notes, setNotes] = useState('');
  const [laterAt, setLaterAt] = useState('');
  useEffect(() => { if (!d.card) { setNotes(''); setLaterAt(''); } }, [d.card]);

  const off = d.rep !== 'connected';
  const word =
    off ? { cls: 'off', text: d.rep === 'ringing' ? 'Connecting' : 'Audio off',
            sub: d.rep === 'ringing' ? 'Allow the microphone if your browser asks.'
              : d.card && d.phase === 'ended' ? 'Save an outcome for the last call below, then connect audio again.'
              : d.card ? 'Your audio dropped. Hang up and save an outcome below, then connect audio again.'
              : 'Connect audio, then start calling.' }
    : d.phase === 'ringing' ? { cls: 'ringing', text: `Ringing ${d.legs.length}`, sub: 'Soft tick while they ring. A rising beep means someone answered — say hello.' }
    : d.phase === 'live' ? { cls: 'live', text: 'On the line', sub: null }
    : d.phase === 'ended' ? { cls: 'ended', text: 'Call ended', sub: null }
    : { cls: 'ready', text: 'Ready', sub: null };

  const c = d.card;
  const split = splitName(c?.name ?? null);
  const name = split.name;
  const company = c?.extra?.company || split.company;
  const canStart = !off && d.phase === 'idle' && !d.busy;

  return (
    <main className="stage">
      <h1 className={'state-word ' + word.cls}>
        <span className={'lamp ' + (word.cls === 'ringing' ? 'amber' : word.cls === 'live' ? 'green' : word.cls === 'ready' ? 'blue' : '')} aria-hidden />
        {word.text}
      </h1>
      {word.sub && <p className="state-sub">{word.sub}</p>}

      {d.phase === 'ringing' && d.legs.length > 0 && (
        <div className="legs" style={{ ['--n' as string]: d.legs.length }} aria-label="Dialing legs">
          <div className="you">you</div>
          {d.legs.map((l) => (
            <div className={'leg ' + l.status} key={l.leadId}>
              <span className="wire" aria-hidden />
              <span className="who">
                <span className="n">{l.name || prettyPhone(l.phone)}</span>
                <span className="m">{l.country ?? prettyPhone(l.phone)} · {l.status}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {d.phase === 'ringing' && (
        <div className="actions">
          <button className="btn btn-coral" onClick={d.hangupLead} disabled={d.busy}>Stop dialing</button>
        </div>
      )}

      {c && (
        <section className={'card' + (d.phase === 'live' ? ' live' : '')} aria-live="polite">
          <div className="head">
            <div>
              <div className="name">{name || prettyPhone(c.phone)}</div>
              <div className="sub">
                {company && <span>{company}</span>}
                {c.extra?.leadStage && <span className="tag">{c.extra.leadStage}</span>}
                {c.extra?.origin && <span className="tag">{c.extra.origin}</span>}
              </div>
            </div>
            <Timer since={d.answeredAt} frozen={d.phase === 'ended' ? d.duration ?? 0 : null} />
          </div>

          <div className="facts">
            <div className="fact"><span>Number</span><b className="mono">{prettyPhone(c.phone)}</b></div>
            <div className="fact"><span>Country</span><b>{c.country ?? '—'}</b></div>
            <div className="fact"><span>Their time</span><b className="lt"><TimeBar offset={c.utcOffset} /></b></div>
            {c.extra?.email && <div className="fact"><span>Email</span><b title={c.extra.email}>{c.extra.email}</b></div>}
            <div className="fact"><span>Attempt</span><b>{c.attempt}{c.lastOutcome ? ` · last ${OUTCOME_LABEL[c.lastOutcome] ?? c.lastOutcome}` : ' · first call'}</b></div>
            {c.extra?.hubspotUrl && <div className="fact"><span>HubSpot</span><b><a href={c.extra.hubspotUrl} target="_blank" rel="noreferrer">Open record ↗</a></b></div>}
          </div>

          {c.lastNote && <div className="lastnote"><b>Last note</b>{c.lastNote}</div>}

          <textarea className="field" placeholder="Notes — saved with the outcome, shown next time this lead comes up" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />

          {d.phase === 'live' && (
            <div className="actions">
              <button className="btn btn-coral" onClick={d.hangupLead} disabled={d.busy}>Hang up</button>
              <button className="btn" onClick={d.softphone.toggleMute}>{d.softphone.muted ? 'Unmute' : 'Mute'}</button>
            </div>
          )}

          {d.phase === 'ended' && (
            <div className="outcomes">
              <button className="btn btn-green" onClick={() => d.disposition('connected', { notes })} disabled={d.busy}>Connected</button>
              <button className="btn" onClick={() => d.disposition('no_answer', { notes })} disabled={d.busy}>No answer</button>
              <div className="later">
                <input className="field" type="datetime-local" value={laterAt} onChange={(e) => setLaterAt(e.target.value)} aria-label="Call back at" />
                <button className="btn btn-blue" onClick={() => d.disposition('later', { notes, laterAt })} disabled={d.busy || !laterAt}>Call later</button>
              </div>
            </div>
          )}
        </section>
      )}

      {d.phase === 'idle' && (
        <div className="start">
          <button className="btn btn-blue btn-lg" onClick={d.startCalling} disabled={!canStart}>Start calling</button>
          {!off && <span className="hint">Dials 2 leads at once. First to answer is put through to you.</span>}
        </div>
      )}

      {d.err && d.err !== d.softphone.error && <p className="err">{d.err}</p>}
      {d.softphone.error && <p className="err">{d.softphone.error}</p>}
    </main>
  );
}
