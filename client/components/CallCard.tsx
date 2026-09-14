'use client';
import { useEffect, useRef, useState } from 'react';
import type { useDialer, Card, Outcome, HistoryRow } from '../lib/useDialer';
import { OUTCOME_LABEL, SUB_OUTCOME_LABEL, ago, describeLater, leadLocalAt, mmss, prettyPhone, talkTime, toLocalInput } from '../lib/format';
import { resolveLead } from '../lib/leadFields';
import { ThumbsUp, Calendar, Phone, ThumbsDown, Ban, PhoneOff, X, History as HistoryIcon, ChevronRight } from './icons';

type D = ReturnType<typeof useDialer>;
type Tile = { key: string; label: string; outcome: Outcome; sub?: string; Icon: React.ComponentType<{ size?: number }>; schedule?: boolean; reason?: boolean };
const REACHED: Tile[] = [
  { key: '1', label: 'Interested', outcome: 'connected', sub: 'interested', Icon: ThumbsUp },
  { key: '2', label: 'Follow-up required', outcome: 'connected', sub: 'follow_up', Icon: Calendar, schedule: true },
  { key: '3', label: 'Callback requested', outcome: 'connected', sub: 'callback', Icon: Phone, schedule: true },
  { key: '4', label: 'Not interested', outcome: 'connected', sub: 'not_interested', Icon: ThumbsDown, reason: true },
  { key: '5', label: 'Not qualified', outcome: 'connected', sub: 'not_qualified', Icon: Ban },
];
const MISSED: Tile[] = [
  { key: '6', label: 'No answer', outcome: 'no_answer', Icon: PhoneOff },
  { key: '7', label: 'Wrong number', outcome: 'invalid', Icon: X },
];
const ALL = [...REACHED, ...MISSED];
const REASONS = ['Price', 'Timing', 'Using a competitor', 'Not relevant', 'Other'];

