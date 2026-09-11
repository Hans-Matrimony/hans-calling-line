'use client';
import { useEffect, useRef, useState } from 'react';
import type { useDialer, Leg, Card, Outcome, HistoryRow } from '../lib/useDialer';
import { OUTCOME_LABEL, SUB_OUTCOME_LABEL, ago, describeLater, leadLocalAt, mmss, prettyPhone, splitName, talkTime, toLocalInput } from '../lib/format';
import { resolveLead } from '../lib/leadFields';
import LeadRail from './LeadRail';
import { ThumbsUp, Calendar, Phone, ThumbsDown, Ban, PhoneOff, X, History as HistoryIcon, ChevronDown, ChevronRight } from './icons';

type D = ReturnType<typeof useDialer>;
type IconC = React.ComponentType<{ size?: number }>;

// The seven outcome tiles (call-card v2), in two groups. Each collapses onto one of the four
// dispositions; `sub` is the tile itself, recorded alongside. `schedule` reveals the callback times
// (a connect that comes back, still counted as a connect); `reason` reveals the optional why-not chips.
type Tile = { key: string; label: string; outcome: Outcome; sub?: string; tone: 'green' | 'blue' | 'coral' | 'grey'; Icon: IconC; schedule?: boolean; reason?: boolean };
const REACHED: Tile[] = [
  { key: '1', label: 'Interested', outcome: 'connected', sub: 'interested', tone: 'green', Icon: ThumbsUp },
  { key: '2', label: 'Follow-up required', outcome: 'connected', sub: 'follow_up', tone: 'blue', Icon: Calendar, schedule: true },
  { key: '3', label: 'Callback requested', outcome: 'connected', sub: 'callback', tone: 'blue', Icon: Phone, schedule: true },
  { key: '4', label: 'Not interested', outcome: 'connected', sub: 'not_interested', tone: 'coral', Icon: ThumbsDown, reason: true },
  { key: '5', label: 'Not qualified', outcome: 'connected', sub: 'not_qualified', tone: 'grey', Icon: Ban },
];
const MISSED: Tile[] = [
  { key: '6', label: 'No answer', outcome: 'no_answer', tone: 'grey', Icon: PhoneOff },
  { key: '7', label: 'Wrong number', outcome: 'invalid', tone: 'coral', Icon: X },
];
const ALL = [...REACHED, ...MISSED];
const REASONS = ['Price', 'Timing', 'Using a competitor', 'Not relevant', 'Other'];

const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '') || (document.activeElement as HTMLElement | null)?.isContentEditable === true;
const initials = (s: string | null) => (s ? s.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() : '');

