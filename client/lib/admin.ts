// The admin dashboard's API surface: the filter row, the response shapes, one fetch hook, and the
// small formatters the screens share. Everything numeric arrives from the server already computed;
// the client only decides how to show it.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export type Period = 'today' | 'yesterday' | '7d' | '30d' | 'custom';
export type Segment = 'all' | 'non_india' | 'india';
export type Filters = { period: Period; from: string; to: string; segment: Segment; rep: number | null };

export const PERIODS: { id: Period; label: string }[] = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: 'custom', label: 'Custom' },
];

/** IST calendar date, YYYY-MM-DD. */
export const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const istClock = () => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short', hour12: false })
    .formatToParts(new Date()).reduce<Record<string, string>>((o, x) => ((o[x.type] = x.value), o), {});
  return `IST ${p.hour}:${p.minute} · ${p.weekday} ${p.day} ${p.month}`;
};

export const DEFAULT_FILTERS: Filters = { period: 'today', from: istToday(), to: istToday(), segment: 'all', rep: null };

export function qs(f: Filters, extra: Record<string, string | number | null | undefined> = {}) {
  const p = new URLSearchParams();
  p.set('period', f.period);
  if (f.period === 'custom') { p.set('from', f.from); p.set('to', f.to); }
  if (f.segment !== 'all') p.set('segment', f.segment);
  if (f.rep) p.set('rep', String(f.rep));
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, String(v));
  return p.toString();
}

/** Fetch `path` again whenever it or `tick` changes. The previous data stays on screen while the next
 *  load runs — a dashboard must never flash to a skeleton on every webhook. */
export function useAdmin<T>(path: string | null, tick = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const latest = useRef(0);
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); return; }
    const n = ++latest.current;
    setLoading(true);
    api<T>(path).then((d) => { if (n === latest.current) { setData(d); setError(null); } })
      .catch((e) => { if (n === latest.current) setError((e as Error).message); })
      .finally(() => { if (n === latest.current) setLoading(false); });
  }, [path, tick]);
  return { data, error, loading };
}

export const del = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) });

