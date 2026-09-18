// Cost capture, recording, the dashboard's metrics and HubSpot call logging, end to end against a
// throwaway `scratch` schema with Plivo and HubSpot stubbed at the fetch layer. Places no calls,
// needs no tokens. Usage (from server/):
//   node scripts/admin-test.mjs
if (process.env.HANS_TEST_DATABASE !== 'isolated') throw new Error('Run npm test from server/ to use the disposable database.');
import { readFileSync } from 'node:fs';

const base = process.env.DATABASE_URL;
process.env.DATABASE_URL = base + (base.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=scratch');
Object.assign(process.env, { PLIVO_AUTH_ID: 'MAtest', PLIVO_AUTH_TOKEN: 'test-token', PLIVO_APPLICATION_ID: 'app-test', PUBLIC_URL: 'https://dialer.test', HUBSPOT_TOKEN: 'pat-test', RECORD_CALLS: 'true' });

// --- stubs: Plivo (the SDK uses global fetch) and HubSpot -----------------------------------------
const calls = { recordStart: 0, recList: 0, recGet: 0, hsCallPost: [], hsCallPatch: [], hsFiles: 0, hsContactPost: [], hsSearch: 0 };
let recordStartStatus = 200;
let hsCallStatus = 200;
let contactsByPhone = {};   // digits -> id, for the search stub
let dialResponse = null;    // what POST /v2/calls answers (3d)
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers({ 'content-type': 'application/json' }), arrayBuffer: async () => new ArrayBuffer(0) });

globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const m = init.method ?? 'GET';
  const root = 'https://api.plivo.com/v1/Account/MAtest/';
  if (u === root + 'Call/' && m === 'POST') return dialResponse();
  if (u.startsWith(root + 'Call/') && u.endsWith('/Play/')) return json({ message: 'ok' });
  if (u.startsWith(root + 'Call/') && u.endsWith('/Record/')) { calls.recordStart++; return recordStartStatus === 200 ? json({ message: 'recording started' }) : json({ error: 'call not found' }, recordStartStatus); }
  if (u.startsWith(root + 'Recording/rec-1/')) { calls.recGet++; return json({ recording_id: 'rec-1', recording_url: 'https://s3.test/rec-1.mp3' }); }
  if (u.startsWith(root + 'Recording/?')) { calls.recList++; return json({ objects: [{ recording_id: 'rec-1', call_uuid: new URL(u).searchParams.get('call_uuid'), recording_url: 'https://s3.test/rec-1.mp3' }] }); }
  if (u === root) return json({ cash_credits: '12.34' });
  if (u === 'https://s3.test/rec-1.mp3') return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('MP3BYTES').buffer, headers: new Headers() };
  if (u.startsWith('https://api.hubapi.com/crm/v3/properties/calls/hs_call_disposition')) return json({ options: [{ label: 'Connected', value: 'guid-connected' }, { label: 'No answer', value: 'guid-noanswer' }] });
  if (u.startsWith('https://api.hubapi.com/crm/v3/objects/contacts/search')) {
    calls.hsSearch++; const q = JSON.parse(init.body).query;
    const hit = Object.entries(contactsByPhone).find(([d]) => d.endsWith(q));
    return json({ results: hit ? [{ id: hit[1], properties: { phone: '+' + hit[0] } }] : [] });
  }
  if (u === 'https://api.hubapi.com/crm/v3/objects/contacts' && m === 'POST') { calls.hsContactPost.push(JSON.parse(init.body)); return json({ id: '900' }); }
  if (u === 'https://api.hubapi.com/crm/v3/objects/calls' && m === 'POST') { calls.hsCallPost.push(JSON.parse(init.body)); return hsCallStatus === 200 ? json({ id: 'hscall-' + calls.hsCallPost.length }) : json({ message: 'forbidden' }, hsCallStatus); }
  if (u.startsWith('https://api.hubapi.com/crm/v3/objects/calls/') && m === 'PATCH') { calls.hsCallPatch.push({ url: u, body: JSON.parse(init.body) }); return json({}); }
  if (u === 'https://api.hubapi.com/files/v3/files' && m === 'POST') { calls.hsFiles++; return json({ id: 'file-1', url: 'https://f.hubspotusercontent.net/rec.mp3' }); }
  throw new Error('unstubbed fetch ' + m + ' ' + u);
};

