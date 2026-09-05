// Cadence and windows (plan s4, s7). Rep shift (14:00-23:00 IST) is not enforced server-side:
// the rep is the trigger. IGNORE_WINDOWS=true lets the 2-phone plumbing test run at any hour.
export const MAX_ATTEMPTS = 6;
export const MIN_GAP_HOURS = 2;
export const LEGS_PER_BURST = 2;
export const DIAL_TIMEOUT_SECS = 30;
export const DAILY_CAP_PER_NUMBER = 100; // was 50; lowered again if a caller ID gets flagged (PLAN-v2 s8)
export const LEAD_LOCAL_WINDOW = { start: 10, end: 19 }; // lead local time, [start, end)
export const IGNORE_WINDOWS = process.env.IGNORE_WINDOWS === 'true';
