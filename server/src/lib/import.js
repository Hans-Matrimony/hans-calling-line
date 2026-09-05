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

/** Upsert leads from a CSV buffer. Re-importing never resets attempt_count / status. */
export async function importCsv(csv) {
  const rows = parse(csv, { columns: (h) => h.map(key), skip_empty_lines: true, bom: true, trim: true });
  const result = { inserted: 0, updated: 0, skipped: [], warnings: [] };

  for (const [i, row] of rows.entries()) {
    const line = i + 2;
    let name = pick(row, 'name', 'fullname')
      || [pick(row, 'firstname'), pick(row, 'lastname')].filter(Boolean).join(' ');
    if (/^[\d\s+()-]+$/.test(name)) name = ''; // HubSpot sometimes puts the phone in Name
    const country = pick(row, 'country', 'countryregion', 'countryfield', 'ipcountry');
    const rawPhone = pick(row, 'phone', 'phonenumber', 'mobilephonenumber', 'mobile') || (name ? '' : pick(row, 'name'));
    const hsId = pick(row, 'recordid', 'hubspotcontactid', 'contactid', 'id');
    // Everything else worth showing on the call card until HubSpot sync lands (plan s14 defers write-back).
    const link = pick(row, 'hubspotlink', 'recordurl', 'url');
    const extra = Object.fromEntries(Object.entries({
      email: pick(row, 'email'), company: pick(row, 'company', 'companyname', 'associatedcompany'),
      leadStage: pick(row, 'leadstage', 'leadstatus'), lifecycle: pick(row, 'lifecyclestage'),
      origin: pick(row, 'origintier', 'originalsource', 'source'), title: pick(row, 'jobtitle'),
      hubspotUrl: /^https?:\/\//.test(link) ? link : '',
    }).filter(([, v]) => v));

    const resolved = resolveLead({ country, phone: rawPhone });
    const phone = normalizePhone(rawPhone, resolved?.region);
    if (!phone) {
      const why = /\d\.?\d*e\+\d+/i.test(String(rawPhone)) ? ' (Excel turned it into scientific notation - re-export from HubSpot and upload without opening in Excel)' : '';
      result.skipped.push({ line, reason: 'unusable phone: ' + JSON.stringify(rawPhone) + why }); continue;
    }
    if (!resolved) result.warnings.push({ line, phone, reason: 'no timezone for country ' + JSON.stringify(country) + '; imported but ineligible until fixed' });

    const { rows: [r] } = await q(
      `INSERT INTO leads (hubspot_contact_id, name, phone, country, utc_offset, segment, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (hubspot_contact_id) DO UPDATE
         SET name = coalesce(EXCLUDED.name, leads.name), phone = EXCLUDED.phone, country = coalesce(EXCLUDED.country, leads.country),
             utc_offset = coalesce(EXCLUDED.utc_offset, leads.utc_offset), segment = EXCLUDED.segment,
             extra = leads.extra || EXCLUDED.extra
       RETURNING (xmax = 0) AS inserted`,
      [hsId || 'manual-' + phone, name || null, phone, country || null, resolved?.offset ?? null, segmentFor(resolved?.region), JSON.stringify(extra)]);
    r.inserted ? result.inserted++ : result.updated++;
  }
  return result;
}
