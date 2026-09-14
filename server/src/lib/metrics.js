// Every dashboard and wallet query, in one place so the admin routes stay thin and the test can call
// them directly. All dates are IST calendar days (docs/ADMIN-DASHBOARD.md s3): the rep console and the
// caller-ID cap stay on the UTC day, this does not.
import { offsetSQL, attemptLimitSQL } from './leadPolicy.js';
import { q } from '../db/pool.js';

const TZ = 'Asia/Kolkata';
export const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
export const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const validYmd = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) && !Number.isNaN(Date.parse(s)) ? String(s) : null);

/** The filter row, parsed once: { from, to } inclusive IST days, segment, rep. */
export function period(query = {}) {
  const today = istToday();
  const p = String(query.period ?? 'today');
  let from = today, to = today;
  if (p === 'yesterday') from = to = addDays(today, -1);
  else if (p === '7d') from = addDays(today, -6);
  else if (p === '30d') from = addDays(today, -29);
  else if (p === 'custom') { from = validYmd(query.from) ?? today; to = validYmd(query.to) ?? today; if (from > to) [from, to] = [to, from]; }
  const segment = ['india', 'non_india'].includes(query.segment) ? query.segment : null;
  const rep = /^\d+$/.test(String(query.rep ?? '')) ? Number(query.rep) : null;
  return { period: p, from, to, segment, rep };
}
const args = (f) => [f.from, f.to, f.segment, f.rep];

// Current period [f, t) and the same-length period before it, every leg tagged `cur`.
const BASE = `
WITH p AS (SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS f, ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' AS t),
c AS (SELECT c.*, l.segment, l.country, l.name AS lead_name, b.user_id, (c.started_at >= p.f) AS cur
      FROM calls c JOIN bursts b ON b.id = c.burst_id JOIN leads l ON l.id = c.lead_id, p
      WHERE c.started_at >= p.f - (p.t - p.f) AND c.started_at < p.t
        AND ($3::text IS NULL OR l.segment = $3) AND ($4::int IS NULL OR b.user_id = $4))`;

const WRAP = `percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (dispositioned_at - (answered_at + duration * interval '1 second'))))
  FILTER (WHERE answered_at IS NOT NULL AND dispositioned_at IS NOT NULL AND duration IS NOT NULL)`;

export async function summary(f) {
  const { rows } = await q(`${BASE}
    SELECT cur,
      count(*) FILTER (WHERE disposition IS DISTINCT FROM 'cancelled')::int                    AS dials,
      count(*) FILTER (WHERE disposition = 'connected')::int                                   AS connects,
      coalesce(sum(duration) FILTER (WHERE answered_at IS NOT NULL), 0)::int                   AS talk_secs,
      count(DISTINCT lead_id) FILTER (WHERE disposition IS DISTINCT FROM 'cancelled')::int     AS leads_dialed,
      count(DISTINCT lead_id) FILTER (WHERE disposition = 'connected')::int                    AS leads_reached,
      count(*) FILTER (WHERE disposition = 'abandoned')::int                                   AS abandoned,
      count(*) FILTER (WHERE disposition = 'later' OR (disposition = 'connected' AND sub_outcome IN ('follow_up', 'callback')))::int AS callbacks,
      ${WRAP}::float AS wrap_median,
      count(*) FILTER (WHERE segment = 'non_india' AND disposition IS DISTINCT FROM 'cancelled')::int AS ni_dials,
      count(*) FILTER (WHERE segment = 'non_india' AND disposition = 'connected')::int              AS ni_connects,
      count(*) FILTER (WHERE segment = 'india' AND disposition IS DISTINCT FROM 'cancelled')::int     AS in_dials,
      count(*) FILTER (WHERE segment = 'india' AND disposition = 'connected')::int                  AS in_connects,
      count(*) FILTER (WHERE disposition = 'cancelled')::int                                   AS cancelled_legs
    FROM c GROUP BY cur`, args(f));
  const empty = { dials: 0, connects: 0, talk_secs: 0, leads_dialed: 0, leads_reached: 0, abandoned: 0, callbacks: 0, wrap_median: null, ni_dials: 0, ni_connects: 0, in_dials: 0, in_connects: 0, cancelled_legs: 0 };
  const pick = (cur) => { const r = rows.find((x) => x.cur === cur); if (!r) return { ...empty }; const { cur: _, ...rest } = r; return rest; };
  return { current: pick(true), previous: pick(false) };
}