function Timer({ since, frozen }: { since: Date | null; frozen: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => { if (!since || frozen != null) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [since, frozen]);
  const secs = frozen ?? (since ? Math.max(0, Math.floor((Date.now() - since.getTime()) / 1000)) : 0);
  return <span className={'call-clk' + (frozen == null && since ? ' live' : '')}>{mmss(secs)}</span>;
}

/** The lead beside the handset, in three states. Ringing: a compact identity preview per leg, read
 *  while it rings. Live: the identity header + a permanent note on the left, the context rail on the
 *  right. Ended: the same, note replaced by the seven outcome tiles. Whatever the state, the identity
 *  header at the top answers "who am I calling, why, have we spoken before" without scrolling. */
export default function CallCard({ d }: { d: D }) {
  if (d.phase === 'ringing') {
    const legs = d.legs.filter((l) => l.status === 'ringing' || l.status === 'answered');
    if (!legs.length) return null;
    return <div className={'stage-preview' + (legs.length > 1 ? ' pair' : '')}>{legs.map((l) => <RingCard key={l.leadId} leg={l} />)}</div>;
  }
  const c = d.card;
  if (!c) return null;
  return <Stage d={d} c={c} />;
}

/** One ringing leg: headline + a compact "why" line, from the preview card the server sent. */
function RingCard({ leg }: { leg: Leg }) {
  const c = leg.card;
  const lead = c ? resolveLead(c) : null;
  const headline = lead?.headline ?? splitName(leg.name).name ?? prettyPhone(leg.phone);
  const sub = lead && lead.headlineKind === 'name' ? [lead.role, lead.company].filter(Boolean).join(' · ') : lead?.role ?? '';
  const why = lead?.why.map((w) => w.value).slice(0, 2).join(' · ');
  return (
    <section className="ring-card">
      <div className="call-status"><span className="eyebrow"><i className="lamp amber" />Ringing</span><span className="call-from mono">{prettyPhone(leg.phone)}</span></div>
      <div className="ring-who">
        <div className="nm">{headline}</div>
        {sub && <div className="role">{sub}</div>}
        <div className="idline">{[why, c && c.callCount > 0 ? `attempt ${c.attempt}` : 'first call'].filter(Boolean).join(' · ')}</div>
      </div>
    </section>
  );
}

/** The next lead, shown before the dial so the rep can read it - and fix it - before it rings. Same
 *  identity header + editable panel as the live card, minus the timer, note and outcome tiles. */
export function LeadPreview({ d, c }: { d: D; c: Card }) {
  return (
    <div className="stage preview">
      <section className="lead-card">
        <div className="call-status"><span className="eyebrow">Up next — review or fix before you dial</span></div>
        <Identity d={d} c={c} />
      </section>
      <LeadRail d={d} c={c} />
    </div>
  );
}

function Stage({ d, c }: { d: D; c: Card }) {
  const ended = d.phase === 'ended';
  const eyebrow = !ended
    ? (d.rep !== 'connected' ? 'Audio dropped — hang up and save the outcome' : 'On the line')
    : d.endCause === 'bridge_failed' ? 'They hung up before you connected — save No answer'
    : d.endCause === 'rep_hangup' ? 'You hung up — save the outcome'
    : 'Call ended — save the outcome';

  return (
    <div className="stage">
      <section className={'lead-card' + (d.phase === 'live' ? ' live' : '')}>
        <div className="call-status">
          <span className={'eyebrow' + (d.phase === 'live' ? ' on' : '')}>
            <i className={'lamp ' + (d.phase === 'live' ? 'green' : '')} />{eyebrow}
          </span>
          <Timer since={d.answeredAt} frozen={ended ? d.duration ?? 0 : null} />
        </div>

        <Identity d={d} c={c} />

        {ended ? <Wrap d={d} c={c} /> : (
          <div className="band">
            <span className="rail-lbl">Note</span>
            <textarea className="field tall" placeholder="Type while they talk — kept if the call drops, carried into the outcome"
              value={d.note} onChange={(e) => d.setNote(e.target.value)} rows={3} />
          </div>
        )}
      </section>

      <LeadRail d={d} c={c} />
    </div>
  );
}

/** The identity header — the top of the card in every live/ended state, so who/why/history never sit
 *  below the fold. Leads with the person's name; with none, the company (else the email) is the hero and
 *  the number drops to a secondary line with an inline "add contact name". Carries the lead-status chip and the
 *  history summary so the rep knows the relationship before the first word. */
function Identity({ d, c }: { d: D; c: Card }) {
  const lead = resolveLead(c);
  const headline = lead.headline ?? prettyPhone(c.phone);
  const sub = lead.headlineKind === 'name' ? [lead.role, lead.company].filter(Boolean).join(' · ')
    : lead.headlineKind === 'number' ? 'Not one of your leads — nothing on file'
    : lead.role ?? '';
  const status = lead.why[0]?.value;
  const others = (c.phones ?? []).filter((p) => p !== c.phone);
  const showNumberInId = lead.headlineKind !== 'number';

  return (
    <div className="who">
      <span className="ava" aria-hidden>{initials(headline) || <Phone />}</span>
      <div className="who-main">
        <div className="nm-row">
          <div className={'nm' + (lead.headlineKind === 'number' ? ' mono num' : '')}>{headline}</div>
          {status && <span className="status-chip">{status}</span>}
        </div>
        {sub && <div className="role">{sub}</div>}
        <div className="idline">
          {showNumberInId && <span className="num mono">{prettyPhone(c.phone)}</span>}
          {others.length > 0 && <span>number {c.phoneIdx} of {c.phones.length}</span>}
          <span>attempt {c.attempt}</span>
        </div>
        <History d={d} c={c} />
      </div>
    </div>
  );
}

/** History summary + expandable list. The one line a rep reads before speaking: how many times, how it
 *  went last, and whether this lead has ever actually connected. "Show history" pulls the full log inline. */
function History({ d, c }: { d: D; c: Card }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const prior = c.callCount;
  if (prior <= 0) return <div className="hist first"><HistoryIcon />First call — no history yet</div>;

  const last = c.lastCallAt ? ago(new Date(c.lastCallAt)) : null;
  const summary = `${prior} previous call${prior === 1 ? '' : 's'} · last ${c.lastOutcome ? (OUTCOME_LABEL[c.lastOutcome] ?? c.lastOutcome) : '—'}${last ? `, ${last}` : ''}`;
  const toggle = async () => { if (!open && !rows) setRows(await d.leadHistory(c.leadId).catch(() => [])); setOpen((v) => !v); };

  return (
    <div className="hist">
      <div className="hist-line">
        <span className={'hist-sum' + (c.everConnected ? ' ok' : '')}><HistoryIcon />{summary} · {c.everConnected ? 'connected before' : 'never connected'}</span>
        <button className="hist-toggle" onClick={toggle} aria-expanded={open}>{open ? 'Hide' : 'Show history'}{open ? <ChevronDown /> : <ChevronRight />}</button>
      </div>
      {c.lastNote && !open && <div className="hist-note" title={c.lastNote}>&ldquo;{c.lastNote}&rdquo;</div>}
      {open && rows && (
        rows.length === 0 ? <div className="hist-note">No saved calls.</div> : (
          <ul className="hist-list">
            {rows.map((r) => (
              <li key={r.callId}>
                <span className="when">{new Date(r.at).toLocaleDateString([], { day: '2-digit', month: 'short' })}</span>
                <span className={'tag ' + (r.disposition ?? '')}>{r.subOutcome ? SUB_OUTCOME_LABEL[r.subOutcome] : OUTCOME_LABEL[r.disposition ?? ''] ?? r.disposition}</span>
                {r.duration != null && r.answered && <span className="dur">{talkTime(r.duration)}</span>}
                {r.notes && <span className="nt">{r.notes}</span>}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

/** Ended: the seven tiles in two groups. The four plain tiles save on press; a schedule tile reveals
 *  the callback times and a reason tile reveals the why-not chips, each saving on confirm. Keys 1-7. */
function Wrap({ d, c }: { d: D; c: Card }) {
  const [pending, setPending] = useState<Tile | null>(null);
  const [laterAt, setLaterAt] = useState('');
  const [reason, setReason] = useState('');
  const [picker, setPicker] = useState(false);
  const firstRef = useRef<HTMLButtonElement>(null);
  const busy = d.busy;

  const save = (t: Tile, opts: { laterAt?: string; reason?: string } = {}) =>
    d.disposition(t.outcome, { subOutcome: t.sub, laterAt: opts.laterAt, reason: opts.reason });
  const pick = (t: Tile) => { if (t.schedule || t.reason) { setPending(t); setReason(''); setLaterAt(''); setPicker(false); } else save(t); };

  useEffect(() => { if (!typing()) firstRef.current?.focus(); }, []);
  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || typing()) return;
      const t = ALL.find((x) => x.key === e.key);
      if (t) { e.preventDefault(); pick(t); }
      else if (e.key === 'Enter' && pending?.reason) { e.preventDefault(); save(pending, { reason }); }
      else if (e.key === 'Enter' && pending?.schedule && laterAt) { e.preventDefault(); save(pending, { laterAt }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, pending, reason, laterAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const presets = [
    { label: 'In 2 h', value: toLocalInput(new Date(Date.now() + 2 * 3600000)) },
    { label: 'Tomorrow 10:00 their time', value: leadLocalAt(c.utcOffset, 1, 10) },
    { label: 'In 3 days 10:00 their time', value: leadLocalAt(c.utcOffset, 3, 10) },
  ].filter((p) => p.value) as { label: string; value: string }[];
  const laterText = laterAt ? describeLater(laterAt, c.utcOffset) : '';

  const group = (tiles: Tile[]) => (
    <div className="tiles">
      {tiles.map((t, i) => (
        <button key={t.key} ref={i === 0 && tiles === REACHED ? firstRef : undefined}
          className={'otile' + (pending?.key === t.key ? ' on-' + t.tone : '')} onClick={() => pick(t)} disabled={busy}>
          <span className="otile-top"><span className={'sw ' + t.tone}><t.Icon size={16} /></span><kbd>{t.key}</kbd></span>
          <b>{t.label}</b>
        </button>
      ))}
    </div>
  );

  return (
    <div className="wrap">
      <span className="rail-lbl">You spoke to them</span>
      {group(REACHED)}
      <span className="rail-lbl">You didn&rsquo;t reach them</span>
      {group(MISSED)}

      {pending?.schedule && (
        <div className="sched">
          <span className="rail-lbl">When do they want the callback?</span>
          <div className="chips">
            {presets.map((p) => (
              <button key={p.label} className={'chip' + (laterAt === p.value ? ' on' : '')} onClick={() => { setLaterAt(p.value); setPicker(false); }} disabled={busy}>{p.label}</button>
            ))}
            <button className={'chip' + (picker ? ' on' : '')} onClick={() => setPicker((v) => !v)} disabled={busy}>Pick a time…</button>
          </div>
          {picker && <input className="field" type="datetime-local" value={laterAt} min={toLocalInput(new Date())} onChange={(e) => setLaterAt(e.target.value)} aria-label="Callback time" />}
          <button className="btn btn-blue" onClick={() => save(pending, { laterAt })} disabled={busy || !laterAt} title={laterAt ? '' : 'Choose a time first'}>
            {laterAt && laterText ? `Save · ${laterText}` : 'Save callback'}{laterAt && <kbd>Enter</kbd>}
          </button>
        </div>
      )}

      {pending?.reason && (
        <div className="sched reasons">
          <span className="rail-lbl">Why not? — optional</span>
          <div className="chips">
            {REASONS.map((r) => (
              <button key={r} className={'chip' + (reason === r ? ' on-coral' : '')} onClick={() => save(pending, { reason: r })} disabled={busy}>{r}</button>
            ))}
          </div>
          <button className="btn" onClick={() => save(pending, { reason })} disabled={busy}>Save without a reason<kbd>Enter</kbd></button>
        </div>
      )}

      <span className="rail-lbl">Note</span>
      <textarea className="field" placeholder="Note — saved with the outcome, shown next time this lead comes up"
        value={d.note} onChange={(e) => d.setNote(e.target.value)} rows={2}
        onKeyDown={(e) => { if (e.key === 'Escape') { (e.target as HTMLTextAreaElement).blur(); firstRef.current?.focus(); } }} />
    </div>
  );
}
