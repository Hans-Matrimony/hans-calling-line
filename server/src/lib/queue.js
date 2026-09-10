import { q, pool } from '../db/pool.js';
import { MAX_ATTEMPTS, MIN_GAP_HOURS, ATTEMPTS_PER_NUMBER, ROLL_GAP_MINUTES, LEAD_LOCAL_WINDOW, IGNORE_WINDOWS, DAILY_CAP_PER_NUMBER } from '../config.js';

// The lead's wall clock right now (a timestamp without zone), and its hour, as SQL over leads alias `l`.
const LOCAL = `((now() AT TIME ZONE 'UTC') + (l.utc_offset * interval '1 hour'))`;
const LOCAL_HOUR = `EXTRACT(HOUR FROM ${LOCAL})`;
// A lead-local wall-clock expression back to an instant.
const AT_LOCAL = (wall) => `((${wall}) - (l.utc_offset * interval '1 hour')) AT TIME ZONE 'UTC'`;
// Already rung at this local hour (any day): hour-variance rule. Cancelled loser legs are not attempts.
const TRIED_THIS_HOUR = `EXISTS (
        SELECT 1 FROM calls c
        WHERE c.lead_id = l.id AND c.disposition IS DISTINCT FROM 'cancelled'
          AND EXTRACT(HOUR FROM (c.started_at AT TIME ZONE 'UTC') + (l.utc_offset * interval '1 hour')) = ${LOCAL_HOUR})`;
const { start: WIN_START, end: WIN_END } = LEAD_LOCAL_WINDOW;

// How many attempts this lead gets in total, over all of its numbers: MAX_ATTEMPTS for a one- or
// two-number lead, 9 for a three-number one, so the last number is still reached after attempts
// lost to abandoned legs and bridge failures. Inlined, never a bind parameter, so the expression
// can be dropped into any query without shifting its placeholders.
const ATTEMPT_CEILING = `GREATEST(${MAX_ATTEMPTS}, ${ATTEMPTS_PER_NUMBER} * cardinality(l.phones))`;

// When the calling-hours gate next admits `l`, ignoring next_call_at: tomorrow's 10:00 local once past
// 19:00 (or when the next local hour would be), today's 10:00 before it, the next local hour when this
// one is already used, else now. One expression so Up next, readiness() and eligibleWhere() cannot
// disagree about what "opens at" means. With IGNORE_WINDOWS the gate is always open.
const WINDOW_OPEN = IGNORE_WINDOWS ? 'now()' : `CASE
      WHEN ${LOCAL_HOUR} >= ${WIN_END} OR (${LOCAL_HOUR} + 1 >= ${WIN_END} AND ${TRIED_THIS_HOUR})
        THEN ${AT_LOCAL(`date_trunc('day', ${LOCAL}) + interval '1 day' + interval '${WIN_START} hours'`)}
      WHEN ${LOCAL_HOUR} < ${WIN_START} THEN ${AT_LOCAL(`date_trunc('day', ${LOCAL}) + interval '${WIN_START} hours'`)}
      WHEN ${TRIED_THIS_HOUR} THEN ${AT_LOCAL(`date_trunc('hour', ${LOCAL}) + interval '1 hour'`)}
      ELSE now() END`;
// The instant this lead can next be dialled by Auto/Burst. A callback and a lead with no timezone
// have only next_call_at to go on ('later' skips the window rules by design).
const OPENS_AT = `CASE WHEN l.status = 'later' OR l.utc_offset IS NULL THEN l.next_call_at
                       ELSE GREATEST(l.next_call_at, ${WINDOW_OPEN}) END`;
// The one rule holding this lead back, or NULL when it is due. Precedence is "what holds it longest":
// a 2h gap that outlasts the window opening is 'gap', so every 'window' / 'hour' lead opens exactly at
// WINDOW_OPEN, a clean local-hour instant Up next can group on.
const WHY = `CASE
      WHEN l.status = 'later' THEN CASE WHEN l.next_call_at > now() THEN 'later' END
      WHEN l.utc_offset IS NULL THEN 'no_timezone'
      WHEN l.next_call_at > now() AND l.next_call_at >= ${WINDOW_OPEN} THEN 'gap'
      ${IGNORE_WINDOWS ? '' : `WHEN ${LOCAL_HOUR} < ${WIN_START} OR ${LOCAL_HOUR} >= ${WIN_END} THEN 'window'
      WHEN ${TRIED_THIS_HOUR} THEN 'hour'`}
      WHEN l.next_call_at > now() THEN 'gap'
      END`;
