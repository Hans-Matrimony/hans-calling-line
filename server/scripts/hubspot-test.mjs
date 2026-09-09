// The HubSpot inlet's reconcile logic (docs/HUBSPOT-QUEUE.md s5), end to end against a throwaway
// `scratch` schema, with HubSpot itself stubbed at the fetch layer. Places no calls and needs no
// HUBSPOT_TOKEN. Usage (from server/):
//   node scripts/hubspot-test.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';

const base = process.env.DATABASE_URL;
process.env.DATABASE_URL = base + (base.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=scratch');
process.env.HUBSPOT_TOKEN = 'pat-test';

// --- the fake portal --------------------------------------------------------------------------
// Shaped from the real Eazybe portal (id 40009480): no hs_calculated_* properties, lead status and
// lifecycle stage stored as internal values, owner ids and user ids that disagree for some people.
let PROPS = ['firstname', 'lastname', 'phone', 'mobilephone', 'country', 'email', 'company', 'jobtitle',
  'lifecyclestage', 'hs_lead_status', 'hubspot_owner_id', 'hs_updated_by_user_id', 'eazybe_dial_queue'];
const OWNERS = [
  { id: '94828863', userId: '94828863', email: 'himanshu@eazybe.com' },
  { id: '578081029', userId: '61259763', email: 'karan@eazybe.com' }, // the two id spaces disagree
];
let CONTACTS = [];
const calls = { search: 0 };

globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace('https://api.hubapi.com', '');
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  if (path.startsWith('/crm/v3/properties/contacts')) return json({ results: [
    ...PROPS.map((name) => ({ name })),
    { name: 'hs_lead_status', options: [{ value: 'NEW', label: 'New' }, { value: 'ATTEMPTED_TO_CONTACT', label: 'Day 1' }] },
    { name: 'lifecyclestage', options: [{ value: 'lead', label: 'Inbound Leads' }, { value: '1086066693', label: 'MQL' }] },
  ].filter((p) => PROPS.includes(p.name)) });

  if (path.startsWith('/crm/v3/owners')) return json({ results: OWNERS });
  if (path.startsWith('/account-info/v3/details')) return json({ portalId: 40009480 });

  if (path.startsWith('/crm/v3/objects/contacts/search')) {
    calls.search++;
    const body = JSON.parse(init.body);
    // Mirror HubSpot's semantics: filters within a group AND, groups OR.
    const match = (c, f) => {
      const v = c.properties[f.propertyName];
      if (f.operator === 'NOT_HAS_PROPERTY') return v == null || v === '';
      if (f.operator === 'EQ') return String(v ?? '') === String(f.value);
      throw new Error('unhandled operator ' + f.operator);
    };
    const results = CONTACTS.filter((c) => body.filterGroups.some((g) => g.filters.every((f) => match(c, f))));
    return json({ results, total: results.length });
  }
  throw new Error('unstubbed HubSpot path ' + path);
};

const { pool, q } = await import('../src/db/pool.js');
const { importCsv } = await import('../src/lib/import.js');
const { releaseLead } = await import('../src/lib/queue.js');
const hubspot = await import('../src/lib/hubspot.js');

let fails = 0;
const ok = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const contact = (id, props) => ({ id, properties: { hubspot_owner_id: '94828863', eazybe_dial_queue: 'true', ...props } });
const lead = (hsId) => q(
  `SELECT status, stopped_reason, attempt_count, source, name, phones, country, utc_offset, segment, extra
   FROM leads WHERE hubspot_contact_id = $1`, [hsId]).then((r) => r.rows[0]);
const counts = (r) => ({ added: r.added, resumed: r.resumed, reopened: r.reopened, removed: r.removed, skipped: r.skipped });

