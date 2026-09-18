import express from 'express';
import { randomUUID } from 'node:crypto';
import { q, withLock, transaction } from '../db/pool.js';
import { emitToUser, pokeAdmins } from '../io.js';
import { onCallCost, refreshCallCost } from '../lib/costs.js';
import { onRecordingSaved, onRecordingError } from '../lib/recordings.js';
import { repUp, activeBurst } from '../state.js';
import { decodeState, encodeState, validWebhook, voiceCall, callbackUrl, conferenceMembers } from '../plivo.js';
import { onLeadEvent, cancelOpenLegs, onRepPlaybackEnded } from '../lib/burst.js';
import { claimManual } from '../lib/queue.js';
import { storeEvent, processEvent, startEventWorker } from '../lib/webhookInbox.js';

export const router = express.Router();
const xml = (value) => '<?xml version="1.0" encoding="UTF-8"?><Response>' + value + '</Response>';
const escape = (value) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const hangupXml = xml('<Hangup/>');
export function conferenceXml(call, joined = false) {
  const rep = call.state.kind === 'rep';
  const room = joined ? call.bridge_room : (rep ? 'rep-' : 'hold-') + call.id;
  return xml('<Conference startConferenceOnEnter="true" endConferenceOnExit="' + (rep ? 'true' : 'false') +
    '" maxMembers="2" timeLimit="14400" enterSound="" exitSound="" callbackMethod="POST" callbackUrl="' +
    escape(callbackUrl('conference', call.id, { stage: joined ? 'joined' : 'hold' })) + '">' + escape(room) + '</Conference>');
}
router.use('/plivo', express.urlencoded({ extended: false, limit: '64kb' }), (req, res, next) => {
  try { if (validWebhook(req)) return next(); } catch (e) { console.warn('plivo signature threw:', req.originalUrl, e.message); return res.sendStatus(403); }
  console.warn('plivo signature rejected:', req.method, req.originalUrl);
  return res.sendStatus(403);
});
// Endpoint application denies direct browser-originated calls: the backend owns every dial.
router.post('/plivo/application', (_req, res) => res.type('text/xml').send(hangupXml));
// Inbound (revert) calls on the caller IDs. A connected rep with room in their conference is
// bridged to the caller at once; otherwise the number joins the rep's queue as a callback lead.
router.post('/plivo/inbound', async (req, res) => {
  try {
    const p = req.body ?? {};
    // Indian carriers hand From over both with and without the leading +: keep the digits only.
    const digits = String(p.From ?? '').replace(/\D/g, '');
    const from = digits ? '+' + digits.replace(/^0+(?=\d)/, '') : '';
    const uuid = p.CallUUID || p.call_uuid;
    console.log('[inbound] from', p.From, '->', from, 'uuid', uuid ? 'yes' : 'MISSING');
  const bye = (text) => res.type('text/xml').send(xml((text ? '<Speak>' + escape(text) + '</Speak>' : '') + '<Hangup/>')); // Plivo's TTS verb is <Speak>, not Twilio's <Say>
    if (!/^\+\d{6,15}$/.test(from) || typeof uuid !== 'string' || !uuid) { console.warn('[inbound] rejected:', JSON.stringify(p).slice(0, 300)); return bye('Sorry, this line could not take your call. Goodbye.'); }
    // Route to the rep this caller knows: whoever dialled them most recently wins, both for the
    // live bridge and for the queued callback; a stranger falls through to the first active rep.
    const known = await q(
      `SELECT b.user_id FROM calls c JOIN bursts b ON b.id = c.burst_id
       JOIN users u ON u.id = b.user_id AND u.active
       WHERE c.to_number = $1 ORDER BY c.started_at DESC LIMIT 1`, [from]);
    const { rows: [rep] } = await q(
      `SELECT id, telnyx_session_call_id FROM users
       WHERE active AND rep_connected AND telnyx_session_call_id IS NOT NULL
       ORDER BY (id = $1) DESC, id LIMIT 1`, [known.rows[0]?.user_id ?? 0]);
    if (rep) {
      const room = 'rep-' + rep.telnyx_session_call_id;
      const members = await conferenceMembers(room).catch(() => null);
      if (members && members.length < 2) {
        const id = randomUUID();
        await q('INSERT INTO plivo_calls(id, call_uuid, state) VALUES ($1, $2, $3)',
          [id, uuid, JSON.stringify({ kind: 'inbound', userId: rep.id, phone: from })]);
        return res.type('text/xml').send(xml('<Conference startConferenceOnEnter="true" endConferenceOnExit="false" maxMembers="2" timeLimit="14400" enterSound="" exitSound="" callbackMethod="POST" callbackUrl="' +
          escape(callbackUrl('conference', id, { stage: 'inbound' })) + '">' + escape(room) + '</Conference>'));
      }
    }
    // Nobody free to take it: queue the callback with the rep the caller knows.
    const owner = known.rows[0] ?? (await q("SELECT id FROM users WHERE active AND role = 'rep' ORDER BY id LIMIT 1")).rows[0];
    if (owner) {
      await transaction(async () => {
        const lead = await claimManual(owner.id, from);
        await q(`UPDATE leads SET status = 'queued', next_call_at = now(), attempt_count = 0 WHERE id = $1`, [lead.id]);
      });
      emitToUser(owner.id, 'queue:changed', {});
      pokeAdmins('queue');
    }
    return bye('Thank you for calling back. Your number has been added to the call-back queue. Goodbye for now.');
  } catch (e) {
    // Plivo punishes a JSON/HTML error page with 8011 "invalid answer XML": always answer in XML.
    console.error('inbound handler failed:', e.message);
    return bye('Sorry, this line could not take your call. Goodbye.');
  }
});
router.post('/plivo/:action', async (req, res) => {
  const action = req.params.action;
  if (!['answer', 'ring', 'hangup', 'fallback', 'bridge', 'conference', 'recording'].includes(action)) return res.sendStatus(404);
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  const call = await voiceCall(id);
  if (!call) return res.sendStatus(404);
  const p = req.body ?? {};
  const uuid = p.CallUUID || p.call_uuid;
  if (typeof uuid !== 'string' || !uuid || (call.call_uuid && call.call_uuid !== uuid)) return res.sendStatus(400);
  const bound = await q('UPDATE plivo_calls SET call_uuid = $2 WHERE id = $1 AND (call_uuid IS NULL OR call_uuid = $2)', [id, uuid]);
  if (!bound.rowCount) return res.sendStatus(409);
  call.call_uuid = uuid;
  // A lead answering after cancellation still counts as abandoned when another lead won.
  const lateAnswer = async () => {
    if (call.state.kind !== 'lead') return;
    const event = { data: { id: 'plivo:' + id + ':late-answer', event_type: 'call.answered', occurred_at: new Date().toISOString(),
      payload: { call_control_id: id, client_state: encodeState(call.state) } } };
    const saved = await storeEvent(event);
    processEvent(saved, handle).catch(error => console.warn('late answer:', error.message));
  };
  if (action === 'answer' || action === 'bridge') {
    if (action === 'answer' && call.cancelled) await lateAnswer();
    let allowed = !call.cancelled && !call.ended_at;
    if (action === 'bridge') {
      const { rowCount } = await q(`SELECT 1 FROM calls c JOIN bursts b ON b.winner_call_id = c.id
        JOIN users u ON u.id = b.user_id JOIN plivo_calls r ON r.id = u.telnyx_session_call_id
        WHERE c.telnyx_call_id = $1 AND c.disposition IS NULL AND c.duration IS NULL AND u.rep_connected
          AND r.ended_at IS NULL AND r.conference_name = $2`, [id, call.bridge_room]);
      allowed = allowed && !!call.bridge_room && rowCount > 0;
    }
    return res.type('text/xml').send(allowed ? conferenceXml(call, action === 'bridge') : hangupXml);
  }
  if (action === 'ring') return res.sendStatus(200);
  const occurred = new Date().toISOString();
  const payload = { call_control_id: id, call_leg_id: uuid, client_state: encodeState(call.state) };
  let type;
  if (action === 'conference') {
    if (p.ConferenceAction !== 'enter' || call.ended_at) return res.sendStatus(200);
    if (call.cancelled) { await lateAnswer(); return res.sendStatus(200); }
    const joined = req.query.stage === 'joined';
    // An inbound caller's enter is valid only in the rep's CURRENT room; a stale one died with the old rep leg.
    if (req.query.stage === 'inbound' && call.state.kind === 'inbound') {
      const { rows: [u] } = await q('SELECT telnyx_session_call_id FROM users WHERE id = $1', [call.state.userId]);
      const room = u?.telnyx_session_call_id ? 'rep-' + u.telnyx_session_call_id : null;
      if (!room || p.ConferenceName !== room || !p.ConferenceMemberID) return res.sendStatus(200);
      await q('UPDATE plivo_calls SET conference_name = $2, member_id = $3 WHERE id = $1', [id, room, p.ConferenceMemberID]);
      emitToUser(call.state.userId, 'inbound:caller', { phone: call.state.phone ?? null });
      pokeAdmins('live');
      return res.sendStatus(200);
    }
    const room = joined ? call.bridge_room : (call.state.kind === 'rep' ? 'rep-' : 'hold-') + id;
    if (!room || p.ConferenceName !== room || !p.ConferenceMemberID) return res.sendStatus(400);
    // A delayed entry to the holding room must not overwrite the active bridge membership.
    await q(`UPDATE plivo_calls SET conference_name = $2, member_id = $3 WHERE id = $1
      AND ($4::boolean OR bridge_room IS NULL)`, [id, room, p.ConferenceMemberID, joined]);
    type = joined ? 'call.bridged' : 'call.answered';
  } else if (action === 'recording') {
    type = p.recording_id || p.RecordingID ? 'call.recording.saved' : 'call.recording.error';
    payload.recording_id = p.recording_id || p.RecordingID;
    const time = value => value && Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : null;
    payload.recording_started_at = time(p.recording_start_ms || p.RecordingStartMs);
    payload.recording_ended_at = time(p.recording_end_ms || p.RecordingEndMs);
    payload.reason = p.error || 'Plivo recording failed';
  } else {
    type = 'call.hangup';
    payload.hangup_cause = String(p.HangupCauseName || p.HangupCause || (action === 'fallback' ? 'answer_failed' : 'normal_hangup')).toLowerCase().replaceAll(' ', '_');
  }
  const event = { data: { id: 'plivo:' + id + ':' + type + (payload.recording_id ? ':' + payload.recording_id : ''), event_type: type, occurred_at: occurred, payload } };
  const eventId = await transaction(async () => {
    if (type === 'call.hangup') {
      await q('UPDATE plivo_calls SET ended_at = coalesce(ended_at, $2) WHERE id = $1', [id, occurred]);
      await storeEvent({ data: { ...event.data, id: 'plivo:' + id + ':cost', event_type: 'call.cost.refresh' } });
    }
    return storeEvent(event);
  });
  if (action === 'fallback') res.type('text/xml').send(hangupXml);
  else res.sendStatus(200);
  processEvent(eventId, handle).catch(error => console.error('webhook handler:', error.message));
});

