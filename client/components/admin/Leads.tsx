'use client';
import { useEffect, useState } from 'react';
import { prettyPhone, relative } from '../../lib/format';
import { qs, useAdmin, OUTCOME_LABEL, type Filters, type LeadsPage, type LeadRow } from '../../lib/admin';

/** The lead's clock right now, from the stored UTC offset; whether they are inside 10:00–19:00 local. */
export function localNow(offset: string | number | null) {
  if (offset == null) return null;
  const off = Number(offset); if (!Number.isFinite(off)) return null;
  const d = new Date(Date.now() + (off * 60 + new Date().getTimezoneOffset()) * 60000);
  const hh = d.getHours();
  return { text: `${String(hh).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, open: hh >= 10 && hh < 19 };
}
const STATUS: Record<string, [string, string]> = { queued: ['blue', 'queued'], later: ['blue', 'callback'], in_flight: ['amber', 'on a call'], connected: ['green', 'connected'], exhausted: ['grey', 'exhausted'], stopped: ['coral', 'stopped'] };

export default function Leads({ filters, tick, onLead }: { filters: Filters; tick: number; onLead: (id: number) => void }) {
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => { setQ(text.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [text]);
  useEffect(() => setPage(1), [filters, status, source]);
  const data = useAdmin<LeadsPage>('/api/admin/leads?' + qs(filters, { status, source, q, page }), tick);
  const total = data.data?.total ?? 0, pages = Math.max(1, Math.ceil(total / 100));
  return (
    <section className="ad-screen">
      <div className="panel">
        <div className="ad-tools">
          <div className="ad-seg">{([['', 'All'], ['queued', 'Queued'], ['later', 'Callback'], ['connected', 'Connected'], ['exhausted', 'Exhausted'], ['stopped', 'Stopped']] as [string, string][]).map(([v, l]) => <button key={v} className={status === v ? 'on' : ''} onClick={() => setStatus(v)}>{l}</button>)}</div>
          <div className="ad-seg">{([['', 'Any source'], ['csv', 'CSV'], ['hubspot', 'HubSpot'], ['manual', 'Keypad']] as [string, string][]).map(([v, l]) => <button key={v} className={source === v ? 'on' : ''} onClick={() => setSource(v)}>{l}</button>)}</div>
          <input type="search" placeholder="Search a name, company or number…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search leads" />
        </div>
        {data.error && <p className="ad-err" style={{ marginTop: 10 }}>{data.error}</p>}
        <div className="ad-scroll" style={{ marginTop: 12 }}><table className="ad-tbl">
          <thead><tr><th>Lead</th><th>Number</th><th>Country</th><th className="num">Their time</th><th>Window</th><th>Rep</th><th>Source</th><th>Status</th><th className="num">Tries</th><th>Last</th><th>Next call</th></tr></thead>
          <tbody>
            {(data.data?.rows ?? []).map((l: LeadRow) => {
              const lt = localNow(l.utc_offset); const st = STATUS[l.status] ?? ['grey', l.status];
              const next = l.next_call_at ? new Date(l.next_call_at) : null;
              return (
                <tr className="row" key={l.id} onClick={() => onLead(l.id)}>
                  <td className={l.name ? 'name' : 'dim'}>{l.name || l.company || 'no name'}{l.company && l.name && <span className="sub">{l.company}</span>}</td>
                  <td className="mono">{prettyPhone(l.phone)}{l.phones?.length > 1 && <span className="sub">+{l.phones.length - 1} more</span>}</td>
                  <td className={l.country ? '' : 'dim'}>{l.country ?? 'no country · from dial code'}</td>
                  <td className="num">{lt?.text ?? <span className="dim">—</span>}</td>
                  <td>{lt ? <span className={'ad-pill ' + (lt.open ? 'green' : 'grey')}>{lt.open ? 'open' : 'closed'}</span> : <span className="ad-pill coral" title="No timezone: this lead can never be due">no clock</span>}</td>
                  <td>{l.rep ? l.rep.split('@')[0] : <span className="dim">—</span>}</td>
                  <td className="dim">{l.source === 'manual' ? 'keypad' : l.source.toUpperCase()}</td>
                  <td><span className={'ad-pill ' + st[0]}>{st[1]}</span></td>
                  <td className="num">{l.attempt_count}<span className="dim"> / 6</span></td>
                  <td className="dim">{l.last_outcome ? OUTCOME_LABEL[l.last_outcome] ?? l.last_outcome : '—'}</td>
                  <td className={'mono' + (l.status === 'queued' || l.status === 'later' ? '' : ' dim')}>{(l.status === 'queued' || l.status === 'later') && next ? (next.getTime() <= Date.now() ? 'due now' : relative(next)) : '—'}</td>
                </tr>
              );
            })}
            {data.data && data.data.rows.length === 0 && <tr><td colSpan={11} className="dim">No leads match.</td></tr>}
          </tbody>
        </table></div>
        <div className="ad-tfoot">
          <span>Most recently called first · <b className="mono">{total}</b> lead{total === 1 ? '' : 's'} · their time is live; window means 10:00–19:00 local</span>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-mini" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
            <span className="mono">{page} / {pages}</span>
            <button className="btn btn-mini" disabled={page >= pages} onClick={() => setPage(page + 1)}>›</button>
          </span>
        </div>
      </div>
    </section>
  );
}
