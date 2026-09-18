import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import pg from 'pg';

// Invoked by test-local.mjs, whose database exists only for this child process.
assert.match(process.env.DATABASE_URL, /127\.0\.0\.1|localhost/);
Object.assign(process.env, { PLIVO_AUTH_ID: 'MAtest', PLIVO_AUTH_TOKEN: 'test-token', PUBLIC_URL: 'https://dialer.test',
  HUBSPOT_TOKEN: '', RECORD_CALLS: 'false', SESSION_SECRET: 'isolated-test-secret' });
const realFetch = globalThis.fetch;
let createMode = 'ok', patchFails = false, searchFails = false, creates = 0, patches = 0;
const remoteCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  if (path.startsWith('http://127.0.0.1:')) return realFetch(url, init);
  if (path.startsWith('https://api.plivo.com/')) return Response.json({ data: { result: 'ok' } });
  if (path.includes('/properties/calls/hs_call_disposition')) return Response.json({ options: [] });
  if (path.endsWith('/objects/calls/search')) {
    if (searchFails) return Response.json({ message: 'forbidden' }, { status: 403 });
    const timestamp = JSON.parse(init.body).filterGroups[0].filters[0].value;
    return Response.json({ results: remoteCalls.filter((c) => String(new Date(c.properties.hs_timestamp).getTime()) === timestamp) });
  }
  if (path.endsWith('/objects/calls') && init.method === 'POST') {
    creates++;
    remoteCalls.push({ id: 'hs-' + creates, ...JSON.parse(init.body) });
    if (createMode === 'lost-response') throw new Error('Simulated connection loss after accepted POST');
    return Response.json({ id: 'hs-' + creates });
  }
  if (path.includes('/objects/calls/') && init.method === 'PATCH') {
    patches++;
    if (patchFails) return Response.json({ message: 'temporary outage' }, { status: 503 });
    return Response.json({});
  }
  throw new Error('Unexpected external request: ' + path);
};

const { q, pool, transaction } = await import('../src/db/pool.js');
const { snapshot, reserveBurst } = await import('../src/lib/sessionState.js');
const { activeBurst, repUp } = await import('../src/state.js');
const { storeEvent, processEvent } = await import('../src/lib/webhookInbox.js');
const { handle } = await import('../src/routes/webhooks.js');
const { encodeState } = await import('../src/plivo.js');
const { reconcileLead } = await import('../src/lib/hubspotReconcile.js');
const { logCall, processCallSync } = await import('../src/lib/hubspotCalls.js');
const { releaseLead, queueOverview } = await import('../src/lib/queue.js');
const { resolveLead, COUNTRIES, DIAL_CODES } = await import('../src/lib/countries.js');
const { localClockSQL, offsetSQL } = await import('../src/lib/leadPolicy.js');
const { leadLocalAt, describeLater } = await import('../../client/lib/format.ts');
const { router } = await import('../src/routes/session.js');
const check = (label, actual, expected) => { assert.deepEqual(actual, expected, label); console.log('PASS  ' + label); };
const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
await q(schema);
await q(schema); // startup migrations must be repeatable
const user = (email) => q("INSERT INTO users(email,password_hash,rep_connected) VALUES($1,'x',true) RETURNING id", [email]).then((r) => r.rows[0].id);
const uid = await user('one@test'), other = await user('two@test');
let serial = 1000;
async function lead(overrides = {}) {
  const id = String(++serial);
  const data = { id, name: 'Original', country: 'United Kingdom', phones: ['+442079460001'],
    segment: 'non_india', source: 'hubspot', extra: { company: 'Acme' }, ...overrides };
  await reconcileLead(data, uid, new Date(), null, false);
  return (await q('SELECT * FROM leads WHERE hubspot_contact_id = $1', [data.id])).rows[0];
}
async function call(l, fields = {}) {
  const { rows: [b] } = await q('INSERT INTO bursts(user_id) VALUES($1) RETURNING id', [uid]);
  const { rows: [c] } = await q(`INSERT INTO calls(lead_id,burst_id,telnyx_call_id,from_number,to_number,answered_at,duration,disposition)
    VALUES($1,$2,$3,'+12025550100',$4,$5,$6,$7) RETURNING *`,
  [l.id, b.id, 'cc-' + (++serial), l.phone, fields.answered_at ?? null, fields.duration ?? null, fields.disposition ?? null]);
  await q("UPDATE leads SET status = 'in_flight' WHERE id = $1", [l.id]);
  if (c.answered_at) await q('UPDATE bursts SET winner_call_id = $2 WHERE id = $1', [b.id, c.id]);
  return c;
}