export async function handle(event) {
  const d = event?.data ?? event ?? {};
  const type = d.event_type;
  const p = { ...(d.payload ?? {}), occurred_at: d.occurred_at ?? new Date().toISOString() };
  const state = decodeState(p.client_state);
  if (type === 'call.cost.refresh') return refreshCallCost(p.call_control_id);
  if (type === 'call.cost') return onCallCost(p, state, d.occurred_at);
  if (type === 'call.recording.saved') return onRecordingSaved(p, state);
  if (type === 'call.recording.error') return onRecordingError(p, state);
  if (!state) return;
  if (state.kind === 'rep') return onRepEvent(type, p, state);
  if (state.kind === 'lead') {
    const result = await withLock('voice-burst:' + state.burstId, async () => {
      await onLeadEvent(type, p, state);
      return true;
    });
    if (!result) throw new Error('burst event is being handled; retry');
  }
}

async function onRepEvent(type, p, { userId }) {
  if (type === 'call.playback.ended') return onRepPlaybackEnded(p.call_control_id, p.media_name || p.media_url);
  if (type === 'call.answered') {
    const call = await voiceCall(p.call_control_id);
    if (call?.ended_at || call?.cancelled) return;
    const { rowCount } = await q('UPDATE users SET rep_connected = true WHERE id = $1 AND telnyx_session_call_id = $2', [userId, p.call_control_id]);
    if (!rowCount) {
      const { rows: [u] } = await q('SELECT telnyx_session_call_id FROM users WHERE id = $1', [userId]);
      if (!u?.telnyx_session_call_id) throw new Error('rep dial has not been saved yet');
      return;
    }
    repUp.add(userId);
    emitToUser(userId, 'rep:connected', {});
    pokeAdmins('live');
  }
  if (type === 'call.hangup') {
    const { rowCount } = await q('UPDATE users SET rep_connected = false WHERE id = $1 AND telnyx_session_call_id = $2', [userId, p.call_control_id]);
    if (!rowCount) return;
    repUp.delete(userId);
    const { rows: [pending] } = await q(`SELECT b.id FROM bursts b JOIN calls c ON c.burst_id = b.id WHERE b.user_id = $1 AND c.disposition IS NULL ORDER BY b.id DESC LIMIT 1`, [userId]);
    const burstId = pending?.id ?? activeBurst.get(userId);
    if (burstId) { await cancelOpenLegs(burstId); activeBurst.delete(userId); }
    await q('UPDATE users SET telnyx_session_call_id = NULL WHERE id = $1 AND telnyx_session_call_id = $2', [userId, p.call_control_id]);
    emitToUser(userId, 'rep:disconnected', { cause: p.hangup_cause });
    pokeAdmins('live');
  }
}
export const startWebhookWorker = () => startEventWorker(handle);
