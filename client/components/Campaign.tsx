'use client';
import { useEffect, useRef, useState } from 'react';
import type { useDialer, ActivityEvent, Card, Leg, NextLead, Mode } from '../lib/useDialer';
import { emptyQueue, NOT_DUE, OUTCOME_LABEL, clock, listCountries, localTime, prettyPhone, relative, splitName } from '../lib/format';
import { resolveLead } from '../lib/leadFields';
import CallCard, { LeadPreview } from './CallCard';
import Handset from './Handset';
import { Phone, Play, ArrowRight, Upload, List } from './icons';

const initials = (s: string | null) => (s ? s.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() : '');

/** A NextLead (queue peek) as a Card, so the pre-call preview and the live card share one component. */
function nextToCard(n: NextLead): Card {
  return {
    callId: 0, leadId: n.id, name: n.name, phone: n.phone, country: n.country, segment: n.segment,
    utcOffset: n.utc_offset, hubspotId: null, extra: n.extra ?? {},
    attempt: n.attempt_count + 1, lastOutcome: n.last_outcome, lastNote: null,
    lastCallAt: n.lastCallAt, everConnected: n.everConnected, callCount: n.attempt_count,
    phones: n.phones ?? [n.phone], phoneIdx: n.phoneIdx ?? 1,
  };
}

/** The standing Up Next column (JustCall parity): who's coming, their local time, tap to preview before
 *  dialing. Read-only while a call is live (you can't re-point a dial mid-call), highlighting the lead
 *  in play. Names prefer the person, then the company, then the number. */
