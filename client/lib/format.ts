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
