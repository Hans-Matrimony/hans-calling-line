import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { q, transaction } from '../db/pool.js';
import { normalizePhone } from '../lib/import.js';
import { resolveLead, segmentFor } from '../lib/countries.js';
import { emitToUser } from '../io.js';
export const router = express.Router();
router.use((req, res, next) => {
  const secret = process.env.CRM_QUEUE_TOKEN;
  if (!secret || secret.length < 32) return res.status(503).json({ error: 'CRM queue integration is not configured.' });
  const actual = Buffer.from(req.get('Authorization') ?? '');
  const expected = Buffer.from('Bearer ' + secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});
// Server-to-server only. Never dial, transfer ownership or reset existing attempts/status.
router.post('/queue', async (req, res) => {
  const email = String(req.body?.repEmail ?? '').trim().toLowerCase();
  const entries = req.body?.leads;
  if (!email || !Array.isArray(entries) || !entries.length || entries.length > 100) return res.status(400).json({ error: 'Provide repEmail and 1-100 leads.' });
  const parsed = [];
  for (const entry of entries) {
    const key = String(entry?.externalId ?? '');
    const phone = normalizePhone(entry?.phone, 'india');
    const location = resolveLead({ phone });
    if (!/^[a-zA-Z0-9:_-]{1,120}$/.test(key) || !phone || !/^\+[1-9]\d{7,14}$/.test(phone) || !location) return res.status(422).json({ error: 'Invalid lead ID, phone or unsupported country. Nothing was queued.' });
    parsed.push({ key, phone, location, name: String(entry.name ?? '').trim().slice(0, 200) });
  }
  const result = await transaction(async () => {
    const { rows: [rep] } = await q("SELECT id FROM users WHERE lower(email) = $1 AND role = 'rep' AND active = true FOR UPDATE", [email]);
    if (!rep) return null;
    let queued = 0, existing = 0;
    for (const lead of parsed) {
      const { rows: [linked] } = await q('SELECT lead_id FROM crm_queue_links WHERE rep_id = $1 AND external_id = $2', [rep.id, lead.key]);
      if (linked) { existing++; continue; }
      const { rows: [same] } = await q('SELECT id FROM leads WHERE user_id = $1 AND (phone = $2 OR $2 = ANY(phones)) ORDER BY id LIMIT 1', [rep.id, lead.phone]);
      let id = same?.id;
      if (id) existing++;
      else {
        const { rows: [added] } = await q("INSERT INTO leads (name, phone, phones, user_id, source, segment, utc_offset, timezone, extra) VALUES ($1, $2, ARRAY[$2], $3, 'crm', $4, $5, $6, $7::jsonb) RETURNING id", [lead.name || null, lead.phone, rep.id, segmentFor(lead.location.region), lead.location.offset, lead.location.timezone, JSON.stringify({ crmExternalId: lead.key })]);
        id = added.id; queued++;
      }
      await q('INSERT INTO crm_queue_links(rep_id, external_id, lead_id) VALUES ($1, $2, $3)', [rep.id, lead.key, id]);
    }
    return { repId: rep.id, queued, existing };
  });
  if (!result) return res.status(422).json({ error: 'No active dialer rep exists with this email.' });
  emitToUser(result.repId, 'queue:changed', {});
  res.json({ queued: result.queued, existing: result.existing });
});