function UpNextColumn({ leads, queued, currentId, previewId, onPreview }:
  { leads: NextLead[] | null; queued: number | undefined; currentId: number | null; previewId: number | null; onPreview?: (id: number) => void }) {
  return (
    <aside className="upnext-col" aria-label="Up next">
      <div className="uc-head"><span>Up next</span>{queued != null && <b>{queued}</b>}</div>
      {leads === null ? <p className="empty">Loading…</p>
        : leads.length === 0 ? <p className="empty"><List />Queue empty</p>
          : (
            <ol className="uc-list">
              {leads.map((l) => {
                const nm = splitName(l.name).name || l.extra?.company || prettyPhone(l.phone);
                const active = l.id === currentId || (currentId == null && l.id === previewId);
                return (
                  <li key={l.id}>
                    <button className={'uc-row' + (active ? ' on' : '')} onClick={() => onPreview?.(l.id)} disabled={!onPreview} aria-current={active}>
                      <span className="uc-ava" aria-hidden>{initials(splitName(l.name).name || l.extra?.company || null) || <Phone />}</span>
                      <span className="uc-main">
                        <span className="uc-name">{nm}</span>
                        <span className="uc-num mono">{prettyPhone(l.phone)}</span>
                      </span>
                      <span className="uc-lt">{localTime(l.utc_offset)?.text ?? '--:--'}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
    </aside>
  );
}

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
const CAP_MSG = 'Every caller ID has hit its daily cap — resets at 00:00 UTC (05:30 IST).';

/** Who is on the line right now, in words - so a rep on Auto/Burst always knows the current lead without
 *  reading the card. Ringing names every leg; live/ended names the one that answered. */
function WhoBanner({ legs, card, phase }: { legs: Leg[]; card: Card | null; phase: string }) {
  const nameOf = (c: Card | null | undefined, fallback?: string | null) => {
    if (c) { const l = resolveLead(c); return { who: l.headline ?? prettyPhone(c.phone), company: l.headlineKind === 'name' ? l.company : null }; }
    return { who: splitName(fallback ?? null).name ?? '—', company: null };
  };
  if (phase === 'ringing' && legs.length) {
    return (
      <div className="who-banner ringing">
        <i className="lamp amber" aria-hidden /><span className="wb-verb">Dialing</span>
        <span className="wb-names">{legs.map((l) => nameOf(l.card, l.name).who).join('  ·  ')}</span>
      </div>
    );
  }
  if ((phase === 'live' || phase === 'ended') && card) {
    const n = nameOf(card);
    return (
      <div className={'who-banner ' + phase}>
        <i className={'lamp ' + (phase === 'live' ? 'green' : '')} aria-hidden />
        <span className="wb-verb">{phase === 'live' ? 'Connected' : 'Wrapping up'}</span>
        <span className="wb-names"><b>{n.who}</b>{n.company && <em>{n.company}</em>}</span>
      </div>
    );
  }
  return null;
}

// One tile colour per event kind, shared by the tape and the named recent-calls list.
const KIND_TILE: Partial<Record<ActivityEvent['kind'], string>> = { connected: 'green', no_answer: 'grey', later: 'blue', cancelled: 'amber', failed: 'coral' };

/** The named run log: every dial this run as a readable row - time, who, company, outcome - newest
 *  first. Answers "who did I just call, when, and how did it go" without opening the Activity tab. */
function RecentCalls({ tape, limit }: { tape: ActivityEvent[]; limit?: number }) {
  const rows = [...tape].reverse().slice(0, limit ?? tape.length);
  if (!rows.length) return null;
  return (
    <ol className="recent" aria-label="Calls this run">
      {rows.map((e) => (
        <li key={e.id}>
          <span className="rt-time">{clock(e.at)}</span>
          <i className={'rt-dot ' + (KIND_TILE[e.kind] ?? 'grey')} aria-hidden />
          <span className="rt-who"><b>{e.text}</b>{e.company && <em>{e.company}</em>}</span>
          <span className="rt-out">{e.sub}</span>
        </li>
      ))}
    </ol>
  );
}

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
  const [previewId, setPreviewId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  // The lead shown in the pre-call preview: the one the rep clicked in Up next, else the next to dial.
  const previewLead = (previewId != null && d.upNext?.find((l) => l.id === previewId)) || d.upNext?.[0] || null;
  const currentId = d.card?.leadId ?? d.legs[0]?.leadId ?? null;

  const inCall = d.phase !== 'idle' || !!d.card;
  const ringing = d.phase === 'ringing';
  const tape = run || last ? d.runTape : [];
  const ready = d.stats?.ready ?? null;
  const queued = d.stats?.queued ?? null;
  const off = d.rep !== 'connected';
  const EMPTY_QUEUE = emptyQueue(d.stats?.hubspot?.configured);
  const capped = d.fromNumbers.length > 0 && !d.fromNumbers.some((n) => n.available);
  const canStart = !off && !d.busy && !inCall && !capped && ready != null && ready > 0;

  // One truthful reason when Start is grey.
  const nextOpen = d.stats?.next_open_at ? new Date(d.stats.next_open_at) : null;
  // "12 open at 10:00 (India), 6 at 13:30 (Germany, France)" when the grouped queue is in; the coarse
  // gap/clock counts until it is.
  const windows = d.queue?.later.filter((g) => g.why === 'window' && g.opensAt).slice(0, 3)
    .map((g, i) => `${g.count}${i ? '' : ' open'} at ${clock(new Date(g.opensAt!))}${g.countries.length ? ` (${listCountries(g.countries, 2)})` : ''}`).join(', ');
  const waiting = d.stats && ready === 0 && queued
    ? windows ? `Nobody is due right now — ${windows}.`
      : `Nobody is due right now.${nextOpen ? ` Next opens ${clock(nextOpen)} (${relative(nextOpen)})` : ''}${d.stats.waiting_gap || d.stats.waiting_window ? ` — ${d.stats.waiting_gap} waiting on the 2h gap, ${d.stats.waiting_window} on their clocks.` : '.'}`
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
    if (r.withAlternates) bits.push(`${r.withAlternates} with alternate numbers`);
    if (r.skipped.length) bits.push(`${r.skipped.length} skipped`);
    if (r.warnings.length) bits.push(`${r.warnings.length} with no timezone (won't dial until the country is fixed)`);
    setImportMsg(`Imported ${bits.join(', ')}.${r.skipped.length || r.warnings.length ? ' Line details are in Activity.' : ''}`);
  };
  // Focus follows the loop: after the outcome is saved, Enter dials the next lead.
  useEffect(() => { if (!inCall && run && canStart) nextRef.current?.focus(); }, [inCall, run, canStart]);

  if (inCall) {
    const abandoned = d.legs.find((l) => l.status === 'abandoned');
    return (
      <div className="camp-shell">
        <UpNextColumn leads={d.upNext} queued={queued ?? undefined} currentId={currentId} previewId={null} />
        <div className="camp-call">
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
          <WhoBanner legs={d.legs} card={d.card} phase={d.phase} />
          {run && <Tape tape={tape} now compact ready={ready} title="This run" />}
          {tape.length > 0 && <RecentCalls tape={tape} limit={4} />}
        </section>

        <CallCard d={d} />
        <div className="handset"><Handset d={d} /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="camp-shell">
      <UpNextColumn leads={d.upNext} queued={queued ?? undefined} currentId={null} previewId={previewLead?.id ?? null} onPreview={setPreviewId} />
      <div className={'camp' + (run ? ' running' : '')}>
      {run ? <StatusLine /> : previewLead ? <StatusLine /> : (
        <div className="camp-hero">
          <StatusLine />
          <h1 className="camp-title">{c.title}</h1>
          <p className="camp-sub">{c.sub}</p>
        </div>
      )}

      <div className="camp-actions">
        <button ref={nextRef} className="btn btn-blue btn-lg" onClick={start} disabled={!canStart}>{run ? <ArrowRight /> : <Play />}{run ? c.next : 'Start dialing'}<kbd>Enter</kbd></button>
        {off && <button className="btn btn-blue" onClick={d.connect} disabled={d.busy}>Connect audio</button>}
        {run && <button className="btn" onClick={d.stopRun} disabled={d.busy}>Stop run</button>}
        <input ref={fileRef} type="file" accept=".csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={d.busy}><Upload />Upload CSV</button>
      </div>
      <p className={'camp-status' + (err ? ' err' : '')} role="status">{status}</p>
      {hot.length > 0 && <p className="camp-usage">{hot.map((n) => `${prettyPhone(n.number)} ${n.usedToday}/${n.cap}`).join(' · ')}</p>}

      {previewLead && <LeadPreview d={d} c={nextToCard(previewLead)} />}

      <div className="camp-grid">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{run ? 'This run' : last ? 'Last run' : 'This run'}{(run ?? last) && <b>since {clock((run ?? last)!.since)}{last ? ` · ended ${clock(last.until)}` : ''}</b>}</h2>
          </div>
          {run || last
            ? <><Tape tape={tape} now={false} ready={run ? ready : null} title={run ? 'This run' : 'Last run'} />{tape.length > 0 && <RecentCalls tape={tape} limit={8} />}</>
            : <p className="empty">Press Start dialing. Each call in this run shows up here as a colour block, in order — green is a connect. Below it, a named log of who you dialed and when.</p>}
        </section>

        <section className="panel queue">
          <div className="panel-head"><h2 className="panel-title">Your queue{queued != null && <b>{queued} in queue</b>}</h2></div>
          <div className="nums"><div><b>{ready ?? '…'}</b><span>ready now</span></div></div>
          {ready === 0 && <p className="empty">{queued ? (waiting ?? NOT_DUE) : EMPTY_QUEUE}</p>}
        </section>
      </div>
      </div>
    </div>
  );
}