const { pool, q } = await import('../src/db/pool.js');
const { onCallCost, balance } = await import('../src/lib/costs.js');
const { startLeadRecording, onRecordingSaved, onRecordingError, recordingUrl } = await import('../src/lib/recordings.js');
const { logCall, attachRecording, processCallSync } = await import('../src/lib/hubspotCalls.js');
const hubspot = await import('../src/lib/hubspot.js');
const m = await import('../src/lib/metrics.js');
const { setSetting } = await import('../src/lib/settings.js');

let fails = 0;
const ok = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fresh scratch schema ---------------------------------------------------------------------
await q('DROP SCHEMA IF EXISTS scratch CASCADE');
await q('CREATE SCHEMA scratch');
await q(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
const { rows: [rep] } = await q(`INSERT INTO users (email, password_hash, hubspot_owner_id) VALUES ('himanshu@hansmatrimony.com', 'x', 94828863) RETURNING id`);
const { rows: [adm] } = await q(`INSERT INTO users (email, password_hash, role) VALUES ('marketing@hansmatrimony.com', 'x', 'admin') RETURNING id, role`);
ok('admin role column', adm.role, 'admin');

const lead = async (hs, phone, extra = {}) => (await q(
  `INSERT INTO leads (hubspot_contact_id, name, phone, phones, segment, user_id, status, country) VALUES ($1, $2, $3, ARRAY[$3], $4, $5, 'queued', $6) RETURNING id`,
  [hs, extra.name ?? null, phone, extra.segment ?? 'non_india', rep.id, extra.country ?? null])).rows[0].id;
const call = async (leadId, ccid, at, o = {}) => { const id = (await q(
  `WITH b AS (INSERT INTO bursts (user_id) VALUES ($1) RETURNING id)
   INSERT INTO calls (lead_id, burst_id, telnyx_call_id, from_number, to_number, started_at, answered_at, duration, disposition, sub_outcome, notes, dispositioned_at)
   SELECT $2, b.id, $3, '+13024170301', $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10, $11::timestamptz FROM b RETURNING id`,
  [rep.id, leadId, ccid, o.to ?? '+447738284594', at, o.answered ?? null, o.duration ?? null, o.disposition ?? null, o.sub ?? null, o.notes ?? null, o.dispositioned ?? null])).rows[0].id;
  await q('INSERT INTO plivo_calls(id, call_uuid, state) VALUES ($1, $1, $2)', [ccid, JSON.stringify({ kind: 'lead', userId: rep.id })]);
  return id;
};
const row = (id) => q('SELECT * FROM calls WHERE id = $1', [id]).then((r) => r.rows[0]);
const costRow = (ccid) => q('SELECT kind, user_id, call_id, total_cost::float AS total_cost, status, jsonb_array_length(parts)::int AS parts FROM telnyx_costs WHERE call_control_id = $1', [ccid]).then((r) => r.rows[0]);

// --- 1. cost capture --------------------------------------------------------------------------
const L1 = await lead('101', '+447738284594', { name: 'L. Corcoran', country: 'United Kingdom' });
const C1 = await call(L1, 'cc-1', '2026-09-09T10:00:00Z', { answered: '2026-09-09T10:00:20Z', duration: 90, disposition: 'connected', sub: 'interested', notes: 'wants a demo', dispositioned: '2026-09-09T10:02:05Z' });
const costEvt = (ccid, extra = {}) => ({ call_control_id: ccid, call_leg_id: 'leg-' + ccid, total_cost: '0.0123', billed_duration_secs: 120, status: 'success', cost_parts: [{ call_part: 'call-control', cost: '0.0040', currency: 'USD', rate: '0.002', billed_duration_secs: 120 }, { call_part: 'sip-trunking', cost: '0.0083', currency: 'USD', rate: '0.005', billed_duration_secs: 100 }], ...extra });
await onCallCost(costEvt('cc-1'), { kind: 'lead', userId: rep.id }, '2026-09-09T10:03:00Z');
ok('lead-leg cost lands with its calls row', await costRow('cc-1'), { kind: 'lead', user_id: rep.id, call_id: C1, total_cost: 0.0123, status: 'success', parts: 2 });
await onCallCost(costEvt('cc-1'), { kind: 'lead', userId: rep.id }, '2026-09-09T10:03:00Z');
ok('redelivery is still one row', (await q('SELECT count(*)::int AS n FROM telnyx_costs')).rows[0].n, 1);
await onCallCost(costEvt('cc-2', { status: 'error', total_cost: null, cost_parts: [] }), { kind: 'lead', userId: rep.id }, '2026-09-09T10:04:00Z');
await onCallCost(costEvt('cc-2', { total_cost: '0.0050' }), { kind: 'lead', userId: rep.id }, '2026-09-09T10:05:00Z');
ok('an error cost followed by a success: success wins', (await costRow('cc-2')).total_cost, 0.005);
await onCallCost(costEvt('rep-1', { total_cost: '0.4000' }), { kind: 'rep', userId: rep.id }, '2026-09-09T11:00:00Z');
ok('rep session leg: attributed to the rep, no call', await costRow('rep-1'), { kind: 'rep', user_id: rep.id, call_id: null, total_cost: 0.4, status: 'success', parts: 2 });
await onCallCost(costEvt('nostate', { total_cost: '0.0010' }), null, '2026-09-09T11:00:00Z');
ok('a leg with no client_state still counts', (await costRow('nostate')).kind, null);
ok('balance parsed', (await balance()).availableCredit, 12.34);

// --- 2. recording -----------------------------------------------------------------------------
await startLeadRecording(C1, 'cc-1', { kind: 'lead', userId: rep.id, burstId: 1, leadId: L1 });
let r = await row(C1);
ok('record_start called, status started, token minted', [calls.recordStart, r.recording_status, /^[0-9a-f]{32}$/.test(r.recording_token)], [1, 'started', true]);
await onRecordingSaved({ call_leg_id: 'leg-1', call_session_id: 'sess-1', recording_started_at: '2026-09-09T10:00:21Z', recording_ended_at: '2026-09-09T10:01:50Z', recording_urls: { mp3: 'https://expires.test/x' } }, { kind: 'lead', userId: rep.id, callId: C1 });
await processCallSync(C1); // drain the durable job, as the background worker does
r = await row(C1);
ok('recording.saved: saved, leg id kept, expiring url not stored', [r.recording_status, r.recording_leg_id, r.recording_id], ['saved', 'leg-1', 'rec-1']);
ok('...and the file was copied into HubSpot Files', [calls.hsFiles, r.hubspot_file_url], [1, 'https://f.hubspotusercontent.net/rec.mp3']);
await onRecordingError({ call_control_id: 'cc-1', reason: 'late error' }, { kind: 'lead', callId: C1 });
ok('a late recording.error never downgrades saved', (await row(C1)).recording_status, 'saved');
await onRecordingSaved({ call_leg_id: 'leg-zzz' }, null);
ok('saved with nothing to attach to: no throw', true, true);
recordStartStatus = 422;
const C2 = await call(L1, 'cc-2', '2026-09-09T12:00:00Z', { answered: '2026-09-09T12:00:10Z', duration: 30 });
await startLeadRecording(C2, 'cc-2', { kind: 'lead', userId: rep.id, burstId: 2, leadId: L1 });
ok('record_start failure is recorded, never thrown', (await row(C2)).recording_status, 'error');
recordStartStatus = 200;
const before = calls.recGet;
await recordingUrl(await row(C1));
ok('a cached recording id goes straight to retrieve', calls.recGet - before, 1);

// --- 3. HubSpot call logging ------------------------------------------------------------------
await logCall(C1);
r = await row(C1);
const posted = calls.hsCallPost[0];
ok('engagement created and remembered', [r.hubspot_call_id, calls.hsCallPost.length], ['hscall-1', 1]);
ok('associated to the contact, call_to_contact', posted.associations[0], { to: { id: '101' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }] });
ok('the fields CallHippo pushes', [posted.properties.hs_call_direction, posted.properties.hs_call_status, posted.properties.hs_call_duration, posted.properties.hs_call_disposition, posted.properties.hs_activity_type, posted.properties.hs_call_body.split(' · Hans call reference: ')[0], posted.properties.hubspot_owner_id],
  ['OUTBOUND', 'COMPLETED', '90000', 'guid-connected', 'Interested', 'Interested · wants a demo', '94828863']);
