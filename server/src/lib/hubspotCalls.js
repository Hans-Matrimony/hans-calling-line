// HubSpot write-back, calls only (plan 2026-09-10). Every settled dial that has a real HubSpot contact
// becomes a Call engagement on that contact: direction, time, duration, from/to, the rep as owner,
// the outcome as a native disposition, the sub-outcome as a call type, the note, and the recording -
// uploaded into HubSpot Files so HubSpot owns a copy. A dial to a number HubSpot does not know is
// pushed only if the admin's "create contacts" toggle is on. Never awaited on the rep's path.
import { q, withLock } from '../db/pool.js';
import { hs, hsRaw, configured, markWrite } from './hubspot.js';
import { getSetting } from './settings.js';
import { recordingBytes } from './recordings.js';
import { queueCallSync } from './hubspotJobs.js';
import { pokeAdmins } from '../io.js';

const CALL_TO_CONTACT = 194;
const FOLDER = '/hans-dialer/recordings';
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const publicUrl = () => String(process.env.PUBLIC_URL ?? '').replace(/[/]$/, '');

// HubSpot's standard dispositions, used until the portal's own list is read (it may add or rename).
const STD = {
  'Connected': 'f240bbac-87c9-4f6e-bf70-924b57d47db7', 'No answer': '73a0d17f-1163-4015-bdd5-ec830791da20',
  'Wrong number': '17b47fee-58de-441e-a44c-c6300d46f273', 'Busy': '9d9162e7-6cf3-4944-bf63-4dff82258764',
  'Left voicemail': 'b2cf5968-551e-4856-9783-52b3da59a7d0',
};
const SUB = { interested: 'Interested', follow_up: 'Follow-up', callback: 'Callback', not_interested: 'Not interested', not_qualified: 'Not qualified' };
const OUTCOME = {
  connected: { label: 'Connected', status: 'COMPLETED', disposition: 'Connected' },
  later:     { label: 'Call later', status: 'COMPLETED', disposition: 'Connected' },
  no_answer: { label: 'No answer', status: 'NO_ANSWER', disposition: 'No answer' },
  abandoned: { label: 'Abandoned', status: 'NO_ANSWER', disposition: 'No answer' },
  failed:    { label: 'Could not be dialed', status: 'FAILED', disposition: 'Busy' },
  invalid:   { label: 'Wrong number', status: 'FAILED', disposition: 'Wrong number' },
};

let dispositions = { at: 0, map: STD };
async function dispositionId(label) {
  if (Date.now() - dispositions.at > 3600_000) {
    try {
      const prop = await hs('/crm/v3/properties/calls/hs_call_disposition');
      const map = Object.fromEntries((prop.options ?? []).map((o) => [o.label, o.value]));
      if (Object.keys(map).length) dispositions = { at: Date.now(), map: { ...STD, ...map } };
      else dispositions.at = Date.now();
    } catch { dispositions.at = Date.now(); }
  }
  return dispositions.map[label] ?? STD[label] ?? null;
}

const isRealId = (id) => /^\d+$/.test(String(id ?? ''));

/** Which HubSpot contact a call belongs to. The lead's own Record ID; else a one-time search by the
 *  number we dialed (a manual-pad number is often an existing contact) - adopted onto the lead; else,
 *  only with the admin toggle on, a new contact. Null means "HubSpot does not know this person". */
