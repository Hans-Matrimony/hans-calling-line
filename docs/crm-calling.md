# CRM Request Leads calling

The CRM integration uses the existing Laravel `users` login for TSEs (active roles 3, 5 and 7). It creates no separate calling rep accounts. Request Leads rows receive a Call button automatically, including a previously called lead when it is requested again. The retired checkbox / rep-email / Send to Dialer panel is removed.

Fresh is an age rule, **not a request category**: a source lead aged 24 hours or less is excluded. Incomplete leads use `meta_date` when present, otherwise `created_at`; website/upgrade leads use `leads.created_at`. All supported request types 0 through 9 remain eligible after the Fresh window. Eligibility is restricted to the signed-in TSE's currently requested leads for the CRM's current day, matching the existing Request Leads flow. Previous calling history never excludes a requested lead. Freshness uses CRM Asia/Kolkata timestamps and is rechecked on every call.

Clicking Call opens a popup in the CRM document, asks for that site's microphone permission, logs the browser SDK in, and connects its audio leg. Only after both the browser and Plivo conference confirm audio does the backend call the authoritative CRM phone number. Pick/Not Pick remains the existing manual CRM action; no calling endpoint or callback writes source CRM tables.

## Storage and authentication

Set `CALLING_STORAGE=crm_mysql` on the calling-line backend. In this mode no PostgreSQL pool, legacy queue, HubSpot polling, or legacy dialing worker is imported. Configure `CRM_DB_HOST`, `CRM_DB_PORT`, `CRM_DB_NAME`, `CRM_DB_USER`, `CRM_DB_PASSWORD` to point to **the same MySQL database used by Laravel CRM**, plus `CRM_DB_SSL=true` if required by that database.

`npm run migrate` creates only these additive tables in that database:

- `hans_calling_agents`: Plivo endpoint mapping keyed by CRM user ID, not a login account.
- `hans_calling_sessions`: browser audio sessions and their provider cost.
- `hans_calling_calls`: requested-lead identity, customer calls, outcomes, recordings, cost and idempotency keys.
- `hans_calling_admins`: existing calling-line admin logins copied at cutover.

CRM source tables are read only for this integration. A database account can be granted SELECT on source tables and write permission only on these prefixed tables after migration.

Set the same random 32+ character value for calling-line `CRM_QUEUE_TOKEN` and Laravel `HANS_DIALER_QUEUE_TOKEN`. The name is retained for deployment compatibility; it now authenticates the server-side calling proxy. There is no default secret. Set calling-line `SESSION_SECRET` to at least 32 random characters. Set Laravel `HANS_DIALER_URL` to the public HTTPS calling-line origin. The browser never receives the shared token, TSE password, or Plivo account secret. CRM requests stay authenticated and CSRF-protected by Laravel, and Node independently checks that the CRM TSE remains active.

Retain the existing Plivo account/application variables and owned `FROM_NUMBER_INDIA`, `FROM_NUMBER_US`, `FROM_NUMBER_EU` values. `PUBLIC_URL` must be the calling-line public HTTPS origin. Signed callbacks use `/webhooks/crm/*`; outbound calls supply these URLs directly. `RECORD_CALLS=false` disables customer recording. `USD_TO_INR` defaults to 80 and is a configurable reporting conversion, not a live exchange rate.

Calling-line's normal login page accepts CRM TSE email/password. Admins see all CRM call logs, audio sessions, costs and recordings; TSEs see their own records. Playback is authenticated and proxied; Plivo credentials never pass to the browser or redirect host. Filters use IST dates, including the whole selected end date. Session history shows the latest 100 sessions separately from the customer-call filter.

## Cutover

1. Build/test both repositories. `npm run build` in `client` copies the installed Plivo browser SDK and license into static assets; Docker already includes those assets. Deploy the calling-line build and CRM changes together.
2. Configure the CRM database connection and both shared secrets in the deployment environment. Set `CALLING_STORAGE=crm_mysql`, then run `npm run migrate` from `server` (Docker runs it before startup).
3. Preserve existing admin credentials with `node scripts/import-crm-admins.mjs --apply` from `server`. It reads admins from the old PostgreSQL `DATABASE_URL` and copies their existing password hashes into CRM. It never creates rep logins. Run only after the CRM calling tables exist.
4. Restart the calling backend, clear Laravel config/view caches, then confirm `/health` reports `storage: crm_mysql` and that the calling-line login shows the CRM workspace.
5. Check microphone permission on the CRM origin with a controlled test lead before wider use.

Local work does not change production environment variables, run production migrations, or place real calls. Legacy PostgreSQL data is preserved. The new CRM reports show CRM-mode calls; old PostgreSQL history is not automatically imported. Switching back to `CALLING_STORAGE=postgres` uses the preserved legacy application.

## Reliability and verification

One audio session and one active customer call per TSE are reserved under MySQL locks. Browser owners prevent another window from taking over active audio. Duplicate submissions reuse a persisted idempotency key. Callback updates are idempotent; late conference events cannot resurrect stopped calls. Uncertain provider responses retain their reservation and request cancellation, rather than immediately redialing. Idle audio closes after two minutes. The worker retries cancellation and CDR lookup, reconciles missed hangups, and expires unresolved reservations only after the provider's four-hour maximum plus a ten-minute grace period.

Automated checks use a freshly initialized, loopback-only MySQL instance, in-memory SQLite for Laravel, and mocked Plivo/browser audio. They never read production DB credentials or place real calls:

```text
node server/scripts/test-crm-mysql.mjs
node client/tests/crm-widget-test.cjs
# From HansDashboardCRM:
php vendor/bin/phpunit tests/Feature/CallingTest.php
```

`MYSQLD_PATH` selects a local MySQL binary for the first test. `PLAYWRIGHT_CHANNEL=msedge` selects the installed test browser. The legacy Plivo/audio tests and the frontend build remain part of regression validation.
