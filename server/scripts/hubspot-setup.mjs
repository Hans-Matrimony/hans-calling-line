// Idempotent HubSpot provisioning for the dialer. Run after HUBSPOT_TOKEN is in server/.env:
//   node scripts/hubspot-setup.mjs
// 1. Reports what the private app's token is actually allowed to do (one probe per scope).
// 2. Creates the "Eazybe dialer" property group and the `eazybe_dial_queue` checkbox - the inlet.
// 3. Checks the call dispositions the write-back maps onto, and says what still needs doing by hand.
// Writes nothing else and never prints the token.
import 'dotenv/config';

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('HUBSPOT_TOKEN is not set in server/.env'); process.exit(1); }
const BASE = 'https://api.hubapi.com';

async function hs(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...init.headers } });
  const text = await res.text().catch(() => '');
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, body, text };
}
const mark = (ok) => (ok ? 'yes' : 'NO ');

// --- 1. what can this token do? ---------------------------------------------------------------
console.log('scopes on this token');
const probes = [
  ['crm.objects.contacts.read ', await hs('/crm/v3/objects/contacts?limit=1')],
  ['crm.schemas.contacts.read ', await hs('/crm/v3/properties/contacts?limit=1')],
  ['crm.objects.owners.read   ', await hs('/crm/v3/owners?limit=1')],
  // A PATCH at a contact id that cannot exist: 404 means we were allowed to try, 403 means we were not.
  ['crm.objects.contacts.write', await hs('/crm/v3/objects/contacts/0', { method: 'PATCH', body: JSON.stringify({ properties: {} }) })],
  ['files                     ', await hs('/files/v3/files?limit=1')],
];
let missing = [];
for (const [name, r] of probes) {
  const allowed = r.status !== 403 && r.status !== 401;
  if (!allowed) missing.push(name.trim());
  console.log(`  ${mark(allowed)}  ${name}  (${r.status})`);
  if (r.status === 401) { console.error('\n  The token was rejected. If you rotated it, update HUBSPOT_TOKEN in server/.env and on Railway.'); process.exit(1); }
}

// --- 2. the property group and the checkbox ---------------------------------------------------
const GROUP = 'eazybe_dialer';
const PROP = 'eazybe_dial_queue';
console.log('\nthe dial-queue checkbox');

let propOk = false;
const existing = await hs('/crm/v3/properties/contacts/' + PROP);
if (existing.ok) {
  const p = existing.body;
  propOk = p.fieldType === 'checkbox' || p.fieldType === 'booleancheckbox';
  console.log(`  already exists: "${p.label}" (${p.type}/${p.fieldType}) in group "${p.groupName}"`);
  if (!propOk) console.log('  WARNING: it is neither a tick box nor a single checkbox, so the inlet will not read it as one');
  else if (p.fieldType === 'booleancheckbox') console.log("  note: this renders as a Yes/No dropdown on a record; fieldType 'checkbox' with one option renders as a real tick box");
} else if (existing.status === 403) {
  console.log('  cannot even look: the token is missing crm.schemas.contacts.read');
} else {
  const g = await hs('/crm/v3/properties/contacts/groups', { method: 'POST', body: JSON.stringify({ name: GROUP, label: 'Eazybe dialer', displayOrder: -1 }) });
  console.log(g.ok ? '  created the property group "Eazybe dialer"'
    : g.status === 409 ? '  property group already there'
    : `  property group: ${g.status} ${String(g.text).slice(0, 120)}`);

  const created = await hs('/crm/v3/properties/contacts', { method: 'POST', body: JSON.stringify({
    name: PROP, label: 'Eazybe · Dial queue', groupName: g.ok || g.status === 409 ? GROUP : 'contactinformation',
    // 'checkbox' with a single option is the only shape HubSpot draws as a real tick box on a record;
    // 'booleancheckbox' is the same data but renders as a Yes/No dropdown, which reps disliked.
    type: 'enumeration', fieldType: 'checkbox', formField: false, hasUniqueValue: false, hidden: false,
    description: 'Tick to send this contact to the Eazybe dialer queue. Untick to remove it. Untick then re-tick to run it again.',
    options: [{ label: 'Add to dial queue', value: 'true', displayOrder: 0, hidden: false }],
  }) });
  if (created.ok) { propOk = true; console.log(`  created "${created.body.label}" — internal name ${created.body.name}`); }
  else if (created.status === 403) console.log('  BLOCKED: creating a property needs crm.schemas.contacts.write on the private app.\n           Either add that scope, or make it by hand: Settings -> Properties -> Contact properties -> Create,\n           "Multiple checkboxes" with one option "Add to dial queue" = true, internal name exactly ' + PROP);
  else console.log(`  failed: ${created.status} ${String(created.text).slice(0, 200)}`);
}

// --- 3. what the call write-back maps onto ----------------------------------------------------
console.log('\ncall dispositions the write-back uses');
const disp = await hs('/crm/v3/properties/calls/hs_call_disposition');
if (disp.ok) for (const o of disp.body.options ?? []) console.log(`  ${o.label.padEnd(18)} ${o.value}`);
else console.log(`  could not read them (${disp.status}) — the write-back falls back to HubSpot's standard ids`);

const types = await hs('/crm/v3/properties/calls/hs_activity_type');
const wanted = ['Interested', 'Follow-up', 'Callback', 'Not interested', 'Not qualified'];
let typeGap = [];
console.log('\ncall types for the outcome tiles (HubSpot has no API to create these)');
if (types.ok) {
  const have = new Set((types.body.options ?? []).map((o) => o.label));
  for (const w of wanted) console.log(`  ${mark(have.has(w))}  ${w}`);
  typeGap = wanted.filter((w) => !have.has(w));
} else console.log(`  could not read them (${types.status})`);

// Only name what is actually outstanding: a checklist that re-lists finished work is noise.
const todo = [];
if (missing.length) todo.push('add these scopes to the private app: ' + missing.join(', '));
if (!propOk) todo.push(`create the ${PROP} single checkbox on contacts`);
if (typeGap.length) todo.push('create these call types (Settings -> Calling -> Call Setup -> Track Call and Meeting Types): ' + typeGap.join(', '));
console.log(todo.length ? '\nstill to do:\n  - ' + todo.join('\n  - ') : '\nnothing outstanding — the HubSpot side is fully set up.');
console.log('rep to HubSpot user mapping: node scripts/hubspot-owners.mjs');
