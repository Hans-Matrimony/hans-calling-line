// Small formatting helpers shared by the console panels.

/** Lead-local time from a UTC offset in hours (e.g. "5.5", -4). */
export function localTime(offset: string | number | null | undefined, now = new Date()): { hour: number; text: string } | null {
  if (offset == null || offset === '') return null;
  const off = Number(offset);
  if (Number.isNaN(off)) return null;
  const ms = now.getTime() + now.getTimezoneOffset() * 60000 + off * 3600000;
  const d = new Date(ms);
  return { hour: d.getHours() + d.getMinutes() / 60, text: d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') };
}

export const WINDOW = { start: 10, end: 19 }; // lead-local calling hours, same as server/src/config.js
export const inWindow = (hour: number) => hour >= WINDOW.start && hour < WINDOW.end;

/** +1 is the only 1-digit country code we dial from; everything else gets a 2-digit split. */
export const prettyPhone = (n: string) =>
  n.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 $1 $2 $3').replace(/^\+(\d{2})(\d{5})(\d+)$/, '+$1 $2 $3').replace(/^\+(\d{3})(\d{4,})$/, '+$1 $2');

export const clock = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export function mmss(seconds: number) {
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function talkTime(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "Lewis Lewis — telonlabs.com" as imported -> { name, company } for the card. */
export function splitName(name: string | null) {
  if (!name) return { name: null, company: null };
  const i = name.indexOf(' — ');
  return i === -1 ? { name, company: null } : { name: name.slice(0, i) || null, company: name.slice(i + 3) || null };
}

export const OUTCOME_LABEL: Record<string, string> = {
  connected: 'connected', no_answer: 'no answer', later: 'call later', cancelled: 'cancelled', failed: 'failed', abandoned: 'abandoned', invalid: 'invalid number',
};

// Call-card v2: the seven tiles collapse onto four dispositions, so the run tape and the activity feed
// prefer the sub-outcome when there is one (a green 'Interested' vs a coral 'Not interested', both of
// which are disposition 'connected'). Falls back to the disposition label when no tile was recorded.
export const SUB_OUTCOME_LABEL: Record<string, string> = {
  interested: 'Interested', follow_up: 'Follow-up', callback: 'Callback', not_interested: 'Not interested', not_qualified: 'Not qualified',
};
const SUB_TONE: Record<string, string> = {
  interested: 'green', follow_up: 'blue', callback: 'blue', not_interested: 'coral', not_qualified: 'grey',
};
/** Tape/feed tone for a settled call, sub-outcome first. Returns a tile colour name or '' (no tile). */
export function outcomeTone(disposition: string | null, subOutcome?: string | null): string {
  if (subOutcome && SUB_TONE[subOutcome]) return SUB_TONE[subOutcome];
  switch (disposition) {
    case 'connected': return 'green';
    case 'later': return 'blue';
    case 'no_answer': return 'grey';
    case 'cancelled': return 'amber';
    case 'invalid': case 'failed': case 'abandoned': return 'coral';
    default: return '';
  }
}

export const DIAL_TIMEOUT = 30; // seconds a lead rings before the dialer gives up (server/src/config.js DIAL_TIMEOUT_SECS)

// One pair of strings for "nothing to dial", shared by the campaign pages and Up next.
/** There are two inlets now, so an empty queue has to name the one this rep actually has. */
export const emptyQueue = (hubspot?: boolean) => hubspot
  ? 'Your queue is empty — tick "Eazybe · Dial queue" on a contact in HubSpot, or press Upload CSV.'
  : 'Your queue is empty — press Upload CSV to add leads.';
export const NOT_DUE = 'Nobody is due right now — leads come back 2h after a no-answer, inside 10:00–19:00 their time, up to 6 tries.';

/** One sentence for what a HubSpot pull did — the feed line, the toast and the Up next strip all say the same thing. */
export function describePull(r: { added: number; resumed: number; reopened: number; removed: number; skipped: number; ticked: number }) {
  const bits = [
    r.added && `${r.added} pulled`,
    r.reopened && `${r.reopened} back for another run`,
    r.resumed && `${r.resumed} put back`,
    r.removed && `${r.removed} removed — unticked in HubSpot`,
    r.skipped && `${r.skipped} skipped — no phone number`,
  ].filter(Boolean).join(' · ');
  return bits || `nothing new — ${r.ticked} contact${r.ticked === 1 ? '' : 's'} ticked`;
}

/** "India, Germany, France +2 more" for a group head. */
export const listCountries = (c: string[], max = 3) => c.slice(0, max).join(', ') + (c.length > max ? ` +${c.length - max} more` : '');

/** Date -> the value a datetime-local input wants, on the rep's clock. */
export function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `hour`:00 on the lead's local day `dayOffset` days from now, as a datetime-local string on the rep's clock.
 *  Callbacks land inside the queue's own window instead of at "10am" on the rep's clock. */
export function leadLocalAt(offset: string | number | null | undefined, dayOffset: number, hour: number): string | null {
  if (offset == null || offset === '') return null;
  const off = Number(offset);
  if (Number.isNaN(off)) return null;
  const d = new Date(Date.now() + off * 3600000); // the lead's wall clock, carried as UTC fields
  d.setUTCDate(d.getUTCDate() + dayOffset); d.setUTCHours(hour, 0, 0, 0);
  return toLocalInput(new Date(d.getTime() - off * 3600000));
}

/** "Tue 10:00 their time" for a chosen callback, so the rep sees the lead's clock, not just their own. */
export function describeLater(laterAt: string, offset: string | number | null | undefined) {
  const when = new Date(laterAt);
  if (Number.isNaN(when.getTime())) return '';
  const off = offset == null || offset === '' ? NaN : Number(offset);
  if (Number.isNaN(off)) return when.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const lead = new Date(when.getTime() + off * 3600000);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][lead.getUTCDay()];
  return `${day} ${String(lead.getUTCHours()).padStart(2, '0')}:${String(lead.getUTCMinutes()).padStart(2, '0')} their time`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else a date - how long ago a moment was. */
export function ago(from: Date, now = new Date()) {
  const s = Math.round((now.getTime() - from.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return from.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

/** "in 12 min", "in 2h 05m", "in 3d" - how far away a moment is. */
/** How long ago something happened, for status lines: "just now", "40s ago", "3 min ago", "2h ago".
 *  relative() below is its future-facing twin ("in 5 min"). */
export function since(from: Date, now = new Date()) {
  const s = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function relative(to: Date, now = new Date()) {
  const m = Math.round((to.getTime() - now.getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `in ${h}h ${String(m % 60).padStart(2, '0')}m` : `in ${Math.round(h / 24)}d`;
}
