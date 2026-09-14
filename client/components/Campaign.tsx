'use client';
import { useRef, useState } from 'react';
import type { useDialer, Card, NextLead, Mode } from '../lib/useDialer';
import { localTime, prettyPhone, relative, clock } from '../lib/format';
import { resolveLead } from '../lib/leadFields';
import { CallNotes, CallTimer, Identity, OutcomeForm } from './CallCard';
import LeadRail from './LeadRail';
import Handset from './Handset';
import { ArrowRight, Check, List, Phone, Refresh } from './icons';

type D = ReturnType<typeof useDialer>;
type View = Mode | 'dialer';
export function nextToCard(l: NextLead): Card {
  return { callId: 0, leadId: l.id, name: l.name, phone: l.phone, country: l.country, segment: l.segment,
    utcOffset: l.utc_offset, timezone: l.timezone, attemptLimit: l.attemptLimit, hubspotId: null, extra: l.extra || {},
    attempt: l.attempt_count + 1, lastOutcome: l.last_outcome, lastNote: null, lastCallAt: l.lastCallAt,
    everConnected: l.everConnected, callCount: l.attempt_count, phones: l.phones || [l.phone], phoneIdx: l.phoneIdx || 1 };
}
const nameOf = (l: NextLead) => resolveLead(nextToCard(l)).headline || prettyPhone(l.phone);

