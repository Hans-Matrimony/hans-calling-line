import express from 'express';
import multer from 'multer';
import { requireAuth } from '../auth.js';
import { importCsv } from '../lib/import.js';
import { peekLeads } from '../lib/queue.js';
import { q } from '../db/pool.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
export const router = express.Router();

router.post('/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'attach a CSV as multipart field "file"' });
  res.json(await importCsv(req.file.buffer));
});

// Counters for the dialer screen (plan s10). "Today" is the DB day (UTC on Railway); the
// 14:00-23:00 IST shift sits inside one UTC day so this is fine for the MVP.
router.get('/stats', requireAuth, async (_req, res) => {
  const { rows: [s] } = await q(`
    SELECT count(*) FILTER (WHERE started_at >= date_trunc('day', now()))::int                              AS dialed_today,
           count(*) FILTER (WHERE started_at >= date_trunc('day', now()) AND disposition = 'connected')::int AS connected_today,
           coalesce(sum(duration) FILTER (WHERE started_at >= date_trunc('day', now()) AND answered_at IS NOT NULL), 0)::int AS talk_seconds_today,
           (SELECT count(*)::int FROM leads WHERE status IN ('queued', 'later'))                            AS queued
    FROM calls WHERE disposition IS DISTINCT FROM 'cancelled'`);
  res.json(s);
});

// "Up next": what the next burst would pick, in order. utc_offset lets the client show the lead's local clock.
router.get('/next', requireAuth, async (req, res) => {
  const n = Math.min(10, Math.max(1, Number(req.query.n) || 5));
  res.json(await peekLeads(n));
});

// Today's activity, oldest first, so the feed survives a page reload.
router.get('/activity', requireAuth, async (_req, res) => {
  const { rows } = await q(`
    SELECT c.id AS "callId", c.lead_id AS "leadId", l.name, l.phone, l.country, c.from_number AS "from",
           c.started_at AS "startedAt", c.answered_at IS NOT NULL AS answered, c.duration, c.disposition, c.notes,
           b.winner_call_id IS NOT NULL AS "burstWon"
    FROM calls c JOIN leads l ON l.id = c.lead_id LEFT JOIN bursts b ON b.id = c.burst_id
    WHERE c.started_at >= date_trunc('day', now())
    ORDER BY c.started_at ASC, c.id ASC`);
  res.json(rows);
});
