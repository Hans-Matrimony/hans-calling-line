'use client';
import { Fragment, useEffect, useState } from 'react';
import { API } from '../../lib/api';
import { clock, prettyPhone } from '../../lib/format';
import { qs, useAdmin, secs, OUTCOME_LABEL, OUTCOME_LAMP, outcomeOf, money, type Filters, type CallsPage, type CallRow } from '../../lib/admin';
import { Play, Download } from '../icons';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const time = (iso: string) => clock(new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })));

/** One call log table, shared by the Calls screen, the Reps screen and the lead drawer. The play
 *  button opens an inline player on the public /rec/ link — the same URL HubSpot's timeline uses. */
export function CallTable({ rows, onLead, showRep = true, showDay = true }: { rows: CallRow[]; onLead: (id: number) => void; showRep?: boolean; showDay?: boolean }) {
  const [playing, setPlaying] = useState<number | null>(null);
  return (
    <div className="ad-scroll"><table className="ad-tbl">
      <thead><tr>
        <th>Time</th>{showRep && <th>Rep</th>}<th>Lead</th><th>Number</th><th>Caller ID</th><th>Country</th>
        <th className="num">Ring</th><th className="num">Talk</th><th>Outcome</th><th>Note</th><th className="num">Wrap</th><th className="num">Cost</th><th>Rec</th><th>HubSpot</th>
      </tr></thead>
      <tbody>
        {rows.map((r) => {
          const o = outcomeOf(r);
          const rec = r.recording_status;
          return (
            <Fragment key={r.id}>
              <tr className="row" onClick={() => onLead(r.lead_id)}>
                <td className="mono">{showDay ? <>{day(r.started_at)}<span className="sub">{time(r.started_at)}</span></> : time(r.started_at)}</td>
                {showRep && <td>{r.rep.split('@')[0]}</td>}
                <td className={r.name ? 'name' : 'dim'}>{r.name || 'no name on the lead'}</td>
                <td className="mono">{prettyPhone(r.phone)}</td>
                <td className="mono dim">{r.from_number ? prettyPhone(r.from_number) : '—'}</td>
                <td className={r.country ? '' : 'dim'}>{r.country ?? '—'}</td>
                <td className="num">{r.ring_secs == null ? <span className="dim">—</span> : r.ring_secs + 's'}</td>
                <td className="num">{r.talk_secs == null ? <span className="dim">—</span> : secs(r.talk_secs)}</td>
                <td><span className={'ad-pill ' + (OUTCOME_LAMP[o] ?? 'grey')}><span className={'lamp ' + (OUTCOME_LAMP[o] ?? 'grey')} />{OUTCOME_LABEL[o] ?? o}</span>{r.reason && <span className="sub">{r.reason}</span>}</td>
                <td className={r.notes ? '' : 'dim'} style={{ maxWidth: 220, overflowWrap: 'anywhere' }}>{r.notes || '—'}</td>
                <td className="num">{r.wrap_secs == null ? <span className="dim">—</span> : r.wrap_secs + 's'}</td>
                <td className="num">{r.cost == null ? <span className="dim">—</span> : money(r.cost)}</td>
                <td className="act" onClick={(e) => e.stopPropagation()}>
                  {rec === 'saved' && r.recording_token
                    ? <button className={'ad-play' + (playing === r.id ? ' on' : '')} title={`Play recording${r.recording_secs ? ' · ' + secs(r.recording_secs) : ''}`} aria-label="Play recording" onClick={() => setPlaying(playing === r.id ? null : r.id)}><Play /></button>
                    : rec === 'started' ? <span className="dim" title="Plivo has not delivered the file yet">recording…</span>
                    : rec === 'error' ? <span className="ad-pill coral" title={r.hubspot_error ?? 'recording failed'}>failed</span>
                    : <span className="dim">—</span>}
                </td>
                <td>{r.hubspot_call_id ? <span className="ad-pill green" title={r.hubspot_file_url ? 'logged with recording' : 'logged'}>logged</span>
                  : r.hubspot_error ? <span className="ad-pill grey" title={r.hubspot_error}>{/no HubSpot contact/.test(r.hubspot_error) ? 'no contact' : 'failed'}</span>
                  : <span className="dim">—</span>}</td>
              </tr>
              {playing === r.id && r.recording_token && (
                <tr><td colSpan={showRep ? 14 : 13} style={{ padding: '0 10px 8px' }}>
                  <div className="ad-audio">
                    <audio controls autoPlay preload="none" src={`${API}/rec/${r.recording_token}.mp3`} />
                    <span className="mono">{r.recording_secs ? secs(r.recording_secs) : ''}{r.hubspot_file_url ? ' · also on the HubSpot timeline' : ''}</span>
                  </div>
                </td></tr>
              )}
            </Fragment>
          );
        })}
        {rows.length === 0 && <tr><td colSpan={showRep ? 14 : 13} className="dim">No calls match.</td></tr>}
      </tbody>
    </table></div>
  );
}

const OUTCOMES: [string, string][] = [['', 'All outcomes'], ['connected', 'Connected'], ['connected_unspecified', 'Connected, no tile'], ['no_answer', 'No answer'], ['later', 'Call later'], ['failed', 'Could not dial'], ['invalid', 'Wrong number'], ['abandoned', 'Abandoned'], ['cancelled', 'Cancelled'], ['open', 'No outcome yet']];

export default function Calls({ filters, tick, onLead }: { filters: Filters; tick: number; onLead: (id: number) => void }) {
  const [outcome, setOutcome] = useState('');
  const [answered, setAnswered] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => { setQ(text.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [text]);
  useEffect(() => setPage(1), [filters, outcome, answered]);
  const query = qs(filters, { outcome, answered, q, page });
  const data = useAdmin<CallsPage>('/api/admin/calls?' + query, tick);
  const total = data.data?.total ?? 0, pages = Math.max(1, Math.ceil(total / 100));
  return (
    <section className="ad-screen">
      <div className="panel">
        <div className="ad-tools">
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome" style={{ minWidth: 170 }}>{OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <div className="ad-seg">{([['', 'Any'], ['1', 'Answered'], ['0', 'Unanswered']] as [string, string][]).map(([v, l]) => <button key={v} className={answered === v ? 'on' : ''} onClick={() => setAnswered(v)}>{l}</button>)}</div>
          <input type="search" placeholder="Search a name, company or number…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search calls" />
          <div className="right"><a className="btn" href={`${API}/api/admin/calls.csv?${qs(filters, { outcome, answered, q })}`}><Download />Export CSV</a></div>
        </div>
        {data.error && <p className="ad-err" style={{ marginTop: 10 }}>{data.error}</p>}
        <div style={{ marginTop: 12 }}><CallTable rows={data.data?.rows ?? []} onLead={onLead} /></div>
        <div className="ad-tfoot">
          <span>Newest first · <b className="mono">{total}</b> call{total === 1 ? '' : 's'} in this period{data.loading ? ' · refreshing…' : ''}</span>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-mini" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Newer</button>
            <span className="mono">{page} / {pages}</span>
            <button className="btn btn-mini" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older ›</button>
          </span>
        </div>
      </div>
    </section>
  );
}