/** Dials and connects per IST day for a window of `days` ending at f.to (the chart keeps context around Today). */
export async function byDay(f, days = 14) {
  const { rows } = await q(`
    SELECT (c.started_at AT TIME ZONE '${TZ}')::date::text AS day,
           count(*) FILTER (WHERE c.disposition IS DISTINCT FROM 'cancelled')::int AS dials,
           count(*) FILTER (WHERE c.disposition = 'connected')::int AS connects
    FROM calls c JOIN bursts b ON b.id = c.burst_id JOIN leads l ON l.id = c.lead_id
    WHERE c.started_at >= ($1::date - ($4::int - 1))::timestamp AT TIME ZONE '${TZ}' AND c.started_at < ($1::date + 1)::timestamp AT TIME ZONE '${TZ}'
      AND ($2::text IS NULL OR l.segment = $2) AND ($3::int IS NULL OR b.user_id = $3)
    GROUP BY 1 ORDER BY 1`, [f.to, f.segment, f.rep, days]);
  // Zero-fill so the chart draws every day, including the ones nobody dialed.
  const map = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: days }, (_, i) => { const day = addDays(f.to, i - days + 1); return map.get(day) ?? { day, dials: 0, connects: 0 }; });
}

export async function outcomes(f) {
  const { rows } = await q(`${BASE}
    SELECT CASE WHEN disposition = 'connected' AND sub_outcome IS NULL THEN 'connected_unspecified'
                WHEN disposition = 'connected' THEN sub_outcome
                WHEN disposition IS NULL AND answered_at IS NOT NULL AND duration IS NOT NULL THEN 'open'
                WHEN disposition IS NULL THEN 'in_progress'
                ELSE disposition END AS outcome, count(*)::int AS n
    FROM c WHERE cur GROUP BY 1 ORDER BY 2 DESC`, args(f));
  return rows;
}

export async function reps(f) {
  const { rows } = await q(`${BASE}
    SELECT u.id, u.email, u.active, u.hubspot_owner_id IS NOT NULL AS hubspot_mapped, u.hubspot_synced_at,
      count(c.id) FILTER (WHERE c.cur AND c.disposition IS DISTINCT FROM 'cancelled')::int AS dials,
      count(c.id) FILTER (WHERE c.cur AND c.disposition = 'connected')::int AS connects,
      coalesce(sum(c.duration) FILTER (WHERE c.cur AND c.answered_at IS NOT NULL), 0)::int AS talk_secs,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.dispositioned_at - (c.answered_at + c.duration * interval '1 second'))))
        FILTER (WHERE c.cur AND c.answered_at IS NOT NULL AND c.dispositioned_at IS NOT NULL AND c.duration IS NOT NULL))::float AS wrap_median,
      (SELECT count(*)::int FROM leads WHERE user_id = u.id AND status IN ('queued', 'later')) AS in_queue
    FROM users u LEFT JOIN c ON c.user_id = u.id
    WHERE u.role = 'rep' AND u.active GROUP BY u.id ORDER BY dials DESC, u.email`, args(f));
  return rows;
}

export async function byHour(f) {
  const { rows } = await q(`${BASE}
    SELECT EXTRACT(HOUR FROM started_at AT TIME ZONE '${TZ}')::int AS hour,
           count(*) FILTER (WHERE disposition IS DISTINCT FROM 'cancelled')::int AS dials,
           count(*) FILTER (WHERE disposition = 'connected')::int AS connects
    FROM c WHERE cur GROUP BY 1 ORDER BY 1`, args(f));
  const map = new Map(rows.map((r) => [r.hour, r]));
  return Array.from({ length: 24 }, (_, hour) => map.get(hour) ?? { hour, dials: 0, connects: 0 });
}

export async function byCountry(f, top = 8) {
  const { rows } = await q(`${BASE}
    SELECT coalesce(country, '') AS country,
           count(*) FILTER (WHERE disposition IS DISTINCT FROM 'cancelled')::int AS dials,
           count(*) FILTER (WHERE disposition = 'connected')::int AS connects
    FROM c WHERE cur GROUP BY 1 ORDER BY 2 DESC`, args(f));
  const head = rows.slice(0, top), tail = rows.slice(top);
  if (tail.length) head.push({ country: 'Other', dials: tail.reduce((a, r) => a + r.dials, 0), connects: tail.reduce((a, r) => a + r.connects, 0) });
  return head;
}

