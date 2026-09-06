'use client';
import type { NextLead } from '../lib/useDialer';
import { EMPTY_QUEUE, NOT_DUE, OUTCOME_LABEL, clock, localTime, prettyPhone, relative, splitName } from '../lib/format';
import TimeBar from './TimeBar';

/** The Up next tab: what the next dial will pick, in order — who, their local time, and whether they're
 *  inside their window. Tap a row to load that number into the handset. */
export default function UpNext({ leads, queued, nextOpen, onDial }: { leads: NextLead[] | null; queued: number | undefined; nextOpen: string | null; onDial: (phone: string) => void }) {
  const open = nextOpen ? new Date(nextOpen) : null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Up next{queued != null && <b>{queued} in queue</b>}</h2>
        <span className="hint">Inside their local calling hours (10:00–19:00), soonest due first · tap to load into the dialer</span>
      </div>
      {leads === null ? (
        <p className="empty">Loading…</p>
      ) : leads.length === 0 ? (
        <p className="empty">{queued ? `${NOT_DUE}${open ? ` Next opens ${clock(open)} (${relative(open)}).` : ''}` : EMPTY_QUEUE}</p>
      ) : (
        <div className="next">
          {leads.map((l) => (
            <button className="lead" key={l.id} onClick={() => onDial(l.phone)} title={`Load ${prettyPhone(l.phone)} into the dialer`}>
              <span className="n">{splitName(l.name).name || l.extra?.company || prettyPhone(l.phone)}</span>
              <span className="lt">{localTime(l.utc_offset)?.text ?? '--:--'}</span>
              <span className="m">
                {l.country ?? 'country unknown'}
                {l.attempt_count > 0 ? ` · attempt ${l.attempt_count + 1}` : ''}
                {l.last_outcome ? ` · last ${OUTCOME_LABEL[l.last_outcome] ?? l.last_outcome}` : ''}
                {l.status === 'later' ? ' · asked for this time' : ''}
              </span>
              <TimeBar offset={l.utc_offset} showTime={false} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