// --- fresh scratch schema ---------------------------------------------------------------------
await q('DROP SCHEMA IF EXISTS scratch CASCADE');
await q('CREATE SCHEMA scratch');
await q(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
const { rows: [u] } = await q(`INSERT INTO users (email, password_hash) VALUES ('himanshu@eazybe.com', 'x') RETURNING id`);
const uid = u.id;

// --- 1. owners are matched by email, both id spaces kept ---------------------------------------
await hubspot.mapOwners();
const { rows: [mapped] } = await q('SELECT hubspot_owner_id::text AS o, hubspot_user_id::text AS s FROM users WHERE id = $1', [uid]);
ok('owner resolved by email, no hardcoded ids', mapped, { o: '94828863', s: '94828863' });

// --- 2. a ticked contact arrives ---------------------------------------------------------------
CONTACTS = [
  contact('101', { firstname: 'L.', lastname: 'Corcoran', phone: '+447738284594', country: 'United Kingdom', email: 'l.corcoran@uwtsd.ac.uk', hs_lead_status: 'ATTEMPTED_TO_CONTACT', lifecyclestage: 'lead' }),
  contact('102', { firstname: '905357807757' }),                                  // phone lives in the name field
  contact('103', { firstname: 'Jose', lastname: 'Almeida', email: 'j@x.com' }),    // ticked but nothing to call
  contact('104', { firstname: 'Naveen', phone: '918712499252', country: 'India' }), // no +, 12 digits
];
ok('first pull adds them', counts(await hubspot.pullQueue(uid)), { added: 3, resumed: 0, reopened: 0, removed: 0, skipped: 1 });

const c101 = await lead('101');
ok('name, country, timezone, segment', [c101.name, c101.country, Number(c101.utc_offset), c101.segment, c101.status, c101.source],
  ['L. Corcoran', 'United Kingdom', 1, 'non_india', 'queued', 'hubspot']);
ok('enum values become labels, not internal codes', [c101.extra.leadStage, c101.extra.lifecycle], ['Day 1', 'Inbound Leads']);
ok('HubSpot record link built from the portal id', c101.extra.hubspotUrl, 'https://app.hubspot.com/contacts/40009480/record/0-1/101');
ok('phone in the name field is read as the number', (await lead('102')).phones, ['+905357807757']);
ok('bare 12-digit number normalised', (await lead('104')).phones, ['+918712499252']);
ok('ticked with no number: skipped, never inserted', await lead('103'), undefined);

// --- 3. a lead already queued is left alone ----------------------------------------------------
await releaseLead((await q(`SELECT id FROM leads WHERE hubspot_contact_id = '101'`)).rows[0].id, 'no_answer');
CONTACTS[0].properties.firstname = 'Renamed In HubSpot';
ok('still ticked: nothing moves', counts(await hubspot.pullQueue(uid)), { added: 0, resumed: 0, reopened: 0, removed: 0, skipped: 1 });
const held = await lead('101');
ok('attempts kept, fields deliberately not refreshed', [held.attempt_count, held.name], [1, 'L. Corcoran']);

// --- 4. untick removes it, re-tick puts it back exactly as it was ------------------------------
CONTACTS[0].properties.eazybe_dial_queue = 'false';
ok('untick removes it from the queue', counts(await hubspot.pullQueue(uid)), { added: 0, resumed: 0, reopened: 0, removed: 1, skipped: 1 });
ok('stopped, and we know why', [(await lead('101')).status, (await lead('101')).stopped_reason], ['stopped', 'hubspot_untick']);

CONTACTS[0].properties.eazybe_dial_queue = 'true';
ok('re-tick puts it back', counts(await hubspot.pullQueue(uid)), { added: 0, resumed: 1, reopened: 0, removed: 0, skipped: 1 });
const back = await lead('101');
ok('back as it was: queued, attempts intact', [back.status, back.stopped_reason, back.attempt_count], ['queued', null, 1]);

// --- 5. a booked callback comes back a callback, not a plain queued lead -----------------------
const id104 = (await q(`SELECT id FROM leads WHERE hubspot_contact_id = '104'`)).rows[0].id;
await releaseLead(id104, 'later', new Date(Date.now() + 864e5).toISOString());
CONTACTS[3].properties.eazybe_dial_queue = 'false';
await hubspot.pullQueue(uid);
ok('unticking a booked callback is remembered as one', (await lead('104')).stopped_reason, 'hubspot_untick_later');
CONTACTS[3].properties.eazybe_dial_queue = 'true';
await hubspot.pullQueue(uid);
ok('re-tick restores "later", not "queued"', (await lead('104')).status, 'later');

// --- 6. a finished lead is not resurrected by a tick that never moved --------------------------
const id102 = (await q(`SELECT id FROM leads WHERE hubspot_contact_id = '102'`)).rows[0].id;
await releaseLead(id102, 'connected');
ok('connected, still ticked: left alone', counts(await hubspot.pullQueue(uid)), { added: 0, resumed: 0, reopened: 0, removed: 0, skipped: 1 });
ok('still connected', (await lead('102')).status, 'connected');

// --- 7. ...but untick + re-tick is how the rep asks for another run ----------------------------
CONTACTS[1].properties.eazybe_dial_queue = 'false';
await hubspot.pullQueue(uid);   // absent: a finished lead is not touched by the untick sweep
ok('finished lead untouched by the untick sweep', (await lead('102')).status, 'connected');
CONTACTS[1].properties.eazybe_dial_queue = 'true';
ok('re-tick re-opens it', counts(await hubspot.pullQueue(uid)), { added: 0, resumed: 0, reopened: 1, removed: 0, skipped: 1 });
const rerun = await lead('102');
ok('fresh run: queued, attempts back to zero', [rerun.status, rerun.attempt_count], ['queued', 0]);

// --- 8. a restart must not resurrect every lead we ever finished -------------------------------
await releaseLead(id102, 'connected');
await q(`UPDATE users SET hubspot_synced_at = now() - interval '3 hours' WHERE id = $1`, [uid]);
await q(`UPDATE leads SET hubspot_seen_at = now() - interval '4 hours' WHERE user_id = $1`, [uid]);
ok('long gap: stamp everything, re-open nothing', counts(await hubspot.pullQueue(uid)), { added: 0, resumed: 0, reopened: 0, removed: 0, skipped: 1 });
ok('the connected lead stayed connected', (await lead('102')).status, 'connected');

// --- 9. an in-flight lead is never pulled out from under a live call ---------------------------
await q(`UPDATE leads SET status = 'in_flight' WHERE hubspot_contact_id = '101'`);
CONTACTS[0].properties.eazybe_dial_queue = 'false';
ok('untick during a call removes nothing', counts(await hubspot.pullQueue(uid)), { added: 0, resumed: 0, reopened: 0, removed: 0, skipped: 1 });
ok('the live lead is still in flight', (await lead('101')).status, 'in_flight');
await q(`UPDATE leads SET status = 'queued' WHERE hubspot_contact_id = '101'`);

// --- 10. an unowned contact the rep last touched still reaches them ----------------------------
CONTACTS.push({ id: '105', properties: { eazybe_dial_queue: 'true', hs_updated_by_user_id: '94828863', firstname: 'Unassigned', phone: '+12025550185' } });
await hubspot.pullQueue(uid);
ok('unowned but last touched by this rep: routed to them', (await lead('105'))?.status, 'queued');
CONTACTS.push({ id: '106', properties: { eazybe_dial_queue: 'true', hubspot_owner_id: '578081029', firstname: 'Someone Else', phone: '+12025550186' } });
await hubspot.pullQueue(uid);
ok("another rep's ticked contact stays out of this queue", await lead('106'), undefined);

// --- 11. one person, one lead, whichever inlet they came through -------------------------------
const csv = 'Name,Phone Number,Country,Email\nTom Blake,+441632960011,United Kingdom,tom@blake.io\n';
await importCsv(Buffer.from(csv), uid);
const { rows: [csvLead] } = await q(`SELECT id, hubspot_contact_id AS hs FROM leads WHERE lower(extra->>'email') = 'tom@blake.io'`);
ok('CSV row with no Record ID is keyed by email', csvLead.hs, 'email-tom@blake.io');
await releaseLead(csvLead.id, 'no_answer');
CONTACTS.push(contact('107', { firstname: 'Tom', lastname: 'Blake', phone: '+441632960011', country: 'United Kingdom', email: 'tom@blake.io' }));
await hubspot.pullQueue(uid);
const { rows: merged } = await q(`SELECT id, attempt_count, source FROM leads WHERE lower(extra->>'email') = 'tom@blake.io'`);
ok('ticking the same person does not create a second lead', merged.length, 1);
ok('the CSV lead was adopted: same row, attempts kept, now HubSpot-governed',
  [merged[0].id === csvLead.id, merged[0].attempt_count, merged[0].source], [true, 1, 'hubspot']);

// --- 12. a ticked lead with no timezone is re-read until it can actually be dialled -------------
// It sits in the queue but queue.js can never make it due, and rejects are silent — so this is the one
// field the pull keeps re-reading. Fill the country in HubSpot and it starts dialling on its own.
CONTACTS.push(contact('108', { firstname: 'Nowhere', phone: '+9995551234' }));   // no country, unknown dial code
ok('imported, but with no timezone', counts(await hubspot.pullQueue(uid)).added, 1);
ok('and it really has none', (await lead('108')).utc_offset, null);
const seen = counts(await hubspot.pullQueue(uid));
ok('not counted as added again', seen.added, 0);
CONTACTS.at(-1).properties.country = 'Germany';
await hubspot.pullQueue(uid);
const fixed = await lead('108');
ok('country filled in HubSpot: the lead becomes dialable on the next poll',
  [Number(fixed.utc_offset), fixed.country, fixed.status], [2, 'Germany', 'queued']);

// --- 13. a broken inlet says so in plain words -------------------------------------------------
PROPS = PROPS.filter((p) => p !== 'eazybe_dial_queue');
const fresh = await import('../src/lib/hubspot.js?missing-property');   // fresh module: empty schema cache
const err = await fresh.pullQueue(uid).then(() => null, (e) => e.message);
ok('missing checkbox property is reported, not swallowed', err,
  'HubSpot is missing the "Eazybe · Dial queue" checkbox — create it on contacts with the internal name eazybe_dial_queue.');
ok('and it is surfaced as unhealthy, not as an empty queue', fresh.status().ok, false);

// --- 14. cost: one search per pull, not one per contact ----------------------------------------
const before = calls.search;
await hubspot.pullQueue(uid);
ok('a pull costs exactly one search', calls.search - before, 1);

console.log(fails ? `\n${fails} failed` : '\nall passed');
await pool.end();
process.exit(fails ? 1 : 0);
