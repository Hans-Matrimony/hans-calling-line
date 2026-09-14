# HubSpot → queue: the second inlet

Implementation update, September 12: [Reliability fixes](RELIABILITY-FIXES.md) supersedes the earlier field-refresh and fixed-offset rules below. Current CRM fields and owners refresh under row locks, live calls defer changes, timezone rules follow DST, and retry groups show their actual delay.

Decided 2026-09-09 with Divyanshu, revised the same day after a "make it seamless" pass (§9 lists
what changed). Supersedes PLAN-v2 §1 row "Sync" and §5. CSV upload (`POST /api/leads/import`) is
untouched and stays the first inlet.

## 1. The two processes, side by side

| | CSV upload | HubSpot checkbox |
|---|---|---|
| Where the rep acts | Eazybe dialer, Upload CSV button | HubSpot contact record (or a bulk edit / workflow) |
| Gesture | Export from HubSpot → upload file | Tick **Eazybe · Dial queue** |
| Whose queue | The rep who uploaded | The **HubSpot contact owner**; unowned → whoever ticked it |
| Reaches the queue | Immediately | Next Start dialing / Up next open; ≤60 s in the background |
| Remove from queue | No way (lead runs its cadence) | Untick |
| Call again after it finished | Re-upload doesn't reset it | Untick, re-tick |
| Fields | Every CSV column → `leads.extra` | A fixed property list (§4) |
| Numbers per lead | Up to 3 (Phone + Alternate 1/2) | Up to 2 (`phone`, `mobilephone`) |

Both land in the same `leads` rows, keyed on the HubSpot Record ID, so **a contact exported to
CSV and a contact ticked in HubSpot are the same lead** — no duplicates, no double-dialing (§5.4
handles the CSV-without-Record-ID case). Both feed the one per-rep queue Auto dial and Burst dial
already draw from.

**The rep instruction, in full:** open a contact → tick *Eazybe · Dial queue* → open the dialer and
press Start. To drop it, untick. To run it again later, untick and re-tick.

## 2. Decisions locked

| Question | Answer | Consequence |
|---|---|---|
| Trigger | Tick a checkbox on the contact. | One step. No dialer UI to learn. Bulk: select rows → Edit → set it. Zero-step: a HubSpot Workflow can tick it by rule (§7). |
| Model | **Live toggle.** Tick = in queue, untick = out, re-tick = back in. | The box honestly shows what is queued. Never cuts a live call. |
| Ownership | Contact owner → `users.hubspot_owner_id`, resolved **by email** from the Owners API. Unowned contact → the user who last modified it (`hs_updated_by_user_id`). | No hardcoded ids, no per-rep setup. Inbound leads picked up before assignment still land with the person who ticked them. |
| Latency | 60 s background poll **+ pull before every Start dialing and on opening Up next**. Sync now stays as a fallback. | From the rep's chair the tick is already there. Search-index lag of a few seconds is the only miss. |
| Numbers | Whichever of `hs_calculated_phone_number` / `_mobile_number` the portal has, else raw `phone` / `mobilephone` through our normaliser. **This portal has neither**, so the raw fields are the live path (§10). | The pull asks only for properties the portal actually has. |
| Auth | One private-app token, **read-only**. Internal portal only. | No OAuth, no multi-tenant. `HUBSPOT_TOKEN` in `server/.env` + Railway. |
| Write-back | **None.** | Finished leads stay ticked (§3). Outcomes → HubSpot is a later build. |
| Rejects | Server log + the count in the Sync toast. No panel. | Owner's call. Connection *health* is loud regardless (§6). |
| Objects | Contacts. | No companies, no deals. |

## 3. The one stale state, and the heuristic that covers it

We never write, so when a lead finishes (`connected` / `exhausted` / `stopped`) its box stays
ticked. Two consequences:

- The ticked count in HubSpot ≠ queue depth. Ticked = queued *or* already worked. Write-back
  fixes this later: clearing the box on finish is the first thing it should do.
- A re-tick on a finished lead is detected by **absence**: the contact was missing from at least
  one poll (unticked), then present again (re-ticked) → fresh run, attempt budget reset. Untick +
  re-tick inside a single 60 s window is missed; the SDR does it again. No property-history reads.

## 4. Properties pulled

