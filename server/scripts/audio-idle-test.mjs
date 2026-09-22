import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
if (process.env.HANS_TEST_DATABASE !== 'isolated') throw new Error('Use npm test for an isolated database');
Object.assign(process.env, { PLIVO_AUTH_ID: 'MAtest', PLIVO_AUTH_TOKEN: 'test-token' });
const requests = [];
let fail = false;
globalThis.fetch = async (url, init) => {
  assert.equal(new URL(url).hostname, 'api.plivo.com');
  assert.equal(init.method, 'DELETE');
  requests.push(new URL(url).pathname);
  return fail ? Response.json({ error: 'temporary failure' }, { status: 503 }) : new Response(null, { status: 204 });
};
const { pool, q } = await import('../src/db/pool.js');
await q(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
const { disconnectIdleAudio } = await import('../src/lib/audioIdle.js');
const { reserveBurst } = await import('../src/lib/sessionState.js');
const { activeBurst } = await import('../src/state.js');
const { setIo } = await import('../src/io.js');
const events = [];
setIo({ to: room => ({ emit: (name, body) => events.push({ room, name, body }) }) });
let seq = 0;
async function rep(age = 180, mode = 'browser') {
  const id = 'rep-' + ++seq;
  const { rows: [u] } = await q(`INSERT INTO users(email,password_hash,audio_mode,rep_connected,telnyx_session_call_id)
    VALUES ($1,'unused',$2,true,$3) RETURNING id`, [id + '@test.local', mode, id]);
  await q(`INSERT INTO plivo_calls(id,call_uuid,state,created_at) VALUES ($1,$2,$3,now() - ($4 * interval '1 second'))`,
    [id, id + '-uuid', JSON.stringify({ kind: 'rep', userId: u.id }), age]);
  return { id, userId: u.id };
}
async function customer(r, kind = 'lead', endedSeconds = null) {
  const id = 'customer-' + ++seq;
  await q(`INSERT INTO plivo_calls(id,state,created_at,ended_at) VALUES ($1,$2,now() - interval '10 minutes',
    CASE WHEN $3::int IS NULL THEN NULL ELSE now() - ($3 * interval '1 second') END)`,
    [id, JSON.stringify({ kind, userId: r.userId }), endedSeconds]);
  return id;
}
const stopped = r => requests.some(p => p.endsWith('/Call/' + r.id + '-uuid/'));
const pass = label => console.log('PASS ' + label);
try {
  const idle = await rep();
  const fresh = await rep(60);
  const handset = await rep(600, 'phone');
  const live = await rep(600); await customer(live);
  const inbound = await rep(600); await customer(inbound, 'inbound');
  const recent = await rep(600); await customer(recent, 'lead', 30);
  const outcome = await rep(600); await customer(outcome, 'lead', 180);
  const { rows: [b] } = await q('INSERT INTO bursts(user_id) VALUES ($1) RETURNING id', [outcome.userId]);
  const { rows: [c] } = await q('INSERT INTO calls(burst_id,duration,notes) VALUES ($1,17,$2) RETURNING id', [b.id, 'Keep this draft']);
  activeBurst.set(outcome.userId, b.id);
  const reserved = await rep(600); assert.equal(await reserveBurst(reserved.userId), null);
  activeBurst.delete(reserved.userId); // persisted grace also works on another worker / after restart
  const inFlight = await rep(600); activeBurst.set(inFlight.userId, 0);
  const pending = await rep(600);
  const { rows: [pb] } = await q('INSERT INTO bursts(user_id) VALUES ($1) RETURNING id', [pending.userId]);
  await q('INSERT INTO calls(burst_id) VALUES ($1)', [pb.id]);
  await disconnectIdleAudio();
  assert.ok(stopped(idle)); assert.ok(stopped(outcome));
  for (const r of [fresh, handset, live, inbound, recent, reserved, inFlight, pending]) assert.equal(stopped(r), false, r.id);
  assert.equal((await q('SELECT rep_connected FROM users WHERE id=$1', [idle.userId])).rows[0].rep_connected, false);
  assert.equal(await reserveBurst(idle.userId), 'audioOff');
  const saved = (await q('SELECT duration,disposition,notes FROM calls WHERE id=$1', [c.id])).rows[0];
  assert.deepEqual(saved, { duration: 17, disposition: null, notes: 'Keep this draft' });
  assert.ok(events.some(e=>e.name === 'rep:disconnected' && e.body.cause === 'idle_timeout'));
  pass('idle browser audio stops; recent connections, ringing/live calls, inbound calls, phone mode and reservations survive');
  pass('pending outcomes and notes survive; disconnected audio cannot start another dial');

  // Expiry is driven by persisted timestamps, including after a restart; no browser heartbeat needed.
  await q("UPDATE plivo_calls SET ended_at=now() - interval '3 minutes' WHERE state->>'kind' <> 'rep' AND state->>'userId'=$1", [String(live.userId)]);
  await disconnectIdleAudio();
  assert.ok(stopped(live));
  pass('customer hangup starts the idle grace period, then idle audio expires');

  const retry = await rep();
  fail = true;
  await disconnectIdleAudio();
  assert.ok((await q('SELECT idle_disconnect_at FROM plivo_calls WHERE id=$1', [retry.id])).rows[0].idle_disconnect_at);
  assert.equal((await q('SELECT telnyx_session_call_id FROM users WHERE id=$1', [retry.userId])).rows[0].telnyx_session_call_id, retry.id);
  // Replace audio before retry. Retrying the old hangup must never clear or hang up the replacement.
  await q(`INSERT INTO plivo_calls(id,call_uuid,state) VALUES ('replacement','replacement-uuid',$1)`, [JSON.stringify({ kind:'rep', userId:retry.userId })]);
  await q("UPDATE users SET telnyx_session_call_id='replacement',rep_connected=true,audio_activity_at=now() WHERE id=$1", [retry.userId]);
  fail = false;
  const before = requests.length;
  await disconnectIdleAudio();
  assert.ok(requests.slice(before).some(p=>p.endsWith('/Call/' + retry.id + '-uuid/')));
  assert.equal(requests.some(p=>p.endsWith('/Call/replacement-uuid/')),false);
  assert.equal((await q('SELECT rep_connected FROM users WHERE id=$1', [retry.userId])).rows[0].rep_connected,true);
  pass('failed hangup retries from persisted state without touching a replacement session');
} finally { await pool.end(); }
