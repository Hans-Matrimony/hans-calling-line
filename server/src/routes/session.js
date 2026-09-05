import express from 'express';
import { requireAuth } from '../auth.js';
import { q } from '../db/pool.js';
import { emitToUser } from '../io.js';
import { repUp, activeBurst } from '../state.js';
import { claimLeads, releaseLead, pickFromNumber, sweepStuckLeads, listFromNumbers } from '../lib/queue.js';
import { resolveLead, segmentFor } from '../lib/countries.js';
import { normalizePhone } from '../lib/import.js';
import { startBurst, cancelOpenLegs, stopRepAudio } from '../lib/burst.js';
import { dialRep, hangup, ensureCredential, webrtcToken, sipDestination, sendDtmf } from '../telnyx.js';
import { LEGS_PER_BURST, DAILY_CAP_PER_NUMBER } from '../config.js';

export const router = express.Router();
router.use(requireAuth);

router.get('/state', async (req, res) => {
  const { rows: [u] } = await q('SELECT phone, rep_leg_destination, telnyx_session_call_id, audio_mode, sip_username FROM users WHERE id = $1', [req.userId]);
  res.json({ ...u, repUp: repUp.has(req.userId), burstId: activeBurst.get(req.userId) ?? null });
});

// Browser audio (plan s9): 24h JWT for the softphone, minted from the user's telephony credential.
router.post('/webrtc-token', async (req, res) => {
  const { rows: [u] } = await q('SELECT id, email, telnyx_credential_id, sip_username FROM users WHERE id = $1', [req.userId]);
  const cred = await ensureCredential(u);
  if (cred.fresh) {
    await q('UPDATE users SET telnyx_credential_id = $2, sip_username = $3 WHERE id = $1', [u.id, cred.id, cred.sip_username]);
    await new Promise((r) => setTimeout(r, 5000)); // Telnyx: credential needs a few seconds before its token logs in
  }
  res.json({ token: await webrtcToken(cred.id), sipUsername: cred.sip_username });
});

// Connect me (plan s8): ring the rep once; the leg stays open all session.
// mode 'phone' rings his handset, 'browser' rings the WebRTC softphone (which auto-answers).
router.post('/connect', async (req, res) => {
  const mode = req.body?.mode === 'browser' ? 'browser' : 'phone';
  const raw = String(req.body?.phone ?? '').trim();
  const phone = raw ? normalizePhone(raw, 'india') : ''; // rep is in India: bare 10 digits -> +91
  if (mode === 'phone' && raw && !phone) return res.status(400).json({ error: `could not parse phone "${raw}" - use +E.164, e.g. +9198xxxxxxxx` });
  if (phone) await q('UPDATE users SET phone = $2 WHERE id = $1', [req.userId, phone]);

  const { rows: [u] } = await q('SELECT phone, sip_username, telnyx_session_call_id FROM users WHERE id = $1', [req.userId]);
  const dest = mode === 'browser' ? (u.sip_username && sipDestination(u.sip_username)) : u.phone;
  if (!dest) return res.status(400).json({ error: mode === 'browser' ? 'softphone not provisioned yet (request a token first)' : 'enter your phone number first' });
  await q('UPDATE users SET audio_mode = $2, rep_leg_destination = $3 WHERE id = $1', [req.userId, mode, dest]);

  if (u.telnyx_session_call_id) await hangup(u.telnyx_session_call_id); // stale leg from an earlier session
  const from = await pickFromNumber('india');
  if (!from) return res.status(400).json({ error: 'no caller ID configured (FROM_NUMBER_* in .env)' });
  const ccid = await dialRep({ to: dest, from, userId: req.userId });
  await q('UPDATE users SET telnyx_session_call_id = $2 WHERE id = $1', [req.userId, ccid]);
  emitToUser(req.userId, 'rep:ringing', { mode });
  res.json({ ok: true, mode });
});

router.post('/disconnect', async (req, res) => {
  const { rows: [u] } = await q('SELECT telnyx_session_call_id FROM users WHERE id = $1', [req.userId]);
  if (u.telnyx_session_call_id) await hangup(u.telnyx_session_call_id);
  res.json({ ok: true });
});

function guardBurst(req, res) {
  if (!repUp.has(req.userId)) { res.status(409).json({ error: 'your audio leg is not connected' }); return false; }
  if (activeBurst.has(req.userId)) { res.status(409).json({ error: 'a call is already in flight (disposition pending?)' }); return false; }
  return true;
}