export function CallTimer({ since, frozen }: { since: Date | null; frozen: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => { if (!since || frozen != null) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [since, frozen]);
  const secs = frozen ?? (since ? Math.max(0, Math.floor((Date.now() - since.getTime()) / 1000)) : 0);
  return <span className="cw-timer" aria-label={`Call duration ${mmss(secs)}`}>{mmss(secs)}</span>;
}

export function Identity({ d, c, children }: { d: D; c: Card; children?: React.ReactNode }) {
  const lead = resolveLead(c);
  const headline = lead.headline ?? prettyPhone(c.phone);
  const sub = lead.headlineKind === 'name' ? [lead.role, lead.company].filter(Boolean).join(' · ') : lead.role;
  return <div className="cw-identity">
    <div className="cw-person">
      <span className="cw-avatar" aria-hidden>{lead.headlineKind === 'number' ? <Phone /> : headline.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
      <div className="cw-person-name"><h2>{headline}</h2><p>{sub || (lead.isUnknown ? 'Add contact details as you talk.' : 'Contact details below')}</p></div>
      {children}
    </div>
    <div className="cw-meta"><span className="mono">{prettyPhone(c.phone)}</span><span>Attempt {c.attempt} of {c.attemptLimit}</span>
      {c.phones.length > 1 && <span>Number {c.phoneIdx} of {c.phones.length}</span>}
      {lead.why[0] && <span className="cw-chip">{lead.why[0].value}</span>}
    </div>
    <History key={c.leadId + ':' + c.callCount} d={d} c={c} />
  </div>;
}

function History({ d, c }: { d: D; c: Card }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const fetchHistory = async () => {
    setLoading(true); setError('');
    try { setRows(await d.leadHistory(c.leadId)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  if (c.callCount <= 0) return <div className="cw-history"><HistoryIcon size={15} /><span>First call · no previous conversations</span></div>;
  return <div className="cw-history">
    <HistoryIcon size={15} /><div>
      <div className="cw-history-line"><span>{c.callCount} previous call{c.callCount === 1 ? '' : 's'} · {c.everConnected ? 'Connected before' : 'Never connected'}</span>
        <button className="cw-link" onClick={() => { if (!open && !rows) void fetchHistory(); setOpen(!open); }} aria-expanded={open}>{open ? 'Hide history' : 'View history'}<ChevronRight size={13} /></button>
      </div>
      <p>{c.lastOutcome ? OUTCOME_LABEL[c.lastOutcome] ?? c.lastOutcome : 'No outcome'}{c.lastCallAt ? ` · ${ago(new Date(c.lastCallAt))}` : ''}</p>
      {c.lastNote && !open && <p className="cw-quote">“{c.lastNote}”</p>}
      {open && <div className="cw-history-detail">
        {loading ? <p role="status">Loading history…</p> : error ? <p role="alert">{error} <button className="cw-link" onClick={fetchHistory}>Retry</button></p> : rows?.length ? <ul>{rows.map((r) => <li key={r.callId}>
          <span className="mono">{new Date(r.at).toLocaleDateString([], { day: '2-digit', month: 'short' })}</span>
          <b>{(r.subOutcome && SUB_OUTCOME_LABEL[r.subOutcome]) || OUTCOME_LABEL[r.disposition ?? ''] || 'No outcome'}</b>
          {r.answered && r.duration != null && <span>{talkTime(r.duration)}</span>}{r.notes && <p>{r.notes}</p>}
        </li>)}</ul> : <p>No saved calls.</p>}
      </div>}
    </div>
  </div>;
}

export function CallNotes({ d, disabled = false }: { d: D; disabled?: boolean }) {
  return <div className="cw-notes"><label htmlFor="call-note">Conversation notes <span>Saved with the outcome</span></label>
    <textarea id="call-note" className="field" placeholder="What matters for the next conversation?" value={d.note} onChange={(e) => d.setNote(e.target.value)} rows={4} disabled={disabled} />
    <small>Notes stay in this tab until you save.</small>
  </div>;
}

/** Selecting a tile never writes an outcome. Every path uses the same explicit submit. */
export function OutcomeForm({ d, c }: { d: D; c: Card }) {
  const [pending, setPending] = useState<Tile | null>(null);
  const [laterAt, setLaterAt] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const savingRef = useRef(false);
  const busy = d.busy || saving;
  const future = laterAt && Number.isFinite(new Date(laterAt).getTime()) && new Date(laterAt).getTime() > Date.now();
  const valid = pending && (!pending.schedule || future);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || e.repeat || e.ctrlKey || e.altKey || e.metaKey || (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const tile = ALL.find((t) => t.key === e.key);
      if (tile) { e.preventDefault(); setPending(tile); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pending || !valid || busy || savingRef.current) return;
    savingRef.current = true; setSaving(true); setFailed(false);
    try {
      const result = await d.disposition(pending.outcome, { subOutcome: pending.sub, laterAt: pending.schedule ? laterAt : undefined, reason: pending.reason ? reason : undefined });
      if (!result) setFailed(true);
    } catch { setFailed(true); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const presets = [
    { label: 'In 2 hours', value: toLocalInput(new Date(Date.now() + 2 * 3600000)) },
    { label: 'Tomorrow, 10am there', value: leadLocalAt(c.utcOffset, 1, 10, c.timezone) },
    { label: 'In 3 days, 10am there', value: leadLocalAt(c.utcOffset, 3, 10, c.timezone) },
  ].filter((p) => p.value) as { label: string; value: string }[];
  const group = (tiles: Tile[], label: string) => <fieldset disabled={busy}><legend>{label}</legend><div className="cw-outcomes">{tiles.map((t) =>
    <button type="button" key={t.key} className={'cw-outcome' + (pending?.key === t.key ? ' selected' : '')} aria-pressed={pending?.key === t.key} onClick={() => setPending(t)}>
      <t.Icon size={16} /><span>{t.label}</span><kbd>{t.key}</kbd>
    </button>)}</div></fieldset>;
  return <form className="cw-wrap" onSubmit={save} aria-label="Save call outcome">
    <div className="cw-section-head"><h3>How did the conversation go?</h3><span>Select one outcome</span></div>
    {group(REACHED, 'You spoke to them')}{group(MISSED, 'You didn’t reach them')}
    {pending?.schedule && <div className="cw-schedule"><label htmlFor="callback-time">Schedule callback <span className="muted">· time below is in your timezone</span></label>
      <div className="chips">{presets.map((p) => <button type="button" key={p.label} className={'chip' + (laterAt === p.value ? ' on' : '')} disabled={busy} onClick={() => setLaterAt(p.value)}>{p.label}</button>)}</div>
      <input id="callback-time" className="field" type="datetime-local" value={laterAt} min={toLocalInput(new Date())} onChange={(e) => setLaterAt(e.target.value)} disabled={busy} required />
      {laterAt && <p className={!future ? 'err' : 'muted'}>{future ? describeLater(laterAt, c.utcOffset, c.timezone) : 'Choose a time in the future.'}</p>}
    </div>}
    {pending?.reason && <fieldset disabled={busy}><legend>Reason · optional</legend><div className="chips">{REASONS.map((r) => <button type="button" key={r} className={'chip' + (reason === r ? ' on' : '')} aria-pressed={reason === r} onClick={() => setReason(reason === r ? '' : r)}>{r}</button>)}</div></fieldset>}
    <CallNotes d={d} disabled={busy} />
    {failed && <p className="cw-error" role="alert">Outcome wasn’t saved. Your notes and selection are kept. Try again.</p>}
    <div className="cw-save-row"><span>{pending ? pending.label : 'Choose an outcome to continue'}<small>The next call starts when you choose.</small></span>
      <button className="btn btn-blue" type="submit" disabled={!valid || busy}>{saving ? 'Saving outcome…' : failed ? 'Retry save outcome' : 'Save outcome'}<ChevronRight size={16} /></button>
    </div>
  </form>;
}
