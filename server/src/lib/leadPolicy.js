import { MAX_ATTEMPTS, ATTEMPTS_PER_NUMBER } from '../config.js';

export const attemptLimit = (phones = []) => Math.max(MAX_ATTEMPTS, ATTEMPTS_PER_NUMBER * phones.length);
export const attemptLimitSQL = (alias = 'l') => `GREATEST(${MAX_ATTEMPTS}, ${ATTEMPTS_PER_NUMBER} * cardinality(${alias}.phones))`;
// Numeric fallback is for older/imported rows that have an offset but no known country or dial code.
export const localClockSQL = (alias = 'l', instant = 'now()') =>
  `(CASE WHEN ${alias}.timezone IS NOT NULL THEN ${instant} AT TIME ZONE ${alias}.timezone
    ELSE (${instant} AT TIME ZONE 'UTC') + ${alias}.utc_offset * interval '1 hour' END)`;
export const offsetSQL = (alias = 'l') =>
  `(EXTRACT(EPOCH FROM (${localClockSQL(alias)} - (now() AT TIME ZONE 'UTC'))) / 3600)::numeric`;