export async function queueOf(userId) {
  const { rows } = await q(`SELECT status, source, count(*)::int AS n FROM leads WHERE user_id = $1 GROUP BY 1, 2`, [userId]);
  return rows;
}

/** The call log. Filters beyond the top row: outcome, answered, caller ID, free text. 100 a page. */
export async function calls(f, o = {}) {
  const limit = Math.min(10000, Math.max(1, Number(o.limit) || 100));
  const offset = Math.max(0, Number(o.offset) || 0);
  const outcome = o.outcome ? String(o.outcome) : null;
  const answered = o.answered === '1' ? true : o.answered === '0' ? false : null;
  const from = o.from ? String(o.from) : null;
  const text = o.q ? String(o.q).trim() : null;
  const { rows } = await q(`
    WITH p AS (SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS f, ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' AS t)
    SELECT c.id, c.started_at, u.id AS rep_id, u.email AS rep, l.id AS lead_id, l.name, coalesce(c.to_number, l.phone) AS phone,
           c.from_number, l.country, l.segment, l.hubspot_contact_id,
           EXTRACT(EPOCH FROM (coalesce(c.answered_at, c.ended_at) - c.started_at))::int AS ring_secs,
           CASE WHEN c.answered_at IS NOT NULL THEN c.duration END AS talk_secs,
           c.disposition, c.sub_outcome, c.reason, c.notes,
           EXTRACT(EPOCH FROM (c.dispositioned_at - (c.answered_at + c.duration * interval '1 second')))::int AS wrap_secs,
           c.recording_status, c.recording_token, EXTRACT(EPOCH FROM (c.recording_ended_at - c.recording_started_at))::int AS recording_secs,
           c.hubspot_call_id, c.hubspot_file_url, c.hubspot_error, t.total_cost::float AS cost,
           count(*) OVER()::int AS total
    FROM p, calls c JOIN bursts b ON b.id = c.burst_id JOIN leads l ON l.id = c.lead_id JOIN users u ON u.id = b.user_id
    LEFT JOIN telnyx_costs t ON t.call_control_id = c.telnyx_call_id
    WHERE c.started_at >= p.f AND c.started_at < p.t
      AND ($3::text IS NULL OR l.segment = $3) AND ($4::int IS NULL OR b.user_id = $4)
      AND ($5::text IS NULL OR CASE $5 WHEN 'connected_unspecified' THEN c.disposition = 'connected' AND c.sub_outcome IS NULL
                                       WHEN 'open' THEN c.disposition IS NULL ELSE c.disposition = $5 END)
      AND ($6::bool IS NULL OR (c.answered_at IS NOT NULL) = $6)
      AND ($7::text IS NULL OR c.from_number = $7)
      AND ($8::text IS NULL OR l.name ILIKE '%' || $8 || '%' OR l.extra->>'company' ILIKE '%' || $8 || '%'
           OR ($9::text <> '' AND coalesce(c.to_number, l.phone) LIKE '%' || $9 || '%'))
    ORDER BY c.started_at DESC, c.id DESC LIMIT $10 OFFSET $11`,
    [f.from, f.to, f.segment, f.rep, outcome, answered, from, text, text ? text.replace(/\D/g, '') : '', limit, offset]);
  return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

export async function leads(f, o = {}) {
  const limit = Math.min(500, Math.max(1, Number(o.limit) || 100));
  const offset = Math.max(0, Number(o.offset) || 0);
  const status = o.status ? String(o.status) : null;
  const source = o.source ? String(o.source) : null;
  const text = o.q ? String(o.q).trim() : null;
  const { rows } = await q(`
    SELECT l.id, l.name, l.phone, l.phones, l.country, ${offsetSQL()} AS utc_offset, l.timezone, ${attemptLimitSQL()} AS "attemptLimit", l.segment, l.source, l.status, l.attempt_count, l.next_call_at,
           l.last_call_at, l.hubspot_contact_id, l.extra->>'company' AS company, l.extra->>'hubspotUrl' AS hubspot_url,
           u.id AS rep_id, u.email AS rep,
           (SELECT p.disposition FROM calls p WHERE p.lead_id = l.id AND p.disposition IS NOT NULL ORDER BY p.started_at DESC LIMIT 1) AS last_outcome,
           count(*) OVER()::int AS total
    FROM leads l LEFT JOIN users u ON u.id = l.user_id
    WHERE ($1::text IS NULL OR l.segment = $1) AND ($2::int IS NULL OR l.user_id = $2)
      AND ($3::text IS NULL OR l.status = $3) AND ($4::text IS NULL OR l.source = $4)
      AND ($5::text IS NULL OR l.name ILIKE '%' || $5 || '%' OR l.extra->>'company' ILIKE '%' || $5 || '%'
           OR ($6::text <> '' AND array_to_string(l.phones, ' ') LIKE '%' || $6 || '%'))
    ORDER BY l.last_call_at DESC NULLS LAST, l.id DESC LIMIT $7 OFFSET $8`,
    [f.segment, f.rep, status, source, text, text ? text.replace(/\D/g, '') : '', limit, offset]);
  return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

export async function leadDetail(id) {
  const { rows: [lead] } = await q(`
    SELECT l.*, ${offsetSQL()} AS utc_offset, ${attemptLimitSQL()} AS "attemptLimit", u.email AS rep, l.extra->>'company' AS company, l.extra->>'hubspotUrl' AS hubspot_url
    FROM leads l LEFT JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [id]);
  if (!lead) return null;
  const { rows: attempts } = await q(`
    SELECT c.id, c.started_at, c.from_number, c.to_number,
           EXTRACT(EPOCH FROM (coalesce(c.answered_at, c.ended_at) - c.started_at))::int AS ring_secs,
           CASE WHEN c.answered_at IS NOT NULL THEN c.duration END AS talk_secs,
           c.disposition, c.sub_outcome, c.reason, c.notes, c.recording_status, c.recording_token, c.hubspot_call_id, u.email AS rep
    FROM calls c JOIN bursts b ON b.id = c.burst_id JOIN users u ON u.id = b.user_id
    WHERE c.lead_id = $1 ORDER BY c.started_at`, [id]);
  return { ...lead, attempts };
}

/** Telnyx spend for one period. Account-wide: the wallet is the account's money, not a rep's. */
export async function wallet(from, to) {
  const T = `
    WITH p AS (SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS f, ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' AS t),
    t AS (SELECT t.*, coalesce(c.started_at, t.occurred_at) AS at
          FROM telnyx_costs t LEFT JOIN calls c ON c.id = t.call_id, p
          WHERE coalesce(c.started_at, t.occurred_at) >= p.f AND coalesce(c.started_at, t.occurred_at) < p.t)`;
  const { rows: [s] } = await q(`${T}
    SELECT coalesce(sum(total_cost), 0)::float AS spend,
           coalesce(sum(total_cost) FILTER (WHERE kind = 'rep'), 0)::float AS rep_spend,
           coalesce(sum(total_cost) FILTER (WHERE kind IS DISTINCT FROM 'rep'), 0)::float AS lead_spend,
           count(*)::int AS legs, coalesce(sum(billed_secs), 0)::int AS billed_secs,
           max(currency) AS currency,
           (SELECT count(*)::int FROM calls c, p WHERE c.started_at >= p.f AND c.started_at < p.t AND c.disposition IS DISTINCT FROM 'cancelled') AS dials,
           (SELECT count(*)::int FROM calls c, p WHERE c.started_at >= p.f AND c.started_at < p.t AND c.disposition = 'connected') AS connects,
           (SELECT count(*)::int FROM calls c, p WHERE c.started_at >= p.f AND c.started_at < p.t AND c.telnyx_call_id IS NOT NULL
              AND c.ended_at < now() - interval '15 minutes'
              AND NOT EXISTS (SELECT 1 FROM telnyx_costs x WHERE x.call_control_id = c.telnyx_call_id)) AS awaiting_cost
    FROM t`, [from, to]);
  const { rows: parts } = await q(`${T}
    SELECT part->>'call_part' AS part, sum((part->>'cost')::numeric)::float AS cost, sum((part->>'billed_duration_secs')::int)::int AS billed_secs
    FROM t, jsonb_array_elements(t.parts) part GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
  return { from, to, ...s, parts };
}

export async function walletByDay(from, to) {
  const { rows } = await q(`
    WITH p AS (SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS f, ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' AS t)
    SELECT (coalesce(c.started_at, t.occurred_at) AT TIME ZONE '${TZ}')::date::text AS day, sum(t.total_cost)::float AS spend
    FROM telnyx_costs t LEFT JOIN calls c ON c.id = t.call_id, p
    WHERE coalesce(c.started_at, t.occurred_at) >= p.f AND coalesce(c.started_at, t.occurred_at) < p.t
    GROUP BY 1 ORDER BY 1`, [from, to]);
  return rows;
}
