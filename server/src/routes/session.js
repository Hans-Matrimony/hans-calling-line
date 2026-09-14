import express from 'express';
import { requireAuth } from '../auth.js';
import { q, transaction } from '../db/pool.js';
import { emitToUser, pokeAdmins } from '../io.js';
import { queueCallSync } from '../lib/hubspotJobs.js';
import { snapshot, reserveBurst } from '../lib/sessionState.js';
import { repUp, activeBurst } from '../state.js';
import { claimLeads, claimManual, releaseLead, pickFromNumber, sweepStuckLeads, listFromNumbers } from '../lib/queue.js';
import { normalizePhone } from '../lib/import.js';
import { startBurst, cancelOpenLegs, stopRepAudio, leadCard, burstLegs, previewCard } from '../lib/burst.js';
import { dialRep, hangup, ensureCredential, webrtcToken, sipDestination, sendDtmf } from '../telnyx.js';
import { pullBeforeRead } from '../lib/hubspot.js';
import { LEGS_PER_BURST } from '../config.js';

export const router = express.Router();
router.use(requireAuth);

// Rep-facing strings, shown verbatim in the UI: plain words, never "leg", "in flight", "disposition".
const MSG = {
  audioOff: 'Audio is not connected — press Connect in the top bar.',
  busy: 'A call is already ringing or waiting for its outcome.',
  capped: 'Every caller ID has hit its daily cap — resets at 00:00 UTC (05:30 IST).',
  nobodyDue: 'Nobody is due right now.',
  noHangup: 'No call to hang up.',
};

