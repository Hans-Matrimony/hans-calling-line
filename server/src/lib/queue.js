import { q, pool } from '../db/pool.js';
import { MAX_ATTEMPTS, MIN_GAP_HOURS, LEAD_LOCAL_WINDOW, IGNORE_WINDOWS, DAILY_CAP_PER_NUMBER } from '../config.js';

// Lead-local hour right now, as SQL over leads alias `l`.
const LOCAL_HOUR = `EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC') + (l.utc_offset * interval '1 hour'))`;

/**
 * Claim up to `limit` eligible leads and mark them in_flight, atomically (plan s7).
 * Eligible: queued/later, next_call_at due, attempts left, inside the lead-local window,
 * never dialed at this local hour before. 'later' leads skip the two time rules: the rep
 * chose that time. IGNORE_WINDOWS=true skips them for everyone (plumbing test at any hour).
 * Cancelled loser legs are not attempts and do not count for hour-variance.
 */
export async function claimLeads(limit, segment = null) {
  const where = [`l.status IN ('queued', 'later')`, `l.next_call_at <= now()`, `l.attempt_count < ${MAX_ATTEMPTS}`];
  if (!IGNORE_WINDOWS) {
    where.push(`(l.status = 'later' OR (
      l.utc_offset IS NOT NULL
      AND ${LOCAL_HOUR} >= ${LEAD_LOCAL_WINDOW.start} AND ${LOCAL_HOUR} < ${LEAD_LOCAL_WINDOW.end}
      AND NOT EXISTS (
        SELECT 1 FROM calls c
        WHERE c.lead_id = l.id AND c.disposition IS DISTINCT FROM 'cancelled'
          AND EXTRACT(HOUR FROM (c.started_at AT TIME ZONE 'UTC') + (l.utc_offset * interval '1 hour')) = ${LOCAL_HOUR})))`);
  }
  const params = [limit];
  if (segment) { params.push(segment); where.push('l.segment = $2'); }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT l.* FROM leads l WHERE ${where.join(' AND ')}
       ORDER BY l.next_call_at ASC LIMIT $1 FOR UPDATE OF l SKIP LOCKED`, params);
    if (rows.length) await client.query(`UPDATE leads SET status = 'in_flight' WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    await client.query('COMMIT');
    return rows;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/** Apply a disposition to a lead (plan s7 table). */
export function releaseLead(leadId, outcome, laterAt = null) {
  switch (outcome) {
    case 'connected':
      return q(`UPDATE leads SET status = 'connected', last_call_at = now(), attempt_count = attempt_count + 1 WHERE id = $1`, [leadId]);
    case 'no_answer':
    case 'failed':
      return q(`UPDATE leads SET attempt_count = attempt_count + 1, last_call_at = now(),
                  next_call_at = now() + interval '${MIN_GAP_HOURS} hours',
                  status = CASE WHEN attempt_count + 1 >= ${MAX_ATTEMPTS} THEN 'exhausted' ELSE 'queued' END
                WHERE id = $1`, [leadId]);
    case 'later': // rep-picked datetime, does not consume an attempt
      return q(`UPDATE leads SET status = 'later', next_call_at = $2, last_call_at = now() WHERE id = $1`, [leadId, laterAt]);
    case 'cancelled': // losing burst leg: straight back to the queue, nothing consumed
      return q(`UPDATE leads SET status = 'queued' WHERE id = $1`, [leadId]);
    case 'invalid': // dead number (unallocated / invalid): stop the lead rather than retry it 6 times
      return q(`UPDATE leads SET status = 'stopped', last_call_at = now(), attempt_count = attempt_count + 1 WHERE id = $1`, [leadId]);
    default:
      throw new Error('unknown outcome ' + outcome);
  }
}

/** Caller ID for a region, honouring the 50/number/day cap (plan s5). Falls back to any
 *  configured number so today's test can dial India leads from +44/+1 before +91 clears. */
export async function pickFromNumber(region) {
  const env = fromNumbersByRegion();
  const order = [...new Set([env[region], env.us, env.eu, env.india].filter(Boolean))];
  const used = await usedTodayByNumber();
  return order.find((n) => (used[n] ?? 0) < DAILY_CAP_PER_NUMBER) ?? null;
}

export const fromNumbersByRegion = () =>
  ({ india: process.env.FROM_NUMBER_INDIA, eu: process.env.FROM_NUMBER_EU, us: process.env.FROM_NUMBER_US });

/** { '+1302...': 12, ... } dials placed today per caller ID (cancelled legs included: they were placed). */
export async function usedTodayByNumber() {
  const { rows } = await q(
    `SELECT from_number, count(*)::int AS n FROM calls WHERE started_at >= date_trunc('day', now()) GROUP BY from_number`);
  return Object.fromEntries(rows.map((r) => [r.from_number, r.n]));
}

/** Every configured caller ID with today's usage, for the manual dialer's dropdown. */
export async function listFromNumbers() {
  const used = await usedTodayByNumber();
  return Object.entries(fromNumbersByRegion()).filter(([, n]) => n)
    .map(([region, number]) => ({ number, region, usedToday: used[number] ?? 0, cap: DAILY_CAP_PER_NUMBER, available: (used[number] ?? 0) < DAILY_CAP_PER_NUMBER }));
}

/** Safety net: a lead left in_flight with no call in the last 2h (rep closed the tab mid-call and
 *  never dispositioned) goes back to the queue without consuming an attempt. Runs before each burst. */
export function sweepStuckLeads() {
  return q(`UPDATE leads l SET status = 'queued'
            WHERE l.status = 'in_flight'
              AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id AND c.started_at > now() - interval '2 hours')`);
}