// Start calling: one burst of LEGS_PER_BURST different leads. Optional body.segment narrows the queue.
router.post('/burst', async (req, res) => {
  if (!guardBurst(req, res)) return;
  await sweepStuckLeads();
  const leads = await claimLeads(LEGS_PER_BURST, req.body?.segment ?? null);
  if (!leads.length) return res.status(404).json({ error: 'no eligible leads right now' });
  try { res.json(await startBurst(req.userId, leads)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Manual dialer: the rep pastes a number and picks the caller ID. Saved as a lead (same
// 'manual-<phone>' id the CSV import uses) so the call, card and disposition flow are identical.
router.get('/from-numbers', async (_req, res) => res.json(await listFromNumbers()));

router.post('/dial', async (req, res) => {
  if (!guardBurst(req, res)) return;
  const raw = String(req.body?.to ?? '').trim();
  const to = normalizePhone(raw); // no region: +E.164 or 00... required
  if (!to) return res.status(400).json({ error: `could not parse "${raw}" - use +E.164, e.g. +14155550123` });
  const from = String(req.body?.from ?? '');
  const numbers = await listFromNumbers();
  const chosen = numbers.find((n) => n.number === from);
  if (!chosen) return res.status(400).json({ error: 'pick a caller ID' });
  if (!chosen.available) return res.status(400).json({ error: `${from} has hit its ${DAILY_CAP_PER_NUMBER}/day cap` });

  const resolved = resolveLead({ country: null, phone: to });
  const { rows: [lead] } = await q(
    `INSERT INTO leads (hubspot_contact_id, phone, utc_offset, segment, status)
     VALUES ($1, $2, $3, $4, 'in_flight')
     ON CONFLICT (hubspot_contact_id) DO UPDATE SET status = 'in_flight' RETURNING *`,
    ['manual-' + to, to, resolved?.offset ?? null, segmentFor(resolved?.region)]);
  try { res.json(await startBurst(req.userId, [lead], from)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Handset dialpad while on a call: tones go out on the rep leg, so the lead's side hears them.
router.post('/dtmf', async (req, res) => {
  const digits = String(req.body?.digits ?? '').replace(/[^0-9*#]/g, '').slice(0, 32);
  if (!digits) return res.status(400).json({ error: 'digits 0-9 * # only' });
  const { rows: [u] } = await q('SELECT telnyx_session_call_id FROM users WHERE id = $1', [req.userId]);
  if (!activeBurst.has(req.userId) || !u?.telnyx_session_call_id) return res.status(409).json({ error: 'no call to send tones on' });
  try { await sendDtmf(u.telnyx_session_call_id, digits); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Red call button: drop whatever is ringing or live for this rep. A live lead still needs a disposition.
router.post('/hangup-lead', async (req, res) => {
  const burstId = activeBurst.get(req.userId);
  if (!burstId) return res.status(409).json({ error: 'nothing to hang up' });
  const { rows: [b] } = await q(
    `SELECT c.id, c.lead_id, c.telnyx_call_id, EXTRACT(EPOCH FROM (now() - c.answered_at))::int AS dur
     FROM bursts b JOIN calls c ON c.id = b.winner_call_id WHERE b.id = $1`, [burstId]);
  if (b?.telnyx_call_id) {
    await hangup(b.telnyx_call_id);
    // Move the UI to 'ended' now instead of waiting on the hangup webhook, so the red button never lingers.
    // The webhook's onHangup coalesces the same duration and re-emits; the client handles the repeat.
    emitToUser(req.userId, 'call:ended', { callId: b.id, leadId: b.lead_id, duration: b.dur ?? 0, cause: 'rep_hangup' });
    return res.json({ ok: true, live: true });
  }
  await cancelOpenLegs(burstId);
  activeBurst.delete(req.userId);
  await stopRepAudio(req.userId); // nothing is ringing any more: silence the tick
  emitToUser(req.userId, 'burst:ended', { burstId, result: 'cancelled' });
  res.json({ ok: true, live: false });
});

// Disposition after the call (plan s7). Rep-controlled; this is what unblocks the next burst.
router.post('/disposition', async (req, res) => {
  const { callId, outcome, laterAt, notes } = req.body ?? {};
  if (!['connected', 'no_answer', 'later'].includes(outcome)) return res.status(400).json({ error: 'bad outcome' });
  if (outcome === 'later' && !laterAt) return res.status(400).json({ error: 'laterAt (ISO datetime) required' });
  const { rows: [c] } = await q(
    'SELECT c.id, c.lead_id, c.burst_id FROM calls c JOIN bursts b ON b.id = c.burst_id WHERE c.id = $1 AND b.user_id = $2',
    [callId, req.userId]);
  if (!c) return res.status(404).json({ error: 'call not found' });
  const note = String(notes ?? '').trim().slice(0, 2000) || null;
  // Idempotent: a repeat submit for the same call (double-click, second tab) is a no-op, not a second attempt.
  const { rowCount } = await q('UPDATE calls SET disposition = $2, notes = $3 WHERE id = $1 AND disposition IS NULL', [c.id, outcome, note]);
  if (rowCount) await releaseLead(c.lead_id, outcome, laterAt ?? null);
  if (activeBurst.get(req.userId) === c.burst_id) activeBurst.delete(req.userId);
  res.json({ ok: true });
});