const app = express();
app.use(express.json(), cookieParser());
app.use('/session', router);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const http = app.listen(0, '127.0.0.1');
await new Promise((resolve) => http.once('listening', resolve));
const post = async (path, body, userId = uid) => {
  const token = jwt.sign({ uid: userId }, process.env.SESSION_SECRET);
  return realFetch(`http://127.0.0.1:${http.address().port}/session/${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'hans_session=' + token }, body: JSON.stringify(body) });
};

try {
  // Deliberately different call and lead ids reproduce the snapshot column collision.
  await q("SELECT setval(pg_get_serial_sequence('calls', 'id'), 100)");
  const l = await lead(), c = await call(l, { answered_at: new Date(Date.now() - 45000), duration: 40 });
  activeBurst.set(uid, c.burst_id);
  let state = await snapshot(uid);
  check('snapshot preserves distinct call and lead ids', [state.phase, state.card.callId, state.card.leadId], ['ended', c.id, l.id]);
  activeBurst.clear(); repUp.clear();
  state = await snapshot(uid);
  check('restart restores pending outcome and blocks another burst', [state.phase, await reserveBurst(uid)], ['ended', 'busy']);
  check('other rep cannot save the call', (await post('disposition', { callId: c.id, outcome: 'connected' }, other)).status, 404);
  check('invalid callback date is rejected', (await post('disposition', { callId: c.id, outcome: 'later', laterAt: 'bad' })).status, 400);

  const originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...args) {
    if (String(args[0]).startsWith("UPDATE leads SET status = 'connected'")) return Promise.reject(new Error('injected release failure'));
    return originalQuery.apply(this, args);
  };
  check('outcome reports a settlement failure', (await post('disposition', { callId: c.id, outcome: 'connected', name: 'Must roll back' })).status, 500);
  check('failed outcome rolls back call, lead edit and sync job', (await q(`SELECT c.disposition, l.name, l.attempt_count,
    (SELECT count(*)::int FROM hubspot_jobs WHERE call_id = c.id) AS jobs FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.id = $1`, [c.id])).rows[0],
  { disposition: null, name: 'Original', attempt_count: 0, jobs: 0 });
  pg.Client.prototype.query = originalQuery;
  await Promise.all([post('disposition', { callId: c.id, outcome: 'connected' }), post('disposition', { callId: c.id, outcome: 'connected' })]);
  check('duplicate outcome consumes one attempt', (await q('SELECT attempt_count FROM leads WHERE id = $1', [l.id])).rows[0].attempt_count, 1);
  check('successful outcome queues durable CRM work', (await q('SELECT count(*)::int AS n FROM hubspot_jobs WHERE call_id = $1', [c.id])).rows[0].n, 1);

  const ringingLead = await lead(), ringing = await call(ringingLead);
  activeBurst.clear();
  check('ringing calls also recover after restart', (await snapshot(uid)).legs[0].leadId, ringingLead.id);
  const event = { data: { id: 'hangup-1', event_type: 'call.hangup', occurred_at: new Date().toISOString(), payload: {
    call_control_id: 'early-cc', hangup_cause: 'timeout', client_state: encodeState({ kind: 'lead', userId: uid, burstId: ringing.burst_id, leadId: ringingLead.id }),
  } } };
  const eventId = await storeEvent(event);
  check('provider redelivery retains one inbox row', await storeEvent(event), eventId);
  await processEvent(eventId, handle);
  check('early webhook remains pending for retry', (await q('SELECT processed_at, attempts FROM telnyx_events WHERE id = $1', [eventId])).rows[0], { processed_at: null, attempts: 1 });
  await q('UPDATE calls SET telnyx_call_id = $2 WHERE id = $1', [ringing.id, 'early-cc']);
  const restarted = await import('../src/lib/webhookInbox.js?restart');
  await restarted.processEvent(eventId, handle);
  await restarted.processEvent(eventId, handle);
  check('replayed webhook settles exactly one attempt', (await q('SELECT status, attempt_count, retry_minutes FROM leads WHERE id = $1', [ringingLead.id])).rows[0],
    { status: 'queued', attempt_count: 1, retry_minutes: 120 });
  check('completed webhook is marked durable', !!(await q('SELECT processed_at FROM telnyx_events WHERE id = $1', [eventId])).rows[0].processed_at, true);

  // Fault between call settlement and lead release must roll back before the inbox retries.
  const failureId = await storeEvent({ data: { id: 'transaction-retry' } });
  await processEvent(failureId, () => transaction(async () => {
    await q("UPDATE calls SET disposition = 'invalid' WHERE id = $1", [ringing.id]);
    throw new Error('injected interruption');
  }));
  check('failed webhook transaction leaves original disposition', (await q('SELECT disposition FROM calls WHERE id = $1', [ringing.id])).rows[0].disposition, 'no_answer');

  repUp.add(uid);
  await q("UPDATE users SET telnyx_session_call_id = 'new-rep', rep_connected = true WHERE id = $1", [uid]);
  await handle({ data: { event_type: 'call.hangup', payload: { call_control_id: 'old-rep', client_state: encodeState({ kind: 'rep', userId: uid }) } } });
  check('old audio hangup cannot clear the replacement', [(await q('SELECT rep_connected FROM users WHERE id = $1', [uid])).rows[0].rep_connected, repUp.has(uid)], [true, true]);
  await q('UPDATE users SET telnyx_session_call_id = NULL WHERE id = $1', [uid]);

  const owned = await lead();
  await q('UPDATE leads SET attempt_count = 2 WHERE id = $1', [owned.id]);
  const changed = { id: owned.hubspot_contact_id, name: 'Updated', country: 'Germany', phones: ['+493012345678'], segment: 'non_india', extra: { company: 'New company', email: 'new@test' } };
  await reconcileLead(changed, other, new Date(Date.now() + 1000), null, false);
  check('ownership and current fields refresh without resetting attempts', (await q('SELECT user_id, name, phone, timezone, attempt_count FROM leads WHERE id = $1', [owned.id])).rows[0],
    { user_id: other, name: 'Updated', phone: '+493012345678', timezone: 'Europe/Berlin', attempt_count: 2 });
  await q("UPDATE leads SET status = 'in_flight' WHERE id = $1", [owned.id]);
  await reconcileLead({ ...changed, name: 'After call' }, uid, new Date(Date.now() + 2000), null, false);
  check('live ownership and card fields stay fixed', (await q('SELECT user_id, name FROM leads WHERE id = $1', [owned.id])).rows[0], { user_id: other, name: 'Updated' });
  await releaseLead(owned.id, 'no_answer');
  await reconcileLead({ ...changed, name: 'After call' }, uid, new Date(Date.now() + 3000), null, false);
  check('deferred transfer completes after settlement', (await q('SELECT user_id, name FROM leads WHERE id = $1', [owned.id])).rows[0], { user_id: uid, name: 'After call' });
  const provisional = await lead({ id: 'manual-provisional', extra: { email: 'adopt@test' } });
  await q("UPDATE leads SET status = 'in_flight' WHERE id = $1", [provisional.id]);
  await reconcileLead({ ...changed, id: '99999', name: 'Deferred CRM name', phones: [provisional.phone], extra: { email: 'adopt@test' } }, uid, new Date(), null, false);
  check('first CRM adoption also protects a live card', (await q('SELECT name, status FROM leads WHERE id = $1', [provisional.id])).rows[0], { name: 'Original', status: 'in_flight' });

  for (const hit of [...COUNTRIES.values(), ...DIAL_CODES.values()]) assert.ok(hit.timezone, 'every mapped country has a named zone');
  for (const [country, winter, summer] of [['United Kingdom', 0, 1], ['United States', -5, -4], ['Australia', 11, 10]]) {
    check(country + ' offsets follow DST', ['2026-01-15', '2026-07-15'].map((d) => resolveLead({ country }, new Date(d + 'T12:00:00Z')).offset), [winter, summer]);
  }
  for (const [zone, now, want] of [
    ['Europe/London', '2026-03-28T12:00:00Z', '2026-03-29T09:00:00.000Z'],
    ['America/New_York', '2026-10-31T12:00:00Z', '2026-11-01T15:00:00.000Z'],
    ['Australia/Sydney', '2026-10-03T02:00:00Z', '2026-10-03T23:00:00.000Z'],
  ]) {
    const value = leadLocalAt(null, 1, 10, zone, new Date(now));
    check(zone + ' callback keeps 10:00 across DST', new Date(value).toISOString(), want);
    assert.match(describeLater(value, null, zone), /10:00/);
  }
  check('SQL uses the zone at the call date', (await q(`SELECT EXTRACT(HOUR FROM ${localClockSQL('l', "'2026-03-29T09:00:00Z'::timestamptz")})::int AS hour
    FROM leads l WHERE id = $1`, [l.id])).rows[0].hour, 10);
  assert.ok((await q(`SELECT ${offsetSQL()} AS off FROM leads l WHERE id = $1`, [l.id])).rows[0].off != null);
  // Put numeric-offset fallback fixtures at local noon, independent of the machine's current hour.
  const offset = 12 - new Date().getUTCHours();
  for (const mins of [10, 15, 120]) {
    const item = await lead({ phones: ['+442079460001', '+442079460002', '+442079460003'] });
    await q("UPDATE leads SET timezone = NULL, utc_offset = $2, retry_minutes = $3::int, next_call_at = now() + $3::int * interval '1 minute' WHERE id = $1", [item.id, offset, mins]);
  }
  const overview = await queueOverview(uid, { per: 50 });
  check('queue groups describe the actual retry delay', overview.later.filter((g) => g.key.startsWith('gap:')).map((g) => g.retryMinutes).sort((a, b) => a - b), [10, 15, 120]);
  check('three-number preview exposes nine-attempt limit', overview.later.find((g) => g.key === 'gap:15').leads.find((x) => x.phones.length === 3).attemptLimit, 9);

  process.env.HUBSPOT_TOKEN = 'test';
  await Promise.all([logCall(c.id), logCall(c.id)]);
  await processCallSync(c.id); // drain any version queued while the first writer was working
  check('concurrent HubSpot writes create one activity', creates, 1);
  patchFails = true;
  await logCall(c.id);
  check('a failed PATCH stays durably queued', (await q('SELECT attempts FROM hubspot_jobs WHERE call_id = $1', [c.id])).rows[0].attempts, 1);
  patchFails = false;
  const crmRestart = await import('../src/lib/hubspotCalls.js?restart');
  await crmRestart.processCallSync(c.id);
  check('retry after worker restart clears the job', (await q('SELECT count(*)::int AS n FROM hubspot_jobs WHERE call_id = $1', [c.id])).rows[0].n, 0);
  check('retry PATCH did not create another call', creates, 1);
  const ambiguous = await call(await lead(), { disposition: 'no_answer' });
  createMode = 'lost-response';
  await logCall(ambiguous.id);
  check('uncertain create stays queued', (await q('SELECT count(*)::int AS n FROM hubspot_jobs WHERE call_id = $1', [ambiguous.id])).rows[0].n, 1);
  searchFails = true;
  await processCallSync(ambiguous.id);
  check('failed reconciliation does not permit another create', [(await q('SELECT hubspot_create_started_at FROM calls WHERE id = $1', [ambiguous.id])).rows[0].hubspot_create_started_at != null, creates], [true, 2]);
  searchFails = false;
  createMode = 'ok';
  await crmRestart.processCallSync(ambiguous.id);
  check('accepted POST with lost response is reconciled without duplicate', [creates, (await q('SELECT hubspot_call_id FROM calls WHERE id = $1', [ambiguous.id])).rows[0].hubspot_call_id], [2, 'hs-2']);
  assert.ok(patches >= 2);
  console.log('\nAll reliability regression checks passed');
} finally {
  await new Promise((resolve) => http.close(resolve));
  await pool.end();
}
