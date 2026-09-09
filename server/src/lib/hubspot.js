// The HubSpot inlet (docs/HUBSPOT-QUEUE.md). A rep ticks "Eazybe · Dial queue" on a contact; a poll
// pulls it into that rep's queue. Live toggle: unticking removes a queued lead, re-ticking brings it
// back. Read-only - nothing is ever written to HubSpot. Dormant and silent without HUBSPOT_TOKEN,
// so the CSV inlet keeps working untouched until the token exists.
import { q } from '../db/pool.js';
import { resolveLead, segmentFor } from './countries.js';
import { normalizePhone, upsertLead, looksLikePhone } from './import.js';

const BASE = 'https://api.hubapi.com';
export const QUEUE_PROP = 'eazybe_dial_queue';
const CACHE_MS = 60 * 60 * 1000;   // property schema, owners and the portal id: re-read hourly
const PAGE_CAP = 5000;             // sanity stop; a rep's queue is never this big
// Longer than this since the previous pull and "was this lead ticked last time?" stops being a real
// question - the server was down, or this is the first pull ever. Re-open nothing in that round.
const RETICK_MAX_GAP_MS = 30 * 60 * 1000;

const token = () => process.env.HUBSPOT_TOKEN || '';
export const configured = () => !!token();

// Rep-facing strings. Same rule as session.js: plain words, and every one of these means "the inlet
// is broken", never "one contact was odd" - those are logged and counted, not surfaced.
const MSG = {
  noProperty: 'HubSpot is missing the "Eazybe · Dial queue" checkbox — create it on contacts with the internal name eazybe_dial_queue.',
  badToken: 'HubSpot rejected the token — check HUBSPOT_TOKEN.',
  noScope: 'The HubSpot token is missing a scope — it needs crm.objects.contacts.read, crm.schemas.contacts.read and crm.objects.owners.read.',
  rateLimited: 'HubSpot is rate-limiting us — the next sync will retry.',
  noOwner: 'Your dialer email does not match any HubSpot user, so we cannot tell which contacts are yours.',
};

// Connection health is portal-wide (token, scopes, the property), so one value serves every rep.
let health = { ok: null, error: null, at: null };
export const status = () => ({ configured: configured(), ...health });
const markOk = () => { health = { ok: true, error: null, at: new Date() }; };
const markBad = (error) => { health = { ok: false, error, at: new Date() }; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hs(path, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      ...init,
      headers: { authorization: 'Bearer ' + token(), 'content-type': 'application/json', ...init.headers },
    });
    if (res.status === 429 && attempt < 3) { await sleep(1000 * (attempt + 1)); continue; }
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error(MSG.badToken);
    if (res.status === 403) throw new Error(MSG.noScope);
    if (res.status === 429) throw new Error(MSG.rateLimited);
    throw new Error(`HubSpot ${res.status} on ${path.split('?')[0]}: ${body.slice(0, 300)}`);
  }
}

/** Every page of a v3 collection endpoint. */
async function pages(path, key = 'results') {
  const out = []; let after;
  do {
    const page = await hs(path + (path.includes('?') ? '&' : '?') + 'limit=100' + (after ? '&after=' + after : ''));
    out.push(...(page[key] ?? []));
    after = page.paging?.next?.after;
  } while (after && out.length < PAGE_CAP);
  return out;
}

// --- portal, schema, owners: read once an hour ------------------------------------------------

let cache = { at: 0, schema: null, portal: null };

/** Which contact properties actually exist, and the label behind each enumeration value.
 *  Both matter: this portal has no hs_calculated_* properties (asking for a property that does not
 *  exist is an error, not an empty field), and lead status / lifecycle stage are stored as internal
 *  values - a call card must not show "ATTEMPTED_TO_CONTACT" or "1086066693". */
async function schema() {
  if (cache.schema && Date.now() - cache.at < CACHE_MS) return cache.schema;
  const props = await pages('/crm/v3/properties/contacts?archived=false');
  const labels = {};
  for (const p of props) if (p.options?.length) labels[p.name] = new Map(p.options.map((o) => [String(o.value), o.label]));
  cache = { ...cache, at: Date.now(), schema: { has: new Set(props.map((p) => p.name)), labels } };
  return cache.schema;
}

/** Portal id, only so the call card can carry a link back to the record. Optional: a portal that
 *  refuses account-info simply gets no HubSpot link, which is not worth failing a sync over. */