async function contactFor(call) {
  if (isRealId(call.hubspot_contact_id)) return call.hubspot_contact_id;
  const dialed = digits(call.to_number);
  if (dialed.length < 8) return null;
  const found = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body: JSON.stringify({
    query: dialed.slice(-10), limit: 10, properties: ['phone', 'mobilephone', 'hubspot_owner_id', 'lastmodifieddate'] }) });
  // One number can sit on several contacts (a duplicate, or one another dialer created). Pick
  // deterministically: the rep's own contact first, then whichever was touched most recently -
  // never "whatever the search happened to return first".
  const hits = (found.results ?? []).filter((c) => [c.properties?.phone, c.properties?.mobilephone].some((n) => n && digits(n).endsWith(dialed.slice(-10))));
  hits.sort((a, b) => (Number(b.properties?.hubspot_owner_id === String(call.owner_id ?? '')) - Number(a.properties?.hubspot_owner_id === String(call.owner_id ?? '')))
    || String(b.properties?.lastmodifieddate ?? '').localeCompare(String(a.properties?.lastmodifieddate ?? '')));
  if (hits.length > 1) console.log(`[hubspot] ${hits.length} contacts hold ${call.to_number}; logging against ${hits[0].id}`);
  let id = hits[0]?.id ?? null;
  if (!id) {
    if (!(await getSetting('hubspot_create_contacts'))) return null;
    const [firstname, ...rest] = String(call.lead_name ?? '').trim().split(/\s+/).filter(Boolean);
    const created = await hs('/crm/v3/objects/contacts', { method: 'POST', body: JSON.stringify({ properties: {
      phone: call.to_number, ...(firstname ? { firstname } : {}), ...(rest.length ? { lastname: rest.join(' ') } : {}),
      ...(call.country ? { country: call.country } : {}), ...(call.owner_id ? { hubspot_owner_id: String(call.owner_id) } : {}),
    } }) });
    id = created.id;
  }
  // Adopt: from now on this lead is that contact (only when nobody else already holds the id).
  await q(`UPDATE leads SET hubspot_contact_id = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM leads x WHERE x.hubspot_contact_id = $2)`, [call.lead_id, String(id)]);
  return String(id);
}

async function load(callId) {
  const { rows: [c] } = await q(
    `SELECT c.id, c.started_at, c.answered_at, c.duration, c.disposition, c.sub_outcome, c.reason, c.notes,
            c.from_number, c.to_number, c.hubspot_call_id, c.hubspot_file_url, c.hubspot_file_id, c.recording_status, c.recording_token,
            c.recording_id, c.recording_leg_id, c.telnyx_call_id, c.hubspot_sync_key, c.hubspot_create_started_at,
            l.id AS lead_id, l.hubspot_contact_id, l.name AS lead_name, l.country,
            u.hubspot_owner_id AS owner_id
     FROM calls c JOIN leads l ON l.id = c.lead_id JOIN bursts b ON b.id = c.burst_id JOIN users u ON u.id = b.user_id
     WHERE c.id = $1`, [callId]);
  return c;
}

const fail = (callId, e) => q('UPDATE calls SET hubspot_error = $2 WHERE id = $1', [callId, String(e?.message ?? e).slice(0, 200)]).catch(() => {});

// A call that was answered but never dispositioned: the rep walked away from the outcome card. It
// still happened, so it still belongs on the timeline - logged the moment the leg hangs up and
// updated when (if) the outcome arrives.
const PENDING = { label: 'Answered — no outcome saved yet', status: 'COMPLETED', disposition: null };

/** Put the call on the contact's timeline, or update what is already there. Called twice for a normal
 *  call - once when the leg hangs up, again when the rep saves the outcome - so it creates on the
 *  first pass and PATCHes on the second. Nothing is ever lost to a forgotten outcome. */
