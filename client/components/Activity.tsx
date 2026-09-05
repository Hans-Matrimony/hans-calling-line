'use client';
import type { ActivityEvent, EventKind } from '../lib/useDialer';
import { clock, prettyPhone } from '../lib/format';

const LAMP: Partial<Record<EventKind, string>> = {
  dialing: 'amber', answered: 'green', connected: 'green', later: 'blue', failed: 'coral', error: 'coral',
};
const Phone = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8z" /></svg>;

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
