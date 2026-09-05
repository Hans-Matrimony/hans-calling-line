# Eazybe Dialer (MVP)

Burst dialer for one rep. Spec: [docs/PLAN.md](docs/PLAN.md).
`server/` Express + Socket.IO + Postgres + Telnyx Call Control. `client/` Next.js 15, static export.

## One-time setup
1. `server/.env` (copy of `.env.example`): Telnyx API + public key, `FROM_NUMBER_*`, `PUBLIC_URL`, `DATABASE_URL`.
2. `cd server && npm i && npm run migrate`
3. `node scripts/add-user.js rep@example.com <password> +91XXXXXXXXXX`
4. `node scripts/import-csv.js ../data/leads.csv` (or upload from the dialer screen)

## Dev
- Tunnel: `ngrok http --url=<static-domain> 3001` -- `PUBLIC_URL` must be `https://<static-domain>`
- Server: `cd server && npm run dev` (:3001)
- Client: `cd client && npm run dev` (:3000, talks to :3001 via `NEXT_PUBLIC_API_URL`)
- Testing outside lead hours: set `IGNORE_WINDOWS=true` in `server/.env`. Remove before Monday.
- Wiring check without DB/Telnyx: `node scripts/smoke.mjs`

## Prod (Railway)
`cd client && npm run build` writes `client/out`; the Express server serves it on the same origin.
`cd server && npm start`. Set `PUBLIC_URL` to the Railway URL and re-point the Telnyx app webhook.

## Flow
Status menu (top of the keypad) -> Audio in browser or Audio on my phone -> Connect me. Phone: it
rings, stay on the call (silence). Browser: the softphone answers itself, you hear silence in the
headset. Start calling -> 2 leads ring; first to answer: beep in ear, lead card, bridge; the other
leg is cancelled (not an attempt). Lead hangs up -> pick a disposition -> Start calling. No auto-advance.

## Browser audio (plan s9)
- `node scripts/telnyx-setup.mjs` creates the Credential Connection `eazybe-dialer-webrtc` and writes
  `TELNYX_WEBRTC_CONNECTION_ID` to `server/.env`. **Set the same variable on the Railway service.**
  Note the script also re-points the Call Control webhook at `PUBLIC_URL` from the local `.env`; after a
  local run, put it back to the Railway URL (or run the script with `PUBLIC_URL` set to Railway).
- First Connect per user creates a Telnyx telephony credential (stored on `users`), then every Connect
  mints a 24h JWT for the browser. SIP passwords never reach the browser.
- Needs HTTPS (Railway is), a wired headset, and mic permission. If browser audio misbehaves, pick
  Audio on my phone in the status menu: nothing else changes.

## Manual dial
Paste or key a `+E.164` number into the keypad, choose the caller ID at the bottom (all `FROM_NUMBER_*`
with today's usage against the 50/day cap), press the green button. The number is saved as a lead
(`manual-<phone>`), dialed as a one-leg burst from the chosen number, and counts as an attempt. The red
button cancels a ringing leg (no attempt) or hangs up a live one (disposition still required).

## Reading results (plan s12, non-India only)
```sql
SELECT count(*) FILTER (WHERE c.disposition <> 'cancelled')                 AS dials,
       count(*) FILTER (WHERE c.disposition = 'connected')                  AS connects,
       count(*) FILTER (WHERE c.disposition = 'abandoned')                  AS abandoned,
       round(100.0 * count(*) FILTER (WHERE c.disposition = 'connected')
             / nullif(count(*) FILTER (WHERE c.disposition <> 'cancelled'), 0), 1) AS connect_pct
FROM calls c JOIN leads l ON l.id = c.lead_id
WHERE l.segment = 'non_india' AND c.started_at >= date_trunc('day', now());

SELECT round(avg(attempt_count), 2) AS attempts_per_lead FROM leads WHERE segment = 'non_india' AND attempt_count > 0;
```