/** One stable workspace for reviewing, calling and saving, shared by all three dialing modes. */
export default function Campaign({ d, mode, onQueue }: { d: D; mode: View; onQueue: () => void }) {
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const startLock = useRef(false);
  const active = d.phase !== 'idle';
  const saved = !active ? d.lastSaved : null;
  const first = d.upNext?.[0];
  const preview = d.upNext?.find((l) => l.id === previewId) || first;
  const c = d.card || (active ? d.legs.find((l) => l.status === 'ringing' || l.status === 'answered')?.card : saved?.card || (mode !== 'dialer' && preview ? nextToCard(preview) : null));
  const inspecting = !active && !saved && preview && first && preview.id !== first.id;
  const isManual = mode === 'dialer';
  const ready = d.stats?.ready ?? 0;
  const available = d.fromNumbers.some((n) => n.available);
  const otherRun = d.run && d.run.mode !== mode;
  const why = !d.recovered ? 'Restoring your session…' : d.rep !== 'connected' ? 'Connect audio in the top bar to start calling.'
    : !d.fromNumbers.length ? 'No caller IDs configured. Ask your admin to add one.' : !available ? 'All caller IDs have reached their daily limit.'
    : otherRun ? `Stop your ${d.run!.mode === 'auto' ? 'auto' : 'burst'} dial run before changing modes.`
    : !d.upNext || !d.stats ? 'Loading your queue…' : !ready ? 'No leads are eligible right now. Check Up next for their opening times.' : '';
  const start = async () => {
    if (active || isManual || why || d.busy || startLock.current) return;
    startLock.current = true; setStarting(true);
    try { if (await d.startCalling(mode === 'burst' ? 2 : 1) === 'started') { d.startRun(mode); setPreviewId(null); } }
    finally { startLock.current = false; setStarting(false); }
  };
  const step = saved ? 4 : d.phase === 'ended' ? 3 : active ? 2 : 1;
  const status = saved ? 'Outcome saved' : d.phase === 'live' ? d.rep === 'connected' ? 'On the line' : 'Audio disconnected · hang up and save'
    : d.phase === 'ringing' ? 'Connecting your conversation' : d.phase === 'ended' ? d.endCause === 'bridge_failed' ? 'Disconnected before bridging · save No answer' : 'Call ended · save the outcome'
    : isManual ? 'Make a call' : inspecting ? 'Queue preview' : 'Next in your queue';
  return <>
    <div className="cw-grid">
      <QueueRail d={d} selectedId={c?.leadId ?? null} disabled={active || d.busy} onQueue={onQueue} onPreview={(l) => { if (isManual) { d.dismissSaved(); d.setPrefill(l.phone); } else { d.dismissSaved(); setPreviewId(l.id); } }} />
      <section className={'cw-conversation phase-' + d.phase} aria-label="Calling workspace">
        <ol className="cw-phases" aria-label="Call progress">{['Review lead', 'Conversation', 'Save outcome'].map((label, i) => <li key={label} className={step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''} aria-current={step === i + 1 ? 'step' : undefined}><span>{step > i + 1 ? <Check size={12} /> : i + 1}</span>{label}</li>)}</ol>
        <div className="cw-call-state" role="status"><span className={'lamp ' + (saved || d.phase === 'live' && d.rep === 'connected' ? 'green' : d.phase === 'ringing' ? 'amber' : '')} />{status}{d.phase === 'ringing' && d.legs.length > 1 && <span className="cw-chip">First answer connects</span>}</div>
        {c && <Identity d={d} c={c}>{(d.phase === 'live' || d.phase === 'ended' || saved) && <CallTimer since={d.answeredAt} frozen={saved ? saved.duration ?? 0 : d.phase === 'ended' ? d.duration ?? 0 : null} />}</Identity>}
        {d.phase === 'ringing' && <div className="cw-ringing">
          {d.legs.map((l) => <div key={l.leadId}><Phone size={15} /><span><b>{l.name || prettyPhone(l.phone)}</b><small className="mono">{prettyPhone(l.phone)}</small></span><span className="cw-chip">{l.status}</span></div>)}
        </div>}
        {d.phase === 'live' && <CallNotes d={d} />}
        {d.phase === 'ended' && c && <OutcomeForm key={c.callId} d={d} c={c} />}
        {d.phase === 'ended' && !c && <p className="cw-error" role="alert">The call details are unavailable. Reload to restore the outcome form.</p>}
        {(d.phase === 'live' || d.phase === 'ringing') && <Handset d={d} />}
        {saved && <div className="cw-saved" role="status"><span className="cw-saved-mark"><Check size={22} /></span><h3>Outcome saved</h3><p>{saved.label}{saved.status === 'exhausted' ? ' · Attempt limit reached' : ''}</p>
          {saved.status === 'queued' && saved.nextCallAt && <small>Scheduled {new Date(saved.nextCallAt).toLocaleString()}</small>}{saved.note && <blockquote>{saved.note}</blockquote>}
        </div>}
        {!active && isManual && !saved && <div className="cw-manual"><Handset d={d} /></div>}
        {!active && !isManual && !saved && <div className="cw-ready"><span className="cw-overline">{mode === 'burst' ? 'Two leads. First answer connects.' : 'One conversation at a time.'}</span>
          <h3>{inspecting ? 'Reviewing this contact' : first ? 'Ready when you are.' : d.upNext === null ? 'Loading your leads…' : 'You’re caught up for now.'}</h3>
          <p>{inspecting ? `The next call starts with ${nameOf(first!)}.` : mode === 'burst' ? 'Ring up to two eligible leads. When one answers, focus on that conversation.' : 'Review the contact, start the call, then capture what comes next.'}</p>
          {d.lastBurst && <p className="cw-notice">{d.lastBurst.result === 'cancelled' ? 'Dialing stopped.' : 'No answer. The retry schedule is in Up next.'}</p>}
        </div>}
        {d.heldBack.length > 0 && <div className="cw-notice">Waiting for retry: {d.heldBack.map((l) => `${l.name || l.phone} (${relative(new Date(l.at))})`).join(' · ')}</div>}
        {!active && <div className="cw-next-action">
          {isManual ? saved && <button className="btn btn-blue" onClick={d.dismissSaved}>Back to dialer<ArrowRight size={16} /></button> : <>
            <div>{saved && first && <><span className="cw-overline">Up next</span><b>{nameOf(first)}</b></>}{why && <p>{why}</p>}{!why && !saved && <small>{ready} ready · {mode === 'burst' ? 'Up to 2 leads per dial' : '1 lead per dial'}</small>}</div>
            {inspecting ? <button className="btn" onClick={() => setPreviewId(null)}>Review next lead<ArrowRight size={16} /></button> : <button className="btn btn-blue" onClick={start} disabled={!!why || d.busy || starting}>{starting ? 'Starting…' : saved || d.run ? mode === 'burst' ? 'Next 2 leads' : 'Next lead' : 'Start calling'}<ArrowRight size={16} /></button>}
          </>}
        </div>}
        <CallerCapacity d={d} />
      </section>
      {c ? <LeadRail key={c.leadId} d={d} c={c} /> : <aside className="cw-context cw-context-empty"><List size={22} /><h3>Your contact, in context.</h3><p>Contact details, local time and history appear here when you call a lead.</p></aside>}
    </div>
    <RunStrip d={d} />
  </>;
}

