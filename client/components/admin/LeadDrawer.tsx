'use client';
import { useEffect, useState } from 'react';
import { API } from '../../lib/api';
import { prettyPhone, relative } from '../../lib/format';
import { useAdmin, secs, OUTCOME_LABEL, OUTCOME_LAMP, outcomeOf, type LeadDetail } from '../../lib/admin';
import { Play, External } from '../icons';
import { localNow } from './Leads';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

/** Every attempt on one lead, with a player on each recorded one. Escape or the scrim closes it. */
export default function LeadDrawer({ id, tick, onClose }: { id: number; tick: number; onClose: () => void }) {
  const d = useAdmin<LeadDetail>(`/api/admin/leads/${id}`, tick);
  const [playing, setPlaying] = useState<number | null>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  const l = d.data;
  const lt = l ? localNow(l.utc_offset) : null;
  const next = l?.next_call_at ? new Date(l.next_call_at) : null;
  return (
    <>
      <div className="ad-scrim" onClick={onClose} />
      <aside className="ad-drawer" role="dialog" aria-label="Lead">
        <div className="dh">
          <div className="ava">{(l?.name || '#').trim().slice(0, 1).toUpperCase()}</div>
          <div><div className="nm">{l ? (l.name || prettyPhone(l.phone)) : 'Loading…'}</div><div className="id mono">{l ? (l.name ? prettyPhone(l.phone) : 'no name on the lead') : ''}</div></div>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="db">
          {d.error && <p className="ad-err">{d.error}</p>}
          {l && (
            <>
              <dl className="ad-kv">
                {l.company && <><dt>Company</dt><dd>{l.company}</dd></>}
                <dt>Country</dt><dd>{l.country ?? <span className="muted">unknown</span>}{lt && <span className="muted"> · {lt.text} their time · {lt.open ? 'open' : 'closed'}</span>}</dd>
                <dt>Rep</dt><dd>{l.rep ? l.rep.split('@')[0] : '—'}</dd>
                <dt>Source</dt><dd>{l.source === 'manual' ? 'typed on the keypad' : l.source.toUpperCase()}</dd>
                <dt>Status</dt><dd>{l.status}{(l.status === 'queued' || l.status === 'later') && next ? <span className="muted"> · next call {next.getTime() <= Date.now() ? 'due now' : relative(next)}</span> : ''}</dd>
                <dt>Attempts</dt><dd>{l.attempt_count} of 6</dd>
                {l.phones?.length > 1 && <><dt>Numbers</dt><dd className="mono">{l.phones.map(prettyPhone).join(' · ')}</dd></>}
                {l.hubspot_url && <><dt>HubSpot</dt><dd><a href={l.hubspot_url} target="_blank" rel="noreferrer">Open the contact <External /></a></dd></>}
              </dl>
              <div>
                <div className="panel-title" style={{ marginBottom: 8 }}>Attempts<b>{l.attempts.length}</b></div>
                <div className="ad-att">
                  {l.attempts.map((a) => {
                    const o = outcomeOf({ disposition: a.disposition, sub_outcome: a.sub_outcome, talk_secs: a.talk_secs });
                    return (
                      <div key={a.id}>
                        <div className="a">
                          <span className="t">{when(a.started_at)}</span>
                          <span className={'lamp ' + (OUTCOME_LAMP[o] ?? 'grey')} />
                          <span>{OUTCOME_LABEL[o] ?? o}{a.talk_secs != null ? <span className="muted"> · {secs(a.talk_secs)}</span> : a.ring_secs != null ? <span className="muted"> · rang {a.ring_secs}s</span> : ''}<span className="muted"> · {a.rep.split('@')[0]}</span></span>
                          <span className="o" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            {a.hubspot_call_id && <span className="ad-pill green" title="logged to HubSpot">HS</span>}
                            {a.recording_status === 'saved' && a.recording_token && <button className={'ad-play' + (playing === a.id ? ' on' : '')} onClick={() => setPlaying(playing === a.id ? null : a.id)} aria-label="Play recording"><Play /></button>}
                          </span>
                          {(a.notes || a.reason) && <span className="note">{[a.reason, a.notes].filter(Boolean).join(' · ')}</span>}
                        </div>
                        {playing === a.id && a.recording_token && <div className="ad-audio" style={{ marginBottom: 8 }}><audio controls autoPlay preload="none" src={`${API}/rec/${a.recording_token}.mp3`} /></div>}
                      </div>
                    );
                  })}
                  {l.attempts.length === 0 && <p className="empty">Never dialed.</p>}
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