| HubSpot property | Lands in |
|---|---|
| `firstname` + `lastname` | `leads.name` |
| `hs_calculated_phone_number`, `hs_calculated_mobile_number` (fallback `phone`, `mobilephone`; and `firstname` when it is only digits — real contacts here carry the number there and no phone property at all) | `leads.phones` (ordered, deduped), `leads.phone` = phones[1] |
| `country`, fallback `hs_calculated_phone_number_country_code` (ISO-2 → name), fallback dial code | `leads.country` → `utc_offset`, `segment` — the existing `countries.js` ladder |
| `hubspot_owner_id`, fallback `hs_updated_by_user_id` | `leads.user_id` |
| `email`, `company`, `jobtitle`, `lifecyclestage`, `hs_lead_status` | `leads.extra` → call card. Both enums are stored as internal codes (`ATTEMPTED_TO_CONTACT`, `1086066693`); the property read carries their option labels so the card shows "Day 1" and "MQL" |
| record id | `leads.hubspot_contact_id`; `extra.hubspotUrl` = `app.hubspot.com/contacts/<portal>/record/0-1/<id>` |

A contact with **no usable phone is skipped** (logged). A contact with no resolvable country is
**imported but ineligible** (null `utc_offset`) — same as the CSV path — until the country is filled
in. A lead with no timezone is the **one** thing every poll re-reads (§5.3): it is sitting in the
queue unable ever to be due, and with rejects silent the rep would never find out — so filling the
country in HubSpot puts it into rotation on its own. The other exception is a lead with **no name**
whose contact has one (born from the keypad, or a CSV with no name column): re-read once, and the card
fills in. Every other field is a snapshot: editing a queued contact's name or phone in HubSpot does
not update the lead. Untick + re-tick does.

## 5. The sync

`pullQueue(user)` — runs for one rep. Called by the 60 s loop for every mapped rep, by
`POST /api/session/burst` and `/api/leads/next` before they read the queue, and by `POST /api/leads/sync`.
Concurrent calls for the same rep coalesce (one in flight at a time).

0. **Property schema.** `GET /crm/v3/properties/contacts` (cached 1 h): which properties exist — asking
   for one that does not is an error, not an empty field — and the option labels behind every enum.
   No `eazybe_dial_queue` here is the "inlet is broken" case, reported, never a silent empty queue.
1. **Owners.** `GET /crm/v3/owners` (cached 1 h) → `{ id, userId, email }`. Map to `users` by email;
   persist `users.hubspot_owner_id` / `hubspot_user_id`. **A rep whose dialer login is not their HubSpot
   email cannot be matched** — the one setup failure that is invisible from HubSpot's side, so
   `node scripts/hubspot-owners.mjs` prints the mapping and the SQL to pin it by hand.
2. **Search.** `POST /crm/v3/objects/contacts/search`: `eazybe_dial_queue EQ true` AND
   (`hubspot_owner_id EQ <rep>` OR (`hubspot_owner_id` not set AND `hs_updated_by_user_id EQ <rep user>`)),
   properties from §4, 100/page, paginate on `after`. Result = the rep's **ticked set**.
3. **Reconcile** ticked set against `leads WHERE source = 'hubspot'` for this rep:

   | Ticked? | Lead status | Action |
   |---|---|---|
   | yes | none | insert, `status='queued'`, stamp `hubspot_seen_at` |
   | yes | `queued` / `later` / `in_flight` | nothing; stamp `hubspot_seen_at` |
   | yes | any, but `utc_offset IS NULL` | re-read the contact — it can never be due until a country lands |
   | yes | any, but `name IS NULL` and the contact has one | re-read once — a lead born thin (keypad, nameless CSV) gets its card filled in |
   | yes | `stopped` by an earlier untick | resume → `queued`, attempts kept |
   | yes | `connected` / `exhausted` / `stopped` by outcome, `hubspot_seen_at` ≥ last poll | stale tick; nothing |
   | yes | same, `hubspot_seen_at` < last poll | **re-tick** → `queued`, `attempt_count=0`, `number_attempts=0`, `phone_idx=1`, `next_call_at=now()` |
   | yes | same, `hubspot_seen_at IS NULL` (a CSV lead that carried the Record ID, never ticked before) | **first tick** → same as re-tick. The tick is the request; there is no earlier poll for it to be absent from (fixed 2026-09-11 — one of 25 ticked contacts stayed `connected`) |

   Every stamped lead also gets `source='hubspot'`, so a CSV lead adopted by Record ID is removed by an
   untick like any other.
   | no | `queued` / `later` | untick → `stopped`, `stopped_reason='hubspot_untick'` |
   | no | `in_flight` | leave it; the next poll after the call handles it |
   | no | finished | nothing |

   A contact whose owner changed shows up in the new owner's ticked set with `leads.user_id` still
   the old rep → reassign (latest owner wins, as CSV already does), then apply the row above.
