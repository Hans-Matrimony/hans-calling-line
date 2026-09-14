import express from 'express';
import { q, withLock } from '../db/pool.js';
import { emitToUser, pokeAdmins } from '../io.js';
import { onCallCost } from '../lib/costs.js';
import { onRecordingSaved, onRecordingError } from '../lib/recordings.js';
import { repUp, activeBurst } from '../state.js';
import { telnyx, decodeState } from '../telnyx.js';
import { onLeadEvent, cancelOpenLegs, onRepPlaybackEnded } from '../lib/burst.js';

import { storeEvent, processEvent, startEventWorker } from '../lib/webhookInbox.js';

export const router = express.Router();

// Raw body: the ed25519 signature covers the exact bytes Telnyx sent. Mounted before express.json().
router.post('/telnyx', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = await telnyx().webhooks.unwrap(req.body.toString('utf8'), { headers: req.headers });
  } catch (e) {
    console.warn('webhook rejected:', e.message);
    return res.status(400).end();
  }
  // A database failure returns non-2xx, so Telnyx redelivers. A crash after this ACK is recovered by the worker.
  const id = await storeEvent(event);
  res.status(200).end();
  processEvent(id, handle).catch((e) => console.error('webhook handler error:', e));
});

export async function handle(event) {
  const d = event?.data ?? event ?? {};
  const type = d.event_type;
  const p = { ...(d.payload ?? {}), occurred_at: d.occurred_at ?? new Date().toISOString() };
  const state = decodeState(p.client_state);
  console.log('[telnyx]', type, state?.kind ?? '-', String(p.call_control_id ?? '').slice(-8), p.hangup_cause ?? p.total_cost ?? '');
  // Money and recordings settle per leg, state or not: a leg with no client_state still cost something.
  if (type === 'call.cost') return onCallCost(p, state, d.occurred_at);
  if (type === 'call.recording.saved') return onRecordingSaved(p, state);
  if (type === 'call.recording.error') return onRecordingError(p, state);
  if (!state) return;
  if (state.kind === 'rep') return onRepEvent(type, p, state);
  if (state.kind === 'lead') {
    const result = await withLock('telnyx-burst:' + state.burstId, async () => {
      await onLeadEvent(type, p, state);
      return true;
    });
    if (!result) throw new Error('burst event is being handled; retry');
  }
}

async function onRepEvent(type, p, { userId }) {
  if (type === 'call.playback.ended') return onRepPlaybackEnded(p.call_control_id, p.media_name || p.media_url); // media_url is empty for a stored cue
  if (type === 'call.answered') {
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
    const { rowCount } = await q('UPDATE users SET rep_connected = false WHERE id = $1 AND telnyx_session_call_id = $2',
      [userId, p.call_control_id]);
    if (!rowCount) return; // A delayed hangup from the previous connection cannot drop the replacement.
    repUp.delete(userId);
    // Plan s8 detail #3: never fail silently. Drop whatever is still ringing or bridged for this rep.
    const { rows: [pending] } = await q(`SELECT b.id FROM bursts b JOIN calls c ON c.burst_id = b.id WHERE b.user_id = $1 AND c.disposition IS NULL ORDER BY b.id DESC LIMIT 1`, [userId]);
    const burstId = pending?.id ?? activeBurst.get(userId);
    if (burstId) { await cancelOpenLegs(burstId); activeBurst.delete(userId); }
    // Clear the id only after cleanup; a retried event can resume an interrupted cleanup.
    await q('UPDATE users SET telnyx_session_call_id = NULL WHERE id = $1 AND telnyx_session_call_id = $2', [userId, p.call_control_id]);
    emitToUser(userId, 'rep:disconnected', { cause: p.hangup_cause });
    pokeAdmins('live');
  }
}

export const startWebhookWorker = () => startEventWorker(handle);
