# Reliability fixes — September 12, 2026

These changes are implemented in the working tree. The visual redesign remains an approval prototype in `docs/ui-proposal/`; it is not part of the production UI changes.

## Six fixes

1. **Refresh and restart recovery.** The session snapshot keeps call IDs and lead IDs distinct, restores ringing calls and pending outcomes from PostgreSQL, and checks persisted pending calls before starting another burst. Automatic browser audio connection waits for recovery and does not replace audio during a recovered call. Delayed hangups from an older audio connection cannot clear its replacement.
2. **Durable webhooks and atomic outcomes.** Verified Telnyx events are stored before HTTP acknowledgement. A worker resumes pending events on startup and retries with backoff. Event and burst locks prevent concurrent processing. Call settlement, lead retry/attempt state, rep edits and the HubSpot job commit together. Winner selection and its answer timestamp commit together. Bridge commands use a stable command ID on retry.
3. **Serialized HubSpot logging and durable retries.** Each call has one serialized sync job, used by hangup, outcome and recording handlers. New work increments a version so an in-progress request cannot erase a later update. Failures remain queued across restarts. An uncertain create is searched by its timestamp and stable reference before another action is sent; a lost response cannot cause a blind second create. Recording upload uses HubSpot’s documented duplicate detection options.
4. **HubSpot ownership and field refresh.** Current name, company, email, numbers, country and ownership refresh on polling and re-ticking. Existing attempts, retry times and callbacks are preserved. A live call keeps its owner and contact fields until settlement; the following poll applies the deferred transfer. Row locks coordinate CRM updates with queue claims.
5. **DST-aware scheduling.** Leads store IANA timezones. Queue windows, previous-attempt local hours, current local clocks and future callback presets use the offset at the relevant date. Existing leads are backfilled by migration. Unknown/legacy rows retain their numeric-offset fallback. Countries with multiple zones retain the existing representative choice (for example US East and Sydney); this does not infer a city from a phone number.
6. **Accurate queue labels.** Cards and admin lead lists use the actual attempt ceiling (six or nine). Retry groups distinguish 10-minute cancellations, 15-minute alternate-number retries and ordinary two-hour retries. The outcome response includes actual retry state, which is shown in the activity message.

## Verification

Run `npm test` from `server/`. The runner creates a fresh, disposable local PGlite database for every suite and stubs external services. It never loads `server/.env`. Direct execution of the older database scripts is guarded so they cannot reset a schema on the configured production database.

Coverage includes existing CSV/cascade, HubSpot inlet, recording, call logging and admin metrics checks, plus regressions for distinct IDs, restart recovery, authorization, invalid callback dates, failed-save rollback, duplicate submissions, early/replayed webhooks, stale audio events, live ownership protection, northern/southern DST, retry groups, concurrent CRM writes, failed PATCH retry and accepted POST response loss. PGlite exercises PostgreSQL SQL and transaction behavior locally; its socket multiplexer is not a production PostgreSQL load/concurrency test. Database advisory locks should also be exercised with concurrent connections in staging.

Client checks: `npm run lint`, `npx tsc --noEmit`, and `npm run build` from `client/`. No real calls, CRM writes or production migrations were used for verification.

## Release and recovery notes

- The existing deployment startup runs `server/src/db/migrate.js` before the server. It adds `telnyx_events`, `hubspot_jobs`, call sync/bridge fields, rep audio state, and lead timezone/retry fields; the schema is safe to reapply. Restart during an idle period when practical, then verify a test call, refresh during ringing and after hangup, outcome save, and HubSpot update in the deployed environment.
- Successful webhook payloads are retained for seven days; pending failures remain available in `telnyx_events` with attempts, error and next retry time. HubSpot pending work is in `hubspot_jobs`; the existing call log exposes `calls.hubspot_error`.
- When a HubSpot create has an ambiguous result and cannot yet be found, the job stays pending instead of risking a duplicate. Inspect HubSpot for the exact `Eazybe call reference` from `calls.hubspot_sync_key`. If the activity exists, reconcile its ID; only clear `hubspot_create_started_at` after confirming that no activity was created. Never automatically clear that marker merely because a search failed.
- Existing historically failed HubSpot writes are not bulk replayed by this migration; new settlements and subsequent recording/outcome updates use the durable worker. No historical call backfill or deployment was requested/performed in this change.

HubSpot file options were checked against the [official Files API documentation](https://developers.hubspot.com/docs/api-reference/latest/files/guide).
