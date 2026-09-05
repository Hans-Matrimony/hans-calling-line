import express from 'express';
import multer from 'multer';
import { requireAuth } from '../auth.js';
import { importCsv } from '../lib/import.js';
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
           (SELECT count(*)::int FROM leads WHERE status IN ('queued', 'later'))                            AS queued
    FROM calls WHERE disposition IS DISTINCT FROM 'cancelled'`);
  res.json(s);
});
