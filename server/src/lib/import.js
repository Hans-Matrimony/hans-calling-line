import { parse } from 'csv-parse/sync';
import { q } from '../db/pool.js';
import { resolveLead, segmentFor } from './countries.js';

// HubSpot export headers vary ("Phone Number", "Country/Region", "Record ID"); normalise to a-z0-9.
const key = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (row, ...names) => {
  for (const n of names) { const v = row[n]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
  return '';
};

export function normalizePhone(raw, region) {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (s.startsWith('+') || s.startsWith('00')) return '+' + digits.replace(/^00/, '');
  if (digits.length === 10 && region === 'india') return '+91' + digits;
  if (digits.length === 10 && region === 'us') return '+1' + digits;
  if (digits.length > 10) return '+' + digits; // assume country code included
  return null;
}

/** HubSpot and some sheets put the phone in the name field. Treat a "name" that is only digits and
 *  phone punctuation as a number, never as a name. */
export const looksLikePhone = (s) => /^[\d\s+()-]+$/.test(String(s ?? '').trim()) && /\d/.test(String(s ?? ''));

/** One person, one lead row, whichever inlet they came through.
 *
 *  A lead held under a provisional key — `email-…` (a CSV with no Record ID) or `manual-…` (the keypad)
 *  — is rewritten to the real HubSpot Record ID the first time that contact arrives carrying one, so it
 *  keeps its attempts, its history and the number it has rolled onto instead of becoming a second lead
 *  we would dial in parallel. Matched on email first, then on any shared number.
 */
async function adoptProvisionalKey(userId, id, email, phones) {
  if (!id || id.startsWith('email-') || id.startsWith('manual-')) return;
  const mail = String(email ?? '').toLowerCase();
  const { rows: [prev] } = await q(
    `SELECT hubspot_contact_id AS id FROM leads
     WHERE user_id = $1 AND hubspot_contact_id <> $2
       AND (hubspot_contact_id LIKE 'email-%' OR hubspot_contact_id LIKE 'manual-%')
       AND (($3 <> '' AND lower(extra->>'email') = $3) OR phones && $4::text[])
     ORDER BY ($3 <> '' AND lower(extra->>'email') = $3) DESC, id LIMIT 1`,
    [userId, id, mail, phones]);
  if (!prev) return;
  // If a row already sits under the real id (the contact was imported twice, once each way) the
  // provisional one is a duplicate we cannot safely fold in; leave it and let the real row win.
  await q(
    `UPDATE leads SET hubspot_contact_id = $2, source = $3 WHERE hubspot_contact_id = $1
       AND NOT EXISTS (SELECT 1 FROM leads x WHERE x.hubspot_contact_id = $2)`,
    [prev.id, id, 'csv']);
}

/**
 * Put one person into one rep's queue. Shared by the CSV import and the HubSpot pull so the two can
 * never disagree about dedupe, ownership or where a part-way lead has got to.
 *
 * `phones` must already be normalised to +E.164, ordered (primary first) and deduped — each inlet
 * parses its own columns and reports its own warnings, but they agree from here down.
 *
 * Re-importing never resets attempt_count or status, nor the number a part-way lead has rolled onto.
 * `source` is last-inlet-wins, matching the existing "latest upload owns the lead" rule for user_id:
 * whichever door the lead most recently came through is the one that governs it.
 */
export async function upsertLead({ userId, id, name, phones, country, utcOffset, segment, extra, source, seenAt = null }) {
  await adoptProvisionalKey(userId, id, extra?.email, phones);
  const { rows: [r] } = await q(
    `INSERT INTO leads (hubspot_contact_id, name, phone, phones, country, utc_offset, segment, extra, user_id, source, hubspot_seen_at)
     VALUES ($1, $2, $3, $9, $4, $5, $6, $7, $8, $10, $11)
     ON CONFLICT (hubspot_contact_id) DO UPDATE
       SET name = coalesce(EXCLUDED.name, leads.name), country = coalesce(EXCLUDED.country, leads.country),
           utc_offset = coalesce(EXCLUDED.utc_offset, leads.utc_offset), segment = EXCLUDED.segment,
           extra = leads.extra || EXCLUDED.extra, user_id = EXCLUDED.user_id, source = EXCLUDED.source,
           hubspot_seen_at = coalesce(EXCLUDED.hubspot_seen_at, leads.hubspot_seen_at),
           phones = EXCLUDED.phones,
           -- Keep a part-way lead where it is: find the number it is on by value in the new list
           -- (position, not index - the sheet may have reordered the columns) and fall back to the
           -- primary if the upload dropped that number altogether.
           phone_idx = GREATEST(1, coalesce(array_position(EXCLUDED.phones, leads.phone), 1)),
           phone = coalesce(EXCLUDED.phones[array_position(EXCLUDED.phones, leads.phone)], EXCLUDED.phone)
     RETURNING id, (xmax = 0) AS inserted, status`,
    [id, name || null, phones[0], country || null, utcOffset ?? null, segment,
     JSON.stringify(extra ?? {}), userId, phones, source, seenAt]);
  return r;
}

/** Upsert leads from a CSV buffer into the uploading rep's own queue. A lead uploaded again by
 *  another rep moves to that rep (latest upload owns it). */
export async function importCsv(csv, userId) {
  const rows = parse(csv, { columns: (h) => h.map(key), skip_empty_lines: true, bom: true, trim: true });
  const result = { inserted: 0, updated: 0, withAlternates: 0, skipped: [], warnings: [] };

  for (const [i, row] of rows.entries()) {
    const line = i + 2;
    let name = pick(row, 'name', 'fullname', 'pocname', 'poc', 'contactname')
      || [pick(row, 'firstname'), pick(row, 'lastname')].filter(Boolean).join(' ');
    if (looksLikePhone(name)) name = ''; // HubSpot sometimes puts the phone in Name
    const country = pick(row, 'country', 'countryregion', 'countryfield', 'ipcountry');
    const rawPhone = pick(row, 'phone', 'phonenumber', 'mobilephonenumber', 'mobile') || (name ? '' : pick(row, 'name'));
    const rawAlts = [
      pick(row, 'alternatenumber1', 'alternatenumber', 'alternatephone1', 'altnumber1', 'alternate1'),
      pick(row, 'alternatenumber2', 'alternatephone2', 'altnumber2', 'alternate2'),
    ].filter(Boolean);
    const hsId = pick(row, 'recordid', 'hubspotcontactid', 'contactid', 'id');
    // Everything else worth showing on the call card until HubSpot sync lands (plan s14 defers write-back).
    const link = pick(row, 'hubspotlink', 'recordurl', 'url');
    const linkedin = pick(row, 'linkedinid', 'linkedin', 'linkedinurl', 'linkedinprofile');
    const email = pick(row, 'email');
    const extra = Object.fromEntries(Object.entries({
      email, company: pick(row, 'company', 'companyname', 'associatedcompany'),
      leadStage: pick(row, 'leadstage', 'leadstatus', 'leaddropdown'), lifecycle: pick(row, 'lifecyclestage'),
      origin: pick(row, 'origintier', 'originalsource', 'source'), title: pick(row, 'jobtitle', 'designation'),
      linkedin, hubspotUrl: /^https?:\/\//.test(link) ? link : '',
    }).filter(([, v]) => v));

    // Timezone comes from the country column first; with none, any of the lead's numbers that
    // carries a dial code answers for it (+44 -> UK, +1 -> US), primary first.
    const resolved = [rawPhone, ...rawAlts].reduce((hit, p) => hit ?? resolveLead({ country, phone: p }), null);
    const phone = normalizePhone(rawPhone, resolved?.region);
    if (!phone) {
      const why = /\d\.?\d*e\+\d+/i.test(String(rawPhone)) ? ' (Excel turned it into scientific notation - re-export from HubSpot and upload without opening in Excel)' : '';
      result.skipped.push({ line, reason: 'unusable phone: ' + JSON.stringify(rawPhone) + why }); continue;
    }
    if (!resolved) result.warnings.push({ line, phone, reason: 'no timezone for country ' + JSON.stringify(country) + '; imported but ineligible until fixed' });

    // The cascade order. Deduped because these sheets often repeat the primary in an alternate
    // column, and a lead that "rolls" onto the identical number burns three tries for nothing.
    const phones = [phone];
    for (const raw of rawAlts) {
      const alt = normalizePhone(raw, resolved?.region);
      if (!alt) { result.warnings.push({ line, phone, reason: 'unusable alternate number ' + JSON.stringify(raw) + '; the other numbers were imported' }); continue; }
      if (!phones.includes(alt)) phones.push(alt);
    }
    if (phones.length > 1) result.withAlternates++;

    // Identity: the HubSpot Record ID when the export has one, else the email (so a corrected phone
    // number does not duplicate the lead), else the number. Reuse the key of a row already held
    // under this email so leads imported before the email key existed are updated, not duplicated.
    let id = hsId;
    if (!id && email) {
      const { rows: [prev] } = await q(
        `SELECT hubspot_contact_id FROM leads WHERE user_id = $1 AND lower(extra->>'email') = $2 LIMIT 1`, [userId, email.toLowerCase()]);
      id = prev?.hubspot_contact_id ?? 'email-' + email.toLowerCase();
    }

    const r = await upsertLead({
      userId, id: id || 'manual-' + phone, name, phones, country,
      utcOffset: resolved?.offset ?? null, segment: segmentFor(resolved?.region), extra, source: 'csv',
    });
    r.inserted ? result.inserted++ : result.updated++;
  }
  return result;
}
