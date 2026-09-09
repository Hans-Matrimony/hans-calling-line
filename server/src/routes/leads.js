import express from 'express';
import multer from 'multer';
import { requireAuth } from '../auth.js';
import { importCsv } from '../lib/import.js';
import { peekLeads, readiness } from '../lib/queue.js';
import { normalizePhone } from '../lib/import.js';
import { q } from '../db/pool.js';
import { pullQueue, pullBeforeRead, status as hubspotStatus, configured as hubspotConfigured } from '../lib/hubspot.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
export const router = express.Router();

// Everything here is the signed-in rep's own leads and calls (PLAN-v2: never shared across the team).
router.post('/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'attach a CSV as multipart field "file"' });
  res.json(await importCsv(req.file.buffer, req.userId));
});

// Counters for the topbar (plan s10). "Today" is the DB day (UTC on Railway); the
// 14:00-23:00 IST shift sits inside one UTC day so this is fine for the MVP.
router.get('/stats', requireAuth, async (req, res) => {
  const { rows: [s] } = await q(`
    SELECT count(*) FILTER (WHERE c.started_at >= date_trunc('day', now()))::int                                AS dialed_today,
           count(*) FILTER (WHERE c.started_at >= date_trunc('day', now()) AND c.disposition = 'connected')::int AS connected_today,
           coalesce(sum(c.duration) FILTER (WHERE c.started_at >= date_trunc('day', now()) AND c.answered_at IS NOT NULL), 0)::int AS talk_seconds_today,
           (SELECT count(*)::int FROM leads WHERE user_id = $1 AND status IN ('queued', 'later'))               AS queued
    FROM calls c JOIN bursts b ON b.id = c.burst_id
    WHERE b.user_id = $1 AND c.disposition IS DISTINCT FROM 'cancelled'`, [req.userId]);
  res.json({ ...s, ...(await readiness(req.userId)), hubspot: await hubspotPanel(req.userId) });
});

/** What the Up next strip needs to tell the truth about the HubSpot inlet: whether it is on, whether it
 *  works, when it last ran, and how much of this rep's queue came in through it. Per-contact rejects stay
 *  in the server log by owner's decision; a broken inlet is a different thing and is always shown. */
export async function hubspotPanel(userId) {
  const st = hubspotStatus();
  if (!st.configured) return { configured: false };
  const { rows: [r] } = await q(
    `SELECT (SELECT hubspot_synced_at FROM users WHERE id = $1) AS "syncedAt",
            count(*) FILTER (WHERE source = 'hubspot' AND status IN ('queued', 'later'))::int AS "inQueue"
     FROM leads WHERE user_id = $1`, [userId]);
  return { configured: true, ok: st.ok, error: st.error, syncedAt: r.syncedAt, inQueue: r.inQueue };
}

// "Up next": what the rep's next dial would pick, in order. utc_offset lets the client show the lead's local clock.
// Pulls from HubSpot first (bounded), so a contact ticked a moment ago is already on the list.
router.get('/next', requireAuth, async (req, res) => {
  const n = Math.min(10, Math.max(1, Number(req.query.n) || 5));
  await pullBeforeRead(req.userId);
  res.json(await peekLeads(req.userId, n));
});

// "Sync now": the fallback for a rep who has just ticked something and does not want to wait. Start
// dialing and Up next both pull on their own, so this is rarely the path that matters.
router.post('/sync', requireAuth, async (req, res) => {
  if (!hubspotConfigured()) return res.status(400).json({ error: 'HubSpot is not connected — HUBSPOT_TOKEN is not set on the server.' });
  try { res.json(await pullQueue(req.userId)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Inline edits from the lead panel (call-card v2). The rep fixes what the sheet got wrong - name,
// company, title, email, LinkedIn, lead source, alternate numbers - and it saves straight to the lead
// so the next attempt (and any export) has it. Scoped to the rep's own lead. Only the keys sent are
// touched; extra merges (a blank never wipes a sibling), and the number in play is always kept in the
// cascade so an edit mid-call can't strand the dialer.
const EXTRA_FIELDS = ['company', 'title', 'email', 'linkedin', 'leadStage'];
router.patch('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad lead id' });
  const { rows: [lead] } = await q('SELECT id, phone, phones, phone_idx FROM leads WHERE id = $1 AND user_id = $2', [id, req.userId]);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const b = req.body ?? {};

  const sets = []; const vals = [id]; let n = 2;
  if ('name' in b) { sets.push(`name = $${n}`); vals.push(String(b.name ?? '').trim() || null); n++; }
  const patch = {};
  for (const k of EXTRA_FIELDS) if (k in b) patch[k] = String(b[k] ?? '').trim().slice(0, 200);
  if (Object.keys(patch).length) { sets.push(`extra = extra || $${n}::jsonb`); vals.push(JSON.stringify(patch)); n++; }
  if (sets.length) await q(`UPDATE leads SET ${sets.join(', ')} WHERE id = $1`, vals);

  // Alternate numbers: the client sends the full desired list, primary first. Normalise to +E.164,
  // drop unparseable ones, dedupe, and make sure the number currently being dialled survives.
  if (Array.isArray(b.phones)) {
    const norm = [];
    for (const raw of b.phones) { const p = normalizePhone(String(raw ?? '')); if (p && !norm.includes(p)) norm.push(p); }
    const inPlay = lead.phones?.[(lead.phone_idx || 1) - 1] ?? lead.phone;
    if (inPlay && !norm.includes(inPlay)) norm.unshift(inPlay);
    if (norm.length) await q(
      `UPDATE leads SET phones = $2, phone_idx = GREATEST(1, coalesce(array_position($2, phone), 1)),
         phone = coalesce($2[array_position($2, phone)], phone) WHERE id = $1`, [id, norm]);
  }

  const { rows: [r] } = await q('SELECT name, extra, phones, phone_idx AS "phoneIdx" FROM leads WHERE id = $1', [id]);
  res.json(r);
});

// Every past call for one lead (call-card v2 "Show history"): date, outcome, note - so the rep can read
// the whole relationship without leaving the dialer. Scoped to the rep's own lead.
router.get('/:id/history', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad lead id' });
  const { rows } = await q(`
    SELECT c.id AS "callId", c.started_at AS "at", c.answered_at IS NOT NULL AS answered, c.duration,
           c.disposition, c.sub_outcome AS "subOutcome", c.reason, c.notes
    FROM calls c JOIN leads l ON l.id = c.lead_id
    WHERE c.lead_id = $1 AND l.user_id = $2 AND c.disposition IS NOT NULL
    ORDER BY c.started_at DESC LIMIT 50`, [id, req.userId]);
  res.json(rows);
});

// Today's activity, oldest first, so the feed survives a page reload.
router.get('/activity', requireAuth, async (req, res) => {
  const { rows } = await q(`
    SELECT c.id AS "callId", c.lead_id AS "leadId", l.name, coalesce(c.to_number, l.phone) AS phone, l.country, c.from_number AS "from",
           c.started_at AS "startedAt", c.answered_at IS NOT NULL AS answered, c.duration, c.disposition, c.sub_outcome AS "subOutcome", c.notes,
           b.winner_call_id IS NOT NULL AS "burstWon"
    FROM calls c JOIN leads l ON l.id = c.lead_id JOIN bursts b ON b.id = c.burst_id
    WHERE b.user_id = $1 AND c.started_at >= date_trunc('day', now())
    ORDER BY c.started_at ASC, c.id ASC`, [req.userId]);
  res.json(rows);
});