ok('recording link is updated to the HubSpot Files copy', calls.hsCallPatch.at(-1).body.properties.hs_call_recording_url, 'https://f.hubspotusercontent.net/rec.mp3');
await logCall(C1);
ok('logging twice is a no-op', calls.hsCallPost.length, 1);

const LM = await lead('manual-+12025550185', '+12025550185');
const C3 = await call(LM, 'cc-3', '2026-09-09T13:00:00Z', { to: '+12025550185', disposition: 'no_answer' });
await logCall(C3);
ok('unknown number, toggle off: searched HubSpot, nothing pushed', [calls.hsSearch, calls.hsCallPost.length, (await row(C3)).hubspot_error], [1, 1, 'no HubSpot contact for this number']);
contactsByPhone = { '12025550185': '777' };
await logCall(C3);
ok('number found in HubSpot by phone: adopted and logged', [(await q('SELECT hubspot_contact_id FROM leads WHERE id = $1', [LM])).rows[0].hubspot_contact_id, calls.hsCallPost.length, calls.hsCallPost[1].properties.hs_call_status], ['777', 2, 'NO_ANSWER']);

const LU = await lead('manual-+33612345678', '+33612345678', { name: 'Marie Curie', country: 'France' });
const C4 = await call(LU, 'cc-4', '2026-09-09T14:00:00Z', { to: '+33612345678', disposition: 'no_answer' });
await logCall(C4);
ok('unknown to HubSpot, toggle off: not created', calls.hsContactPost.length, 0);
await setSetting('hubspot_create_contacts', true);
await q('UPDATE calls SET hubspot_error = NULL WHERE id = $1', [C4]);
await logCall(C4);
ok('toggle on: contact created with the lead\'s name, then logged', [calls.hsContactPost[0].properties.firstname, calls.hsContactPost[0].properties.lastname, (await q('SELECT hubspot_contact_id FROM leads WHERE id = $1', [LU])).rows[0].hubspot_contact_id, calls.hsCallPost.length], ['Marie', 'Curie', '900', 3]);

