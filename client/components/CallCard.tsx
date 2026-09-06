'use client';
import { useEffect, useRef, useState } from 'react';
import type { useDialer } from '../lib/useDialer';
import { OUTCOME_LABEL, describeLater, leadLocalAt, mmss, prettyPhone, splitName, toLocalInput } from '../lib/format';
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

const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '') || (document.activeElement as HTMLElement | null)?.isContentEditable === true;

/** The lead beside the handset: who answered, what we know about them, and - once the call ends - the outcome.
 *  Call controls (mute, dialpad, note, hang up) live on the handset; this card never duplicates them.
 *  After the call: focus lands on Connected, keys 1 / 2 / 3 save an outcome, and "Call later" offers times on
 *  the lead's clock so a callback always lands inside their calling hours. */
export default function CallCard({ d }: { d: D }) {
  const [laterAt, setLaterAt] = useState('');
  const [picker, setPicker] = useState(false);
  const firstRef = useRef<HTMLButtonElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const c = d.card;
  const ended = d.phase === 'ended';
  const busy = d.busy;

  useEffect(() => { if (!c) { setLaterAt(''); setPicker(false); } }, [c]);
  // Focus follows the loop: the moment the call ends, Enter means "Connected" - unless the rep is mid-note.
  useEffect(() => { if (ended && !typing()) firstRef.current?.focus(); }, [ended]);
  // 1 / 2 / 3 while the outcome is pending. Never while typing, never with a modifier held.
  useEffect(() => {
    if (!ended || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || typing()) return;
      if (e.key === '1') { e.preventDefault(); d.disposition('connected', {}); }
      else if (e.key === '2') { e.preventDefault(); d.disposition('no_answer', {}); }
      else if (e.key === '3') { e.preventDefault(); (chipRef.current ?? laterRef.current)?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ended, busy, d]);

  if (!c) return null;

  const split = splitName(c.name);
  const name = split.name;
  const company = c.extra?.company || split.company;
  const eyebrow = !ended
    ? (d.rep !== 'connected' ? 'Audio dropped — hang up and save the outcome' : 'On the line')
    : d.endCause === 'bridge_failed' ? 'They hung up before you were connected — save No answer'
    : d.endCause === 'rep_hangup' ? 'You hung up — save the outcome below'
    : 'They hung up — save the outcome below';

  const presets: { label: string; value: string | null }[] = [
    { label: 'In 2 h', value: toLocalInput(new Date(Date.now() + 2 * 3600000)) },
    { label: 'Tomorrow 10:00 their time', value: leadLocalAt(c.utcOffset, 1, 10) },
    { label: 'In 3 days 10:00 their time', value: leadLocalAt(c.utcOffset, 3, 10) },
  ];
  const choose = (v: string) => { setLaterAt(v); setPicker(false); laterRef.current?.focus(); };
  const laterText = laterAt ? describeLater(laterAt, c.utcOffset) : '';

  return (
    <section className={'card' + (d.phase === 'live' ? ' live' : '')}>
      <div className="head">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <div className="name">{name || prettyPhone(c.phone)}</div>
          <div className="sub">
            {company && <span>{company}</span>}
            {c.extra?.leadStage && <span className="tag">{c.extra.leadStage}</span>}
            {c.extra?.origin && <span className="tag">{c.extra.origin}</span>}
          </div>
        </div>
        <Timer since={d.answeredAt} frozen={ended ? d.duration ?? 0 : null} />
      </div>

      <div className="facts">
        <div className="fact"><span>Number</span><b className="mono">{prettyPhone(c.phone)}</b></div>
        <div className="fact"><span>Country</span><b>{c.country ?? '—'}</b></div>
        <div className="fact"><span>Their time</span><b className="lt"><TimeBar offset={c.utcOffset} /></b></div>
        {c.extra?.email && <div className="fact"><span>Email</span><b title={c.extra.email}>{c.extra.email}</b></div>}
        <div className="fact"><span>Attempt</span><b>{c.attempt}{c.lastOutcome ? ` · last ${OUTCOME_LABEL[c.lastOutcome] ?? c.lastOutcome}` : ' · first call'}</b></div>
        {c.extra?.hubspotUrl && <div className="fact"><span>HubSpot</span><b><a href={c.extra.hubspotUrl} target="_blank" rel="noreferrer">Open record ↗</a></b></div>}
      </div>

      {c.lastNote && <div className="lastnote" title={c.lastNote}><b>Last note</b>{c.lastNote}</div>}

      {ended && (
        <>
          <textarea className="field" placeholder="Note — saved with the outcome, shown next time this lead comes up" value={d.note} onChange={(e) => d.setNote(e.target.value)} rows={2}
            onKeyDown={(e) => { if (e.key === 'Escape') { (e.target as HTMLTextAreaElement).blur(); firstRef.current?.focus(); } }} />
          <div className="outcomes">
            <button ref={firstRef} className="btn btn-green" onClick={() => d.disposition('connected', {})} disabled={busy}>Connected<kbd>1</kbd></button>
            <button className="btn" onClick={() => d.disposition('no_answer', {})} disabled={busy}>No answer<kbd>2</kbd></button>
            <div className="later">
              <span className="hint">Call back at<kbd>3</kbd></span>
              <div className="chips">
                {presets.filter((p) => p.value).map((p, i) => (
                  <button key={p.label} ref={i === 0 ? chipRef : undefined} className={'btn btn-mini' + (laterAt === p.value ? ' btn-blue' : '')} onClick={() => choose(p.value!)} disabled={busy}>{p.label}</button>
                ))}
                <button className={'btn btn-mini' + (picker ? ' btn-blue' : '')} onClick={() => setPicker((v) => !v)} disabled={busy}>Pick…</button>
              </div>
              {picker && (
                <label className="pick">
                  <input className="field" type="datetime-local" value={laterAt} min={toLocalInput(new Date())} onChange={(e) => setLaterAt(e.target.value)} aria-label="Call back at" />
                  <span className="hint">Your clock (IST)</span>
                </label>
              )}
              <button ref={laterRef} className={'btn' + (laterAt ? ' btn-blue' : '')} onClick={() => d.disposition('later', { laterAt })} disabled={busy || !laterAt} title={laterAt ? '' : 'Choose a time first'}>
                {laterAt && laterText ? `Call later · ${laterText}` : 'Call later'}
              </button>
            </div>
          </div>
          <button className="wrong" onClick={() => d.disposition('invalid', {})} disabled={busy} title="Reachable, but not this person — stops the lead without counting a connect">Wrong number</button>
        </>
      )}
    </section>
  );
}