async function portal() {
  if (cache.portal !== null) return cache.portal;
  try { cache.portal = (await hs('/account-info/v3/details')).portalId ?? 0; }
  catch { cache.portal = 0; }
  return cache.portal;
}

/** Match HubSpot users to reps by email and store both ids. HubSpot's two id spaces disagree for some
 *  people (Karan Dewan is owner 578081029 but user 61259763), and we need the owner id to find
 *  contacts they own and the user id to find contacts they last touched. */
export async function mapOwners() {
  const owners = await pages('/crm/v3/owners?archived=false');
  let mapped = 0;
  for (const o of owners) {
    if (!o.email) continue;
    const { rowCount } = await q(
      `UPDATE users SET hubspot_owner_id = $2, hubspot_user_id = $3 WHERE lower(email) = $1
         AND (hubspot_owner_id IS DISTINCT FROM $2 OR hubspot_user_id IS DISTINCT FROM $3)`,
      [String(o.email).toLowerCase(), Number(o.id), o.userId ? Number(o.userId) : null]);
    mapped += rowCount;
  }
  return mapped;
}

// --- one contact -> one lead ------------------------------------------------------------------

const PROPS = [
  'firstname', 'lastname', 'phone', 'mobilephone', 'country', 'email', 'company', 'jobtitle',
  'lifecyclestage', 'hs_lead_status', 'hubspot_owner_id', 'hs_updated_by_user_id',
  // Present in some portals only; asked for only when the schema says they exist.
  'hs_calculated_phone_number', 'hs_calculated_mobile_number', 'hs_calculated_phone_number_country_code',
  'hs_linkedin_url', 'website',
];

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && String(v).trim() !== ''));
const labelOf = (labels, name, v) => (v == null ? '' : labels[name]?.get(String(v)) ?? String(v));

/** @returns lead fields ready for upsertLead, or null when there is no number to call. */
function toLead(contact, { labels, portalId }) {
  const p = contact.properties ?? {};
  const full = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
  // Contacts created from a phone-only source carry the number in firstname and no phone property
  // at all (seen live in this portal). Treat that as the number, not as a name.
  const nameIsPhone = looksLikePhone(full);
  const name = nameIsPhone ? '' : full;

  // HubSpot's calculated numbers are already E.164 and beat our own parsing of a local-format
  // number; this portal has neither property, so in practice the raw fields are what arrive.
  const country = p.country || p.hs_calculated_phone_number_country_code || '';
  const raw = [
    p.hs_calculated_phone_number || p.phone,
    p.hs_calculated_mobile_number || p.mobilephone,
    nameIsPhone ? full : '',
  ].filter(Boolean);

  // Timezone from the country property first, then from whichever number carries a dial code.
  const resolved = raw.reduce((hit, n) => hit ?? resolveLead({ country, phone: n }), null);
  const phones = [];
  for (const n of raw) {
    const e164 = normalizePhone(n, resolved?.region);
    if (e164 && !phones.includes(e164)) phones.push(e164);
  }
  if (!phones.length) return null;

  return {
    id: String(contact.id),
    name,
    phones,
    country,
    utcOffset: resolved?.offset ?? null,
    segment: segmentFor(resolved?.region),
    source: 'hubspot',
    extra: clean({
      email: p.email,
      company: p.company,
      title: p.jobtitle,
      leadStage: labelOf(labels, 'hs_lead_status', p.hs_lead_status),
      lifecycle: labelOf(labels, 'lifecyclestage', p.lifecyclestage),
      linkedin: p.hs_linkedin_url,
      hubspotUrl: portalId ? `https://app.hubspot.com/contacts/${portalId}/record/0-1/${contact.id}` : '',
    }),
  };
}

/** Every contact this rep has ticked: the ones they own, plus unowned ones they last touched (an
 *  inbound lead picked up before it was assigned would otherwise vanish silently). */