hsCallStatus = 403;
const C5 = await call(L1, 'cc-5', '2026-09-09T15:00:00Z', { disposition: 'no_answer' });
await logCall(C5);
ok('403: write health says so, nothing thrown', [hubspot.status().write.ok, /crm.objects.contacts.write/.test(hubspot.status().write.error)], [false, true]);
hsCallStatus = 200;

// recording that saves AFTER the engagement exists -> PATCH
const C6 = await call(L1, 'cc-6', '2026-09-09T16:00:00Z', { answered: '2026-09-09T16:00:05Z', duration: 40, disposition: 'connected', dispositioned: '2026-09-09T16:01:00Z' });
await logCall(C6);
await startLeadRecording(C6, 'cc-6', { kind: 'lead', userId: rep.id, burstId: 6, leadId: L1 });
await onRecordingSaved({ call_leg_id: 'leg-1' }, { kind: 'lead', callId: C6 });
await sleep(900); // list -> download -> upload -> PATCH, four stubbed hops
ok('late recording is PATCHed onto the existing engagement', calls.hsCallPatch.at(-1)?.body?.properties?.hs_call_recording_url, 'https://f.hubspotusercontent.net/rec.mp3');

// --- 3b. a rep who never presses an outcome tile must not make the call vanish ------------------
const C7 = await call(L1, 'cc-7b', '2026-09-09T17:00:00Z', { answered: '2026-09-09T17:00:04Z', duration: 25 }); // answered, no disposition
const postsBefore = calls.hsCallPost.length;
await logCall(C7);
const pending = calls.hsCallPost.at(-1);
ok('answered but never dispositioned: logged anyway at hangup',
  [calls.hsCallPost.length - postsBefore, pending?.properties?.hs_call_status, pending?.properties?.hs_call_duration, 'hs_call_disposition' in (pending?.properties ?? {})],
  [1, 'COMPLETED', '25000', false]);
