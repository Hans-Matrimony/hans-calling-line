import { q, transaction } from '../db/pool.js';
import { upsertLead, adoptProvisionalKey } from './import.js';
import { resolveLead } from './countries.js';
import { isDeepStrictEqual } from 'node:util';

const FINISHED = new Set(['connected', 'exhausted', 'stopped']);

/** Refresh CRM fields and ownership under the same row lock used by queue claims.
 * A live call keeps its owner, numbers and outcome state until the next poll after settlement. */
export async function reconcileLead(lead, userId, startedAt, prev, trustAbsence) {
  return transaction(async () => {
    await q('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['hs-contact:' + lead.id]);
    await adoptProvisionalKey(userId, lead.id, lead.extra?.email, lead.phones);
    const { rows: [ex] } = await q('SELECT * FROM leads WHERE hubspot_contact_id = $1 FOR UPDATE', [lead.id]);
    if (!ex) {
      await upsertLead({ ...lead, userId, seenAt: startedAt });
      return { action: 'added' };
    }
    if (ex.hubspot_seen_at && new Date(ex.hubspot_seen_at) > startedAt) return { action: 'skipped' };
    if (ex.status === 'in_flight') {
      // Do not mark a transferred contact seen by its old owner: a later poll must still reconcile it.
      if (ex.user_id === userId) await q('UPDATE leads SET hubspot_seen_at = $2 WHERE id = $1', [ex.id, startedAt]);
      return { action: 'skipped' };
    }
    const resume = ex.status === 'stopped' && String(ex.stopped_reason ?? '').startsWith('hubspot_untick');
    const reopen = !resume && FINISHED.has(ex.status) && (ex.hubspot_seen_at == null ||
      (trustAbsence && new Date(ex.hubspot_seen_at) < prev));
    const status = resume ? (ex.stopped_reason === 'hubspot_untick_later' ? 'later' : 'queued') : reopen ? 'queued' : ex.status;
    const index = reopen ? 0 : Math.max(0, lead.phones.indexOf(ex.phone));
    const resolved = resolveLead({ country: lead.country, phone: lead.phones[0] });
    const changed = ex.user_id !== userId || ex.name !== (lead.name || null) || ex.country !== (lead.country || null) ||
      ex.timezone !== (resolved?.timezone ?? null) || !isDeepStrictEqual(ex.phones, lead.phones) || !isDeepStrictEqual(ex.extra, lead.extra);
    await q(`UPDATE leads SET user_id = $2, name = NULLIF($3, ''), country = NULLIF($4, ''),
      phones = $5, phone_idx = $6, phone = $7, timezone = $8, utc_offset = $9, segment = $10,
      extra = $11, hubspot_seen_at = $12, source = 'hubspot', status = $13,
      stopped_reason = CASE WHEN $14 OR $15 THEN NULL ELSE stopped_reason END,
      attempt_count = CASE WHEN $14 THEN 0 ELSE attempt_count END,
      number_attempts = CASE WHEN $14 OR phone IS DISTINCT FROM $7 THEN 0 ELSE number_attempts END,
      next_call_at = CASE WHEN $14 THEN now() ELSE next_call_at END,
      retry_minutes = CASE WHEN $14 THEN NULL ELSE retry_minutes END WHERE id = $1`,
    [ex.id, userId, lead.name, lead.country, lead.phones, index + 1, lead.phones[index], resolved?.timezone ?? null,
      resolved?.offset ?? null, lead.segment, JSON.stringify(lead.extra), startedAt, status, reopen, resume]);
    return { action: resume ? 'resumed' : reopen ? 'reopened' : changed ? 'refreshed' : null, previousOwner: ex.user_id !== userId ? ex.user_id : null };
  });
}
