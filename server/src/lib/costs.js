// Plivo account balance uses the existing ledger table to preserve historical billing.
import { q } from '../db/pool.js';
import { pokeAdmins } from '../io.js';
import { plivoRequest, voiceCall } from '../plivo.js';

/** Upsert one call.cost event. Telnyx retries webhooks and may send an 'error' cost before a
 *  'success' one: the later event wins; identity fields are kept from whichever arrived first. */
export async function onCallCost(p, state, occurredAt) {
  if (!p?.call_control_id) return;
  let total = Number(p.total_cost);
  if (!Number.isFinite(total)) total = 0;                                   // status 'error' may carry null
  const parts = Array.isArray(p.cost_parts) ? p.cost_parts : [];
  const currency = parts.find((x) => x?.currency)?.currency ?? 'USD';
  await q(
    `INSERT INTO telnyx_costs (call_control_id, call_leg_id, call_session_id, kind, user_id, call_id,
                               occurred_at, total_cost, currency, billed_secs, status, parts)
     VALUES ($1, $2, $3, $4, $5, (SELECT id FROM calls WHERE telnyx_call_id = $1), $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (call_control_id) DO UPDATE SET
       total_cost = EXCLUDED.total_cost, billed_secs = EXCLUDED.billed_secs, status = EXCLUDED.status,
       parts = EXCLUDED.parts, occurred_at = EXCLUDED.occurred_at, currency = EXCLUDED.currency,
       kind = coalesce(telnyx_costs.kind, EXCLUDED.kind), user_id = coalesce(telnyx_costs.user_id, EXCLUDED.user_id),
       call_id = coalesce(telnyx_costs.call_id, EXCLUDED.call_id)`,
    [p.call_control_id, p.call_leg_id ?? null, p.call_session_id ?? null, state?.kind ?? null, state?.userId ?? null,
     p.occurred_at ?? occurredAt ?? new Date().toISOString(), total, currency, p.billed_duration_secs ?? null,
     p.status ?? null, JSON.stringify(parts)]);
  pokeAdmins('cost');
}

// Plivo's API and CDR amounts are USD; the Indian Console converts at a fixed rate (~80) for
// display. Match it: set EXCHANGE_RATE_INR to Plivo's rate; 80 is the sensible default.
export const rate = () => Number(process.env.EXCHANGE_RATE_INR) || 80;
export const toInr = async (n) => (Number.isFinite(n) ? Math.round(n * rate() * 100) / 100 : n);

// CDRs are fetched through a durable inbox job; Plivo may publish them after hangup.
export async function refreshCallCost(id) {
  const call = await voiceCall(id);
  if (!call?.call_uuid) throw new Error('Plivo call UUID is not available for billing yet');
  const cdr = await plivoRequest('Call/' + encodeURIComponent(call.call_uuid) + '/');
  if (cdr.total_amount == null || !Number.isFinite(Number(cdr.total_amount))) throw new Error('Plivo billing is not ready yet');
  await onCallCost({ call_control_id: id, call_leg_id: call.call_uuid, total_cost: cdr.total_amount,
    billed_duration_secs: Number(cdr.bill_duration ?? cdr.billed_duration ?? cdr.call_duration ?? 0), status: 'success',
    cost_parts: [{ call_part: 'voice', cost: cdr.total_amount, currency: 'USD', rate: cdr.total_rate ?? null }],
  }, call.state, call.ended_at ?? new Date().toISOString());
}

let cached = { at: 0, value: null };
export async function balance() {
  if (cached.value && Date.now() - cached.at < 60_000) return cached.value;
  const data = await plivoRequest('');
  const amount = data.cash_credits == null ? null : await toInr(Number(data.cash_credits));
  cached = { at: Date.now(), value: {
    balance: amount, pending: null, creditLimit: null, availableCredit: amount,
    currency: 'INR', asOf: new Date().toISOString(),
  } };
  return cached.value;
}
