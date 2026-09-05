'use client';
import type { ActivityEvent, EventKind } from '../lib/useDialer';
import { clock } from '../lib/format';

const LAMP: Partial<Record<EventKind, string>> = {
  dialing: 'amber', answered: 'green', connected: 'green', later: 'blue', failed: 'coral', error: 'coral',
};

/** Today's events, newest first. Restored from the server on reload; live events prepend. Collapsed by default. */
export default function Activity({ feed, loaded, open, onToggle }: { feed: ActivityEvent[]; loaded: boolean; open: boolean; onToggle: () => void }) {
  const calls = feed.filter((e) => e.kind !== 'sys').length;
  const latest = feed.find((e) => e.kind !== 'sys');
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Activity</h2>
        <button className="btn btn-ghost btn-mini" onClick={onToggle} aria-expanded={open} aria-controls="activity-feed">{open ? 'Minimize' : 'Open'}</button>
      </div>
      {!open && latest && (
        <p className="empty" style={{ marginTop: 8 }}><span className="mono small">{clock(latest.at)}</span> · {latest.text}{latest.sub ? ` · ${latest.sub}` : ''}</p>
      )}
      {open && (
        !loaded && calls === 0 ? <p className="empty">Loading…</p>
        : feed.length === 0 ? <p className="empty">Nothing yet today.</p>
        : (
          <div className="feed" id="activity-feed" role="log" aria-live="polite">
            {feed.map((e) => (
              <div className={'ev' + (e.kind === 'sys' ? ' sys' : '')} key={e.id}>
                <span className="t">{clock(e.at)}</span>
                <span className={'lamp ' + (LAMP[e.kind] ?? '')} aria-hidden />
                <span className="what">
                  <span className="n">{e.text}</span>
                  {e.sub && <span className="d"> · {e.sub}</span>}
                </span>
              </div>
            ))}
          </div>
        )
      )}
    </section>
  );
}
