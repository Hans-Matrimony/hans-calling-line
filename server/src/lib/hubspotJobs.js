import { q } from '../db/pool.js';

/** Call inside the transaction that settles a call; the worker sees it only after commit. */
export function queueCallSync(callId) {
  return q(`INSERT INTO hubspot_jobs (call_id) VALUES ($1)
    ON CONFLICT (call_id) DO UPDATE SET version = hubspot_jobs.version + 1, next_attempt_at = now()`, [callId]);
}
