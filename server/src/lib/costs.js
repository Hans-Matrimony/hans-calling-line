// Telnyx spend (Wallet). Telnyx sends one `call.cost` webhook per leg after it ends - only when the
// Call Control app has call_cost_in_webhooks on (scripts/telnyx-setup.mjs). Every leg we place costs
// money, including the loser legs of a burst and the rep's own session leg, so each lands in
// telnyx_costs whether or not a `calls` row exists for it.
import { q } from '../db/pool.js';
import { pokeAdmins } from '../io.js';
import { telnyx } from '../telnyx.js';

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

// Telnyx account balance, for the Wallet. One call a minute at most: the dashboard polls, Telnyx does not.
let cached = { at: 0, value: null };
export async function balance() {
  if (cached.value && Date.now() - cached.at < 60_000) return cached.value;
  const { data } = await telnyx().balance.retrieve();
  const n = (v) => (v == null ? null : Number(v));
  cached = { at: Date.now(), value: {
    balance: n(data?.balance), pending: n(data?.pending), creditLimit: n(data?.credit_limit),
    availableCredit: n(data?.available_credit), currency: data?.currency ?? 'USD', asOf: new Date().toISOString(),
  } };
  return cached.value;
}