// The rep's leads that still have a turn coming: queued or a booked callback, attempts left.
const IN_QUEUE = (user) => `l.user_id = ${user} AND l.status IN ('queued', 'later') AND l.attempt_count < ${ATTEMPT_CEILING}`;

/**
 * Claim up to `limit` eligible leads and mark them in_flight, atomically (plan s7).
 * Eligible: queued/later, next_call_at due, attempts left, inside the lead-local window,
 * never dialed at this local hour before. 'later' leads skip the two time rules: the rep
 * chose that time. IGNORE_WINDOWS=true skips them for everyone (plumbing test at any hour).
. * Cancelled loser legs are not attempts and do not count for hour-variance.
 * Always scoped to the rep's own leads: leads are never shared across the team. `user` is the
 * placeholder carrying the rep ($2 for peek/claim, whose $1 is the limit).
 */
function eligibleWhere(segment, { user = '$2' } = {}) {
  const where = [IN_QUEUE(user), `l.next_call_at <= now()`];
  if (!IGNORE_WINDOWS) {
    where.push(`(l.status = 'later' OR (
      l.utc_offset IS NOT NULL
      AND ${LOCAL_HOUR} >= ${WIN_START} AND ${LOCAL_HOUR} < ${WIN_END}
      AND NOT ${TRIED_THIS_HOUR}))`);
  }
  if (segment) where.push('l.segment = $3');
  return where.join(' AND ');
}

// What a row of Up next shows (peekLeads and queueOverview return the same shape).
const LEAD_COLS = `l.id, l.name, l.phone, l.phones, l.country, l.segment, l.utc_offset, l.attempt_count, l.status, l.next_call_at, l.extra,
            l.phone_idx AS "phoneIdx", cardinality(l.phones) AS "phoneCount", l.last_call_at AS "lastCallAt",
            (SELECT p.disposition FROM calls p WHERE p.lead_id = l.id AND p.disposition IS NOT NULL ORDER BY p.started_at DESC LIMIT 1) AS last_outcome,
            EXISTS (SELECT 1 FROM calls p WHERE p.lead_id = l.id AND p.disposition = 'connected') AS "everConnected"`;

/** Read-only preview of what the next burst would pick ("Up next" panel). Same rules as claimLeads. */
export async function peekLeads(userId, limit, segment = null) {
  const params = [limit, userId];
  if (segment) params.push(segment);
  const { rows } = await q(
    `SELECT ${LEAD_COLS} FROM leads l WHERE ${eligibleWhere(segment)} ORDER BY l.next_call_at ASC LIMIT $1`, params);
  return rows;
}

/**
 * The whole queue, grouped by when each lead opens - what Up next shows. The rep ticked 25 contacts and
 * saw 3: the other 22 were held by their clocks and simply not listed. Here every lead is in exactly one
 * group: 'ready' (Auto/Burst would pick it now), 'window:<instant>' (held by calling hours, one group per
 * opening time, so India at 10:00 IST and Germany at 10:00 CET are two heads), or the rule holding it:
 * 'gap' | 'hour' | 'later' | 'no_timezone'. Each group carries `per` rows unless its key is in `expand`.
 */
export async function queueOverview(userId, { per = 5, expand = [] } = {}) {
  const grouped = `
    WITH l0 AS (
      SELECT ${LEAD_COLS}, (${eligibleWhere(null, { user: '$1' })}) AS ready, ${WHY} AS why, ${OPENS_AT} AS "opensAt"
      FROM leads l WHERE ${IN_QUEUE('$1')}),
    g AS (
      SELECT *, CASE WHEN ready THEN 'ready'
                     WHEN why = 'window' THEN 'window:' || to_char("opensAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                     ELSE coalesce(why, 'gap') END AS key
      FROM l0)`;
  const [{ rows: heads }, { rows }] = await Promise.all([
    q(`${grouped}
       SELECT key, min(why) AS why, min("opensAt") AS "opensAt", count(*)::int AS count,
              coalesce(array_agg(DISTINCT country) FILTER (WHERE country IS NOT NULL AND country <> ''), '{}') AS countries
       FROM g GROUP BY key`, [userId]),
    q(`${grouped}, n AS (SELECT *, row_number() OVER (PARTITION BY key ORDER BY "opensAt", next_call_at, id) AS rn FROM g)
       SELECT * FROM n WHERE rn <= $2 OR key = ANY($3) ORDER BY "opensAt", next_call_at, id`, [userId, per, expand]),
  ]);
  const group = (h) => ({
    key: h.key, why: h.why, opensAt: h.opensAt, count: h.count, countries: h.countries,
    leads: rows.filter((r) => r.key === h.key).map(({ key, rn, ready, ...lead }) => lead),
  });
  const ready = heads.find((h) => h.key === 'ready');
  // Soonest first; a lead with no timezone has no opening time and goes last.
  const later = heads.filter((h) => h.key !== 'ready').map(group).sort((a, b) =>
    (a.why === 'no_timezone') - (b.why === 'no_timezone') || new Date(a.opensAt) - new Date(b.opensAt));
  const soonest = later.find((g) => g.why !== 'no_timezone')?.opensAt ?? null;
  return {
    now: new Date(),
    total: heads.reduce((n, h) => n + h.count, 0),
    ready: ready ? group(ready) : { key: 'ready', why: null, opensAt: null, count: 0, countries: [], leads: [] },
    later, soonest,
  };
}