router.get('/state', async (req, res) => {
  const { rows: [u] } = await q('SELECT phone, rep_leg_destination, telnyx_session_call_id, audio_mode, sip_username, rep_connected FROM users WHERE id = $1', [req.userId]);
  res.json({ ...u, repUp: u.rep_connected, ...(await snapshot(req.userId)) });
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

  await q('UPDATE users SET rep_connected = false, telnyx_session_call_id = NULL WHERE id = $1', [req.userId]);
  repUp.delete(req.userId);
  if (u.telnyx_session_call_id) await hangup(u.telnyx_session_call_id);
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

/** One burst at a time per rep. Plants a claim token (0) synchronously, so a double-click or a second tab
 *  that lands while this request is still claiming leads is refused instead of ringing four people. */
async function guardBurst(req, res) {
  let error;
  try { error = await reserveBurst(req.userId); }
  catch (e) { if (activeBurst.get(req.userId) === 0) activeBurst.delete(req.userId); throw e; }
  if (error) { res.status(409).json({ error: MSG[error] }); return false; }
  return true;
}
/** Give the token back and answer. A real burst id (startBurst succeeded) is never touched here. */
function refuse(req, res, code, error) {
  if (activeBurst.get(req.userId) === 0) activeBurst.delete(req.userId);
  res.status(code).json({ error });
}

// One burst from the rep's own queue: body.legs 1 = Auto dial (one lead), otherwise LEGS_PER_BURST = Burst dial.
// Optional body.segment narrows the queue.
router.post('/burst', async (req, res) => {
  if (!(await guardBurst(req, res))) return;
  try {
    if (!(await listFromNumbers()).some((n) => n.available)) return refuse(req, res, 409, MSG.capped); // refuse before claiming: nothing to cool down
    await pullBeforeRead(req.userId); // a contact ticked seconds ago is dialable on this very press
    await sweepStuckLeads();
    const legs = req.body?.legs === 1 ? 1 : LEGS_PER_BURST;
    const leads = await claimLeads(req.userId, legs, req.body?.segment ?? null);
    if (!leads.length) return refuse(req, res, 404, MSG.nobodyDue);
    // Burst dial with one lead only: say who is held back (the loser's 10-min cooldown, usually) instead of looking broken.
    const heldBack = leads.length < legs ? (await q(
      `SELECT name, phone, next_call_at AS "at" FROM leads
       WHERE user_id = $1 AND status = 'queued' AND next_call_at > now() AND next_call_at < now() + interval '15 minutes'
       ORDER BY next_call_at LIMIT 2`, [req.userId])).rows : [];
    res.json(await startBurst(req.userId, leads, null, { heldBack }));
  } catch (e) { refuse(req, res, 502, e.message); }
});

// Manual dialer: the rep pastes a number and picks the caller ID. Dialled as the rep's own lead for
// that number (queue.js claimManual), so the call, card and disposition flow are identical.
router.get('/from-numbers', async (_req, res) => res.json(await listFromNumbers()));

router.post('/dial', async (req, res) => {
  if (!(await guardBurst(req, res))) return;
  try {
    const raw = String(req.body?.to ?? '').trim();
    const to = normalizePhone(raw); // no region: +E.164 or 00... required
    if (!to) return refuse(req, res, 400, `Could not read "${raw}" — use the country code, e.g. +14155550123.`);
    const from = String(req.body?.from ?? '');
    const chosen = (await listFromNumbers()).find((n) => n.number === from);
    if (!chosen) return refuse(req, res, 400, 'Choose a caller ID.');
    if (!chosen.available) return refuse(req, res, 400, 'This caller ID has hit its daily cap — choose another.');

    // The rep's own lead that carries this number, moved onto it; a number nobody holds becomes a
    // plain manual lead. Either way startBurst dials the row's `phone`, which is the number typed.
    const lead = await claimManual(req.userId, to);
    res.json(await startBurst(req.userId, [lead], from));
  } catch (e) { refuse(req, res, 502, e.message); }
});

// Handset dialpad while on a call: tones go out on the rep leg, so the lead's side hears them.
router.post('/dtmf', async (req, res) => {
  const digits = String(req.body?.digits ?? '').replace(/[^0-9*#]/g, '').slice(0, 32);
  if (!digits) return res.status(400).json({ error: 'digits 0-9 * # only' });
  const { rows: [u] } = await q('SELECT telnyx_session_call_id FROM users WHERE id = $1', [req.userId]);
  if (!activeBurst.get(req.userId) || !u?.telnyx_session_call_id) return res.status(409).json({ error: 'Dialpad works only while a call is live.' });
  try { await sendDtmf(u.telnyx_session_call_id, digits); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Red call button: drop whatever is ringing or live for this rep. A live lead still needs its outcome.
router.post('/hangup-lead', async (req, res) => {
  const burstId = activeBurst.get(req.userId) || null;
  // The live call: by burst when we have one, else the rep's latest answered call with no outcome
  // (server restarted, or the rep leg dropped and the burst was cleared) - never a dead 409 while a card is up.
  const { rows: [b] } = burstId
    ? await q(`SELECT c.id, c.lead_id, c.telnyx_call_id, EXTRACT(EPOCH FROM (now() - c.answered_at))::int AS dur
               FROM bursts b JOIN calls c ON c.id = b.winner_call_id WHERE b.id = $1 AND c.disposition IS NULL`, [burstId])
    : await q(`SELECT c.id, c.lead_id, c.telnyx_call_id, EXTRACT(EPOCH FROM (now() - c.answered_at))::int AS dur
               FROM calls c JOIN bursts b ON b.id = c.burst_id
               WHERE b.user_id = $1 AND c.answered_at IS NOT NULL AND c.disposition IS NULL ORDER BY c.started_at DESC LIMIT 1`, [req.userId]);
  if (b?.telnyx_call_id) {
    await hangup(b.telnyx_call_id);
    // Settle the duration now and move the UI to 'ended' without waiting on the hangup webhook, so the red button
    // never lingers and a reload right after shows the outcome step. The webhook's onHangup coalesces the same value.
    await q('UPDATE calls SET duration = coalesce(duration, $2) WHERE id = $1', [b.id, b.dur ?? 0]);
    emitToUser(req.userId, 'call:ended', { callId: b.id, leadId: b.lead_id, duration: b.dur ?? 0, cause: 'rep_hangup' });
    return res.json({ ok: true, live: true });
  }
  if (!burstId) return res.status(409).json({ error: MSG.noHangup });
  await cancelOpenLegs(burstId);
  const legs = await burstLegs(burstId);
  activeBurst.delete(req.userId);
  await stopRepAudio(req.userId); // nothing is ringing any more: silence the tick
  emitToUser(req.userId, 'burst:ended', { burstId, result: 'cancelled', legs });
  pokeAdmins('live');
  res.json({ ok: true, live: false });
});

// Outcome after the call (plan s7, call-card v2). The rep presses one of seven tiles; the client maps
// them onto the four dispositions and sends the tile itself as `subOutcome`. Two sub-outcomes book a
// time (follow_up / callback) - a connect that comes back, still counted as a connect. `reason` is the
// optional chip on Not interested. name/company let the rep put a face on a manual "unknown" number.
const SUB_OUTCOMES = ['interested', 'follow_up', 'callback', 'not_interested', 'not_qualified'];
const NEEDS_TIME = new Set(['follow_up', 'callback']);
router.post('/disposition', async (req, res) => {
  const { callId, outcome, subOutcome, reason, laterAt, notes, name, company } = req.body ?? {};
  if (!['connected', 'no_answer', 'later', 'invalid'].includes(outcome)) return res.status(400).json({ error: 'Choose an outcome.' });
  const sub = subOutcome ? String(subOutcome) : null;
  if (sub && !SUB_OUTCOMES.includes(sub)) return res.status(400).json({ error: 'unknown outcome ' + sub });
  if (sub && outcome !== 'connected') return res.status(400).json({ error: 'that outcome does not take a sub-outcome' });
  const needsTime = outcome === 'later' || (sub && NEEDS_TIME.has(sub));
  if (needsTime && !laterAt) return res.status(400).json({ error: 'Choose a date and time first.' });
  if (needsTime && (!Number.isFinite(new Date(laterAt).getTime()) || new Date(laterAt).getTime() < Date.now() - 60_000)) return res.status(400).json({ error: 'That time has already passed.' });
  const result = await transaction(async () => {
    const { rows: [c] } = await q(
      'SELECT c.id, c.lead_id, c.burst_id, c.disposition FROM calls c JOIN bursts b ON b.id = c.burst_id WHERE c.id = $1 AND b.user_id = $2 FOR UPDATE OF c',
      [callId, req.userId]);
    if (!c) return null;
    if (c.disposition) return { call: c, lead: (await q('SELECT status, next_call_at, retry_minutes FROM leads WHERE id = $1', [c.lead_id])).rows[0] };
    const note = String(notes ?? '').trim().slice(0, 2000) || null;
    const reasonVal = reason ? String(reason).trim().slice(0, 120) || null : null;
    // A face for a manual "unknown" number: save what the rep typed so the next attempt has a real card.
    // extra || jsonb merges, so a blank company never wipes an existing one.
    const nm = String(name ?? '').trim().slice(0, 120);
    const co = String(company ?? '').trim().slice(0, 120);
    if (nm || co) await q(
      `UPDATE leads SET name = coalesce(NULLIF($2, ''), name), extra = extra || $3::jsonb WHERE id = $1`,
      [c.lead_id, nm, JSON.stringify(co ? { company: co } : {})]);
    // Idempotent: a repeat submit for the same call (double-click, second tab) is a no-op, not a second attempt.
    // dispositioned_at - (answered_at + duration) is the rep's wrap-up time (manual Next makes it worth measuring).
    const { rowCount } = await q(
      'UPDATE calls SET disposition = $2, sub_outcome = $4, reason = $5, notes = $3, dispositioned_at = now() WHERE id = $1 AND disposition IS NULL',
      [c.id, outcome, note, sub, reasonVal]);
    // A booked connect (follow_up / callback) passes its time to releaseLead so the lead comes back; a plain
    // connect passes none and leaves the queue. NEEDS_TIME is what routes the two branches in queue.js.
    if (rowCount) {
      const { rows: [lead] } = await releaseLead(c.lead_id, outcome, (needsTime ? laterAt : null) ?? null);
      await queueCallSync(c.id);
      return { call: c, lead };
    }
  });
  if (!result) return res.status(404).json({ error: 'call not found' });
  if (activeBurst.get(req.userId) === result.call.burst_id) activeBurst.delete(req.userId);
  pokeAdmins('call');
  res.json({ ok: true, status: result.lead.status, nextCallAt: result.lead.next_call_at, retryMinutes: result.lead.retry_minutes });
});
