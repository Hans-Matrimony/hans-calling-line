# Hans Dialer

Next.js 15 frontend (`client/`), Express/Socket.IO backend (`server/`), PostgreSQL, and **Plivo Voice**. Supports browser or phone audio, manual calling, one-lead auto dial and two-lead burst dial, outcomes, recordings, admin reporting, and optional HubSpot sync.

## Local setup

Requires Node.js 22+ and npm. Run from the repository root:

```powershell
npm ci --prefix server
npm ci --prefix client
# Fresh checkout only; do not overwrite an existing .env:
Copy-Item server/.env.example server/.env
'NEXT_PUBLIC_API_URL=http://localhost:3001' | Set-Content client/.env
```

Set a random `SESSION_SECRET` in `server/.env`. This machine already has a generated secret and configured local environment files. A root `.env` is not loaded by the app scripts.

Start the persistent development database in a terminal:

```powershell
npm run dev:db
```

PGlite listens only on `127.0.0.1:5433` and stores data in ignored `server/.local/postgres/`. It is a PostgreSQL-compatible development database with multiplexed connections. Use full PostgreSQL for production and concurrency validation; set `DATABASE_URL` to that server and skip `dev:db`.

In a second terminal:

```powershell
npm run migrate --prefix server
npm run dev:server
```

In a third terminal:

```powershell
npm run dev:client
```

Open http://localhost:3000; API health: http://localhost:3001/health. The local admin is `admin@hans.local`; its generated password is in ignored `.local/login.txt`. Background logs/PIDs are in `.local/`.

For a fresh database, create a user from `server/`:

```powershell
node scripts/add-user.js rep@example.com 'choose-a-password' --phone=+9198XXXXXXXX
# Add --admin for an administrator account. Admins manage the workspace; reps dial.
```

Upload leads as CSV in the app or, from `server/`, run `node scripts/import-csv.js ../data/leads.csv`.

## Plivo configuration

Set these **server-side** values in `server/.env`:

| Variable | Purpose |
| --- | --- |
| `PLIVO_AUTH_ID` | Account Auth ID from Plivo Console |
| `PLIVO_AUTH_TOKEN` | Private account Auth Token; also verifies V3 webhook signatures |
| `PLIVO_APPLICATION_ID` | Plivo Voice Application used for browser endpoints |
| `PUBLIC_URL` | Public HTTPS backend URL, without a trailing slash |
| `FROM_NUMBER_INDIA`, `FROM_NUMBER_EU`, `FROM_NUMBER_US` | Allowed caller IDs in E.164 format; comma-separated lists supported |
| `CLIENT_ORIGIN` | Frontend origin, locally `http://localhost:3000` |
| `DATABASE_URL`, `SESSION_SECRET`, `PORT` | Database, cookie-signing secret, API port |
| `HUBSPOT_TOKEN`, `HUBSPOT_POLL_SECONDS` | Optional CRM integration; a blank token disables polling |
| `IGNORE_WINDOWS` | `true` allows dialing outside lead-local hours; default `false` |
| `RECORD_CALLS`, `RECORD_BEEP` | Recording enabled by default; beep disabled by default |

For local calling, expose port 3001 with an HTTPS tunnel and put that URL in `PUBLIC_URL`. After setting account credentials, create/configure the Voice Application from `server/`:

```powershell
node scripts/plivo-setup.mjs
```

The setup script saves `PLIVO_APPLICATION_ID` to `server/.env`. It creates/updates the application's POST answer URL to `PUBLIC_URL/webhooks/plivo/application`; it does not buy numbers or place calls. You can configure the same application manually in Plivo Console. Restart the backend after environment changes.

Every server-originated call supplies its own answer, ring, hangup and fallback URLs. Plivo callbacks under `/webhooks/plivo/*` must pass V3 signature validation using the configured public URL and POST form payload. Do not rewrite or strip the query string at the proxy.

Browser Connect provisions one SIP endpoint per rep and returns an incoming-only JWT valid for 12 hours. Account credentials and SIP passwords stay on the server. Outgoing browser calls are disabled; the backend initiates the rep session. Allow microphone permission and use headphones. Phone mode rings the saved rep phone instead. Audio sessions have a four-hour provider time limit; reconnect when the session ends.

Plivo must allow the destination and caller ID on your account. For domestic India calling, use a rented Plivo India number with accepted compliance registration; country permissions, account verification and balance must also be configured. See [Plivo Call API](https://www.plivo.com/docs/voice/api/calls) and your Plivo Console for account-specific availability.

## Calling and recording flow

The rep joins a private conference and stays connected between leads. Answered leads first join individual holding conferences. A database claim selects one burst winner, cancels the other request/call, plays the rep cue, and transfers the winner into the rep's room. Conference entry confirms the bridge before recording starts. When the lead hangs up, the rep remains connected and chooses an outcome before starting again.

Call IDs are mapped durably because Plivo returns a request UUID before assigning the live CallUUID. The callback inbox handles retries and survives restarts. Recording callbacks store recording IDs; playback fetches the current URL and proxies audio with credentials kept on the server. The Record API requests stereo MP3 on the winning lead only. Live audio/channel behavior still requires validation on your Plivo account.

The wallet reads Plivo account credits and retrieves call-detail charges after hangup using retryable jobs. Figures reflect Plivo call-detail charges; separate conference, recording, number-rental or other invoice fees may not appear in this call ledger.

## Migration from Telnyx

Run `npm run migrate --prefix server` before starting the updated backend. Existing leads, users, outcomes and history are retained. Legacy database names such as `telnyx_call_id`, `telnyx_session_call_id`, `telnyx_costs` and `telnyx_events` are retained for data compatibility; new calls store stable local Plivo IDs there and use `plivo_calls` for provider mapping. Browser endpoints have separate `plivo_endpoint_id` and `plivo_sip_username` fields. Reconnect audio after migrating.

The Telnyx runtime SDKs and setup script have been removed. Historical Telnyx-hosted recordings are not fetched using Plivo credentials; existing HubSpot-hosted copies remain in HubSpot. Historical spend remains in the ledger. Perform migration when no real calls are active.

## Validation

```powershell
npm test --prefix server
npm run lint --prefix client
npm run build --prefix client
# UI regressions with installed Chrome (optional):
$env:PLAYWRIGHT_CHANNEL = 'chrome'
$env:UI_TEST_OUTPUT = "$PWD/.local/ui-tests"
npm run test:ui --prefix client
```

Backend tests use disposable isolated databases and mocked Plivo/HubSpot APIs. They do not place calls or use `server/.env`. Browser UI tests require Playwright from your environment. Live PSTN/SIP audio and provider delivery cannot be verified without configured Plivo credentials and a reachable HTTPS webhook.

## Production

The Next.js static export in `client/out` is served by Express. Set `NEXT_PUBLIC_API_URL=` for a same-origin production build; this value is embedded at build time. Keep frontend secrets out of `NEXT_PUBLIC_*` variables. Run the root build, then start with migrations:

```powershell
npm run build
npm start
```

Set `PUBLIC_URL` to the deployment HTTPS URL and configure the same Plivo Voice Application there. Set `NODE_ENV=production` in deployment to enable secure cookies.
