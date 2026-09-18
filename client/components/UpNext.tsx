'use client';
import type { ReactNode } from 'react';
import type { HubSpot, QueueGroup, QueueLead, QueueOverview } from '../lib/useDialer';
import { emptyQueue, OUTCOME_LABEL, clock, describeLater, describePull, leadWho, listCountries, localTime, prettyPhone, relative, since } from '../lib/format';
import TimeBar from './TimeBar';

/** The second inlet, in one line. Reps tick "Hans · Dial queue" on a contact in HubSpot and it lands
 *  here; nothing in this strip is a step they have to take. It exists to answer "I ticked it — is it
 *  here yet?" (what the last pull brought, and when we last looked), and to say so loudly when the inlet
 *  itself is broken (bad token, missing scope, the checkbox property was never created) — a broken inlet
 *  must never look like an empty queue. */
function HubSpotStrip({ hs, onSync, busy }: { hs: HubSpot; onSync: () => void; busy: boolean }) {
  const broken = hs.ok === false;
  const lc = hs.lastChange;
  return (
    <div className={'inlet' + (broken ? ' bad' : '')}>
      <span className={'lamp ' + (broken ? 'coral' : 'green')} aria-hidden />
      <span className="inlet-t">
        {broken ? hs.error : (
          <>
            HubSpot
            {lc?.at ? ` · ${describePull(lc)} ${since(new Date(lc.at))}` : ''}
            {hs.syncedAt ? ` · checked ${since(new Date(hs.syncedAt))}` : ' · first sync on the way'}
          </>
        )}
      </span>
      <button className="btn btn-mini" onClick={onSync} disabled={busy} title="Pull ticked contacts from HubSpot now">
        Sync now
      </button>
    </div>
  );
}

/** One row, identical for every group so tap-to-dial is the same everywhere. A held row also says when it opens. */
function Row({ l, onDial }: { l: QueueLead; onDial: (phone: string) => void }) {
  const opens = l.why === 'later' ? describeLater(l.next_call_at, l.utc_offset, l.timezone)
    : l.why === 'gap' || l.why === 'hour' ? `opens ${clock(new Date(l.opensAt))}` : '';
  return (
    <button className="lead" onClick={() => onDial(l.phone)} title={`Load ${prettyPhone(l.phone)} into the dialer`}>
      <span className="n">{leadWho(l.name, l.extra) || prettyPhone(l.phone)}</span>
      <span className="lt">{localTime(l.utc_offset, new Date(), l.timezone)?.text ?? '--:--'}</span>
      <span className="m">
        {l.country ?? 'country unknown'}
        {l.attempt_count > 0 ? ` · attempt ${l.attempt_count + 1} of ${l.attemptLimit}` : ''}
        {l.phoneIdx > 1 ? ` · alt ${l.phoneIdx - 1} of ${l.phoneCount - 1}` : ''}
        {l.last_outcome ? ` · last ${OUTCOME_LABEL[l.last_outcome] ?? l.last_outcome}` : ''}
        {opens ? ` · ${opens}` : ''}
      </span>
      <TimeBar offset={l.utc_offset} timezone={l.timezone} showTime={false} />
    </button>
  );
}

/** What a group's head says: the rule that holds its leads, and when it lets go. */
function head(g: QueueGroup): { title: string; note: string } {
  const at = g.opensAt ? new Date(g.opensAt) : null;
  switch (g.why) {
    case 'window': return { title: `Opens ${at ? clock(at) : '—'}`, note: [at && relative(at), listCountries(g.countries)].filter(Boolean).join(' · ') };
    case 'gap': return { title: g.retryMinutes ? `Back after ${g.retryMinutes === 120 ? '2h' : g.retryMinutes + ' min'}` : 'Waiting for retry', note: at ? `first ${relative(at)}` : '' };
    case 'hour': return { title: 'Opens next hour', note: 'already tried at this hour of their day' };
    case 'later': return { title: 'Callbacks you booked', note: at ? `first ${relative(at)}` : '' };
    case 'no_timezone': return { title: 'No country, so no calling hours', note: 'fill Country in HubSpot and it schedules itself' };
    default: return { title: 'Due now', note: 'inside their calling hours · tap to load into the dialer' };
  }
}

function Group({ g, onDial, onExpand, children }: { g: QueueGroup; onDial: (phone: string) => void; onExpand: (key: string) => void; children?: ReactNode }) {
  const h = head(g);
  return (
    <div className="un-group">
      <div className={'un-head' + (g.key === 'ready' ? ' due' : '')}>
        <span>{h.title}</span><b>{g.count}</b><em>{h.note}</em>
      </div>
      {children}
      {g.leads.length > 0 && <div className="next">{g.leads.map((l) => <Row key={l.id} l={l} onDial={onDial} />)}</div>}
      {g.leads.length < g.count && (
        <button className="btn btn-mini un-more" onClick={() => onExpand(g.key)}>Show all {g.count}</button>
      )}
    </div>
  );
}

/** The Up next tab: the rep's whole queue, grouped by when each lead opens — who is due now, who opens
 *  later and at what time, who is held back and why. Tap any row to load that number into the handset;
 *  a hand-dialled call ignores calling hours, so nothing here is out of reach. */
export default function UpNext({ queue, onDial, onExpand, hubspot, onSync, busy }: {
  queue: QueueOverview | null; onDial: (phone: string) => void; onExpand: (key: string) => void;
  hubspot?: HubSpot; onSync: () => void; busy: boolean;
}) {
  const EMPTY_QUEUE = emptyQueue(hubspot?.configured);
  const soonest = queue?.soonest ? new Date(queue.soonest) : null;
  const noTz = queue?.later.find((g) => g.why === 'no_timezone')?.count ?? 0;
  const laterCount = queue ? queue.total - queue.ready.count - noTz : 0;
  const summary = queue && queue.total > 0 && [
    `${queue.total} in your queue`,
    `${queue.ready.count} due now`,
    laterCount > 0 && `${laterCount} open later${soonest ? `, first at ${clock(soonest)} (${relative(soonest)})` : ''}`,
    noTz > 0 && `${noTz} with no country`,
  ].filter(Boolean).join(' · ');
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Up next{queue != null && <b>{queue.total} in queue</b>}</h2>
        <span className="hint">Due now are inside their calling hours (10:00–19:00). Everything else is listed by when it opens. Tap any row to load it into the dialer — a hand-dialled call ignores calling hours.</span>
      </div>
      {hubspot?.configured && <HubSpotStrip hs={hubspot} onSync={onSync} busy={busy} />}
      {queue === null ? (
        <p className="empty">Loading…</p>
      ) : queue.total === 0 ? (
        <p className="empty">{EMPTY_QUEUE}</p>
      ) : (
        <>
          <p className="un-sum">{summary}</p>
          <Group g={queue.ready} onDial={onDial} onExpand={onExpand}>
            {queue.ready.count === 0 && (
              <p className="empty">Nobody is due right now{soonest ? ` — the first opens ${clock(soonest)} (${relative(soonest)}).` : '.'}</p>
            )}
          </Group>
          {queue.later.map((g) => <Group key={g.key} g={g} onDial={onDial} onExpand={onExpand} />)}
        </>
      )}
    </section>
  );
}