// --- response shapes (server/src/routes/admin.js) --------------------------------------------
export type Sum = {
  dials: number; connects: number; talk_secs: number; leads_dialed: number; leads_reached: number; abandoned: number; callbacks: number;
  wrap_median: number | null; ni_dials: number; ni_connects: number; in_dials: number; in_connects: number; cancelled_legs: number;
};
export type Summary = Filters & { current: Sum; previous: Sum };
export type Day = { day: string; dials: number; connects: number };
export type Outcome = { outcome: string; n: number };
export type LiveState = 'on_call' | 'ringing' | 'idle' | 'off';
export type Live = { id: number; email: string; audio: boolean; state: LiveState; with: { name: string | null; phone: string; since?: string } | null };
export type Rep = {
  id: number; email: string; active: boolean; hubspot_mapped: boolean; hubspot_synced_at: string | null;
  dials: number; connects: number; talk_secs: number; wrap_median: number | null; in_queue: number; now: Live | null; hubspot: 'mapped' | 'not mapped' | 'off';
};
export type Hour = { hour: number; dials: number; connects: number };
export type Country = { country: string; dials: number; connects: number };
export type QueueRow = { status: string; source: string; n: number };
export type Readiness = { ready: number; next_open_at: string | null; waiting_gap: number; waiting_window: number };
export type HubSpotPanel = { configured: boolean; ok?: boolean | null; error?: string | null; syncedAt?: string | null; inQueue?: number };
export type CallRow = {
  id: number; started_at: string; rep_id: number; rep: string; lead_id: number; name: string | null; phone: string; from_number: string | null;
  country: string | null; segment: string; hubspot_contact_id: string | null; ring_secs: number | null; talk_secs: number | null;
  disposition: string | null; sub_outcome: string | null; reason: string | null; notes: string | null; wrap_secs: number | null;
  recording_status: 'started' | 'saved' | 'error' | null; recording_token: string | null; recording_secs: number | null;
  hubspot_call_id: string | null; hubspot_file_url: string | null; hubspot_error: string | null; cost: number | null;
};
export type CallsPage = Filters & { rows: CallRow[]; total: number };
export type RepDetail = Filters & {
  rep: { id: number; email: string; role: string; active: boolean }; current: Sum; previous: Sum;
  byHour: Hour[]; byCountry: Country[]; queue: QueueRow[]; readiness: Readiness; hubspot: HubSpotPanel; recent: CallRow[]; now: Live | null;
};
export type LeadRow = {
  id: number; name: string | null; phone: string; phones: string[]; country: string | null; utc_offset: string | null; timezone?: string | null; attemptLimit: number; segment: string;
  source: string; status: string; attempt_count: number; next_call_at: string; last_call_at: string | null; hubspot_contact_id: string | null;
  company: string | null; hubspot_url: string | null; rep_id: number | null; rep: string | null; last_outcome: string | null;
};
export type LeadsPage = { rows: LeadRow[]; total: number };
export type Attempt = {
  id: number; started_at: string; from_number: string | null; to_number: string | null; ring_secs: number | null; talk_secs: number | null;
  disposition: string | null; sub_outcome: string | null; reason: string | null; notes: string | null; recording_status: string | null; recording_token: string | null; hubspot_call_id: string | null; rep: string;
};
export type LeadDetail = LeadRow & { attempts: Attempt[]; extra: Record<string, unknown> };
export type CallerId = { number: string; region: string; usedToday: number; cap: number; available: boolean; ever: number };
export type WalletPeriod = {
  from: string; to: string; spend: number; rep_spend: number; lead_spend: number; legs: number; billed_secs: number; currency: string | null;
  dials: number; connects: number; awaiting_cost: number; parts: { part: string; cost: number; billed_secs: number | null }[];
};
export type Balance = { balance: number | null; pending: number | null; creditLimit: number | null; availableCredit: number | null; currency: string; asOf: string } | { error: string };
export type Wallet = { balance: Balance; periods: { today: WalletPeriod; d7: WalletPeriod; d30: WalletPeriod }; byDay: { day: string; spend: number }[] };
export type Health = {
  recording: { on: boolean; beep: boolean; saved: number; errors: number };
  cost: { lastAt: string | null; rows: number };
  hubspot: HubSpotPanel & { write?: { ok: boolean | null; error: string | null; at: string | null }; logged: number; failed: number };
  settings: Settings;
};
export type Settings = { hubspot_create_contacts: boolean };
export type AdminUser = {
  id: number; email: string; role: 'rep' | 'admin'; active: boolean; created_at: string; deactivated_at: string | null;
  hubspot_mapped: boolean; in_queue: number; dials_7d: number; audio: boolean;
};

// --- formatters ---------------------------------------------------------------------------------
export const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);
export const fpct = (v: number, d = 1) => v.toFixed(d) + '%';
export const money = (n: number | null | undefined, ccy = 'USD') =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 }).format(n);
export const secs = (s: number | null | undefined) => {
  if (s == null) return '—';
  const n = Math.round(s); const m = Math.floor(n / 60);
  return m ? `${m}m ${String(n % 60).padStart(2, '0')}s` : `${n}s`;
};
export const OUTCOME_LABEL: Record<string, string> = {
  connected_unspecified: 'Connected — no outcome tile picked', interested: 'Interested', follow_up: 'Follow-up booked', callback: 'Callback booked',
  not_interested: 'Not interested', not_qualified: 'Not qualified', no_answer: 'No answer', later: 'Call later', failed: 'Could not be dialed',
  invalid: 'Wrong number', abandoned: 'Abandoned', cancelled: 'Cancelled', open: 'No outcome saved yet', in_progress: 'In progress', connected: 'Connected',
};
export const OUTCOME_LAMP: Record<string, string> = {
  connected_unspecified: 'amber', interested: 'green', follow_up: 'blue', callback: 'blue', not_interested: 'coral', not_qualified: 'grey',
  no_answer: 'grey', later: 'blue', failed: 'coral', invalid: 'coral', abandoned: 'coral', cancelled: 'grey', open: 'amber', in_progress: 'amber', connected: 'green',
};
/** What a call row says in one word: the sub-outcome when there is one, else the disposition. */
export const outcomeOf = (r: { disposition: string | null; sub_outcome: string | null; talk_secs?: number | null }) =>
  r.disposition === 'connected' ? (r.sub_outcome ?? 'connected_unspecified') : r.disposition ?? (r.talk_secs != null ? 'open' : 'in_progress');