function QueueRail({ d, selectedId, disabled, onPreview, onQueue }: { d: D; selectedId: number | null; disabled: boolean; onPreview: (l: NextLead) => void; onQueue: () => void }) {
  const [query, setQuery] = useState('');
  const leads = d.upNext?.filter((l) => [l.name, l.extra?.company, l.phone].join(' ').toLowerCase().includes(query.toLowerCase()));
  const hs = d.stats?.hubspot;
  return <aside className="cw-queue" aria-label="Lead queue"><div className="cw-section-head"><h2>Up next</h2><span className="cw-chip">{d.stats?.ready ?? '…'} ready</span></div>
    <input className="field cw-search" type="search" aria-label="Search queue preview" placeholder="Search next 10 leads" value={query} onChange={(e) => setQuery(e.target.value)} />
    <div className="cw-queue-label"><span>Contact</span><span>Local time</span></div>
    {!leads ? <p className="cw-empty">Loading queue…</p> : !leads.length ? <p className="cw-empty">{query ? 'No matching leads in this preview.' : 'No leads are ready right now.'}</p> : <ol className="cw-queue-list">{leads.map((l) => <li key={l.id}><button className={selectedId === l.id ? 'selected' : ''} disabled={disabled} onClick={() => onPreview(l)} aria-current={selectedId === l.id ? 'true' : undefined}>
      <span className="cw-mini-avatar" aria-hidden>{nameOf(l).slice(0, 1).toUpperCase()}</span><span className="cw-queue-person"><b>{nameOf(l)}</b><small>{l.extra?.company || prettyPhone(l.phone)}</small></span><time>{localTime(l.utc_offset, new Date(), l.timezone)?.text ?? 'Unknown'}</time>
    </button></li>)}</ol>}
    <div className="cw-queue-foot"><div><span>Waiting / scheduled</span><b className="mono">{d.stats ? Math.max(0, d.stats.queued - d.stats.ready) : '…'}</b></div>
      {d.queue?.soonest && <p>Next opening {relative(new Date(d.queue.soonest))}</p>}
      <button className="cw-link" onClick={onQueue}>View full queue<ArrowRight size={14} /></button>
    </div>
    {hs?.configured && <div className={'cw-sync' + (hs.ok === false ? ' has-error' : '')}><span className="lamp" /><div><b>{hs.ok === false ? 'HubSpot needs attention' : hs.syncedAt ? 'Queue synced' : 'Waiting for HubSpot'}</b><small>{hs.ok === false ? hs.error : hs.syncedAt ? `Last pull ${relative(new Date(hs.syncedAt))}` : 'No completed pull yet'}</small></div><button className="cw-link" title="Sync HubSpot now" aria-label="Sync HubSpot now" onClick={d.syncNow} disabled={d.busy}><Refresh size={14} /></button></div>}
  </aside>;
}

export function CallerCapacity({ d }: { d: D }) {
  return <div className="cw-capacity" aria-label="Caller ID daily capacity"><span>Caller IDs · today</span>{d.fromNumbers.length ? d.fromNumbers.map((n) => <div key={n.number}><span className="mono">{prettyPhone(n.number)}</span><meter min={0} max={Math.max(1, n.cap)} value={n.usedToday} aria-label={`${n.number}: ${n.usedToday} of ${n.cap} dials`} /><span className="mono">{n.usedToday}/{n.cap}</span></div>) : <p>No caller IDs configured</p>}</div>;
}

function RunStrip({ d }: { d: D }) {
  const [open, setOpen] = useState(false);
  if (!d.run && !d.runTape.length) return null;
  const connected = d.runTape.filter((e) => e.kind === 'connected' || e.kind === 'later').length;
  return <section className="cw-run" aria-label="Dialing run"><div className="cw-run-summary"><span className="cw-overline">{d.run ? 'This run' : 'Last run'}</span><div className="cw-tape" aria-hidden>{d.runTape.slice(-50).map((e) => <i key={e.id} className={e.kind} />)}</div><span>{d.runTape.length} results · {connected} interested / follow-ups</span>
    <button className="cw-link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide call log' : 'View call log'}</button>
    {d.run && (d.phase === 'idle' ? <button className="btn" onClick={d.stopRun}>Stop run</button> : <button className="btn" onClick={d.endRunAfterCall} disabled={d.run.endAfter}>{d.run.endAfter ? 'Ending after this call' : 'End after this call'}</button>)}
  </div>{open && <ol className="cw-run-log">{d.runTape.length ? d.runTape.map((e) => <li key={e.id}><time className="mono">{clock(e.at)}</time><b>{e.text}</b><span>{e.sub}</span></li>) : <li>Completed calls will appear here.</li>}</ol>}</section>;
}
