import express from 'express';
import { q } from '../db/pool.js';
import { emitToUser, pokeAdmins } from '../io.js';
import { onCallCost } from '../lib/costs.js';
import { onRecordingSaved, onRecordingError } from '../lib/recordings.js';
import { repUp, activeBurst } from '../state.js';
import { telnyx, decodeState } from '../telnyx.js';
import { onLeadEvent, cancelOpenLegs, onRepPlaybackEnded } from '../lib/burst.js';

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
  res.status(200).end(); // ack first: Telnyx retries on non-2xx and we do not want duplicates
  handle(event).catch((e) => console.error('webhook handler error:', e));
});

async function handle(event) {
  const d = event?.data ?? event ?? {};
  const type = d.event_type;
  const p = d.payload ?? {};
  const state = decodeState(p.client_state);
  console.log('[telnyx]', type, state?.kind ?? '-', String(p.call_control_id ?? '').slice(-8), p.hangup_cause ?? p.total_cost ?? '');
  // Money and recordings settle per leg, state or not: a leg with no client_state still cost something.
  if (type === 'call.cost') return onCallCost(p, state, d.occurred_at);
  if (type === 'call.recording.saved') return onRecordingSaved(p, state);
  if (type === 'call.recording.error') return onRecordingError(p, state);
  if (!state) return;
  if (state.kind === 'rep') return onRepEvent(type, p, state);
  if (state.kind === 'lead') return onLeadEvent(type, p, state);
}

async function onRepEvent(type, p, { userId }) {
  if (type === 'call.playback.ended') return onRepPlaybackEnded(p.call_control_id, p.media_name || p.media_url); // media_url is empty for a stored cue
  if (type === 'call.answered') {
    repUp.add(userId);
    emitToUser(userId, 'rep:connected', {});
    pokeAdmins('live');
  }
  if (type === 'call.hangup') {
    repUp.delete(userId);
    await q('UPDATE users SET telnyx_session_call_id = NULL WHERE id = $1 AND telnyx_session_call_id = $2',
      [userId, p.call_control_id]);
    // Plan s8 detail #3: never fail silently. Drop whatever is still ringing or bridged for this rep.
    const burstId = activeBurst.get(userId);
    if (burstId) { await cancelOpenLegs(burstId); activeBurst.delete(userId); }
    emitToUser(userId, 'rep:disconnected', { cause: p.hangup_cause });
    pokeAdmins('live');
  }
}