export async function claimLeads(userId, limit, segment = null) {
  const where = eligibleWhere(segment);
  const params = [limit, userId];
  if (segment) params.push(segment);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT l.* FROM leads l WHERE ${where}
       ORDER BY l.next_call_at ASC LIMIT $1 FOR UPDATE OF l SKIP LOCKED`, params);
    if (rows.length) await client.query(`UPDATE leads SET status = 'in_flight' WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    await client.query('COMMIT');
    return rows;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// Is there a number after the one in play? Rolling to it is what makes alternates worth having.
const HAS_NEXT = `l.phone_idx < cardinality(l.phones)`;
// The current number is spent (ATTEMPTS_PER_NUMBER tries used) and there is somewhere to go.
const ROLL = `l.number_attempts + 1 >= ${ATTEMPTS_PER_NUMBER} AND ${HAS_NEXT}`;
// Move to the next number. coalesce guards a row the backfill missed: leads.phone is NOT NULL, and
// a constraint violation here would fire after calls.disposition was already committed, leaving the
// lead stuck in_flight until sweepStuckLeads runs.
const ADVANCE = (when) => `
  number_attempts = CASE WHEN ${when} THEN 0 ELSE l.number_attempts + 1 END,
  phone_idx       = CASE WHEN ${when} THEN l.phone_idx + 1 ELSE l.phone_idx END,
  phone           = CASE WHEN ${when} THEN coalesce(l.phones[l.phone_idx + 1], l.phone) ELSE l.phone END`;

/** Apply a disposition to a lead (plan s7 table). Unreachable leads roll onto their next number
 *  (PLAN-v2 alternates): one lead row, one attempt budget, `phone` always the number in play. */
export function releaseLead(leadId, outcome, laterAt = null) {
  switch (outcome) {
    case 'connected':
      // A plain connect leaves the queue (the rep owns it now). But a connect that ends in a booked
      // follow-up / callback (call-card v2: the rep spoke to them AND set a time) still counts as a
      // connect - disposition stays 'connected', so stats and the tape credit it - yet the lead comes
      // back at the chosen time. `laterAt` is what tells the two apart.
      return laterAt
        ? q(`UPDATE leads SET status = 'later', next_call_at = $2, last_call_at = now(), attempt_count = attempt_count + 1 WHERE id = $1`, [leadId, laterAt])
        : q(`UPDATE leads SET status = 'connected', last_call_at = now(), attempt_count = attempt_count + 1 WHERE id = $1`, [leadId]);
    case 'no_answer':
    case 'failed':
      // Three tries on this number, then the next one 15 min later. Only when the lead has no
      // number left does the whole budget apply and the lead exhaust.
      return q(`UPDATE leads l SET attempt_count = l.attempt_count + 1, last_call_at = now(),${ADVANCE(ROLL)},
                  next_call_at = now() + CASE WHEN ${ROLL} THEN interval '${ROLL_GAP_MINUTES} minutes'
                                                           ELSE interval '${MIN_GAP_HOURS} hours' END,
                  status = CASE WHEN NOT (${ROLL}) AND l.attempt_count + 1 >= ${ATTEMPT_CEILING} THEN 'exhausted' ELSE 'queued' END
                WHERE l.id = $1`, [leadId]);
    case 'later': // rep-picked datetime, does not consume an attempt
      return q(`UPDATE leads SET status = 'later', next_call_at = $2, last_call_at = now() WHERE id = $1`, [leadId, laterAt]);
    case 'cancelled': // losing burst leg: back to the queue, nothing consumed. 10 min cooldown so the
      // lead is not rung again by the very next burst (seen live: two missed calls 20 s apart).
      // Never rolls: a leg can legitimately release twice (cancelled, then abandoned), and only
      // the second one may count against the number.
      return q(`UPDATE leads SET status = 'queued', next_call_at = GREATEST(next_call_at, now() + interval '10 minutes') WHERE id = $1`, [leadId]);
    case 'invalid': // dead number (unallocated / invalid), or the rep's "Wrong number": don't spend
      // this number's remaining tries on a line that is answering for someone else - go straight to
      // the alternate. Only a lead with nowhere left to go stops.
      return q(`UPDATE leads l SET attempt_count = l.attempt_count + 1, last_call_at = now(),${ADVANCE(HAS_NEXT)},
                  next_call_at = CASE WHEN ${HAS_NEXT} THEN now() + interval '${ROLL_GAP_MINUTES} minutes' ELSE l.next_call_at END,
                  status = CASE WHEN ${HAS_NEXT} THEN 'queued' ELSE 'stopped' END
                WHERE l.id = $1`, [leadId]);
    default:
      throw new Error('unknown outcome ' + outcome);
  }
}

/** Configured caller IDs as a flat list. Each FROM_NUMBER_* may hold several comma-separated E.164
 *  numbers; within a region they are rotated (least-used-today first) to spread load and to avoid one
 *  number firing every burst, which reads as spam (plan s5). */
export function configuredNumbers() {
  const byRegion = { india: process.env.FROM_NUMBER_INDIA, eu: process.env.FROM_NUMBER_EU, us: process.env.FROM_NUMBER_US };
  const out = [];
  for (const [region, raw] of Object.entries(byRegion))
    for (const n of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))
      out.push({ number: n, region });
  return out;
}

