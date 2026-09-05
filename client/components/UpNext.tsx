'use client';
import type { NextLead } from '../lib/useDialer';
import { OUTCOME_LABEL, localTime, prettyPhone } from '../lib/format';
import TimeBar from './TimeBar';

/** What the next Start calling will pick, in order: who, their local time, and whether they're inside their window. */
export default function UpNext({ leads, queued }: { leads: NextLead[] | null; queued: number | undefined }) {
  const shown = leads?.slice(0, 3) ?? null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Up next{queued != null && <b>{queued} in queue</b>}</h2>
      </div>
      {shown === null ? (
        <p className="empty">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="empty">
          {queued ? 'Nobody in the queue is inside their local calling hours right now. US leads open around 19:30 IST.' : 'Queue is empty — upload a CSV to load leads.'}
        </p>
      ) : (
        <div className="next">
          {shown.map((l) => (
            <div className="lead" key={l.id}>
              <span className="n">{l.name || l.extra?.company || prettyPhone(l.phone)}</span>
              <span className="lt">{localTime(l.utc_offset)?.text ?? '--:--'}</span>
              <span className="m">
                {l.country ?? 'country unknown'}
                {l.attempt_count > 0 ? ` · attempt ${l.attempt_count + 1}` : ''}
                {l.last_outcome ? ` · last ${OUTCOME_LABEL[l.last_outcome] ?? l.last_outcome}` : ''}
                {l.status === 'later' ? ' · asked for this time' : ''}
              </span>
              <TimeBar offset={l.utc_offset} showTime={false} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