async function writeCall(callId) {
  if (!configured()) return;
  const c = await load(callId);
  if (!c) return;
  if (c.disposition === 'cancelled') return;              // the loser leg of a burst: never a call
  if (!c.answered_at && !c.disposition) return;           // still ringing; nothing to say yet
  const out = c.disposition ? OUTCOME[c.disposition] : PENDING;
  if (!out) return;
  try {
    const contact = await contactFor(c);
    if (!contact) { await q(`UPDATE calls SET hubspot_error = 'no HubSpot contact for this number' WHERE id = $1`, [callId]); return; }

    const sub = c.sub_outcome ? SUB[c.sub_outcome] ?? c.sub_outcome : null;
    const reference = 'Hans call reference: ' + c.hubspot_sync_key;
    const body = [sub, c.reason, c.notes, reference].filter(Boolean).join(' · ');
    const properties = {
      hs_timestamp: new Date(c.started_at).toISOString(),
      hs_call_direction: 'OUTBOUND',
      hs_call_status: out.status,
      hs_call_title: 'Hans dialer · ' + (sub ?? out.label),
      hs_call_from_number: c.from_number, hs_call_to_number: c.to_number,
      ...(c.answered_at && c.duration != null ? { hs_call_duration: String(c.duration * 1000) } : {}),
      ...(body ? { hs_call_body: body } : {}),
      ...(c.owner_id ? { hubspot_owner_id: String(c.owner_id) } : {}),
      ...(sub ? { hs_activity_type: sub } : {}),
    };
    const disp = await dispositionId(out.disposition);
    if (disp) properties.hs_call_disposition = disp;
    const rec = recordingLink(c);
    if (rec) properties.hs_call_recording_url = rec;

    // Reconcile an uncertain POST before any retry. A timeout can occur after HubSpot accepted it.
    if (!c.hubspot_call_id && c.hubspot_create_started_at) {
      const found = await hs('/crm/v3/objects/calls/search', { method: 'POST', body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'hs_timestamp', operator: 'EQ', value: String(new Date(c.started_at).getTime()) }] }],
        properties: ['hs_call_body'], limit: 100,
      }) });
      const match = (found.results ?? []).find((r) => String(r.properties?.hs_call_body ?? '').includes(reference));
      if (!match) throw new Error('Awaiting HubSpot reconciliation of an uncertain create; no second activity sent.');
      c.hubspot_call_id = String(match.id);
      await q('UPDATE calls SET hubspot_call_id = $2 WHERE id = $1', [callId, c.hubspot_call_id]);
    }

    // Already on the timeline (logged at hangup): update it in place, associations and all, rather
    // than adding a second activity for the same call.
    if (c.hubspot_call_id) {
      await hs('/crm/v3/objects/calls/' + c.hubspot_call_id, { method: 'PATCH', body: JSON.stringify({ properties }) });
      await q('UPDATE calls SET hubspot_error = NULL WHERE id = $1', [callId]);
      markWrite(true);
      pokeAdmins('hubspot');
      return;
    }

    const payload = { properties, associations: [{ to: { id: contact }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: CALL_TO_CONTACT }] }] };
    await q('UPDATE calls SET hubspot_create_started_at = now() WHERE id = $1', [callId]);
    let created;
    try {
      try { created = await hs('/crm/v3/objects/calls', { method: 'POST', body: JSON.stringify(payload) }); }
      catch (e) {
        // The five sub-outcome call types must exist in the portal; without them HubSpot rejects the
        // value. Log the call anyway, minus the type, and say so on the health line.
        if (e.status === 400 && properties.hs_activity_type && /hs_activity_type/i.test(e.message)) {
          markWrite(false, 'Call types are not set up in HubSpot (Settings → Calling → Call Setup → Track Call and Meeting Types) — calls are logged without a type.');
          delete payload.properties.hs_activity_type;
          created = await hs('/crm/v3/objects/calls', { method: 'POST', body: JSON.stringify(payload) });
        } else throw e;
      }
    } catch (e) {
      // Only a rejection of this POST can clear the uncertainty marker. A failed reconciliation
      // search must retain it, or the next worker could send a duplicate create.
      if (e.status >= 400 && e.status < 500) await q('UPDATE calls SET hubspot_create_started_at = NULL WHERE id = $1', [callId]);
      throw e;
    }
    await q('UPDATE calls SET hubspot_call_id = $2, hubspot_error = NULL WHERE id = $1', [callId, String(created.id)]);
    markWrite(true);
    pokeAdmins('hubspot');
  } catch (e) {
    markWrite(false, e.status === 403 ? 'Calls are not being logged to HubSpot — the token needs crm.objects.contacts.write.' : e.message);
    throw e;
  }
}

