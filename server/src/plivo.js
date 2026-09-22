// Plivo transport. Stable local IDs survive the request_uuid -> CallUUID transition.
// Legacy telnyx_* database columns retain their names so existing history is preserved.
import { randomBytes, randomUUID } from 'node:crypto';
import { q } from './db/pool.js';
import { DIAL_TIMEOUT_SECS } from './config.js';

import { need, publicUrl, callbackUrl, plivoRequest } from './plivoTransport.js';
export { publicUrl, callbackUrl, encodeState, decodeState, authHeader, plivoRequest, validWebhook } from './plivoTransport.js';
export async function voiceCall(id) {
  const { rows: [row] } = await q('SELECT * FROM plivo_calls WHERE id = $1', [id]);
  return row;
}
const segment = (value) => encodeURIComponent(String(value));
async function live(id) {
  const call = await voiceCall(id);
  if (!call?.call_uuid || call.ended_at) throw new Error('Call is not connected; reconnect audio and try again.');
  return call;
}
async function dial({ to, from, state, timeout }) {
  // Validate before creating any provider-side call.
  need('PLIVO_AUTH_ID'); need('PLIVO_AUTH_TOKEN');
  if (!/^https:\/\//.test(publicUrl())) throw new Error('PUBLIC_URL must be a public HTTPS URL for Plivo calls.');
  const id = randomUUID();
  await q('INSERT INTO plivo_calls(id, state) VALUES ($1, $2)', [id, JSON.stringify(state)]);
  console.log('[plivo] dial', state.kind, '->', to, 'from', from);
  try {
    const result = await plivoRequest('Call/', 'POST', {
      from, to, answer_url: callbackUrl('answer', id), answer_method: 'POST',
      ring_url: callbackUrl('ring', id), ring_method: 'POST',
      hangup_url: callbackUrl('hangup', id), hangup_method: 'POST',
      fallback_url: callbackUrl('fallback', id), fallback_method: 'POST',
      ring_timeout: timeout, time_limit: 14400,
    });
    if (typeof result.request_uuid !== 'string') throw new Error('Plivo did not return a request UUID');
    await q('UPDATE plivo_calls SET request_uuid = $2 WHERE id = $1', [id, result.request_uuid]);
    return id;
  } catch (error) {
    // Retain the correlation row: an ambiguous network failure may still produce callbacks.
    await q('UPDATE plivo_calls SET cancelled = true WHERE id = $1', [id]);
    throw error;
  }
}
export const dialRep = ({ to, from, userId }) => dial({ to, from, state: { kind: 'rep', userId }, timeout: 40 });
export const dialLead = ({ to, from, userId, burstId, leadId }) => dial({ to, from, state: { kind: 'lead', userId, burstId, leadId }, timeout: DIAL_TIMEOUT_SECS });

export async function hangup(id) {
  const call = await voiceCall(id);
  if (!call) return; // A pre-migration session cannot be sent to Plivo.
  await q('UPDATE plivo_calls SET cancelled = true WHERE id = $1', [id]);
  if (call.ended_at) return;
  const path = call.call_uuid ? 'Call/' + segment(call.call_uuid) + '/' : call.request_uuid ? 'Request/' + segment(call.request_uuid) + '/' : null;
  if (!path) return;
  try { await plivoRequest(path, 'DELETE'); }
  catch (error) { if (error.status !== 404 && error.status !== 410) throw error; }
}

async function play(id, file, loop = false) {
  const call = await live(id);
  const audio = publicUrl() + '/static/' + file;
  // Conference-member playback isolates the cue to the rep's ear. The member API takes a single
  // `url`; the bare-leg Call API takes `urls` and understands loop 'infinity'.
  if (call.member_id && call.conference_name)
    return plivoRequest('Conference/' + segment(call.conference_name) + '/Member/' + segment(call.member_id) + '/Play/',
      'POST', loop ? { url: audio, loop: 'true' } : { url: audio });
  return plivoRequest('Call/' + segment(call.call_uuid) + '/Play/',
    'POST', { urls: audio, ...(loop ? { loop: 'infinity' } : {}) });
}
export const beep = (id) => play(id, 'beep.wav');
export const startTick = (id) => play(id, 'tick.wav', true);
export const noAnswerTone = (id) => play(id, 'noanswer.wav');
/** Live members of a conference, or null when the conference does not exist (stale rep flag). */
export async function conferenceMembers(name) {
  try {
    const data = await plivoRequest('Conference/' + encodeURIComponent(name) + '/');
    return Array.isArray(data.members) ? data.members : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}
export async function stopPlayback(id) {
  const call = await voiceCall(id);
  if (!call?.call_uuid || call.ended_at) return;
  const path = call.member_id && call.conference_name
    ? 'Conference/' + segment(call.conference_name) + '/Member/' + segment(call.member_id) + '/Play/'
    : 'Call/' + segment(call.call_uuid) + '/Play/';
  try { await plivoRequest(path, 'DELETE'); }
  catch (error) { if (error.status !== 404) throw error; }
}
export async function bridge(repId, leadId) {
  const rep = await live(repId);
  const lead = await live(leadId);
  if (!rep.conference_name) throw new Error('Rep audio has not joined its conference');
  if (lead.conference_name === rep.conference_name) return;
  await q('UPDATE plivo_calls SET bridge_room = $2 WHERE id = $1', [leadId, rep.conference_name]);
  await plivoRequest('Call/' + segment(lead.call_uuid) + '/', 'POST', {
    legs: 'aleg', aleg_url: callbackUrl('bridge', leadId), aleg_method: 'POST',
  });
}
export async function sendDtmf(id, digits) {
  const call = await live(id);
  return plivoRequest('Call/' + segment(call.call_uuid) + '/DTMF/', 'POST', { digits });
}
export async function startRecording(id, opts = {}) {
  const call = await live(id);
  if (opts.play_beep) {
    await play(id, 'beep.wav');
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  return plivoRequest('Call/' + segment(call.call_uuid) + '/Record/', 'POST', {
    time_limit: 14400, file_format: 'mp3', record_channel_type: 'stereo',
    callback_url: callbackUrl('recording', id), callback_method: 'POST',
  });
}
export const isInvalidDestination = (error) => /\bto (?:parameter |number )?is invalid\b|invalid destination (?:number|phone)|destination number is invalid/i.test(error?.message ?? '');
export const providerDetail = (error) => String(error?.message ?? 'Plivo request failed').slice(0, 200);

export async function ensureCredential(user) {
  if (user.plivo_endpoint_id && user.plivo_sip_username) return { id: user.plivo_endpoint_id, sip_username: user.plivo_sip_username };
  const result = await plivoRequest('Endpoint/', 'POST', {
    username: 'hans' + user.id + randomBytes(4).toString('hex'),
    password: randomBytes(24).toString('base64url'), alias: 'hans-' + user.id,
    app_id: need('PLIVO_APPLICATION_ID'),
  });
  if (!result.endpoint_id || !result.username) throw new Error('Plivo endpoint response is incomplete');
  return { id: result.endpoint_id, sip_username: result.username, fresh: true };
}
export async function webrtcToken(username) {
  const now = Math.floor(Date.now() / 1000);
  const result = await plivoRequest('JWT/Token/', 'POST', {
    iss: need('PLIVO_AUTH_ID'), sub: username, nbf: now - 30, exp: now + 43200,
    per: { voice: { incoming_allow: true, outgoing_allow: false } }, app: need('PLIVO_APPLICATION_ID'),
  });
  if (!result.token) throw new Error('Plivo did not return a browser token');
  return result.token;
}
// Plivo endpoints register as sip:<username>_<auth_id>@phone.plivo.com (the SDK appends the
// account suffix); dialing the bare username is "endpoint not registered".
export const sipDestination = (username) => 'sip:' + username + '_' + need('PLIVO_AUTH_ID') + '@phone.plivo.com';
