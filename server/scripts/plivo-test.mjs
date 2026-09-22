import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
if (process.env.HANS_TEST_DATABASE !== 'isolated') throw new Error('Use npm test for an isolated database');
Object.assign(process.env, { PLIVO_AUTH_ID: 'MAtest', PLIVO_AUTH_TOKEN: 'test-token', PLIVO_APPLICATION_ID: 'app-test', PUBLIC_URL: 'https://dialer.test', RECORD_CALLS: 'true' });
const realFetch = globalThis.fetch;
const requests = [];
let serial = 0, billingReady = false;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, init);
  if (u.hostname !== 'api.plivo.com') throw new Error('Unexpected external request: ' + u.hostname);
  assert.equal(init.headers.Authorization, 'Basic ' + Buffer.from('MAtest:test-token').toString('base64'));
  const path = u.pathname.replace('/v1/Account/MAtest/', '');
  const body = init.body ? JSON.parse(init.body) : null;
  requests.push({ path, method: init.method, body });
  if (path === 'Call/' && init.method === 'POST') return Response.json({ request_uuid: 'request-' + ++serial });
  if (path === 'Endpoint/') return Response.json({ endpoint_id: 'endpoint-1', username: 'hans123456789012' });
  if (path === 'JWT/Token/') return Response.json({ token: 'browser-token' });
  if (path.endsWith('/Record/')) return Response.json({ recording_id: 'recording-1' });
  if (path.startsWith('Call/') && init.method === 'GET') return billingReady
    ? Response.json({ total_amount: '0.023', bill_duration: 60, total_rate: '0.023' })
    : Response.json({ error: 'not ready' }, { status: 404 });
  if (path === 'Recording/recording-1/') return Response.json({ recording_url: 'https://media.plivo.com/recording-1.mp3' });
  if (init.method === 'DELETE') return new Response(null, { status: 204 });
  if (path.endsWith('/Play/') || (path.startsWith('Call/') && init.method === 'POST')) return Response.json({ message: 'ok' });
  throw new Error('Unstubbed Plivo request: ' + init.method + ' ' + path);
};
const { pool, q } = await import('../src/db/pool.js');
await q(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
const { router, handle } = await import('../src/routes/webhooks.js');
const { processEvent } = await import('../src/lib/webhookInbox.js');
const voice = await import('../src/plivo.js');
const { startBurst } = await import('../src/lib/burst.js');
const { recordingUrl, fetchRecording } = await import('../src/lib/recordings.js');
const app = express();
app.use('/webhooks', router);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const local = 'http://127.0.0.1:' + server.address().port;
const sign = (path, body, nonce = 'test-nonce') => {
  const u = new URL('https://dialer.test' + path);
  const query = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('&');
  const params = Object.keys(body).sort().map(key => key + body[key]).join('');
  const canonical = u.origin + u.pathname + (query || params ? '?' + query : '') + (query && params ? '.' : '') + params + '.' + nonce;
  return createHmac('sha256', 'test-token').update(canonical).digest('base64');
};
async function callback(path, body, signed = true) {
  return realFetch(local + path, { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...(signed ? { 'X-Plivo-Signature-V3': sign(path, body), 'X-Plivo-Signature-V3-Nonce': 'test-nonce' } : {}),
  }, body: new URLSearchParams(body) });
}
async function drain(id) {
  for (let tries = 0; tries < 80; tries++) {
    await processEvent(id, handle);
    const { rows: [row] } = await q('SELECT processed_at, error FROM telnyx_events WHERE id = $1', [id]);
    if (row?.processed_at) return;
    if (row?.error) throw new Error(row.error);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Event did not finish: ' + id);
}
async function send(id, action, body, stage) {
  const path = '/webhooks/plivo/' + action + '?id=' + id + (stage ? '&stage=' + stage : '');
  const response = await callback(path, body);
  assert.equal(response.status, 200, await response.clone().text());
  return response.text();
}
const passed = label => console.log('PASS ' + label);
try {
  assert.equal((await callback('/webhooks/plivo/application', {}, false)).status, 403);
  const body = { CallUUID: 'fake' };
  const response = await realFetch(local + '/webhooks/plivo/application', { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', 'X-Plivo-Signature-V3': sign('/webhooks/plivo/application', body), 'X-Plivo-Signature-V3-Nonce': 'test-nonce',
  }, body: new URLSearchParams({ CallUUID: 'tampered' }) });
  assert.equal(response.status, 403);
  assert.match(await (await callback('/webhooks/plivo/application', body)).text(), /<Hangup/);
  passed('unsigned and tampered callbacks rejected; valid V3 callback accepted');

  const { rows: [rep] } = await q("INSERT INTO users(email,password_hash) VALUES ('plivo-test@example.test','unused') RETURNING id");
  const endpoint = await voice.ensureCredential({ id: rep.id });
  assert.equal(await voice.webrtcToken(endpoint.sip_username), 'browser-token');
  const tokenRequest = requests.find(r => r.path === 'JWT/Token/').body;
  assert.equal(tokenRequest.sub, endpoint.sip_username);
  assert.deepEqual(tokenRequest.per, { voice: { incoming_allow: true, outgoing_allow: false } });
  assert.ok(!JSON.stringify(endpoint).includes('password'));
  const beforeEndpoint = requests.length;
  await voice.ensureCredential({ plivo_endpoint_id: endpoint.id, plivo_sip_username: endpoint.sip_username });
  assert.equal(requests.length, beforeEndpoint);
  passed('browser endpoint reuse, scoped JWT, and no SIP password in client response');

  const repId = await voice.dialRep({ userId: rep.id, to: 'sip:rep@phone.plivo.com', from: '+12025550100' });
  await q('UPDATE users SET telnyx_session_call_id = $2 WHERE id = $1', [rep.id, repId]);
  const repXml = await send(repId, 'answer', { CallUUID: 'rep-uuid' });
  assert.match(repXml, /endConferenceOnExit="true"/);
  await send(repId, 'conference', { CallUUID: 'rep-uuid', ConferenceAction: 'enter', ConferenceName: 'rep-' + repId, ConferenceMemberID: '1' }, 'hold');
  await drain('plivo:' + repId + ':call.answered');
  assert.equal((await q('SELECT rep_connected FROM users WHERE id=$1', [rep.id])).rows[0].rep_connected, true);
  passed('request UUID and live call UUID mapped; rep readiness waits for conference entry');

  const leads = [];
  for (const [name, phone] of [['First', '+447700900101'], ['Second', '+447700900102']]) {
    leads.push((await q(`INSERT INTO leads(name,phone,phones,country,timezone,utc_offset,segment,user_id,status)
      VALUES ($1,$2,ARRAY[$2],'United Kingdom','Europe/London',1,'non_india',$3,'in_flight') RETURNING *`, [name, phone, rep.id])).rows[0]);
  }
  const burst = await startBurst(rep.id, leads, '+12025550100');
  const { rows: legs } = await q('SELECT * FROM calls WHERE burst_id=$1 ORDER BY id', [burst.burstId]);
  const first = legs[0].telnyx_call_id, second = legs[1].telnyx_call_id;
  assert.match(await send(first, 'answer', { CallUUID: 'lead-uuid' }), /hold-/);
  await send(first, 'conference', { CallUUID: 'lead-uuid', ConferenceAction: 'enter', ConferenceName: 'hold-' + first, ConferenceMemberID: '1' }, 'hold');
  await drain('plivo:' + first + ':call.answered');
  const secondMap = await voice.voiceCall(second);
  assert.ok(requests.some(r => r.path === 'Request/' + secondMap.request_uuid + '/' && r.method === 'DELETE'));
  assert.equal(requests.filter(r => r.path.endsWith('/Record/')).length, 0);
  const transfers = requests.filter(r => r.path === 'Call/lead-uuid/' && r.method === 'POST');
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].body.legs, 'aleg');
  assert.equal((await q('SELECT bridged_at FROM calls WHERE id=$1', [legs[0].id])).rows[0].bridged_at, null);
  assert.match(await send(first, 'bridge', { CallUUID: 'lead-uuid' }), new RegExp('rep-' + repId));
  passed('winner selection cancels queued loser by request UUID; bridge waits for provider confirmation');

  await send(first, 'conference', { CallUUID: 'lead-uuid', ConferenceAction: 'enter', ConferenceName: 'hold-' + first, ConferenceMemberID: '1' }, 'hold');
  await drain('plivo:' + first + ':call.answered');
  assert.equal(requests.filter(r => r.path === 'Call/lead-uuid/' && r.method === 'POST').length, 1);
  await send(first, 'conference', { CallUUID: 'lead-uuid', ConferenceAction: 'enter', ConferenceName: 'rep-' + repId, ConferenceMemberID: '2' }, 'joined');
  await drain('plivo:' + first + ':call.bridged');
  await send(first, 'conference', { CallUUID: 'lead-uuid', ConferenceAction: 'enter', ConferenceName: 'rep-' + repId, ConferenceMemberID: '2' }, 'joined');
  await drain('plivo:' + first + ':call.bridged');
  assert.equal(requests.filter(r => r.path.endsWith('/Record/')).length, 1);
  assert.equal(requests.find(r => r.path.endsWith('/Record/')).body.record_channel_type, 'stereo');
  passed('duplicate callbacks do not re-transfer or duplicate recording');

  const mismatch = await callback('/webhooks/plivo/ring?id=' + first, { CallUUID: 'wrong-uuid' });
  assert.equal(mismatch.status, 400);
  assert.match(await send(second, 'answer', { CallUUID: 'loser-uuid' }), /<Hangup/);
  await drain('plivo:' + second + ':late-answer');
  assert.equal((await q('SELECT disposition FROM calls WHERE id=$1', [legs[1].id])).rows[0].disposition, 'abandoned');
  passed('live UUID cannot be replaced; late answered losers are hung up and counted as abandoned');

  await send(first, 'recording', { call_uuid: 'lead-uuid', recording_id: 'recording-1', recording_start_ms: '1750000000000', recording_end_ms: '1750000060000' });
  await drain('plivo:' + first + ':call.recording.saved:recording-1');
  const recording = (await q('SELECT * FROM calls WHERE id=$1', [legs[0].id])).rows[0];
  assert.equal(recording.recording_status, 'saved');
  assert.equal(await recordingUrl(recording), 'https://media.plivo.com/recording-1.mp3');
  passed('Plivo recording callback maps to saved recording and playback lookup');

  await send(first, 'hangup', { CallUUID: 'lead-uuid', HangupCauseName: 'Normal Hangup' });
  await drain('plivo:' + first + ':call.hangup');
  assert.equal((await q('SELECT rep_connected FROM users WHERE id=$1', [rep.id])).rows[0].rep_connected, true);
  const costId = 'plivo:' + first + ':cost';
  await processEvent(costId, handle);
  assert.equal((await q('SELECT processed_at FROM telnyx_events WHERE id=$1', [costId])).rows[0].processed_at, null);
  billingReady = true;
  await drain(costId);
  assert.equal(Number((await q('SELECT total_cost FROM telnyx_costs WHERE call_control_id=$1', [first])).rows[0].total_cost), 0.023);
  passed('lead hangup preserves rep; delayed CDR billing retries durably');

  await voice.hangup(repId);
  assert.ok(requests.some(r => r.path === 'Call/rep-uuid/' && r.method === 'DELETE'));
  assert.ok(voice.isInvalidDestination(new Error('to parameter is invalid')));
  assert.equal(voice.isInvalidDestination(new Error('from parameter is invalid')), false);
  assert.equal(voice.isInvalidDestination(new Error('destination country not allowed')), false);
  passed('live hangup uses CallUUID; caller-ID and permissions errors do not exhaust leads');

  // Idle audio must leave incoming callbacks in the original rep's queue.
  await q('UPDATE users SET rep_connected=false WHERE id=$1', [rep.id]);
  const inbound = await callback('/webhooks/plivo/inbound', { From: leads[0].phone, CallUUID: 'queued-inbound-uuid' });
  assert.equal(inbound.status, 200);
  assert.match(await inbound.text(), /added to the call-back queue/);
  const queued = (await q('SELECT user_id,status FROM leads WHERE id=$1', [leads[0].id])).rows[0];
  assert.equal(queued.user_id, rep.id);
  assert.equal(queued.status, 'queued');
  passed('incoming callback with audio off stays assigned to the rep who last called');

  const downloads = [];
  globalThis.fetch = async (url, init) => {
    downloads.push({ url: String(url), init });
    if (downloads.length === 1) return new Response(null, { status: 302, headers: { location: 'https://storage.example.test/file.mp3' } });
    return new Response('audio');
  };
  assert.equal((await fetchRecording('https://media.plivo.com/file.mp3')).status, 200);
  assert.ok(downloads[0].init.headers.Authorization);
  assert.equal(downloads[1].init.headers.Authorization, undefined);
  passed('recording authentication is never forwarded to third-party storage');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await pool.end();
}