/** Queue first so process restarts cannot lose a sync, then try it immediately. */
export async function logCall(callId) {
  await queueCallSync(callId);
  return processCallSync(callId);
}
export const attachRecording = logCall;

export async function processCallSync(callId) {
  if (!configured()) return;
  return withLock('hubspot-call:' + callId, async () => {
    const { rows: [job] } = await q('SELECT version FROM hubspot_jobs WHERE call_id = $1', [callId]);
    if (!job) return;
    try {
      await writeCall(callId);
      await uploadRecording(callId);
      // An outcome arriving during a network request increments the version; that newer work stays queued.
      await q('DELETE FROM hubspot_jobs WHERE call_id = $1 AND version = $2', [callId, job.version]);
    } catch (e) {
      await fail(callId, e);
      await q("UPDATE hubspot_jobs SET attempts = attempts + 1, error = $2, next_attempt_at = now() + LEAST(3600, 5 * power(2, LEAST(attempts, 10))) * interval '1 second' WHERE call_id = $1", [callId, String(e.message).slice(0, 500)]);
      console.warn('HubSpot sync deferred', callId, e.message);
    }
  });
}

export function startCallSyncWorker() {
  let running = false;
  const tick = async () => {
    if (running || !configured()) return;
    running = true;
    try {
      const { rows } = await q('SELECT call_id FROM hubspot_jobs WHERE next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 25');
      for (const row of rows) await processCallSync(row.call_id);
    } catch (e) { console.warn('HubSpot worker', e.message); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick, 2000);
  timer.unref();
  return timer;
}

/** The best recording link we have for HubSpot: the copy in HubSpot Files, else our public proxy. */
function recordingLink(c) {
  if (c.hubspot_file_url) return c.hubspot_file_url;
  if (c.recording_status === 'saved' && c.recording_token && /^https:/.test(publicUrl())) return publicUrl() + '/rec/' + c.recording_token + '.mp3';
  return null;
}

/** Once the recording exists at the provider: copy it into HubSpot Files, then put the link on the
 *  engagement (create-time if the engagement does not exist yet, PATCH if it does). */
async function uploadRecording(callId) {
  if (!configured()) return;
  const c = await load(callId);
  if (!c?.hubspot_call_id || c.recording_status !== 'saved') return;
  try {
    if (!c.hubspot_file_url) {
      const bytes = await recordingBytes(c);
      if (!bytes) throw new Error('Recording is not available yet');
      const when = new Date(c.started_at).toISOString().replace(/[-:]/g, '').slice(0, 13);
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: 'audio/mpeg' }), `call-${c.id}-${when}-${digits(c.to_number)}.mp3`);
      fd.append('folderPath', FOLDER);
      fd.append('options', JSON.stringify({ access: 'PUBLIC_NOT_INDEXABLE', overwrite: false, duplicateValidationStrategy: 'RETURN_EXISTING', duplicateValidationScope: 'EXACT_FOLDER' }));
      const file = await hsRaw('/files/v3/files', { method: 'POST', body: fd });
      await q('UPDATE calls SET hubspot_file_id = $2, hubspot_file_url = $3, hubspot_error = NULL WHERE id = $1', [callId, String(file.id), file.url]);
      c.hubspot_file_url = file.url;
      markWrite(true);
    }
    if (c.hubspot_call_id) {
      await hs('/crm/v3/objects/calls/' + c.hubspot_call_id, { method: 'PATCH', body: JSON.stringify({ properties: { hs_call_recording_url: c.hubspot_file_url } }) });
      pokeAdmins('hubspot');
    }
  } catch (e) {
    if (e.status === 403) markWrite(false, 'Recordings are not being copied to HubSpot — the token needs the files scope.');
    console.warn('hubspot attachRecording', callId, e.message);
    throw e;
  }
}
