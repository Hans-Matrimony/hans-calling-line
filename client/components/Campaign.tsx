'use client';
import { useEffect, useRef, useState } from 'react';
import type { useDialer, ActivityEvent, LegStatus, Mode } from '../lib/useDialer';
import { EMPTY_QUEUE, NOT_DUE, OUTCOME_LABEL, clock, localTime, prettyPhone, relative, splitName } from '../lib/format';
import CallCard from './CallCard';
import Handset from './Handset';

type D = ReturnType<typeof useDialer>;

const COPY = {
  auto: { legs: 1 as const, eyebrow: 'Auto dial', title: 'One lead at a time.', next: 'Next lead',
    sub: 'Dials the next lead in your queue. When the call ends, save the outcome on the lead card, then press Next lead.' },
  burst: { legs: 2 as const, eyebrow: 'Burst dial', title: 'Two at once. First to answer wins.', next: 'Next burst',
    sub: 'Rings two leads at once. The first to pick up is put through to you; the other is tried again later. When the call ends, save the outcome on the lead card, then press Next burst.' },
};

// The tape: one tile per lead dialed this run, in order, coloured by what happened. It encodes the sequence honestly -
// a rep reads "three no-answers then a connect" at a glance without a single number.
const TILE: Partial<Record<ActivityEvent['kind'], string>> = { connected: 'green', no_answer: 'grey', later: 'blue', cancelled: 'amber', failed: 'coral' };
const TILE_ORDER = ['green', 'grey', 'blue', 'amber', 'coral'];
const TILE_LABEL: Record<string, string> = { green: 'connected', grey: 'no answer', blue: 'call later', amber: 'cancelled', coral: 'failed' };
const RACE: Record<LegStatus, string> = {
  ringing: 'ringing…', answered: 'answered — on the line with you', cancelled: 'cancelled — back in a later burst', abandoned: 'picked up too late — counts as an attempt',
};
const CAP_MSG = 'Every caller ID has hit its daily cap — resets at 00:00 UTC (05:30 IST).';

function Tape({ tape, now, ready, title, compact }: { tape: ActivityEvent[]; now: boolean; ready: number | null; title: string; compact?: boolean }) {
  const counts: Record<string, number> = {};
  for (const e of tape) { const k = TILE[e.kind]; if (k) counts[k] = (counts[k] ?? 0) + 1; }
  return (
    <div className={'tape' + (compact ? ' compact' : '')}>
      <div className="tape-row" aria-label="Calls this run">
        {tape.map((e) => <span key={e.id} className={'tile ' + TILE[e.kind]} title={`${e.text}${e.sub ? ' · ' + e.sub : ''}`} />)}
        {now && <span className="tile now" title="dialing now" />}
        {!tape.length && !now && <span className="hint">No calls in this run yet.</span>}
      </div>
      <div className="tape-sum">
        <span>{title}</span>
        {TILE_ORDER.filter((k) => counts[k]).map((k) => <span key={k}><i className={'tile ' + k} />{counts[k]} {TILE_LABEL[k]}</span>)}
        {ready != null && <span>{ready} ready{ready === 0 && <span className="muted"> · queue drained</span>}</span>}
      </div>
    </div>
  );
}

/** Auto dial / Burst dial: a run through the rep's own queue. Before a run: the hero, Start, the queue. Between dials:
 *  a compact status line, Next, the tape. In a call: the run bar + lead card on the left, the handset's in-call view on
 *  the right. Run state lives in useDialer, so switching tabs or a lead answering elsewhere never loses it. */