/** Caller ID for a region, honouring the 50/number/day cap (plan s5). Picks the least-used number in
 *  the region; falls back to the least-used number anywhere so India dials from +1/+44 before +91 clears. */
export async function pickFromNumber(region) {
  const all = configuredNumbers();
  const used = await usedTodayByNumber();
  const leastUsed = (list) => list
    .filter((n) => (used[n.number] ?? 0) < DAILY_CAP_PER_NUMBER)
    .sort((a, b) => (used[a.number] ?? 0) - (used[b.number] ?? 0))[0];
  const pick = leastUsed(all.filter((n) => n.region === region)) ?? leastUsed(all.filter((n) => n.region !== region));
  return pick?.number ?? null;
}

/** { '+1302...': 12, ... } dials placed today per caller ID (cancelled legs included: they were placed). */
export async function usedTodayByNumber() {
  const { rows } = await q(
    `SELECT from_number, count(*)::int AS n FROM calls WHERE started_at >= date_trunc('day', now()) GROUP BY from_number`);
  return Object.fromEntries(rows.map((r) => [r.from_number, r.n]));
}

/** Every configured caller ID with today's usage, for the manual dialer's dropdown. */
export async function listFromNumbers() {
  const used = await usedTodayByNumber();
  return configuredNumbers()
    .map(({ number, region }) => ({ number, region, usedToday: used[number] ?? 0, cap: DAILY_CAP_PER_NUMBER, available: (used[number] ?? 0) < DAILY_CAP_PER_NUMBER }));
}

/** Safety net: a lead left in_flight with no call in the last 2h (rep closed the tab mid-call and
 *  never dispositioned) goes back to the queue without consuming an attempt. Runs before each burst. */
export function sweepStuckLeads() {
  return q(`UPDATE leads l SET status = 'queued'
            WHERE l.status = 'in_flight'
              AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id AND c.started_at > now() - interval '2 hours')`);
}

/** What the campaign pages need to explain a grey Start button honestly: how many leads Start would pick
 *  right now, when the next one opens (2h gap or the lead-local 10:00), and how many wait on each rule. */
export async function readiness(userId) {
  const { rows: [r] } = await q(`SELECT count(*)::int AS ready FROM leads l WHERE ${eligibleWhere(null, { user: '$1' })}`, [userId]);
  const { rows: [w] } = await q(
    `SELECT count(*) FILTER (WHERE l.next_call_at > now())::int  AS waiting_gap,
            count(*) FILTER (WHERE l.next_call_at <= now())::int AS waiting_window,
            min(${OPENS_AT}) AS next_open_at
     FROM leads l
     WHERE ${IN_QUEUE('$1')} AND NOT (${eligibleWhere(null, { user: '$1' })})`, [userId]);
  return { ready: r.ready, next_open_at: w.next_open_at, waiting_gap: w.waiting_gap, waiting_window: w.waiting_window };
}
