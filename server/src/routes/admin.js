// The admin dashboard's API (docs/ADMIN-DASHBOARD.md). Every route is admin-only and reads across all
// reps. The numbers come from lib/metrics.js; this file only parses the filter row and shapes JSON.
import express from 'express';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '../auth.js';
import { q } from '../db/pool.js';
import { repUp, activeBurst } from '../state.js';
import * as m from '../lib/metrics.js';
import { readiness, listFromNumbers } from '../lib/queue.js';
import { status as hubspotStatus } from '../lib/hubspot.js';
import { hubspotPanel } from './leads.js';
import { balance } from '../lib/costs.js';
import { getSettings, setSetting, DEFAULTS } from '../lib/settings.js';
import { cancelOpenLegs } from '../lib/burst.js';
import { hangup } from '../plivo.js';
import { pokeAdmins } from '../io.js';
import { RECORD_CALLS, RECORD_BEEP } from '../config.js';

export const router = express.Router();
router.use(requireAdmin);

const int = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null);

router.get('/summary', async (req, res) => {
  const f = m.period(req.query);
  res.json({ ...f, ...(await m.summary(f)) });
});
router.get('/by-day', async (req, res) => res.json(await m.byDay(m.period(req.query), Math.min(60, Math.max(1, Number(req.query.days) || 14)))));
router.get('/outcomes', async (req, res) => res.json(await m.outcomes(m.period(req.query))));

/** Who is doing what right now, from the server's own memory of rep legs and bursts. */
async function live() {
  const { rows: users } = await q(`SELECT id, email FROM users WHERE role = 'rep' AND active ORDER BY email`);
  const ids = users.map((u) => activeBurst.get(u.id)).filter((b) => b && b !== 0);
  const { rows: legs } = ids.length ? await q(`
    SELECT b.id AS burst_id, c.id AS call_id, c.answered_at, c.disposition, coalesce(c.to_number, l.phone) AS phone, l.name,
           b.winner_call_id = c.id AS winner
    FROM bursts b JOIN calls c ON c.burst_id = b.id JOIN leads l ON l.id = c.lead_id
    WHERE b.id = ANY($1) AND c.disposition IS NULL`, [ids]) : { rows: [] };
  return users.map((u) => {
    const burstId = activeBurst.get(u.id) || null;
    const mine = legs.filter((x) => x.burst_id === burstId);
    const winner = mine.find((x) => x.winner) ?? mine.find((x) => x.answered_at);
    const state = winner ? 'on_call' : mine.length ? 'ringing' : repUp.has(u.id) ? 'idle' : 'off';
    return { id: u.id, email: u.email, audio: repUp.has(u.id), state,
      with: winner ? { name: winner.name, phone: winner.phone, since: winner.answered_at } : mine[0] ? { name: mine[0].name, phone: mine[0].phone } : null };
  });
}
router.get('/live', async (_req, res) => res.json(await live()));

router.get('/reps', async (req, res) => {
  const f = m.period(req.query);
  const [rows, now] = await Promise.all([m.reps(f), live()]);
  const hs = hubspotStatus();
  res.json(rows.map((r) => ({ ...r, now: now.find((n) => n.id === r.id) ?? null, hubspot: hs.configured ? (r.hubspot_mapped ? 'mapped' : 'not mapped') : 'off' })));
});

router.get('/reps/:id', async (req, res) => {
  const id = int(req.params.id);
  const { rows: [u] } = id ? await q('SELECT id, email, role, active FROM users WHERE id = $1', [id]) : { rows: [] };
  if (!u) return res.status(404).json({ error: 'no such rep' });
  const f = { ...m.period(req.query), rep: id };
  const [sum, hours, countries, queue, ready, hubspot, recent, now] = await Promise.all([
    m.summary(f), m.byHour(f), m.byCountry(f), m.queueOf(id), readiness(id), hubspotPanel(id), m.calls(f, { limit: 20 }), live(),
  ]);
  res.json({ rep: u, ...f, ...sum, byHour: hours, byCountry: countries, queue, readiness: ready, hubspot, recent: recent.rows, now: now.find((n) => n.id === id) ?? null });
});

router.get('/calls', async (req, res) => {
  const f = m.period(req.query);
  res.json({ ...f, ...(await m.calls(f, { ...req.query, offset: (Math.max(1, Number(req.query.page) || 1) - 1) * 100 })) });
});

