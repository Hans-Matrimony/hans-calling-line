'use client';
import { useEffect, useRef, useState } from 'react';
import type { useDialer, Card, LeadPatch } from '../lib/useDialer';
import { localTime, prettyPhone } from '../lib/format';
import { resolveLead } from '../lib/leadFields';
import TimeBar from './TimeBar';
import { Clock, User, Building, Briefcase, Mail, LinkedIn, Tag, Phone, External, Check } from './icons';

type D = ReturnType<typeof useDialer>;
type IconC = React.ComponentType<{ size?: number }>;

/** The editable contact panel beside a call (call-card v2, JustCall parity). Everything the rep needs on
 *  the lead - and can fix on the spot: name, company, title, email, LinkedIn, lead source, and the two
 *  alternate numbers that feed the dialer's cascade. Each edit saves straight to the lead, so the next
 *  attempt and any export carry it. Shown the same before the dial, during, and after. */
export default function LeadRail({ d, c }: { d: D; c: Card }) {
  const [open, setOpen] = useState(false);
  const lead = resolveLead(c);
  const lt = localTime(c.utcOffset);
  const set = (p: LeadPatch) => d.patchLead(c.leadId, p);

  // Alternate numbers: the panel edits everything after the first entry in the cascade.
  const primary = c.phones?.[0] ?? c.phone;
  const alts = (c.phones ?? []).filter((p) => p !== primary);
  const saveAlt = (idx: number, v: string) => {
    const next = [...alts]; next[idx] = v.trim();
    set({ phones: [primary, ...next].filter(Boolean) });
  };

  return (
    <aside className="lead-panel" aria-label="Contact details">
      <header className="lp-time">
        <Clock />
        {lt ? <><b>It&rsquo;s {lt.text} there</b>{c.country && <span> · {c.country}</span>}</> : <b className="muted">Timezone unknown</b>}
        {lt && <TimeBar offset={c.utcOffset} showTime={false} />}
      </header>

      <div className="lp-fields">
        <Field label="Name" Icon={User} value={lead.name} onSave={(v) => set({ name: v })} />
        <Field label="Company" Icon={Building} value={lead.company} onSave={(v) => set({ company: v })} />
        <Field label="Job title" Icon={Briefcase} value={lead.role} onSave={(v) => set({ title: v })} />
        <Field label="Email" Icon={Mail} value={fieldStr(c, 'email')} type="email" link={(v) => 'mailto:' + v} onSave={(v) => set({ email: v })} />
        <Field label="LinkedIn" Icon={LinkedIn} value={fieldStr(c, 'linkedin')} link={(v) => (/^https?:\/\//.test(v) ? v : null)} onSave={(v) => set({ linkedin: v })} />
        <Field label="Lead source" Icon={Tag} value={fieldStr(c, 'leadStage')} onSave={(v) => set({ leadStage: v })} />
        <Field label="Alternate 1" Icon={Phone} value={alts[0] ?? null} mono placeholder="Add (+country code)" onSave={(v) => saveAlt(0, v)} />
        <Field label="Alternate 2" Icon={Phone} value={alts[1] ?? null} mono placeholder="Add (+country code)" onSave={(v) => saveAlt(1, v)} />
      </div>

      {lead.more.length > 0 && (
        <div className="lp-more">
          <button className="rail-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Hide' : `More from HubSpot (${lead.more.length})`}
          </button>
          {open && <dl className="kv more">{lead.more.map((m) => (<div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>))}</dl>}
        </div>
      )}
    </aside>
  );
}

const fieldStr = (c: Card, k: keyof Card['extra']) => { const v = c.extra?.[k]; return v == null || v === '' ? null : String(v); };

/** One editable row: click the value (or "Add") to edit; Enter or blur saves, Escape cancels. A saved
 *  tick flashes so the rep sees it stuck. Links open in place but don't swallow the click-to-edit. */
function Field({ label, Icon, value, placeholder = 'Add', type = 'text', mono, link, onSave }:
  { label: string; Icon: IconC; value: string | null; placeholder?: string; type?: string; mono?: boolean; link?: (v: string) => string | null; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value ?? '');
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setVal(value ?? ''); }, [value, editing]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const commit = () => {
    setEditing(false);
    if ((val.trim() || '') !== (value ?? '')) { onSave(val.trim()); setSaved(true); setTimeout(() => setSaved(false), 1200); }
  };
  const href = value && link ? link(value) : null;
  const external = !!href && /^https?:\/\//.test(href);

  return (
    <div className={'lp-row' + (editing ? ' editing' : '')}>
      <span className="lp-label"><Icon size={15} />{label}</span>
      {editing ? (
        <div className="lp-edit">
          <input ref={ref} className="field lp-input" type={type} value={val} inputMode={mono ? 'tel' : undefined}
            onChange={(e) => setVal(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { setVal(value ?? ''); setEditing(false); } }} />
          <span className="keyhint"><kbd>Enter</kbd> save<span className="lp-hint-sep">·</span><kbd>Esc</kbd> cancel</span>
        </div>
      ) : (
        <button className={'lp-value' + (value ? (mono ? ' mono' : '') : ' empty')} onClick={() => setEditing(true)} title="Click to edit">
          {value
            ? (href ? <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{value}{external && <External size={12} />}</a> : (mono ? prettyPhone(value) : value))
            : placeholder}
          {saved && <i className="lp-saved" aria-label="saved"><Check size={14} /></i>}
        </button>
      )}
    </div>
  );
}
