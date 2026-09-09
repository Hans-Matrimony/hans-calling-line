// Public playback of a recording by its token: GET /rec/<token>.mp3. No login - HubSpot's timeline
// player and the admin dashboard both use this link. The only secret is the 128-bit token; nulling
// it on the calls row revokes the link. The Telnyx key and Telnyx's expiring links never leave the
// server: we resolve a fresh link and stream the bytes through, Range included so seeking works.
import express from 'express';
import { Readable } from 'node:stream';
import { q } from '../db/pool.js';
import { recordingUrl } from '../lib/recordings.js';

export const router = express.Router();

router.get('/:token.mp3', async (req, res) => {
  const token = String(req.params.token ?? '');
  if (!/^[0-9a-f]{32}$/.test(token)) return res.status(404).end();
  const { rows: [c] } = await q(
    `SELECT id, telnyx_call_id, recording_id, recording_leg_id, recording_status FROM calls WHERE recording_token = $1`, [token]);
  if (!c || c.recording_status !== 'saved') return res.status(404).json({ error: 'no recording for this call' });
  let url = null;
  try { url = await recordingUrl(c); } catch (e) { console.warn('recording lookup', c.id, e.message); }
  if (!url) return res.status(502).json({ error: 'recording not available from Telnyx' });
  const up = await fetch(url, { headers: req.headers.range ? { range: req.headers.range } : {} });
  if (!up.ok) return res.status(502).json({ error: 'telnyx download ' + up.status });
  res.status(up.status); // 200 or 206
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (up.headers.get(h)) res.setHeader(h, up.headers.get(h));
  res.setHeader('content-type', 'audio/mpeg');
  res.setHeader('cache-control', 'private, max-age=0');
  Readable.fromWeb(up.body).pipe(res);
});