4. **Cross-inlet merge.** Before inserting, look for a lead of this rep with the same email
   (`extra->>'email'`) or an overlapping phone whose key is `email-…` or `manual-…` → rewrite its
   `hubspot_contact_id` to the Record ID, set `source='hubspot'`, keep its attempts and history.
   One person, one lead, whichever door they came through.
5. **Skips** (no phone, no mappable owner) → one `console.warn` each, counted.
6. Emit `queue:synced` to `user:<id>`; the client refetches stats and Up next.

Never touches `in_flight`. Rate: 3 reps × ≤2 requests/min against a 190-req/10 s budget.

## 6. Code

| # | File | Change |
|---|---|---|
| 1 | `sql/schema.sql` | `users`: `hubspot_owner_id BIGINT`, `hubspot_user_id BIGINT`. `leads`: `source TEXT NOT NULL DEFAULT 'csv'` (`hubspot` / `csv` / `manual`; backfill `manual-…` keys), `hubspot_seen_at TIMESTAMPTZ`, `stopped_reason TEXT`. Applied by the root `npm start` (`npm run migrate --prefix server` runs first), so a Railway deploy migrates itself. |
| 2 | `lib/hubspot.js` (new) | Client (token, retries on 429), owners cache, portal id (`GET /account-info/v3/details`, cached), `pullQueue(user)` → `{ added, resumed, reopened, removed, skipped, healthy, error }`. Dormant without `HUBSPOT_TOKEN`. |
| 3 | `lib/import.js` | Extract `normalizePhone` + country/segment resolve + the upsert into `upsertLead()` used by both inlets. CSV behaviour unchanged; the new email/phone merge runs for CSV too (it already does the email half). |
| 4 | `routes/leads.js` | `POST /sync`. `GET /next` pulls first. `/stats` gains `hubspot: { configured, healthy, error, lastSyncedAt, addedToday }`. |
| 5 | `routes/session.js` | `/burst` calls `pullQueue` before `claimLeads` (bounded: 3 s timeout, then dial with what's there). |
| 6 | `index.js` | 60 s loop (`HUBSPOT_POLL_SECONDS`) over users with a mapped owner. Owner resolution on boot and hourly. |
| 7 | `components/UpNext.tsx` | One strip at the top: `HubSpot · synced 40 s ago · 12 added today · [Sync now]`. Unhealthy: `HubSpot · not connected · <reason>` in the error colour. Toast after Sync now: "Added 4 · 1 back · 2 removed · 1 skipped". CSV button stays exactly where it is. |
| 8 | `lib/format.ts`, `components/Campaign.tsx` | `EMPTY_QUEUE` becomes `emptyQueue(hubspotOn)`: with the inlet on, an empty queue names both doors instead of only Upload CSV. |
| 9 | `scripts/hubspot-owners.mjs` (new) | Prints rep ↔ HubSpot user, `--apply` writes it. The answer to "why is my queue empty". |
| 10 | `scripts/hubspot-test.mjs` (new) | The whole reconcile table (§5.3) against a throwaway schema with HubSpot stubbed at the fetch layer. Needs no token. |

**Health is loud even though rejects are silent.** Bad token (401), missing scope (403), property
not created yet (400 on the filter), rate-limited — these mean *the inlet is broken*, not "one
contact was odd". They surface in the strip and in `/stats`, never only in logs.

## 7. What Divyanshu does in the portal

**Private app** — Settings → Integrations → Private Apps → Create. Scopes, all read:
`crm.objects.contacts.read`, `crm.schemas.contacts.read`, `crm.objects.owners.read`.
Copy the token into `server/.env` as `HUBSPOT_TOKEN=` and into Railway (`dialer` service).

**One property** — Settings → Properties → Contact properties → Create. Group "Eazybe dialer":

| Internal name | Label | Field type |
|---|---|---|
| `eazybe_dial_queue` | Eazybe · Dial queue | Single checkbox |

Nothing else. No owner ids to look up (resolved by email — each rep's dialer login must equal their
HubSpot user email). The `eazybe_last_*` properties from PLAN-v2 §5 belong to write-back; not now.

**Optional, zero-step:** a HubSpot Workflow that sets *Eazybe · Dial queue* = Yes by rule (e.g. owner
is Himanshu AND country ≠ India AND lead status = New). Under the live-toggle model that workflow
*is* the queue policy. Pair it with a second branch that unticks on your own "done" criteria.

## 8. Not in this build

Write-back of outcomes (and clearing the box on finish) · call engagements on the timeline ·
HubSpot lists as a source · OAuth / customer portals · companies and deals · a rejects panel ·
live field refresh for queued leads · webhooks (the endpoint shape is ready if 60 s ever feels slow).

## 9. Revised on the seamless pass (same day)

| Was | Now | Why |
|---|---|---|
| Snapshot; untick ignored; re-tick via property history | Live toggle; untick removes; re-tick by absence | A checkbox that ignores untick lies to the rep. Also deletes the batch-read history path. |
| 3-min poll + Sync now button | 60 s poll + pull on Start / Up next; button is a fallback | "Tick, then press a second button" is two steps. |
| Owner only; unowned skipped | Owner, else last-modified-by | Unassigned inbound leads would silently vanish. |
| Hardcoded owner ids per rep | Resolved by email from Owners API | One less setup step, no per-rep config. |
| Raw `phone` / `mobilephone` through our normaliser | HubSpot's `hs_calculated_*` E.164 first | Local-format numbers were coming out wrong. |
| Silent everything | Rejects silent, **connection health loud** | A broken inlet must not look like an empty queue. |
| — | Cross-inlet merge on email/phone | CSV-without-Record-ID + tick would double-dial one person. |

## 10. Built 2026-09-09 — and what the real portal changed

Verified against portal 40009480 ("Eazybe") before writing the mapping. Six things the spec had wrong
or missing:

| Assumed | Actually | Done about it |
|---|---|---|
| `hs_calculated_phone_number` gives us E.164 | **The portal has no `hs_calculated_*` properties at all** | The pull reads the property schema first and asks only for what exists; raw `phone`/`mobilephone` through `normalizePhone` is the live path |
| Lead status / lifecycle can be shown as-is | They are internal codes — `ATTEMPTED_TO_CONTACT`, `1086066693` | The same schema read collects option labels; the card shows "Day 1", "MQL" |
| Every contact has a phone property | Some carry the number in `firstname` and have no phone property | Treated as the number, the way `importCsv` already did |
| Owner ids from PLAN-v2 need confirming | Confirmed active: Himanshu 94828863, Shubhankar 76993679, Hrithik Malhotra 89926302, **Mayank Khandelwal 95425968** | Still resolved by email at runtime; nothing hardcoded |
| `hubspot_owner_id` and `hs_updated_by_user_id` are one id space | They disagree (Karan Dewan: owner 578081029, user 61259763) | Both stored, both used — owner id to find contacts owned, user id to find contacts last touched |
| Cross-inlet dedupe is an edge case | **289 of 310 existing leads are keyed `manual-<phone>`** because their CSV export carried no Record ID or email | The adopt-provisional-key path is the main event: ticking any of those 289 folds into the existing lead instead of creating a second one to dial in parallel |

`source` backfill: a `manual-<phone>` key does **not** mean a hand-dialled number — `importCsv` falls
back to it for any row with no Record ID and no email. The discriminator is "no country and none of the
columns only a spreadsheet supplies": 289 csv, 22 manual on this database.

**Deploy order — migrate first, and it is automatic.** `upsertLead` writes `source` and `hubspot_seen_at`
on every CSV import too, so the schema must land before the new code or CSV upload breaks. The root
`npm start` is `npm run migrate --prefix server && npm start --prefix server`, so every Railway deploy
does it in the right order on its own. (Also applied by hand on 2026-09-09.)

### What is proven, and what is not

- `scripts/hubspot-test.mjs` — 27 assertions over the whole reconcile table with HubSpot stubbed:
  add, leave alone, untick, re-tick, callback-stays-a-callback, finished-not-resurrected, restart
  safety, in-flight protection, unowned routing, another rep's contacts, cross-inlet adoption,
  missing property, one search per pull. All pass.
- `scripts/cascade-test.mjs` — 28 assertions, unchanged and still passing after the `upsertLead`
  extraction, so the CSV inlet is untouched.
- Live, against the real portal: a bad token returns the plain-words error through `/stats` and
  `/sync`, and both strip states render (screenshotted).
- **Not yet proven:** one real ticked contact travelling into a queue. That needs `HUBSPOT_TOKEN` and
  the `eazybe_dial_queue` property, both §7. Tick one contact, press Sync now, expect "1 added".

## 11. The checkbox itself (2026-09-10)

Created as `fieldType: booleancheckbox` (HubSpot's "Single checkbox") and immediately changed to
**`fieldType: checkbox` with exactly one option** — `Add to dial queue = true`, no default.

Why: a `booleancheckbox` stores a clean boolean, but HubSpot renders it on a contact record as a
**Yes/No dropdown** — two clicks, and it reads like a question rather than an action. `checkbox`
with a single option is the only shape HubSpot draws as a real tick box. Same stored value
(`true`), same search filter (`eazybe_dial_queue EQ 'true'`), verified against a live contact after
the change — so no server code changed. Unticking empties the property, which is exactly what the
untick sweep in §5.3 already expects.

**HubSpot's search index trails a write by ~20 seconds.** Measured: a tick was invisible to every
operator (EQ, CONTAINS_TOKEN, HAS_PROPERTY) 5 s after saving and found by all three at ~20 s. So a
rep who ticks and immediately presses Start can miss one poll; the next one picks it up. Worth
remembering before concluding the inlet is broken — read the record directly to tell the two apart.

## 12. What Up next shows (2026-09-11)

A rep ticked 25 contacts at 00:09 IST, opened Up next at 00:29 and saw three rows. All 25 had
arrived; 22 were held by their local clocks (India at 00:xx, Europe at 20:xx) and the panel listed
only what Auto/Burst would dial *now*. The inlet worked and the screen lied by omission.

Up next now shows the **whole queue, grouped by when each lead opens**, from `GET /api/leads/queue`
(`queueOverview()` in `lib/queue.js`; pulls from HubSpot first, like `/next`):

| Group key | Head | Who |
|---|---|---|
| `ready` | **Due now** | inside calling hours, past the 2h gap, not yet tried at this hour — what Start would pick |
| `window:<instant>` | **Opens 10:00 · in 8h 51m · India** | held by the 10:00–19:00 rule; one group per opening instant, so India (10:00 IST) and Germany (13:30 IST) are two heads |
| `gap` | Back after the 2h gap | rows say when |
| `hour` | Opens next hour | already rung at this hour of their day |
| `later` | Callbacks you booked | rows say "Tue 10:00 their time" |
| `no_timezone` | No country, so no calling hours | fill Country in HubSpot and it schedules itself |

Every group carries 5 rows; "Show all N" (`?group=<key>`, repeatable) opens one in full and stays
open across the minute poll. Rows are the same tap-to-dial button everywhere: a hand-dialled call
ignores calling hours, so nothing on the page is out of reach. `opensAt` / `why` come from one SQL
expression (`OPENS_AT`, `WHY`) shared with `readiness()` and `eligibleWhere()`, so the Campaign page,
the stats and Up next cannot disagree. Owner's decision: the gate itself stays — no per-run
"ignore calling hours" switch; the keypad is the override.

**"Did my 25 arrive?"** — `users.hubspot_last_change` keeps the last pull that changed the queue
(`{at, added, resumed, reopened, removed, skipped, ticked}`); the strip reads "HubSpot · 25 pulled
19 min ago · checked 40s ago". The same pull emits `queue:synced` to the rep's tabs, which print
"HubSpot: 25 pulled" in the feed and refetch — no reload, no waiting for the minute poll.
(The event was documented in §5.6 from the start but never actually emitted until now.)
