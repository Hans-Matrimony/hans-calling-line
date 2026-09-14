'use client';
import { useEffect, useRef, useState } from 'react';
import type { useDialer, Card, LeadPatch } from '../lib/useDialer';
import { localTime, prettyPhone } from '../lib/format';
import { resolveLead } from '../lib/leadFields';
import TimeBar from './TimeBar';
import { Clock, Check, External } from './icons';

type D = ReturnType<typeof useDialer>;
const FIELDS = [['name', 'Name'], ['company', 'Company'], ['title', 'Job title'], ['email', 'Email'], ['linkedin', 'LinkedIn'], ['leadStage', 'Lead stage'], ['alt1', 'Alternate 1'], ['alt2', 'Alternate 2']] as const;
type Draft = Record<typeof FIELDS[number][0], string>;

export default function LeadRail({ d, c }: { d: D; c: Card }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60000); return () => clearInterval(t); }, []);
  const lead = resolveLead(c);
  const lt = localTime(c.utcOffset, new Date(), c.timezone);
  const primary = c.phones[0] ?? c.phone;
  const edit = () => {
    setDraft({ name: lead.name || '', company: lead.company || '', title: lead.role || '', email: c.extra.email || '', linkedin: c.extra.linkedin || '', leadStage: c.extra.leadStage || '', alt1: c.phones[1] || '', alt2: c.phones[2] || '' });
    setEditing(true); setError(''); setSaved(false);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft || lock.current) return;
    lock.current = true; setSaving(true); setError('');
    const { alt1, alt2, ...fields } = draft;
    const p: LeadPatch = { ...fields, phones: [primary, alt1.trim(), alt2.trim()].filter(Boolean) };
    try { await d.patchLead(c.leadId, p); setEditing(false); setSaved(true); }
    catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setSaving(false); }
  };
  const details = [
    ['Company', lead.company], ['Job title', lead.role], ['Email', c.extra.email], ['LinkedIn', c.extra.linkedin],
    ...lead.why.map((w) => [w.label, w.value]),
  ].filter(([, value]) => value);
  return <aside className="cw-context" aria-label="Contact context">
    <section className="cw-local">
      <span className="cw-overline"><Clock size={14} />Their local time</span>
      <div><b>{lt ? lt.text : 'Unknown'}</b><span>{c.country || 'No country'}</span></div>
      {lt ? <TimeBar offset={c.utcOffset} timezone={c.timezone} showTime={false} /> : <p>Add a country in HubSpot to determine calling hours.</p>}
    </section>
    <section className="cw-contact">
      <div className="cw-section-head"><h3>Contact details</h3>{!editing && <button className="cw-link" onClick={edit}>Edit</button>}</div>
      {saved && <p className="cw-success" role="status"><Check size={14} />Contact saved</p>}
      {editing && draft ? <form className="cw-edit" onSubmit={save} aria-label="Edit contact">
        {FIELDS.map(([key, label], i) => <label key={key}>{label}<input className="field" autoFocus={i === 0} type={key === 'email' ? 'email' : key.startsWith('alt') ? 'tel' : 'text'} value={draft[key]} placeholder={key.startsWith('alt') ? '+country code and number' : label} disabled={saving} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></label>)}
        {error && <p className="cw-error" role="alert">Couldn’t save: {error}</p>}
        <div className="cw-edit-actions"><button type="submit" className="btn btn-blue" disabled={saving}>{saving ? 'Saving…' : 'Save contact'}</button><button type="button" className="btn" disabled={saving} onClick={() => setEditing(false)}>Cancel</button></div>
      </form> : <>
        <dl className="cw-details">{details.map(([label, value], i) => <div key={label! + i}><dt>{label}</dt><dd>
          {label === 'Email' ? <a href={'mailto:' + value}>{value}</a> : label === 'LinkedIn' && /^https?:\/\//.test(value!) ? <a href={value!} target="_blank" rel="noreferrer">View profile <External size={12} /></a> : value}
        </dd></div>)}
          <div><dt>Phone numbers</dt><dd>{(c.phones.length ? c.phones : [c.phone]).map((p, i) => <span className="cw-phone mono" key={p}>{prettyPhone(p)}<small>{i === 0 ? 'Primary' : `Alternate ${i}`}{p === c.phone && c.phones.length > 1 ? ' · current' : ''}</small></span>)}</dd></div>
          <div><dt>Assigned to</dt><dd>{d.me.email}</dd></div>
        </dl>
        {lead.reach.find((r) => r.kind === 'hubspot' && r.href && /^https?:\/\//.test(r.href)) && <a className="cw-link cw-crm" href={lead.reach.find((r) => r.kind === 'hubspot')!.href} target="_blank" rel="noreferrer">Open in HubSpot <External size={13} /></a>}
      </>}
      {lead.more.length > 0 && <details className="cw-more"><summary>More from HubSpot ({lead.more.length})</summary><dl className="cw-details">{lead.more.map((m) => <div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>)}</dl></details>}
    </section>
  </aside>;
}