async function ticked(user, props) {
  const ticks = { propertyName: QUEUE_PROP, operator: 'EQ', value: 'true' };
  const filterGroups = [{ filters: [ticks, { propertyName: 'hubspot_owner_id', operator: 'EQ', value: String(user.hubspot_owner_id) }] }];
  if (user.hubspot_user_id) filterGroups.push({ filters: [
    ticks,
    { propertyName: 'hubspot_owner_id', operator: 'NOT_HAS_PROPERTY' },
    { propertyName: 'hs_updated_by_user_id', operator: 'EQ', value: String(user.hubspot_user_id) },
  ] });

  const out = []; let after;
  do {
    const body = { filterGroups, properties: props, limit: 100, sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }] };
    if (after) body.after = after;
    const page = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body: JSON.stringify(body) });
    out.push(...(page.results ?? []));
    after = page.paging?.next?.after;
  } while (after && out.length < PAGE_CAP);
  // A truncated read must not be mistaken for "everything else was unticked".
  return { contacts: out, complete: !after };
}

// --- the pull ---------------------------------------------------------------------------------

const FINISHED = new Set(['connected', 'exhausted', 'stopped']);
const EMPTY = { added: 0, resumed: 0, reopened: 0, removed: 0, skipped: 0, refreshed: 0 };

async function doPull(user) {
  const startedAt = new Date();
  const prev = user.hubspot_synced_at ? new Date(user.hubspot_synced_at) : null;
  // "Absent from the previous pull" is the whole re-tick signal, and it is only a real answer when
  // the previous pull was recent. After a restart or a long outage we stamp and re-open nothing,
  // rather than resurrecting every lead we ever finished.
  const trustAbsence = !!prev && startedAt - prev < RETICK_MAX_GAP_MS;

  const { has, labels } = await schema();
  if (!has.has(QUEUE_PROP)) throw new Error(MSG.noProperty);
  const { contacts, complete } = await ticked(user, PROPS.filter((n) => has.has(n)));
  const portalId = await portal();

  const r = { ...EMPTY };
  const leads = [];
  for (const c of contacts) {
    const lead = toLead(c, { labels, portalId });
    if (lead) leads.push(lead);
    else { r.skipped++; console.warn(`[hubspot] rep ${user.id}: contact ${c.id} is ticked but has no number to call`); }
  }

  const ids = leads.map((l) => l.id);
  const { rows: existing } = ids.length
    ? await q(`SELECT hubspot_contact_id AS hs, id, status, stopped_reason AS reason, hubspot_seen_at AS seen,
                      utc_offset IS NULL AS "noTimezone"
               FROM leads WHERE hubspot_contact_id = ANY($1)`, [ids])
    : { rows: [] };
  const byId = new Map(existing.map((e) => [e.hs, e]));

  const stamp = [];    // already here and unchanged: one bulk touch, nothing else
  const reopen = [];   // finished, and absent from the previous pull -> unticked and re-ticked
  const resume = [];   // we stopped it on an untick and it is ticked again -> put it back as it was
  const fresh = [];    // no lead row yet, or here but still with no timezone

  for (const lead of leads) {
    const ex = byId.get(lead.id);
    if (!ex) { fresh.push(lead); continue; }
    // A lead with no timezone is in the queue but can never be due (queue.js needs utc_offset), and
    // with rejects silent the rep would never learn why. It is the one case worth re-reading every
    // poll: fill the country in HubSpot and the lead starts dialing on its own.
    if (ex.noTimezone) { fresh.push(lead); continue; }
    stamp.push(lead.id);
    if (ex.status === 'stopped' && String(ex.reason ?? '').startsWith('hubspot_untick')) resume.push(ex);
    else if (FINISHED.has(ex.status) && trustAbsence && ex.seen && new Date(ex.seen) < prev) reopen.push(ex.id);
  }

  // Steady state is these two statements and nothing more: a rep whose queue has not changed costs
  // one search and one UPDATE. Fields of a lead already queued are deliberately not refreshed
  // (docs/HUBSPOT-QUEUE.md s4) - untick and re-tick is how a rep asks for a re-read.
  if (stamp.length) await q(`UPDATE leads SET hubspot_seen_at = $2 WHERE hubspot_contact_id = ANY($1)`, [stamp, startedAt]);

  for (const lead of fresh) {
    const row = await upsertLead({ ...lead, userId: user.id, seenAt: startedAt });
    if (row.inserted) r.added++; else r.refreshed++;
  }

  if (reopen.length) {
    const { rowCount } = await q(
      `UPDATE leads SET status = 'queued', attempt_count = 0, number_attempts = 0, phone_idx = 1,
              phone = coalesce(phones[1], phone), next_call_at = now(), stopped_reason = NULL
       WHERE id = ANY($1)`, [reopen]);
    r.reopened = rowCount;
  }
  // Back to exactly what it was before the untick: a booked callback stays a callback (a 'later' lead
  // skips the window rules deliberately), a queued lead keeps its attempts and its next_call_at.
  for (const group of [['hubspot_untick', 'queued'], ['hubspot_untick_later', 'later']]) {
    const rows = resume.filter((e) => e.reason === group[0]).map((e) => e.id);
    if (!rows.length) continue;
    const { rowCount } = await q(`UPDATE leads SET status = $2, stopped_reason = NULL WHERE id = ANY($1)`, [rows, group[1]]);
    r.resumed += rowCount;
  }

  // Unticked: gone from the queue. Only leads whose last inlet was HubSpot, never one that is on a
  // call right now, and never off a partial read.
  if (complete) {
    const { rowCount } = await q(
      `UPDATE leads SET status = 'stopped',
              stopped_reason = CASE WHEN status = 'later' THEN 'hubspot_untick_later' ELSE 'hubspot_untick' END
       WHERE user_id = $1 AND source = 'hubspot' AND status IN ('queued', 'later')
         AND hubspot_seen_at IS NOT NULL AND hubspot_seen_at < $2`, [user.id, startedAt]);
    r.removed = rowCount;
  }

  if (complete) await q('UPDATE users SET hubspot_synced_at = $2 WHERE id = $1', [user.id, startedAt]);
  markOk();
  return { ...r, syncedAt: startedAt, ticked: leads.length };
}

