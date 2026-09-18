# Admin dashboard — design (2026-09-09, for review)

**Who:** one admin login, `marketing@hansmatrimony.com`, role `admin`. Sees every rep. Reps see nothing new.
**Job:** answer "is the dialer working, and who is working it" — then let the admin open any call.
**Mockup:** the published artifact (link in chat) shows all four screens with today's real numbers.

Status: **built and deployed 2026-09-10 — see §7.** §§1–6 are the review-stage design; decisions that changed are listed in §7.

## 1. What the data already supports

Everything below is SQL over tables that exist today (`calls`, `leads`, `bursts`, `users`). No new
tracking, no new writes from the dialer. One schema change: `users.role`.

Numbers from the live database on 2026-09-09, which the mockup uses:

| | |
|---|---|
| Dials per IST day, last 5 | 17 → 30 → 46 → 43 → **60** |
| Connect rate, non-India, all time | **7.6%** (13 of 172) — baseline to beat is 13% |
| Connect rate, India | 16.7% (4 of 24) |
| Sub-outcome picked on a connect | 4 of 17 — reps mostly leave the tile unpressed |
| Median wrap-up | 9 s (n = 26) |
| Caller ID `+1 302 417 0301` | 207 of 273 dials ever; **64 / 100** today |
| Dials at 00:00–01:00 IST | 17, zero connects — someone dialing at midnight |
| Queue | 447 leads: 405 CSV queued, 22 manual, 0 from HubSpot (inlet dormant) |

Each of those is a thing the dashboard should make visible at a glance. The sub-outcome one and
the midnight one are findings nobody had yet.

## 2. Role model

| | Rep | Admin |
|---|---|---|
| `users.role` | `rep` (default) | `admin` |
| After login | Dialer console, unchanged | Dashboard. No dialer — marketing@ does not dial. |
| API | `/api/session/*`, `/api/leads/*` scoped to self, unchanged | `/api/admin/*`, `requireAdmin` middleware; 403 for reps |
| Data | Own leads and calls | Every rep's |

Same login page, same cookie. After `/api/me` returns `role: 'admin'` the client renders `<Admin/>`
instead of `<Console/>`. One static page, no router — the same pattern the app already uses.

## 3. Screens

One **filter row** at the top of every screen, scoping everything under it (never per-panel):
**Period** Today · Yesterday · 7 days · 30 days · Custom — **Segment** All · Non-India · India —
**Rep** All · one. All dates are **IST** (Asia/Kolkata); today's `/stats` uses the UTC day, which
happens to contain the whole 14:00–23:00 shift but breaks for a 30-day range. The dashboard is IST.

### Overview — is it working?

1. **KPI row**, eight tiles, each with a delta vs the previous period of the same length:
   Dials · Connects · **Connect rate** · Talk time · Attempts / lead · Reach · Abandoned · Callbacks booked.
   Connect rate is the hero: the tile shows the rate, the segment it is for, and the **13% baseline** as a
   marker. Under "All" the tile shows non-India by default with India as the secondary number, because
   non-India is the measurement and India is the control (PLAN §2).
2. **Dials & connects by day** — one chart, two series (blue, green), one axis. Hover gives the day.
3. **Outcomes** — horizontal bars, one hue, sorted: No answer · Connected (unspecified) · Could not dial ·
   Interested · Follow-up · Not interested · Call later · Wrong number · Abandoned. "Connected (unspecified)"
   is deliberately its own row so the untouched-tile problem stays visible until it goes away.
4. **Reps** — a table, one row per rep: dials, connects, rate (with a bar), talk, avg wrap-up, leads left
   in queue, HubSpot sync state. Sorted by dials. Click → Reps screen filtered to them.
5. **Caller IDs** — one meter per number: dials today / cap (100), region, total ever. Amber past 80%.
   This is the cap that stops the day; it belongs on the front page.
6. **Live** — who is connected right now: audio on/off, on a call (with whom, how long), idle. From
   the server's in-memory `repUp` / `activeBurst`, pushed over the admin socket room.

### Reps — who is working it?

The Overview KPIs for one rep, plus what only makes sense per person:
- **By hour of day (IST)** — dials and connects per hour. Shows the shift actually worked and where
  connects land (today: 12:00–18:00, with a dead 17-dial hour at midnight).
- **By country** — dials, connects, rate; the top 8 + Other.
- **Queue** — queued / due now / waiting on the 2 h gap / waiting on their clock / later / exhausted /
  connected / stopped; CSV vs HubSpot vs manual; HubSpot sync health and last sync.
- **Recent calls** — their last 20, same columns as the Calls screen.

### Calls — every dial

The log. Columns: time (IST) · rep · lead (name, or number when nameless) · number · caller ID ·
country · ring (s) · talk (s) · outcome · sub-outcome · reason · note · wrap-up (s).
Filters beyond the top row: outcome, answered / not, caller ID, search by name or number.
**Row → lead drawer:** every attempt on that lead in order, its status and next call, HubSpot link.
**Export CSV** of the current filter. Paginated 100 at a time, newest first.

### Leads — why hasn't X been called?

Every lead across reps: name · number(s) · country · local time now · rep · source · status ·
attempts · last outcome · next call at · in window now? Filters: status, source, rep, segment,
search. Row → the same lead drawer. This is where "I ticked it in HubSpot, where is it?" gets answered
without the server log.

## 4. Metric definitions — exact, so nobody argues later

