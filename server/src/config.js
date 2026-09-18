// Cadence and windows (plan s4, s7). Rep shift (14:00-23:00 IST) is not enforced server-side:
// the rep is the trigger. IGNORE_WINDOWS=true lets the 2-phone plumbing test run at any hour.
export const MAX_ATTEMPTS = 6;
export const MIN_GAP_HOURS = 2;
// Multi-number leads: tries spent on one number before rolling to the lead's next one, and the
// shorter gap before that fresh number is first rung (a new channel, so it need not wait the full
// MIN_GAP_HOURS - but not seconds later either). MAX_ATTEMPTS stays the floor for the whole lead:
// the ceiling is GREATEST(MAX_ATTEMPTS, ATTEMPTS_PER_NUMBER * how many numbers the lead has).
export const ATTEMPTS_PER_NUMBER = 3;
export const ROLL_GAP_MINUTES = 15;
export const LEGS_PER_BURST = 2;
export const DIAL_TIMEOUT_SECS = 30;
export const DAILY_CAP_PER_NUMBER = 100; // was 50; lowered again if a caller ID gets flagged (PLAN-v2 s8)
export const LEAD_LOCAL_WINDOW = { start: 10, end: 19 }; // lead local time, [start, end)
export const IGNORE_WINDOWS = process.env.IGNORE_WINDOWS === 'true';
// Call recording (plan 2026-09-10): every bridged conversation, silently, unless switched off on Railway.
// RECORD_BEEP=true plays a beep to the lead when recording starts (off by owner's decision).
export const RECORD_CALLS = process.env.RECORD_CALLS !== 'false';
export const RECORD_BEEP = process.env.RECORD_BEEP === 'true';
