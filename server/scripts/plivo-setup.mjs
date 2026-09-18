// Creates/updates only the Plivo Voice Application; does not rent numbers or place calls.
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { plivoRequest, publicUrl } from '../src/plivo.js';
const base = publicUrl();
if (!base.startsWith('https://')) throw new Error('Set PUBLIC_URL to the public HTTPS tunnel or deployment URL first.');
// answer_url is the inbound handler: a caller ID dialed back is bridged to the rep or queued as a callback.
const application = { app_name: 'Hans-Dialer', answer_url: base + '/webhooks/plivo/inbound', answer_method: 'POST' };
let id = process.env.PLIVO_APPLICATION_ID?.trim();
if (id) await plivoRequest('Application/' + encodeURIComponent(id) + '/', 'POST', application);
else {
  const result = await plivoRequest('Application/', 'POST', application);
  id = result.app_id;
  if (!id) throw new Error('Plivo did not return an application ID');
}
// Containers have no server/.env (env comes from the platform): print the ID instead of crashing.
try {
  const path = new URL('../.env', import.meta.url);
  const env = readFileSync(path, 'utf8');
  const line = 'PLIVO_APPLICATION_ID=' + id;
  writeFileSync(path, /^PLIVO_APPLICATION_ID=.*$/m.test(env) ? env.replace(/^PLIVO_APPLICATION_ID=.*$/m, line) : env.trimEnd() + '\n' + line + '\n');
  console.log('Plivo application ready. PLIVO_APPLICATION_ID saved to server/.env; set the same ID in deployment variables.');
} catch {
  console.log('Plivo application ready. No server/.env here (container) — set this in your deployment environment:');
  console.log('PLIVO_APPLICATION_ID=' + id);
}

// Point every configured caller ID at this application, so dialing it back reaches the inbound handler.
// Numbers on another application are reported and MOVED — check the list if Contacto or anything else used them.
const owned = new Set((await plivoRequest('Number/').catch(() => ({ objects: [] }))).objects?.map((n) => n.number) ?? []);
const wanted = ['FROM_NUMBER_INDIA', 'FROM_NUMBER_EU', 'FROM_NUMBER_US']
  .flatMap((key) => String(process.env[key] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
for (const number of [...new Set(wanted)]) {
  const bare = number.replace(/^\+/, '');
  if (!owned.has(bare)) { console.log('NOT on this account, skipped:', number); continue; }
  await plivoRequest('Number/' + encodeURIComponent(bare) + '/', 'POST', { app_id: id });
  console.log('assigned to the dialer application:', number);
}
