'use client';
import { useRef, useState } from 'react';
import type { useDialer, ActivityEvent } from '../lib/useDialer';
import { localTime, prettyPhone, splitName } from '../lib/format';
import CallCard from './CallCard';
import Handset from './Handset';

type D = ReturnType<typeof useDialer>;
export type Mode = 'auto' | 'burst';

const COPY = {
  auto: { legs: 1 as const, eyebrow: 'Auto dial', title: 'One lead at a time.', next: 'Next lead',
    sub: 'Dials the next lead in your queue. When the call ends, save the outcome and press Next.' },
  burst: { legs: 2 as const, eyebrow: 'Burst dial', title: 'Two at once. First to answer wins.', next: 'Next burst',
    sub: 'Rings two leads together. The first to pick up is put through to you; the other is cancelled and comes back in a later burst.' },
};

// The tape: one tile per dial this run, in order, coloured by what happened. Encodes the sequence honestly -
// a rep can read "three no-answers then a connect" at a glance without a single number.
const TILE: Partial<Record<ActivityEvent['kind'], string>> = { connected: 'green', no_answer: 'grey', later: 'blue', cancelled: 'amber', failed: 'coral' };
const LEGEND: [string, string][] = [['green', 'connected'], ['grey', 'no answer'], ['blue', 'call later'], ['amber', 'cancelled'], ['coral', 'failed']];

/** Auto dial / Burst dial: a run through the rep's own queue. Idle = the hero, Start, the queue, the tape of this run.
 *  In a call = the run strip + lead card on the left, the handset's in-call view on the right. */
export default function Campaign({ d, mode }: { d: D; mode: Mode }) {
  const c = COPY[mode];
  const [run, setRun] = useState<{ since: Date } | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const inCall = d.phase !== 'idle' || !!d.card;
  const tape = run ? d.feed.filter((e) => e.at >= run.since && TILE[e.kind]).reverse() : [];
  const dialed = tape.filter((e) => e.kind !== 'cancelled').length;
  const connected = tape.filter((e) => e.kind === 'connected').length;

  const ready = d.upNext?.length ?? null;
  const off = d.rep !== 'connected';
  const canStart = !off && !d.busy && !inCall && ready !== 0;
  const why = off ? 'Connect audio first.' : ready === 0 ? 'Nobody in your queue is inside their calling hours right now.' : '';

  const start = async () => { if (await d.startCalling(c.legs) !== undefined) setRun((r) => r ?? { since: new Date() }); };
  const upload = async (f: File) => {
    const r = await d.upload(f);
    if (r) setImportMsg(`Imported ${r.inserted} new, ${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}${r.warnings.length ? `, ${r.warnings.length} without a timezone` : ''}.`);
  };

  const Tape = ({ compact = false }: { compact?: boolean }) => (
    <div className={'tape' + (compact ? ' compact' : '')}>
      <div className="tape-row" aria-label="Dials this run">
        {tape.map((e) => <span key={e.id} className={'tile ' + TILE[e.kind]} title={`${e.text} · ${e.sub ?? e.kind}`} />)}
        {inCall && <span className="tile now" title="dialing now" />}
        {!tape.length && !inCall && <span className="hint">Nothing dialed this run yet.</span>}
      </div>
      {!compact && (
        <div className="tape-legend">{LEGEND.map(([k, l]) => <span key={k}><i className={'tile ' + k} />{l}</span>)}</div>
      )}
      <div className="tape-sum">This run · {dialed} dialed · {connected} connected</div>
    </div>
  );

  if (inCall) {
    return (
      <div className="camp-call">
        <div className="run-strip">
          <div className="head">
            <span className="camp-eyebrow">{c.eyebrow}{run ? ' · running' : ''}</span>
            {run && <button className="btn btn-mini" onClick={() => setRun(null)}>Stop run</button>}
          </div>
          {run && <Tape compact />}
          {d.phase === 'ringing' && d.legs.length > 1 && (
            <div className="race" aria-label="Leads ringing">
              {d.legs.map((l) => (
                <div className={'racer ' + l.status} key={l.leadId}>
                  <span className={'lamp ' + (l.status === 'ringing' ? 'amber' : l.status === 'answered' ? 'green' : '')} aria-hidden />
                  <b>{splitName(l.name).name || prettyPhone(l.phone)}</b>
                  <span className="m">{l.country ?? prettyPhone(l.phone)} · {l.status === 'cancelled' ? 'cancelled — back in a later burst' : l.status}</span>
                </div>
              ))}
            </div>
          )}
          {d.card && <CallCard d={d} />}
          {d.err && d.err !== d.softphone.error && <p className="err">{d.err}</p>}
        </div>
        <div className="handset"><Handset d={d} /></div>
      </div>
    );
  }

  return (
    <div className="camp">
      <div className="camp-hero">
        <span className="camp-eyebrow">{c.eyebrow}{run ? ' · running' : ''}</span>
        <h1 className="camp-title">{c.title}</h1>
        <p className="camp-sub">{c.sub}</p>
      </div>

      <div className="camp-actions">
        <button className="btn btn-blue btn-lg" onClick={start} disabled={!canStart}>{run ? c.next : 'Start dialing'}</button>
        {run && <button className="btn" onClick={() => setRun(null)} disabled={d.busy}>Stop run</button>}
        <input ref={fileRef} type="file" accept=".csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={d.busy}>Upload CSV</button>
        <span className="hint">{why || importMsg || ''}</span>
      </div>
      {d.err && d.err !== d.softphone.error && <p className="err">{d.err}</p>}

      <div className="camp-grid">
        <section className="panel">
          <div className="panel-head"><h2 className="panel-title">This run</h2></div>
          {run ? <Tape /> : <p className="empty">Press Start dialing. Every dial in this run lands here as a tile, in order.</p>}
        </section>

        <section className="panel queue">
          <div className="panel-head"><h2 className="panel-title">Your queue</h2></div>
          <div className="nums">
            <div><b>{ready ?? '…'}</b><span>ready now</span></div>
            <div><b>{d.stats?.queued ?? '…'}</b><span>in queue</span></div>
          </div>
          {d.upNext && d.upNext.length > 0 && (
            <div className="next">
              {d.upNext.slice(0, c.legs + 1).map((l) => (
                <div className="lead" key={l.id}>
                  <span className="n">{l.name || l.extra?.company || prettyPhone(l.phone)}</span>
                  <span className="lt">{localTime(l.utc_offset)?.text ?? '--:--'}</span>
                  <span className="m">{l.country ?? 'country unknown'}{l.attempt_count > 0 ? ` · attempt ${l.attempt_count + 1}` : ''}</span>
                </div>
              ))}
            </div>
          )}
          {ready === 0 && <p className="empty">{d.stats?.queued ? 'Leads open up as their local clocks reach 10:00.' : 'Upload a CSV to fill your queue.'}</p>}
        </section>
      </div>
    </div>
  );
}