const csv = (rows, cols) => {
  const esc = (v) => { const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
};
router.get('/calls.csv', async (req, res) => {
  const f = m.period(req.query);
  const { rows } = await m.calls(f, { ...req.query, limit: 10000 });
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="calls-${f.from}-to-${f.to}.csv"`);
  res.send(csv(rows, ['started_at', 'rep', 'name', 'phone', 'from_number', 'country', 'segment', 'ring_secs', 'talk_secs', 'disposition', 'sub_outcome', 'reason', 'notes', 'wrap_secs', 'recording_status', 'cost', 'hubspot_call_id']));
});

router.get('/leads', async (req, res) => {
  const f = m.period(req.query);
  res.json(await m.leads(f, { ...req.query, offset: (Math.max(1, Number(req.query.page) || 1) - 1) * 100 }));
});
router.get('/leads/:id', async (req, res) => {
  const lead = int(req.params.id) ? await m.leadDetail(int(req.params.id)) : null;
  if (!lead) return res.status(404).json({ error: 'no such lead' });
  res.json(lead);
});

router.get('/caller-ids', async (_req, res) => {
  const [nums, { rows: ever }] = await Promise.all([listFromNumbers(), q('SELECT from_number, count(*)::int AS ever FROM calls GROUP BY 1')]);
  res.json(nums.map((n) => ({ ...n, ever: ever.find((e) => e.from_number === n.number)?.ever ?? 0 })));
});

router.get('/wallet', async (_req, res) => {
  const today = m.istToday();
  const [bal, d1, d7, d30, byDay] = await Promise.all([
    balance().catch((e) => ({ error: e.message })),
    m.wallet(today, today), m.wallet(m.addDays(today, -6), today), m.wallet(m.addDays(today, -29), today), m.walletByDay(m.addDays(today, -29), today),
  ]);
  res.json({ balance: bal, periods: { today: d1, d7, d30 }, byDay });
});

/** What the dashboard should say about its own plumbing. Read-only. */
router.get('/health', async (_req, res) => {
  const { rows: [c] } = await q('SELECT max(received_at) AS last_cost, count(*)::int AS costs FROM telnyx_costs');
  const { rows: [r] } = await q(`SELECT count(*) FILTER (WHERE recording_status = 'saved')::int AS saved, count(*) FILTER (WHERE recording_status = 'error')::int AS errors FROM calls`);
  const { rows: [h] } = await q(`SELECT count(*) FILTER (WHERE hubspot_call_id IS NOT NULL)::int AS logged, count(*) FILTER (WHERE hubspot_error IS NOT NULL)::int AS failed FROM calls`);
  res.json({ recording: { on: RECORD_CALLS, beep: RECORD_BEEP, ...r }, cost: { lastAt: c.last_cost, rows: c.costs }, hubspot: { ...hubspotStatus(), ...h }, settings: await getSettings() });
});

router.get('/settings', async (_req, res) => res.json(await getSettings()));
router.patch('/settings', async (req, res) => {
  const b = req.body ?? {};
  for (const k of Object.keys(b)) {
    if (!(k in DEFAULTS)) return res.status(400).json({ error: 'unknown setting ' + k });
    if (typeof b[k] !== typeof DEFAULTS[k]) return res.status(400).json({ error: k + ' must be ' + typeof DEFAULTS[k] });
    await setSetting(k, b[k]);
  }
  pokeAdmins('settings');
  res.json(await getSettings());
});

// --- Users: add and remove reps from the dashboard ------------------------------------------

router.get('/users', async (_req, res) => {
  const { rows } = await q(`
    SELECT u.id, u.email, u.role, u.active, u.created_at, u.deactivated_at, u.hubspot_owner_id IS NOT NULL AS hubspot_mapped,
           (SELECT count(*)::int FROM leads WHERE user_id = u.id AND status IN ('queued', 'later')) AS in_queue,
           (SELECT count(*)::int FROM calls c JOIN bursts b ON b.id = c.burst_id
             WHERE b.user_id = u.id AND c.disposition IS DISTINCT FROM 'cancelled' AND c.started_at > now() - interval '7 days') AS dials_7d
    FROM users u ORDER BY u.active DESC, u.role, u.email`);
  res.json(rows.map((u) => ({ ...u, audio: repUp.has(u.id) })));
});

router.post('/users', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const role = req.body?.role === 'admin' ? 'admin' : 'rep';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email — it should be their HubSpot login email.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password needs at least 8 characters.' });
  // Re-adding a removed rep brings them back with the new password; an active one gets a reset.
  const { rows: [u] } = await q(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true, deactivated_at = NULL
     RETURNING id, email, role, active`, [email, await bcrypt.hash(password, 10), role]);
  pokeAdmins('users');
  res.json(u);
});

router.delete('/users/:id', async (req, res) => {
  const id = int(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad user id' });
  if (id === req.userId) return res.status(400).json({ error: 'You cannot remove your own login.' });
  const { rows: [u] } = await q('SELECT id, telnyx_session_call_id FROM users WHERE id = $1', [id]);
  if (!u) return res.status(404).json({ error: 'no such user' });
  // Cut them off cleanly: whatever is ringing or bridged for them ends, their audio leg drops.
  const burstId = activeBurst.get(id);
  if (burstId) { await cancelOpenLegs(burstId).catch(() => {}); activeBurst.delete(id); }
  if (u.telnyx_session_call_id) await hangup(u.telnyx_session_call_id);
  repUp.delete(id);
  await q(`UPDATE users SET active = false, deactivated_at = now(), telnyx_session_call_id = NULL WHERE id = $1`, [id]);
  const to = int(req.body?.reassignTo);
  let moved = 0;
  if (to && to !== id) ({ rowCount: moved } = await q(`UPDATE leads SET user_id = $2 WHERE user_id = $1 AND status IN ('queued', 'later')`, [id, to]));
  pokeAdmins('users');
  res.json({ ok: true, moved });
});

router.patch('/users/:id', async (req, res) => {
  const id = int(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad user id' });
  const b = req.body ?? {};
  const sets = []; const vals = [id]; let n = 2;
  if (b.active === true) { sets.push('active = true, deactivated_at = NULL'); }
  if (b.role === 'rep' || b.role === 'admin') { if (id === req.userId && b.role !== 'admin') return res.status(400).json({ error: 'You cannot demote your own login.' }); sets.push(`role = $${n++}`); vals.push(b.role); }
  if (typeof b.password === 'string') { if (b.password.length < 8) return res.status(400).json({ error: 'Password needs at least 8 characters.' }); sets.push(`password_hash = $${n++}`); vals.push(await bcrypt.hash(b.password, 10)); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to change' });
  const { rows: [u] } = await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, email, role, active`, vals);
  if (!u) return res.status(404).json({ error: 'no such user' });
  pokeAdmins('users');
  res.json(u);
});