export default function Campaign({ d, mode }: { d: D; mode: Mode }) {
  const c = COPY[mode];
  const run = d.run?.mode === mode ? d.run : null;
  const last = !run && d.lastRun?.mode === mode ? d.lastRun : null;
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const inCall = d.phase !== 'idle' || !!d.card;
  const ringing = d.phase === 'ringing';
  const tape = run || last ? d.runTape : [];
  const ready = d.stats?.ready ?? null;
  const queued = d.stats?.queued ?? null;
  const off = d.rep !== 'connected';
  const capped = d.fromNumbers.length > 0 && !d.fromNumbers.some((n) => n.available);
  const canStart = !off && !d.busy && !inCall && !capped && ready != null && ready > 0;

  // One truthful reason when Start is grey.
  const nextOpen = d.stats?.next_open_at ? new Date(d.stats.next_open_at) : null;
  const waiting = d.stats && ready === 0 && queued
    ? `Nobody is due right now.${nextOpen ? ` Next opens ${clock(nextOpen)} (${relative(nextOpen)})` : ''}${d.stats.waiting_gap || d.stats.waiting_window ? ` — ${d.stats.waiting_gap} waiting on the 2h gap, ${d.stats.waiting_window} on their clocks.` : '.'}`
    : null;
  const why = off ? (d.softphone.error ?? 'Connect audio first.') : capped ? CAP_MSG : ready === 0 ? (queued ? (waiting ?? NOT_DUE) : EMPTY_QUEUE) : '';
  const err = d.err && d.err !== d.softphone.error ? d.err : off ? null : d.softphone.error; // when audio is off `why` already carries the softphone error
  const nextPreview = run && !why && d.upNext?.length
    ? 'Next: ' + d.upNext.slice(0, c.legs).map((l) => splitName(l.name).name || prettyPhone(l.phone)).join(' and ')
      + (c.legs === 1 ? ` · ${localTime(d.upNext[0].utc_offset)?.text ?? '--:--'} their time · attempt ${d.upNext[0].attempt_count + 1}${d.upNext[0].last_outcome ? ', last ' + (OUTCOME_LABEL[d.upNext[0].last_outcome] ?? d.upNext[0].last_outcome) : ''}` : '')
    : '';
  const lastBurstLine = run && d.lastBurst
    ? (d.lastBurst.result === 'cancelled' ? `Dialing stopped. Press ${c.next}.` : `Nobody answered${d.lastBurst.names.length ? ' — ' + d.lastBurst.names.join(' · ') : ''}. Press ${c.next}.`)
    : '';
  const status = err ?? (why || lastBurstLine || nextPreview || importMsg || '');
  const hot = d.fromNumbers.filter((n) => n.usedToday / n.cap > 0.8);

  const word = ringing ? { text: 'Ringing', lamp: 'amber' } : d.phase === 'live' ? { text: 'In a call', lamp: 'green' } : d.phase === 'ended' ? { text: 'Call ended', lamp: 'green' } : run ? { text: 'Run paused', lamp: 'blue' } : { text: 'Ready', lamp: '' };
  const StatusLine = () => (
    <span className={'camp-eyebrow' + (run ? '' : ' muted')}>
      {run && <i className={'lamp ' + word.lamp} aria-hidden />}{word.text} · {c.eyebrow}{run ? ` · since ${clock(run.since)}` : ''}
    </span>
  );

  const start = async () => { if (await d.startCalling(c.legs) === 'started') d.startRun(mode); };
  const upload = async (f: File) => {
    const r = await d.upload(f);
    if (!r) return;
    const bits = [`${r.inserted} new`, `${r.updated} updated`];
    if (r.skipped.length) bits.push(`${r.skipped.length} skipped`);
    if (r.warnings.length) bits.push(`${r.warnings.length} with no timezone (won't dial until the country is fixed)`);
    setImportMsg(`Imported ${bits.join(', ')}.${r.skipped.length || r.warnings.length ? ' Line details are in Activity.' : ''}`);
  };
  // Focus follows the loop: after the outcome is saved, Enter dials the next lead.
  useEffect(() => { if (!inCall && run && canStart) nextRef.current?.focus(); }, [inCall, run, canStart]);

  if (inCall) {
    const showRace = d.legs.length > 0 && (ringing || d.legs.some((l) => l.status === 'cancelled' || l.status === 'abandoned'));
    const racers = ringing ? d.legs : d.legs.filter((l) => l.status !== 'answered');
    const abandoned = d.legs.find((l) => l.status === 'abandoned');
    return (
      <div className="camp-call">
        <div className="run-strip">
          <section className="panel run-bar">
            <div className="panel-head">
              <StatusLine />
              {run && (d.phase === 'live' || d.phase === 'ended') && (
                <button className="btn btn-mini" onClick={d.endRunAfterCall} disabled={run.endAfter} title="The run ends once you save this call's outcome">
                  {run.endAfter ? 'Ending after this call' : 'End run after this call'}
                </button>
              )}
            </div>
            {err && <p className="camp-status err">{err}</p>}
            {!err && abandoned && <p className="camp-status err">{splitName(abandoned.name).name || prettyPhone(abandoned.phone)} picked up while you were connecting — counted as an attempt, back in 2h.</p>}
            {!err && !abandoned && ringing && d.heldBack.length > 0 && (
              <p className="camp-status">Only one lead was ready — {d.heldBack.map((h) => `${splitName(h.name).name || prettyPhone(h.phone)} back at ${clock(new Date(h.at))}`).join(', ')}.</p>
            )}
            {run && <Tape tape={tape} now compact ready={ready} title="This run" />}
          </section>

          {showRace && (
            <div className="race" aria-label="Leads dialed">
              {racers.map((l) => (
                <div className={'racer ' + l.status} key={l.leadId}>
                  <span className={'lamp ' + (l.status === 'ringing' ? 'amber' : l.status === 'answered' ? 'green' : l.status === 'abandoned' ? 'coral' : '')} aria-hidden />
                  <b>{splitName(l.name).name || prettyPhone(l.phone)}</b>
                  <span className="m">{l.country ?? prettyPhone(l.phone)} · {RACE[l.status]}</span>
                </div>
              ))}
            </div>
          )}

          {d.card && <CallCard d={d} />}
        </div>
        <div className="handset"><Handset d={d} /></div>
      </div>
    );
  }

  return (
    <div className={'camp' + (run ? ' running' : '')}>
      {run ? <StatusLine /> : (
        <div className="camp-hero">
          <StatusLine />
          <h1 className="camp-title">{c.title}</h1>
          <p className="camp-sub">{c.sub}</p>
        </div>
      )}

      <div className="camp-actions">
        <button ref={nextRef} className="btn btn-blue btn-lg" onClick={start} disabled={!canStart}>{run ? c.next : 'Start dialing'}</button>
        {off && <button className="btn btn-blue" onClick={d.connect} disabled={d.busy}>Connect audio</button>}
        {run && <button className="btn" onClick={d.stopRun} disabled={d.busy}>Stop run</button>}
        <input ref={fileRef} type="file" accept=".csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={d.busy}>Upload CSV</button>
      </div>
      <p className={'camp-status' + (err ? ' err' : '')} role="status">{status}</p>
      {hot.length > 0 && <p className="camp-usage">{hot.map((n) => `${prettyPhone(n.number)} ${n.usedToday}/${n.cap}`).join(' · ')}</p>}

      <div className="camp-grid">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{run ? 'This run' : last ? 'Last run' : 'This run'}{(run ?? last) && <b>since {clock((run ?? last)!.since)}{last ? ` · ended ${clock(last.until)}` : ''}</b>}</h2>
          </div>
          {run || last
            ? <Tape tape={tape} now={false} ready={run ? ready : null} title={run ? 'This run' : 'Last run'} />
            : <p className="empty">Press Start dialing. Each call in this run shows up here as a colour block, in order — green is a connect.</p>}
        </section>

        <section className="panel queue">
          <div className="panel-head"><h2 className="panel-title">Your queue{queued != null && <b>{queued} in queue</b>}</h2></div>
          <div className="nums"><div><b>{ready ?? '…'}</b><span>ready now</span></div></div>
          {d.upNext && d.upNext.length > 0 && (
            <>
              <span className="micro">Next up</span>
              <div className="next">
                {d.upNext.slice(0, c.legs + 1).map((l) => (
                  <div className="lead" key={l.id}>
                    <span className="n">{splitName(l.name).name || l.extra?.company || prettyPhone(l.phone)}</span>
                    <span className="lt">{localTime(l.utc_offset)?.text ?? '--:--'}</span>
                    <span className="m">
                      {l.country ?? 'country unknown'}
                      {l.attempt_count > 0 ? ` · attempt ${l.attempt_count + 1}` : ''}
                      {l.last_outcome ? ` · last ${OUTCOME_LABEL[l.last_outcome] ?? l.last_outcome}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {ready === 0 && <p className="empty">{queued ? (waiting ?? NOT_DUE) : EMPTY_QUEUE}</p>}
        </section>
      </div>
    </div>
  );
}
