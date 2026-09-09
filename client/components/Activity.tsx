'use client';
import type { ActivityEvent, EventKind } from '../lib/useDialer';
import { clock, prettyPhone } from '../lib/format';
import { Phone } from './icons';

const LAMP: Partial<Record<EventKind, string>> = {
  dialing: 'amber', answered: 'green', connected: 'green', later: 'blue', failed: 'coral', error: 'coral',
};

/** The Activity tab: today's events, newest first. Restored from the server on reload; live events prepend.
 *  Rows that belong to a number carry a call button that loads it into the handset. */
export default function Activity({ feed, loaded, onDial }: { feed: ActivityEvent[]; loaded: boolean; onDial: (phone: string) => void }) {
  const calls = feed.filter((e) => e.kind !== 'sys').length;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Activity{calls > 0 && <b>{calls} today</b>}</h2>
      </div>
      {!loaded && calls === 0 ? <p className="empty">Loading…</p>
        : feed.length === 0 ? <p className="empty">Nothing yet today. Calls you place show up here as they happen.</p>
        : (
          <div className="feed full" id="activity-feed" role="log" aria-live="polite">
            {feed.map((e) => (
              <div className={'ev' + (e.kind === 'sys' ? ' sys' : '')} key={e.id}>
                <span className="t">{clock(e.at)}</span>
                <span className={'lamp ' + (LAMP[e.kind] ?? '')} aria-hidden />
                <span className="what">
                  <span className="n">{e.text}</span>
                  {e.sub && <span className="d"> · {e.sub}</span>}
                </span>
                {e.phone && <button className="dial" onClick={() => onDial(e.phone!)} aria-label={`Load ${prettyPhone(e.phone)} into the dialer`} title="Call again"><Phone /></button>}
              </div>
            ))}
          </div>
        )}
    </section>
  );
}
