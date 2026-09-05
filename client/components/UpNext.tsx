'use client';
import type { NextLead } from '../lib/useDialer';
import { OUTCOME_LABEL, localTime, prettyPhone } from '../lib/format';
import TimeBar from './TimeBar';

/** The Up next tab: what the next Start calling will pick, in order — who, their local time, and whether they're
 *  inside their window. Tap a row to load that number into the handset. */
export default function UpNext({ leads, queued, onDial }: { leads: NextLead[] | null; queued: number | undefined; onDial: (phone: string) => void }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Up next{queued != null && <b>{queued} in queue</b>}</h2>
        <span className="hint">Inside their local calling hours (10:00–19:00), soonest due first · tap to load into the dialer</span>
      </div>
      {leads === null ? (
        <p className="empty">Loading…</p>
      ) : leads.length === 0 ? (
        <p className="empty">
          {queued ? 'Nobody in the queue is inside their local calling hours right now. US leads open around 19:30 IST.' : 'Queue is empty — upload a CSV to load leads.'}
        </p>
      ) : (
        <div className="next">
          {leads.map((l) => (
            <button className="lead" key={l.id} onClick={() => onDial(l.phone)} title={`Load ${prettyPhone(l.phone)} into the dialer`}>
              <span className="n">{l.name || l.extra?.company || prettyPhone(l.phone)}</span>
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
