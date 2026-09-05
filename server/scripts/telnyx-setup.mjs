// Idempotent Telnyx provisioning. Run after TELNYX_API_KEY, PUBLIC_URL and FROM_NUMBER_* are in .env:
//   node scripts/telnyx-setup.mjs
// 1. Outbound Voice Profile "eazybe-dialer" - a new profile whitelists US only, so it is created
//    with every country in src/lib/countries.js. A dial elsewhere fails as "destination not whitelisted".
// 2. Call Control Application "eazybe-dialer" -> PUBLIC_URL/webhooks/telnyx. The URL is refreshed on
//    every run: ngrok today, the Railway URL on Sunday.
// 3. TELNYX_CONNECTION_ID written into .env.
// 4. FROM_NUMBER_* assigned to the application.
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import Telnyx from 'telnyx';

const need = (k) => { const v = process.env[k]; if (!v) throw new Error(k + ' is not set in server/.env'); return v; };
const NAME = 'eazybe-dialer';
const t = new Telnyx({ apiKey: need('TELNYX_API_KEY') });
const webhook = need('PUBLIC_URL').replace(/[/]$/, '') + '/webhooks/telnyx';

const DESTINATIONS = [
  'IN', 'US', 'CA', 'MX', 'CO', 'PE', 'BR', 'AR',
  'GB', 'IE', 'PT', 'DE', 'FR', 'NL', 'ES', 'IT', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'PL', 'CZ', 'HU', 'HR', 'RS',
  'FI', 'GR', 'RO', 'BG', 'UA', 'TR', 'RU', 'IL', 'LT', 'LV', 'EE',
  'AE', 'OM', 'SA', 'QA', 'KW', 'BH', 'JO', 'LB', 'IQ', 'IR',
  'NG', 'MA', 'DZ', 'TN', 'GH', 'SN', 'CI', 'ZA', 'ZM', 'ZW', 'BW', 'RW', 'MZ', 'EG', 'KE', 'TZ', 'UG', 'ET',
  'SG', 'CN', 'MY', 'HK', 'PH', 'TW', 'TH', 'VN', 'ID', 'KH', 'JP', 'KR', 'AU', 'NZ', 'PK', 'BD', 'LK', 'NP',
];

async function findByName(pager) {
  for await (const item of pager) if (item.name === NAME || item.application_name === NAME) return item;
  return null;
}

// 1. Outbound voice profile
let ovp = await findByName(t.outboundVoiceProfiles.list());
if (ovp) console.log('outbound voice profile exists  ', ovp.id);
else {
  ({ data: ovp } = await t.outboundVoiceProfiles.create({ name: NAME, concurrent_call_limit: 10, whitelisted_destinations: DESTINATIONS }));
  console.log('created outbound voice profile ', ovp.id);
}

// 2. Call Control application
const appBody = { application_name: NAME, webhook_event_url: webhook, webhook_api_version: '2', outbound: { outbound_voice_profile_id: ovp.id, channel_limit: 10 } };
let app = await findByName(t.callControlApplications.list());
if (app) { await t.callControlApplications.update(app.id, appBody); console.log('updated call control app       ', app.id); }
else { ({ data: app } = await t.callControlApplications.create(appBody)); console.log('created call control app       ', app.id); }
console.log('webhook ->', webhook);

// 3. .env
const envPath = new URL('../.env', import.meta.url);
const env = readFileSync(envPath, 'utf8');
const line = 'TELNYX_CONNECTION_ID=' + app.id;
writeFileSync(envPath, /^TELNYX_CONNECTION_ID=.*$/m.test(env) ? env.replace(/^TELNYX_CONNECTION_ID=.*$/m, line) : env + '\n' + line + '\n');
console.log('TELNYX_CONNECTION_ID written to .env');

// 4. Numbers
const wanted = ['FROM_NUMBER_INDIA', 'FROM_NUMBER_EU', 'FROM_NUMBER_US'].map((k) => process.env[k]).filter(Boolean);
if (!wanted.length) console.warn('no FROM_NUMBER_* set yet - re-run after buying numbers');
const owned = [];
for await (const n of t.phoneNumbers.list()) owned.push(n);
for (const num of wanted) {
  const n = owned.find((o) => o.phone_number === num);
  if (!n) { console.warn('NOT on this Telnyx account:', num); continue; }
  if (n.connection_id === app.id) { console.log('already assigned', num); continue; }
  await t.phoneNumbers.update(n.id, { connection_id: app.id });
  console.log('assigned', num, '-> app');
}

// 5. Credential Connection for the browser softphone (plan s9). Per-user telephony credentials hang
//    off it (see src/telnyx.js ensureCredential); the connection's own user_name/password are never used.
//    sip_uri_calling_preference 'internal' lets our Call Control app dial sip:<sip_username>@sip.telnyx.com.
const WEBRTC_NAME = NAME + '-webrtc';
//    An outbound voice profile MUST be attached: without one rtc.telnyx.com rejects every login with
//    LOGIN_FAILED 46001 "Authentication failed" (found the hard way on 2026-09-05).
let cred = null;
for await (const c of t.credentialConnections.list()) if (c.connection_name === WEBRTC_NAME) { cred = c; break; }
if (cred) {
  if (!cred.outbound?.outbound_voice_profile_id) { await t.credentialConnections.update(cred.id, { outbound: { outbound_voice_profile_id: ovp.id } }); console.log('attached voice profile to credential connection'); }
  console.log('credential connection exists    ', cred.id);
} else {
  const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  ({ data: cred } = await t.credentialConnections.create({
    connection_name: WEBRTC_NAME, user_name: 'eazybe' + rnd(10), password: rnd(32),
    sip_uri_calling_preference: 'internal', anchorsite_override: 'Latency',
    outbound: { outbound_voice_profile_id: ovp.id },
  }));
  console.log('created credential connection   ', cred.id);
}
const env2 = readFileSync(envPath, 'utf8');
const line2 = 'TELNYX_WEBRTC_CONNECTION_ID=' + cred.id;
writeFileSync(envPath, /^TELNYX_WEBRTC_CONNECTION_ID=.*$/m.test(env2) ? env2.replace(/^TELNYX_WEBRTC_CONNECTION_ID=.*$/m, line2) : env2 + '\n' + line2 + '\n');
console.log('TELNYX_WEBRTC_CONNECTION_ID written to .env (set it on Railway too)');