// One pull per rep at a time: the 60s loop, Start dialing and the Sync now button all call this, and
// two overlapping reconciles of the same queue would fight over the untick sweep.
const inFlight = new Map();

/** Pull one rep's ticked contacts. Throws on a broken inlet (bad token, missing property); a contact
 *  we cannot use is counted and logged, never thrown. */
export async function pullQueue(userId) {
  if (!configured()) return { ...EMPTY, skipped: 0, off: true };
  if (inFlight.has(userId)) return inFlight.get(userId);
  const run = (async () => {
    const { rows: [user] } = await q(
      'SELECT id, email, hubspot_owner_id, hubspot_user_id, hubspot_synced_at FROM users WHERE id = $1', [userId]);
    if (!user) throw new Error('no such user');
    if (!user.hubspot_owner_id) {
      await mapOwners();
      const { rows: [again] } = await q('SELECT id, email, hubspot_owner_id, hubspot_user_id, hubspot_synced_at FROM users WHERE id = $1', [userId]);
      if (!again?.hubspot_owner_id) throw new Error(MSG.noOwner);
      return doPull(again);
    }
    return doPull(user);
  })().catch((e) => { markBad(e.message); throw e; });
  inFlight.set(userId, run);
  run.finally(() => inFlight.delete(userId)).catch(() => {});
  return run;
}

/** For the paths a rep is waiting on (Start dialing, opening Up next): pull if we can, but never let
 *  HubSpot hold up a dial. Past the deadline the pull carries on in the background and the queue is
 *  read as it stands. */
export async function pullBeforeRead(userId, ms = 3000) {
  if (!configured()) return null;
  try {
    return await Promise.race([pullQueue(userId), new Promise((r) => setTimeout(() => r(null), ms))]);
  } catch { return null; }  // health already recorded; a broken inlet must not break dialing
}

/** Background loop. Also (re)maps owners to reps by email, so a new rep needs no HubSpot config. */
export function startPolling(seconds = Number(process.env.HUBSPOT_POLL_SECONDS ?? 60)) {
  if (!configured()) { console.log('[hubspot] HUBSPOT_TOKEN not set — CSV upload is the only inlet'); return; }
  let ownersAt = 0;
  const tick = async () => {
    try {
      if (Date.now() - ownersAt > CACHE_MS) { await mapOwners(); ownersAt = Date.now(); }
      const { rows } = await q('SELECT id FROM users WHERE hubspot_owner_id IS NOT NULL');
      for (const u of rows) {
        try { await pullQueue(u.id); }
        catch (e) { console.warn(`[hubspot] sync failed for rep ${u.id}: ${e.message}`); }
      }
    } catch (e) { markBad(e.message); console.warn('[hubspot] poll failed: ' + e.message); }
  };
  tick();
  const t = setInterval(tick, Math.max(15, seconds) * 1000);
  t.unref?.();
  console.log(`[hubspot] polling every ${seconds}s for the "${QUEUE_PROP}" checkbox`);
}
