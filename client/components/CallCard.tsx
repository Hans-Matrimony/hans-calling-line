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

/** The lead beside the handset: who answered, what we know about them, and — once the call ends — the outcome.
 *  Call controls (mute, dialpad, note, hang up) live on the handset; this card never duplicates them. */
export default function CallCard({ d }: { d: D }) {
  const [laterAt, setLaterAt] = useState('');
  useEffect(() => { if (!d.card) setLaterAt(''); }, [d.card]);
  const c = d.card;
  if (!c) return null;

  const split = splitName(c.name);
  const name = split.name;
  const company = c.extra?.company || split.company;
  const ended = d.phase === 'ended';

  return (
    <section className={'card' + (d.phase === 'live' ? ' live' : '')} aria-live="polite">
      <div className="head">
        <div>
          <span className="eyebrow">{ended ? 'Call ended — save an outcome' : d.rep !== 'connected' ? 'Audio dropped — hang up and save an outcome' : 'On the line'}</span>
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

      {c.lastNote && <div className="lastnote"><b>Last note</b>{c.lastNote}</div>}

      {ended && (
        <>
          <textarea className="field" placeholder="Note — saved with the outcome, shown next time this lead comes up" value={d.note} onChange={(e) => d.setNote(e.target.value)} rows={2} />
          <div className="outcomes">
            <button className="btn btn-green" onClick={() => d.disposition('connected', {})} disabled={d.busy}>Connected</button>
            <button className="btn" onClick={() => d.disposition('no_answer', {})} disabled={d.busy}>No answer</button>
            <div className="later">
              <input className="field" type="datetime-local" value={laterAt} onChange={(e) => setLaterAt(e.target.value)} aria-label="Call back at" />
              <button className="btn btn-blue" onClick={() => d.disposition('later', { laterAt })} disabled={d.busy || !laterAt}>Call later</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
