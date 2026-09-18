// Multi-number leads: CSV parsing and the alternate-number cascade, end to end against a throwaway
// `scratch` schema on the configured database. Places no calls. Usage (from server/):
//   node scripts/cascade-test.mjs
if (process.env.HANS_TEST_DATABASE !== 'isolated') throw new Error('Run npm test from server/ to use the disposable database.');
import { readFileSync } from 'node:fs';

// Point every pool connection at the scratch schema before anything imports pool.js, so the real
// tables are never touched.
const base = process.env.DATABASE_URL;
process.env.DATABASE_URL = base + (base.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=scratch');

const { pool, q } = await import('../src/db/pool.js');
const { importCsv } = await import('../src/lib/import.js');
const { releaseLead } = await import('../src/lib/queue.js');

let fails = 0;
const ok = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// --- fresh scratch schema -----------------------------------------------------------------
await q('DROP SCHEMA IF EXISTS scratch CASCADE');
await q('CREATE SCHEMA scratch');
await q(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
const { rows: [u] } = await q(`INSERT INTO users (email, password_hash) VALUES ('rep@test', 'x') RETURNING id`);
const uid = u.id;

// --- 2. import the real format ------------------------------------------------------------
const CSV = `Company name,POC Name,Designation,Email,Country,Phone Number,Alternate number 1,Alternate number 2,LinkedIn Id
Acme Partners,Rahul Mehta,Head of Partnerships,rahul@acme.com,India,+919810012345,+919810099999,+442079460011,https://linkedin.com/in/rahulmehta
Brightline,Sara Okafor,BD Lead,sara@brightline.io,United Kingdom,+442079460022,+442079460033,,linkedin.com/in/saraokafor
Solo Corp,Tom Blake,CEO,tom@solo.co,United States,+13024170300,,,
Dupe Ltd,Ann Roy,COO,ann@dupe.com,India,+919820011111,+919820011111,,
NoCountry SA,Luc Berg,Partner,luc@nc.eu,,+442079460044,,,
Badalt Inc,Mo Khan,VP,mo@badalt.com,India,+919830022222,not-a-number,+919830033333,`;

const r = await importCsv(Buffer.from(CSV), uid);
// withAlternates counts leads that ended up with more than one usable number, so Dupe Ltd - whose
// alternate column just repeats its primary - is correctly not one of them.
ok('import counts', { ins: r.inserted, upd: r.updated, alt: r.withAlternates, skip: r.skipped.length }, { ins: 6, upd: 0, alt: 3, skip: 0 });
ok('unparseable alternate warned, others kept', r.warnings.filter((w) => /unusable alternate/.test(w.reason)).length, 1);

const leads = async () => (await q(`SELECT name, phone, phones, phone_idx, country, utc_offset, segment, extra FROM leads WHERE user_id = $1 ORDER BY id`, [uid])).rows;
const L = await leads();
ok('POC Name -> name', L[0].name, 'Rahul Mehta');
ok('Designation -> extra.title', L[0].extra.title, 'Head of Partnerships');
ok('LinkedIn Id -> extra.linkedin', L[0].extra.linkedin, 'https://linkedin.com/in/rahulmehta');
ok('3 numbers in cascade order', L[0].phones, ['+919810012345', '+919810099999', '+442079460011']);
ok('phone = phones[1]', [L[0].phone, L[0].phone_idx], ['+919810012345', 1]);
ok('single-number lead', L[2].phones, ['+13024170300']);
ok('duplicate alternate deduped', L[3].phones, ['+919820011111']);
ok('blank country falls back to the +44 dial code', [L[4].utc_offset, L[4].segment], ['1.00', 'non_india']);
ok('bad alternate dropped, good one kept', L[5].phones, ['+919830022222', '+919830033333']);
ok('no NULL elements in any phones array', (await q(`SELECT count(*)::int n FROM leads WHERE array_position(phones, NULL) IS NOT NULL`)).rows[0].n, 0);

// --- 3. cascade ---------------------------------------------------------------------------
const id = (await q(`SELECT id FROM leads WHERE name = 'Rahul Mehta'`)).rows[0].id;
const state = async (leadId = id) => {
  const { rows: [x] } = await q(`SELECT phone, phone_idx, number_attempts, attempt_count, status,
    round(EXTRACT(EPOCH FROM (next_call_at - now())) / 60)::int AS mins FROM leads WHERE id = $1`, [leadId]);
  return x;
};
const noAnswer = async (n, leadId = id) => { for (let i = 0; i < n; i++) await releaseLead(leadId, 'no_answer'); };

await noAnswer(2);
let s = await state();
ok('2 no-answers: still on number 1, 2h gap', { i: s.phone_idx, na: s.number_attempts, mins: s.mins }, { i: 1, na: 2, mins: 120 });
await noAnswer(1);
s = await state();
ok('3rd no-answer rolls to number 2 in 15 min', { p: s.phone, i: s.phone_idx, na: s.number_attempts, st: s.status, mins: s.mins },
  { p: '+919810099999', i: 2, na: 0, st: 'queued', mins: 15 });
await noAnswer(3);
s = await state();
ok('rolls to number 3', { p: s.phone, i: s.phone_idx, ac: s.attempt_count, st: s.status }, { p: '+442079460011', i: 3, ac: 6, st: 'queued' });
await noAnswer(2);
ok('8 attempts: not exhausted yet (ceiling 9)', (await state()).status, 'queued');
await noAnswer(1);
s = await state();
ok('9th attempt exhausts the lead, nowhere left to roll', { i: s.phone_idx, ac: s.attempt_count, st: s.status }, { i: 3, ac: 9, st: 'exhausted' });

// invalid rolls immediately
const id2 = (await q(`SELECT id FROM leads WHERE name = 'Sara Okafor'`)).rows[0].id;
await releaseLead(id2, 'invalid');
s = await state(id2);
ok('"Wrong number" rolls straight to the alternate', { p: s.phone, i: s.phone_idx, na: s.number_attempts, st: s.status, mins: s.mins },
  { p: '+442079460033', i: 2, na: 0, st: 'queued', mins: 15 });
await releaseLead(id2, 'invalid');
ok('"Wrong number" on the last number stops the lead', (await state(id2)).status, 'stopped');

// single-number lead keeps today's behaviour
const id3 = (await q(`SELECT id FROM leads WHERE name = 'Tom Blake'`)).rows[0].id;
await noAnswer(5, id3);
ok('single-number lead: 5 attempts, still queued', (await state(id3)).status, 'queued');
await noAnswer(1, id3);
s = await state(id3);
ok('single-number lead exhausts at 6, never rolls', { i: s.phone_idx, ac: s.attempt_count, st: s.status }, { i: 1, ac: 6, st: 'exhausted' });

// cancelled never rolls
const id4 = (await q(`SELECT id FROM leads WHERE name = 'Mo Khan'`)).rows[0].id;
await releaseLead(id4, 'cancelled'); await releaseLead(id4, 'cancelled'); await releaseLead(id4, 'cancelled');
s = await state(id4);
ok('cancelled consumes nothing and never rolls', { i: s.phone_idx, na: s.number_attempts, ac: s.attempt_count }, { i: 1, na: 0, ac: 0 });

// --- 4. re-import preserves cascade progress ----------------------------------------------
await q(`UPDATE leads SET status = 'queued', attempt_count = 3 WHERE name = 'Rahul Mehta'`);
await importCsv(Buffer.from(CSV), uid);
s = await state();
ok('re-import keeps the lead on number 3', { p: s.phone, i: s.phone_idx }, { p: '+442079460011', i: 3 });

const REORDERED = `Company name,POC Name,Designation,Email,Country,Phone Number,Alternate number 1,Alternate number 2,LinkedIn Id
Acme Partners,Rahul Mehta,Head of Partnerships,rahul@acme.com,India,+442079460011,+919810012345,+919810099999,`;
await importCsv(Buffer.from(REORDERED), uid);
s = await state();
ok('columns reordered: follows the number by value, not position', { p: s.phone, i: s.phone_idx }, { p: '+442079460011', i: 1 });

const DROPPED = `Company name,POC Name,Designation,Email,Country,Phone Number,Alternate number 1,Alternate number 2,LinkedIn Id
Acme Partners,Rahul Mehta,Head of Partnerships,rahul@acme.com,India,+919810012345,,,`;
await importCsv(Buffer.from(DROPPED), uid);
s = await state();
ok('number dropped from the sheet: back to the primary', { p: s.phone, i: s.phone_idx }, { p: '+919810012345', i: 1 });

ok('no lead violates phone = phones[phone_idx]',
  (await q(`SELECT count(*)::int n FROM leads WHERE phone IS DISTINCT FROM phones[phone_idx]`)).rows[0].n, 0);

// email identity: same person, corrected phone number, no Record ID -> update, not duplicate
const MOVED = `Company name,POC Name,Designation,Email,Country,Phone Number,Alternate number 1,Alternate number 2,LinkedIn Id
Solo Corp,Tom Blake,CEO,tom@solo.co,United States,+13024170399,,,`;
const r2 = await importCsv(Buffer.from(MOVED), uid);
ok('corrected phone under the same email updates the lead', { ins: r2.inserted, upd: r2.updated }, { ins: 0, upd: 1 });
ok('one Tom Blake, on the new number',
  (await q(`SELECT phone FROM leads WHERE name = 'Tom Blake'`)).rows.map((x) => x.phone), ['+13024170399']);

// --- 6. keypad / tap-to-dial: the rep's own lead, never a nameless twin ----------------------
// Seen live: 30 leads each had a second 'manual-<phone>' row that releaseLead kept requeueing as a
// bare number. A hand-dialled number that a lead already carries must dial that lead.
const { claimManual } = await import('../src/lib/queue.js');
const sara = (await q(`SELECT id FROM leads WHERE name = 'Sara Okafor'`)).rows[0].id;
const rowsOn = async (p) => (await q(`SELECT count(*)::int n FROM leads WHERE user_id = $1 AND $2 = ANY(phones)`, [uid, p])).rows[0].n;
let m = await claimManual(uid, '+442079460033'); // Sara's alternate, typed by hand
ok('dialling a number a lead carries claims that lead', { id: m.id, st: m.status, p: m.phone, i: m.phone_idx, nm: m.name }, { id: sara, st: 'in_flight', p: '+442079460033', i: 2, nm: 'Sara Okafor' });
ok('and makes no second row', await rowsOn('+442079460033'), 1);
await releaseLead(sara, 'no_answer');
ok('after the call it is back in the queue, still one row', [(await state(sara)).status, await rowsOn('+442079460033')], ['queued', 1]);
m = await claimManual(uid, '+15550000001'); // a number nobody holds
ok('an unknown number becomes a plain manual lead', { key: m.hubspot_contact_id, phones: m.phones, st: m.status }, { key: 'manual-+15550000001', phones: ['+15550000001'], st: 'in_flight' });
// The one-off sweep in schema.sql stops the twins already made, and only those.
await q(`INSERT INTO leads (hubspot_contact_id, phone, phones, segment, status, user_id) VALUES ('manual-+442079460022', '+442079460022', ARRAY['+442079460022'], 'non_india', 'queued', $1)`, [uid]);
await q(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
ok('a nameless keypad twin of a real lead is stopped',
  (await q(`SELECT status, stopped_reason FROM leads WHERE hubspot_contact_id = 'manual-+442079460022'`)).rows[0], { status: 'stopped', stopped_reason: 'duplicate' });
ok('the real lead and a manual lead with no twin are untouched',
  (await q(`SELECT status FROM leads WHERE id = $1 OR hubspot_contact_id = 'manual-+15550000001' ORDER BY id`, [sara])).rows.map((x) => x.status), ['queued', 'in_flight']);

await q('DROP SCHEMA scratch CASCADE');
await pool.end();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
