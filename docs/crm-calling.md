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
- `hans_calling_auto_leads`: separate Auto Calling reservations, confirmed dispositions and CRM history references.

The Calling Line backend reads CRM source tables and writes only the prefixed calling tables. Its database account can retain SELECT-only access to source tables after migration. Laravel Auto Calling uses the CRM connection to reserve source leads and apply the existing Pick/Not Pick updates when the TSE saves an outcome.

Set the same random 32+ character value for calling-line `CRM_QUEUE_TOKEN` and Laravel `HANS_DIALER_QUEUE_TOKEN`. The name is retained for deployment compatibility; it now authenticates the server-side calling proxy. There is no default secret. Set calling-line `SESSION_SECRET` to at least 32 random characters. Set Laravel `HANS_DIALER_URL` to the public HTTPS calling-line origin. The browser never receives the shared token, TSE password, or Plivo account secret. CRM requests stay authenticated and CSRF-protected by Laravel, and Node independently checks that the CRM TSE remains active.

Retain the existing Plivo account/application variables and owned `FROM_NUMBER_INDIA`, `FROM_NUMBER_US`, `FROM_NUMBER_EU` values. `PUBLIC_URL` must be the calling-line public HTTPS origin. Signed callbacks use `/webhooks/crm/*`; outbound calls supply these URLs directly. `RECORD_CALLS=false` disables customer recording. `USD_TO_INR` defaults to 80 and is a configurable reporting conversion, not a live exchange rate.

Calling-line's normal login page accepts CRM TSE email/password. Admins see all CRM call logs, audio sessions, costs and recordings; TSEs see their own records. Playback is authenticated and proxied; Plivo credentials never pass to the browser or redirect host. Filters use IST dates, including the whole selected end date. Session history shows the latest 100 sessions separately from the customer-call filter.

## CRM calling on/off switch

Set `HANS_DIALER_ENABLED=false` in the Laravel CRM environment to hide Request Leads calling buttons and prevent new Request Leads calls. Request Leads retains its default of `true`. The separate Auto Calling section is independently controlled by `HANS_AUTO_CALLING_ENABLED` (default `false`). Set either flag to `true` to enable only that feature.

After changing this value, run `php artisan config:cache` and `php artisan view:clear` in the CRM deployment. Newly loaded pages omit the calling widget entirely when disabled. Already-open pages remove their Call buttons on the next successful lead refresh (normally within 15 seconds); an idle popup is hidden too. New audio/login/call proxy requests are rejected immediately after the configuration is refreshed. Existing call status and End call controls remain available until the current call finishes. Each flag gates its own CRM page, audio credentials and call proxy routes. Either feature can remain enabled while the other is disabled; calling-line reporting and login remain available.

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

## Separate CRM Auto Calling

Open **CRM > Auto Calling** with an active TSE account (roles 3, 5, 7). Click **Start calling**, allow microphone access, and keep the page open. Audio connects before dialing. The shared popup provides Mute and End call with local connecting/ended sounds and spoken status messages; Request Leads uses the same popup. Browser speech availability depends on installed voices; the connecting tone is generated locally.

The CRM reserves one random eligible lead at a time, alternating randomly between available source pools:

- Non-Fresh `incomplete_leads` under the Request New Leads filters, assigned creation-age rule, 150-per-day new-lead limit and existing active-bucket limit. Converted/already assigned numbers, Channel1/Punjab, deleted/bakwas and Fresh duplicates are excluded.
- Rejected `leads` under the existing rejected-lead rules (recent follow-up, rejection ownership restriction, available `request_by`), also excluding Fresh/deleted records.

Fresh means the last 24 hours using `COALESCE(meta_date,created_at)` for incomplete leads and `created_at` for leads. Pending Request Leads numbers are excluded across both source tables and TSEs. A unique active TSE and phone reservation prevents duplicate allocation. Source `request_by` is reserved so the manual request flow does not claim the same row. Existing manual Request Leads calling remains available separately.

After a call ends, its persisted Plivo answer state suggests Pick or Not Pick. The TSE can correct the suggestion and must choose/save an existing CRM disposition. Add Lead opens the existing full CRM form for incomplete leads; rejected leads use the existing follow-up/reassignment behavior and interest values. Negative outcomes use the existing source model updates and `not_pick_data`. Successful saves write a completed `user_request_leads` history row for the authenticated TSE, without adding an item to the manual pending queue. All CRM changes and the reservation completion commit together. Duplicate saves do not apply counters twice.

Only a successful outcome save allows the next reservation/call. **Stop calling** ends current audio/call and pauses progression. Saving a pending outcome after stopping does not restart the run. Reloading also leaves the run stopped and restores the pending lead/outcome; no microphone prompt or new dial occurs until Start/Resume is clicked. An uncalled reserved lead stays assigned to that TSE for resume. Uncertain provider calls must finish reconciliation before marking/advancing.

Calling-line admin/TSE history shows the queue and saved Auto Calling outcome alongside the usual recording, costs and provider status. `HANS_AUTO_CALLING_ENABLED=false` hides the Auto Calling navigation and blocks new reservations/calls; completing an existing outcome remains possible.

### Deploying the Auto Calling update

1. Deploy Calling Line first. Its startup migration creates `hans_calling_auto_leads` in the configured CRM DB, including for existing installations.
2. Deploy CRM and run `php artisan migrate --path=database/migrations/2026_09_23_000001_create_hans_calling_auto_leads.php --force`. This migration safely skips the shared table if Calling Line already created it. It retains history on rollback.
3. Run `php artisan config:cache` and `php artisan view:clear`, then hard-refresh CRM. Keep the existing CRM DB, bridge token and Plivo configuration. Set `HANS_AUTO_CALLING_ENABLED=true` to enable Auto Calling. The existing `HANS_DIALER_ENABLED` value separately controls Request Leads buttons and calls.

Additional isolated checks, run from the CRM repository:

```text
php vendor/bin/phpunit --filter 'AutoCallingTest|CallingTest'
# Set AUTO_CALLING_PREVIEW_HTML to a local output file, then run the AutoCallingTest page-render test.
# With that same environment variable, browser checks use actual Blade HTML with all calls/saves mocked:
node tests/browser/auto-calling.cjs
```

The browser test locates the sibling Calling Line checkout by default (`CALLING_ROOT` can override it). No automated check places a real call.