ok('...and it says so on the timeline', pending?.properties?.hs_call_title, 'Hans dialer · Answered — no outcome saved yet');
await q(`UPDATE calls SET disposition = 'connected', sub_outcome = 'interested', notes = 'came back to it' WHERE id = $1`, [C7]);
const patchesBefore = calls.hsCallPatch.length;
await logCall(C7);
const upd = calls.hsCallPatch.at(-1);
ok('the outcome later updates that same activity, no second one',
  [calls.hsCallPost.length - postsBefore, calls.hsCallPatch.length - patchesBefore, upd?.body?.properties?.hs_call_disposition, upd?.body?.properties?.hs_activity_type, upd?.body?.properties?.hs_call_body?.split(' · Hans call reference: ')[0]],
  [1, 1, 'guid-connected', 'Interested', 'Interested · came back to it']);
const stillRinging = await call(L1, 'cc-7c', '2026-09-09T17:30:00Z', {}); // never answered, no outcome
await logCall(stillRinging);
ok('a leg still in flight is not logged', calls.hsCallPost.length - postsBefore, 1);
await q(`UPDATE calls SET disposition = 'cancelled' WHERE id = $1`, [stillRinging]);
await logCall(stillRinging);
ok('a cancelled burst leg is never logged', calls.hsCallPost.length - postsBefore, 1);

// --- 3c. a number Plivo calls invalid must stop being retried ---------------------------------
// The two strings below are verbatim from production, where 11 dead numbers ate 16 of 73 dials in a
// day without ever consuming an attempt.
const { isInvalidDestination } = await import('../src/plivo.js');
const { releaseLead } = await import('../src/lib/queue.js');
const REAL = 'to parameter is invalid';
ok('Plivo invalid destination is recognised as a permanently bad number', isInvalidDestination(new Error(REAL)), true);
ok('invalid destination is recognised', isInvalidDestination(new Error('invalid destination number')), true);
ok('a timeout is NOT: it must keep its attempt', isInvalidDestination(new Error('request to https://api.plivo.com timed out')), false);
ok('nor is a rate limit', isInvalidDestination(new Error('429 {"errors":[{"code":10015,"detail":"Too many requests"}]}')), false);
ok('nor a destination missing from the outbound voice profile — that is our config, fixable',
  isInvalidDestination(new Error('403 {"errors":[{"code":10012,"detail":"Destination not whitelisted on the outbound voice profile"}]}')), false);
// and the lead really does move on: 'invalid' rolls to the next number, or stops a one-number lead
const LB = await lead('manual-+1995157410', '+1995157410');
await releaseLead(LB, 'invalid');
const bad = (await q('SELECT status, attempt_count FROM leads WHERE id = $1', [LB])).rows[0];
ok('a one-number lead with a dead number stops instead of looping', [bad.status, bad.attempt_count], ['stopped', 1]);

// --- 3d. when nothing rang, the rep reads why - not "no legs could be placed" --------------------
const { providerDetail } = await import('../src/plivo.js');
const { startBurst } = await import('../src/lib/burst.js');
ok('the one readable line of a Plivo error', providerDetail(new Error(REAL)), 'to parameter is invalid');
await q("INSERT INTO plivo_calls(id, call_uuid, state) VALUES ('rep-leg-1', 'rep-leg-1', '{}')");
await q('UPDATE users SET telnyx_session_call_id = $2 WHERE id = $1', [rep.id, 'rep-leg-1']);
const leadRow = async (id) => (await q('SELECT * FROM leads WHERE id = $1', [id])).rows[0];
const LC = await lead('manual-+98136252291', '+98136252291');
dialResponse = () => json({ error: 'to parameter is invalid' }, 400);
ok('an invalid number: the plain-words refusal, in the same words as the tape row',
  await startBurst(rep.id, [await leadRow(LC)], '+13024170301').then(() => null, (e) => e.message), 'That is not a valid phone number — the lead moves on.');
