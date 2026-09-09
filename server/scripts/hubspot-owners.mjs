// Which dialer rep is which HubSpot user. The inlet matches them by email automatically, so this is
// the one thing that can quietly leave a rep with an empty queue: their dialer login and their HubSpot
// login are different addresses. Prints the mapping and, when it cannot be made, exactly what to run.
// Read-only. Usage (from server/):
//   node scripts/hubspot-owners.mjs            show the mapping
//   node scripts/hubspot-owners.mjs --apply    also write the matches to the users table
import 'dotenv/config';
import { pool, q } from '../src/db/pool.js';
import { mapOwners, configured } from '../src/lib/hubspot.js';

if (!configured()) {
  console.error('HUBSPOT_TOKEN is not set in server/.env — nothing to check yet.');
  process.exit(1);
}

const owners = [];
for (let after; ;) {
  const res = await fetch('https://api.hubapi.com/crm/v3/owners?archived=false&limit=100' + (after ? '&after=' + after : ''),
    { headers: { authorization: 'Bearer ' + process.env.HUBSPOT_TOKEN } });
  if (!res.ok) { console.error(`HubSpot ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
  const page = await res.json();
  owners.push(...(page.results ?? []));
  after = page.paging?.next?.after;
  if (!after) break;
}

if (process.argv.includes('--apply')) console.log('matched and saved:', await mapOwners(), 'rep(s)\n');

const byEmail = new Map(owners.filter((o) => o.email).map((o) => [o.email.toLowerCase(), o]));
const { rows: users } = await q('SELECT id, email, hubspot_owner_id FROM users ORDER BY id');

console.table(users.map((u) => {
  const o = byEmail.get(u.email);
  return {
    rep: u.email,
    'HubSpot user': o ? `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim() || o.email : '— no HubSpot user with this email —',
    ownerId: o?.id ?? '',
    stored: u.hubspot_owner_id ?? '(not set)',
  };
}));

const unmatched = users.filter((u) => !byEmail.has(u.email));
if (unmatched.length) {
  console.log(`\n${unmatched.length} rep(s) have no HubSpot user with the same email, so nothing will sync for them.`);
  console.log('Either give them a dialer login that matches their HubSpot email, or pin the owner id by hand:\n');
  for (const u of unmatched) console.log(`  UPDATE users SET hubspot_owner_id = <owner id>, hubspot_user_id = <user id> WHERE email = '${u.email}';`);
  console.log('\nHubSpot users this portal has:');
  console.table(owners.map((o) => ({ ownerId: o.id, userId: o.userId ?? '', email: o.email ?? '', name: `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim() })));
}

await pool.end();
