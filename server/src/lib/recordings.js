// Call recordings. The winning lead leg is recorded from the moment it is bridged (dual channel, mp3),
// silently - owner's decision, 2026-09-10. Telnyx keeps the file; we keep what it takes to find it
// again and a public token to serve it. Recording must never touch the call: every path here
// swallows its own errors.
import { randomBytes } from 'node:crypto';
import { q } from '../db/pool.js';
import { pokeAdmins } from '../io.js';
import { telnyx, startRecording, encodeState } from '../telnyx.js';
import { RECORD_CALLS, RECORD_BEEP } from '../config.js';

/** Start recording the lead leg right after the bridge. `state` is the leg's existing client_state;
 *  record_start replaces it for every later webhook, so we send a superset that adds callId. */
export async function startLeadRecording(callId, ccid, state) {
  if (!RECORD_CALLS) return;
  try {
    await startRecording(ccid, { play_beep: RECORD_BEEP, command_id: 'rec-' + callId, client_state: encodeState({ ...state, callId }) });
    await q(`UPDATE calls SET recording_status = 'started', recording_token = coalesce(recording_token, $2) WHERE id = $1 AND recording_status IS NULL`,
      [callId, randomBytes(16).toString('hex')]);
  } catch (e) {
    console.warn('record_start failed', String(ccid).slice(-8), e.message);
    await q(`UPDATE calls SET recording_status = 'error', recording_error = $2 WHERE id = $1`, [callId, String(e.message).slice(0, 200)]).catch(() => {});
  }
}

// How a saved/error webhook finds its calls row: the callId we put in client_state at record_start,
// else the leg's call_control_id (present in practice though not in the SDK's typing).
const handle = (p, state) =>
  state?.callId ? ['id = $1', state.callId] : p?.call_control_id ? ['telnyx_call_id = $1', p.call_control_id] : [];

/** call.recording.saved: the file exists at Telnyx. The links in the payload die in 10 minutes and are
 *  not stored. Fires the HubSpot upload (lazy import: hubspotCalls imports this module too). */
export async function onRecordingSaved(p, state) {
  const [where, key] = handle(p, state);
  if (!where) { console.warn('recording.saved: nothing to attach it to', p?.call_leg_id); return; }
  const { rows: [c] } = await q(
    `UPDATE calls SET recording_status = 'saved', recording_leg_id = $2, recording_session_id = $3,
       recording_started_at = $4, recording_ended_at = $5, recording_error = NULL,
       recording_token = coalesce(recording_token, $6)
     WHERE ${where} RETURNING id`,
    [key, p.call_leg_id ?? null, p.call_session_id ?? null, p.recording_started_at ?? null, p.recording_ended_at ?? null,
     randomBytes(16).toString('hex')]);
  if (!c) return;
  pokeAdmins('recording');
  const { attachRecording } = await import('./hubspotCalls.js');
  attachRecording(c.id).catch((e) => console.warn('hubspot recording attach', e.message));
}

export async function onRecordingError(p, state) {
  const [where, key] = handle(p, state);
  if (!where) return;
  await q(`UPDATE calls SET recording_status = 'error', recording_error = $2 WHERE ${where} AND recording_status IS DISTINCT FROM 'saved'`,
    [key, String(p?.reason ?? 'recording error').slice(0, 200)]);
}

/** A fresh mp3 link for a call. Cached recording id -> retrieve; else find it by leg (or by the
 *  call_control_id) and cache the id for next time. Null when Telnyx has nothing (yet, or any more). */
export async function recordingUrl(call) {
  if (call.recording_id) {
    const { data } = await telnyx().recordings.retrieve(call.recording_id);
    return data?.download_urls?.mp3 ?? null;
  }
  const filter = call.recording_leg_id ? { call_leg_id: call.recording_leg_id } : { call_control_id: call.telnyx_call_id };
  for await (const r of telnyx().recordings.list({ filter })) {
    if (r.status && r.status !== 'completed') continue;
    await q('UPDATE calls SET recording_id = $2 WHERE id = $1', [call.id, r.id]);
    return r.download_urls?.mp3 ?? null;
  }
  return null;
}

/** The whole file, for the HubSpot upload. */
export async function recordingBytes(call) {
  const url = await recordingUrl(call);
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error('telnyx download ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