ok('the lead stopped, with one failed call on record',
  [(await leadRow(LC)).status, (await q(`SELECT count(*)::int n FROM calls WHERE lead_id = $1 AND disposition = 'failed'`, [LC])).rows[0].n], ['stopped', 1]);
const LD = await lead('manual-+447700900123', '+447700900123');
dialResponse = () => json({ error: 'Service unavailable' }, 422);
ok('any other refusal carries Plivo\'s reason and says the lead comes back',
  await startBurst(rep.id, [await leadRow(LD)], '+13024170301').then(() => null, (e) => e.message), 'The call could not be placed — Service unavailable. Back in the queue in 10 min.');
const back = (await q(`SELECT status, round(EXTRACT(EPOCH FROM (next_call_at - now())) / 60)::int AS mins FROM leads WHERE id = $1`, [LD])).rows[0];
ok('and it really is back in the queue in 10 min', back, { status: 'queued', mins: 10 });
await q('DELETE FROM calls WHERE lead_id IN ($1, $2)', [LC, LD]); // today's failed dials would skew the dated metrics below

// --- 4. metrics: IST day, segments, wrap median -------------------------------------------------
const LI = await lead('202', '+919876543210', { segment: 'india', country: 'India' });
await call(LI, 'cc-7', '2026-09-08T18:00:00Z', { disposition: 'no_answer' }); // 23:30 IST on 8 Sep
await call(LI, 'cc-8', '2026-09-08T19:00:00Z', { disposition: 'no_answer' }); // 00:30 IST on 9 Sep
const f9 = { from: '2026-09-09', to: '2026-09-09', segment: null, rep: null };
const s = await m.summary(f9);
ok('IST day: 18:00Z is yesterday, 19:00Z is today', [s.previous.dials, s.current.dials >= 1], [1, true]);
ok('segment split reaches the hero tile', [s.current.in_dials, s.current.ni_connects >= 2], [1, true]);
const sni = await m.summary({ ...f9, segment: 'non_india' });
ok('segment filter excludes India', sni.current.in_dials, 0);
ok('wrap median ignores calls with no outcome time', typeof s.current.wrap_median, 'number');
const days = await m.byDay(f9, 3);
ok('by-day is zero-filled and ends on the period', [days.length, days.at(-1).day, days[1].dials], [3, '2026-09-09', 1]);
const oc = await m.outcomes(f9);
ok('outcomes: connected without a tile is its own row', oc.some((o) => o.outcome === 'connected_unspecified'), true);
const rp = await m.reps(f9);
ok('reps: admin is not a rep row', rp.map((x) => x.email), ['himanshu@hansmatrimony.com']);
const cl = await m.calls(f9, { q: 'corcoran' });
ok('call log search by name', cl.rows.every((x) => x.name === 'L. Corcoran') && cl.total >= 1, true);
const cl2 = await m.calls(f9, { q: '+1 202 555 0185' });
ok('call log search by number ignores formatting', cl2.total, 1);
const ld = await m.leadDetail(L1);
ok('lead drawer has every attempt with recording tokens', ld.attempts.length >= 3 && ld.attempts.some((a) => a.recording_token), true);

// --- 5. wallet ----------------------------------------------------------------------------------
await q(`UPDATE calls SET disposition = 'cancelled' WHERE telnyx_call_id = 'cc-2'`);
const w = await m.wallet('2026-09-09', '2026-09-09');
ok('spend includes the cancelled leg, the rep leg and the stateless leg', w.spend.toFixed(4), (0.0123 + 0.005 + 0.4 + 0.001).toFixed(4));
ok('...but dials do not count the cancelled leg', w.dials, (await q(`SELECT count(*)::int AS n FROM calls WHERE started_at >= '2026-09-08T18:30:00Z' AND disposition IS DISTINCT FROM 'cancelled'`)).rows[0].n);
ok('rep share separated', w.rep_spend, 0.4);
ok('parts breakdown by product', w.parts.map((p) => p.part).sort(), ['call-control', 'sip-trunking']);

console.log(fails ? `\n${fails} failed` : '\nall passed');
await pool.end();
process.exit(fails ? 1 : 0);