| Metric | Definition |
|---|---|
| Dial | A `calls` row whose `disposition` is not `cancelled`. A cancelled loser leg was placed but is not a dial (matches today's `/stats`). |
| Connect | `disposition = 'connected'`, including booked follow-ups / callbacks. Voicemail counts (no AMD, PLAN §1). |
| Connect rate | Connects ÷ dials. Shown per segment; the non-India number is the one that matters. |
| Talk time | Σ `duration` where `answered_at` is set. |
| Attempts / lead | Dials ÷ distinct leads dialed in the period. |
| Reach | Distinct leads with ≥ 1 connect ÷ distinct leads dialed. |
| Abandoned | `disposition = 'abandoned'` ÷ dials. Target < 2% (PLAN §12). |
| Callbacks booked | `disposition = 'later'` + connects with `sub_outcome` in (follow_up, callback). |
| Ring time | `answered_at − started_at`; for a no-answer, `duration` to hangup. |
| Wrap-up | `dispositioned_at − (answered_at + duration)`; median, not mean — one forgotten card ruins a mean. |
| Day | IST calendar day of `started_at`. |
| Previous period | Same length, immediately before; deltas are against it. |

## 5. Build shape (after sign-off)

| # | Piece | Est. |
|---|---|---|
| 1 | `users.role`; `requireAdmin`; `add-user.js --role admin`; `/api/me` returns role | 1 h |
| 2 | `routes/admin.js`: `/summary`, `/by-day`, `/outcomes`, `/reps`, `/reps/:id`, `/calls`, `/leads`, `/lead/:id`, `/live`, `/calls.csv` — every one takes `from`, `to`, `segment`, `rep` | 4 h |
| 3 | Admin socket room; `/live` pushes on rep:connected / burst:started / call:ended | 1 h |
| 4 | Client: `<Admin/>` shell + filter row + Overview | 4 h |
| 5 | Reps, Calls (+ drawer, CSV), Leads | 5 h |
| 6 | Index on `calls (started_at)`; `leads (user_id, status)` exists | — |

~2 days. No new libraries: the charts are inline SVG like the dialer's TimeBar, the tables are plain.

## 6. Open questions — where your input goes

1. **Does the admin ever dial?** Design says no dialer for `admin`. If marketing@ should also be able
   to call, the shell needs a role switch.
2. **Who else gets admin?** One login now. If Himanshu should see the team, `role` covers it.
3. **Date range default.** Today, or 7 days? Today matches the dialer; 7 days matches how a manager
   opens a dashboard in the morning.
4. **The 13% baseline** — keep it as a fixed marker, or make it editable per segment?
5. **Recordings.** Not in the MVP (PLAN §14). The Calls screen has a column slot for it if/when.
6. **Cost.** Telnyx per-minute cost per call / per rep / per day is one join away once we store the
   Telnyx rate. Worth a column?
7. **Export.** CSV only, or a scheduled daily email of the Overview?
8. **HubSpot write-back** lands later; the Calls drawer's "HubSpot record" link is the hook for it.

## 7. Built 2026-09-10

Status: **built and deployed.** Decisions since the review (owner, 2026-09-10): no connect-rate target —
the rate and its delta are the whole story; a **Users** screen (add / remove / reactivate / reset
password, remove = deactivate with history kept and an optional queue hand-over); a **Wallet**
(Telnyx balance, spend today / 7 d / 30 d, cost per dial all-in and lead-only, per connect, per
billed minute, spend by day, cost by product); **recordings** of every bridged call — Telnyx
`record_start` on the lead leg at the bridge, dual-channel mp3, silent, admin-only playback via the
public token route `/rec/<token>.mp3`; **HubSpot call logging** for every settled dial that has a real
contact (direction, time, duration, from/to, rep as owner, outcome as a native disposition,
sub-outcome as a call type, note, and the recording file **uploaded into HubSpot Files**); unknown
numbers are searched in HubSpot by phone first, and a contact is created only when the admin's
"create contacts" toggle is on (default off).

| Piece | Where |
|---|---|
| Roles, deactivation, admin socket room | `server/src/auth.js`, `server/src/index.js`, `server/src/io.js` (`pokeAdmins`) |
| Cost capture (`call.cost` webhook → `telnyx_costs`), balance | `server/src/lib/costs.js`; `call_cost_in_webhooks` set on the Telnyx app |
| Recording start / saved / error, fresh download links | `server/src/lib/recordings.js`; public playback `server/src/routes/rec.js` |
| HubSpot Call engagements + Files upload + contact search/create | `server/src/lib/hubspotCalls.js` (hooks in `burst.js` and `routes/session.js`) |
| Every dashboard query (IST days, previous-period deltas) | `server/src/lib/metrics.js` |
| Admin API incl. users and settings | `server/src/routes/admin.js` (`requireAdmin`) |
| Screens | `client/components/admin/*` (Overview, Reps, Calls, Leads, Wallet, Users, LeadDrawer); classes prefixed `ad-` in `client/app/admin.css` |
| Tests | `server/scripts/admin-test.mjs` — 40 assertions over cost, recording, metrics, HubSpot logging, with Telnyx and HubSpot stubbed |
| Schema | appended to `server/sql/schema.sql`; applied on every deploy by the root `npm start` |

Owner-side, still open at build time: create the admin login (`node scripts/add-user.js marketing@hansmatrimony.com <password> "" admin`);
add `crm.objects.contacts.write` and `files` to the private app; create the `hans_dial_queue` checkbox; create the five call
types (Interested, Follow-up, Callback, Not interested, Not qualified) under Settings → Calling → Call Setup → Track Call and
Meeting Types; fix the three reps whose dialer email is not their HubSpot email (himanshu, jeaneth, mayank showed "not matched").
