'use client';
import type { HubSpot, NextLead } from '../lib/useDialer';
import { emptyQueue, NOT_DUE, OUTCOME_LABEL, clock, localTime, prettyPhone, relative, since, splitName } from '../lib/format';
import TimeBar from './TimeBar';

/** The second inlet, in one line. Reps tick "Eazybe · Dial queue" on a contact in HubSpot and it lands
 *  here; nothing in this strip is a step they have to take. It exists to answer "I ticked it — is it
 *  here yet?", and to say so loudly when the inlet itself is broken (bad token, missing scope, the
 *  checkbox property was never created) — a broken inlet must never look like an empty queue. */
function HubSpotStrip({ hs, onSync, busy }: { hs: HubSpot; onSync: () => void; busy: boolean }) {
  const broken = hs.ok === false;
  return (
    <div className={'inlet' + (broken ? ' bad' : '')}>
      <span className={'lamp ' + (broken ? 'coral' : 'green')} aria-hidden />
      <span className="inlet-t">
        {broken ? hs.error : (
          <>
            HubSpot · {hs.syncedAt ? `synced ${since(new Date(hs.syncedAt))}` : 'first sync on the way'}
            {hs.inQueue ? ` · ${hs.inQueue} ticked contact${hs.inQueue === 1 ? '' : 's'} in your queue` : ''}
          </>
        )}
      </span>
      <button className="btn btn-mini" onClick={onSync} disabled={busy} title="Pull ticked contacts from HubSpot now">
        Sync now
      </button>
    </div>
  );
}

/** The Up next tab: what the next dial will pick, in order — who, their local time, and whether they're
 *  inside their window. Tap a row to load that number into the handset. */
export default function UpNext({ leads, queued, nextOpen, onDial, hubspot, onSync, busy }: {
  leads: NextLead[] | null; queued: number | undefined; nextOpen: string | null; onDial: (phone: string) => void;
  hubspot?: HubSpot; onSync: () => void; busy: boolean;
}) {
  const open = nextOpen ? new Date(nextOpen) : null;
  const EMPTY_QUEUE = emptyQueue(hubspot?.configured);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Up next{queued != null && <b>{queued} in queue</b>}</h2>
        <span className="hint">Inside their local calling hours (10:00–19:00), soonest due first · tap to load into the dialer</span>
      </div>
      {hubspot?.configured && <HubSpotStrip hs={hubspot} onSync={onSync} busy={busy} />}
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
                {l.phoneIdx > 1 ? ` · alt ${l.phoneIdx - 1} of ${l.phoneCount - 1}` : ''}
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
