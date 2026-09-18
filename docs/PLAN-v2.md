# Hans Dialer — v2 plan (team dialer, HubSpot-driven queue)

Decided 2026-09-06 with Divyanshu. Supersedes PLAN.md §1 rows "HubSpot", "Auth", §14 "multi-rep".
Deadline: dialer fully working for 3 reps by **Mon 2026-09-08 14:00 IST**.

## 1. Decisions locked

| Question | Answer |
|---|---|
| Rep audio | **Browser only.** No phone/browser choice in the UI. Server keeps the PSTN branch dormant (`mode:'phone'` on /connect) as break-glass; nothing exposes it. |
| Lead source | **HubSpot checkbox.** Rep ticks `hans_dial_queue` on a contact they own; the dialer pulls it. CSV upload stays as a secondary path. |
| Lead ownership | **HubSpot contact owner = rep.** `users.hubspot_owner_id` ↔ `hubspot_owner_id` on the contact. Leads are never shared: every queue/stats/activity query is scoped to `leads.user_id`. |
| Sync | Server polls HubSpot every 3 min per rep + **Sync now** button. Unchecking in HubSpot removes a queued/later lead on the next poll (never cuts a call in progress). |
| Write-back | After every dispositioned call: `hans_last_outcome`, `hans_last_called_at`, `hans_attempts`, `hans_next_call_at`. When a lead leaves the queue (connected / exhausted / invalid number) the checkbox is cleared. Notes write-back: later. |
| Phone field | `phone`, fall back to `mobilephone`. Timezone from `country` (existing table), dial code fallback. |
| One-at-a-time ("Power") | JustCall Power Dialer: 1 lead per burst; **saving the outcome auto-dials the next lead**. Pause/Resume button. No-answer also advances. Queue empty / all out of hours → stops and says so. |
| Multiple at once ("Burst") | Existing 2-leg burst: first answer wins, others cancelled and retried next burst. Timezone-gated (lead local 10:00–19:00), unchanged. |
| Manual pad | **No timezone gate.** Rep is trusted. Same card/disposition flow. |
| Reps Monday | Himanshu (HubSpot owner 94828863), Shubhankar Sharma (76993679), Riddick (owner id TBD — not found by that name). |

## 2. Schema changes (schema.sql, self-applied by `npm start`)

- `users`: + `hubspot_owner_id BIGINT`; `audio_mode` default → `'browser'`.
- `leads`: + `user_id INT REFERENCES users(id)`, + `source TEXT` (`hubspot|csv|manual`), + `hubspot_synced_at TIMESTAMPTZ`.
  Uniqueness becomes `(user_id, hubspot_contact_id)` (drop the global unique). Backfill existing rows → Himanshu (id 3).
- Manual dials keep id `manual-<phone>` but are now unique per rep, so two reps dialing the same number no longer collide.

## 3. Server work

| # | File | Change |
|---|---|---|
| 1 | `lib/queue.js` | `claimLeads/peekLeads(userId, limit, segment)`; `eligibleWhere` adds `l.user_id = $uid`. `sweepStuckLeads` unchanged. |
| 2 | `routes/session.js` | `/burst` takes `{legs: 1|2}` (clamped to `LEGS_PER_BURST`). `/dial` inserts with `user_id`. `/connect` defaults to browser. `/disposition` → write-back (fire-and-forget). |
| 3 | `routes/leads.js` | `/stats`, `/next`, `/activity` scoped to the rep. `/import` stamps `user_id`+`source='csv'`. New `POST /sync` (button). |
| 4 | `lib/hubspot.js` (new) | `pullQueue(user)`: contacts search `hans_dial_queue=true AND hubspot_owner_id=<rep>`, paginate 100/page, upsert leads, stop queued/later leads no longer checked, re-queue re-checked ones. `pushCall(lead)`: PATCH the 4 properties (+ clear checkbox when done). Reads property definitions once so date vs datetime is formatted right. Token: `HUBSPOT_TOKEN`. |
| 5 | `index.js` | Poll loop every `HUBSPOT_POLL_MINUTES` (default 3) over users with `hubspot_owner_id`; emits `queue:synced` so Up next refreshes. |
| 6 | `lib/burst.js` | `onHangup` no-answer/failed path also triggers write-back. Otherwise untouched (race/bridge logic is proven). |
| 7 | `scripts/add-user.mjs` (new) | `node scripts/add-user.mjs <email> <password> <hubspot_owner_id>` — creates/updates a rep. |

## 4. Client work

- **Mode switch** on the Stage (persisted per browser): `One at a time` · `2 at once`. Start button label/hint follow the mode.
- **Power mode**: after outcome saved (or nobody answered) → "Next in 2s…" then auto `/burst {legs:1}`; **Pause** toggles auto-advance; 404 "no eligible leads" stops it with a clear message.
- **Sync now** button + "last synced" in Up next; toast with pulled/removed counts.
- Remove every trace of audio-mode choice (already browser-only; tidy copy).
- **Manual pad polish** (CallHippo parity, P1 if time): country-code picker with flag (+91/+1/+44 first), backspace, redial last number, in-call DTMF keypad (Telnyx `send_dtmf`) for IVRs. Mute exists. Hold: not now.

## 5. HubSpot setup — Divyanshu does (exact specs)

Private app (Settings → Integrations → Private Apps) scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`. Paste token as `HUBSPOT_TOKEN` in server/.env and Railway (`dialer` service).

Contact properties (Settings → Properties → Create; group "Hans dialer"):

| Internal name | Label | Field type |
|---|---|---|
| `hans_dial_queue` | Hans · Dial queue | Single checkbox |
| `hans_last_outcome` | Hans · Last call outcome | Dropdown select — internal values exactly `connected`, `no_answer`, `later`, `invalid` (labels: Connected, No answer, Call later, Invalid number) |
| `hans_last_called_at` | Hans · Last called at | Date and time picker (Date picker if that's the only option) |
| `hans_attempts` | Hans · Call attempts | Number |
| `hans_next_call_at` | Hans · Next call at | Date and time picker (Date picker if that's the only option) |

Rep workflow in HubSpot: open a contact you own → tick "Hans · Dial queue" → within 3 min (or Sync now) it appears in Up next.

## 6. Monday gate — user-side, code cannot fix

1. **Numbers.** Only `FROM_NUMBER_US` is populated (2 numbers = 100 dials/day at the 50/number cap, shared by 3 reps). Buy +44 now; +91 needs regulatory docs. Add them comma-separated to `FROM_NUMBER_EU` / `FROM_NUMBER_INDIA` on Railway.
2. **Riddick's HubSpot identity** (name/email as it appears in HubSpot) + emails/passwords for Shubhankar and Riddick.
3. Wired headsets for all 3; each rep's first Connect provisions their WebRTC credential automatically.

## 7. Build order

| Day | Work | Verify |
|---|---|---|
| Sat | §2 schema + §3.1–3 scoping + `{legs}` + add-user script | Himanshu's queue/stats identical to before; second user sees an empty queue. |
| Sat | §3.4–6 HubSpot pull + write-back + poll | Tick a contact → appears in Up next; disposition → 4 properties update in HubSpot; untick → gone next poll. |
| Sun | §4 mode switch + Power auto-advance + Sync button | Power: 3 leads dialled back-to-back with only outcome clicks. Burst: unchanged 2-leg behaviour. |
| Sun | Manual pad polish (P1) | Country picker + DTMF on a live call. |
| Sun eve | Deploy, onboard 3 reps, live headset test each | Each rep connects, syncs, dials. |

## 8. Amendments (2026-09-06, later)

- Third rep is **Hrithik Malhotra** (HubSpot owner 89926302), not "Riddick".
- `DAILY_CAP_PER_NUMBER` **100** (was 50). Lower later if a caller ID gets flagged.
- **Write-back dropped for this build.** Whom-not-to-call is decided by the dialer's own `leads.status` /
  `attempt_count` / `next_call_at`; the HubSpot checkbox is only the inlet and a re-sync never resets a
  lead's state. Write-back (and `crm.objects.contacts.write`) returns once `HUBSPOT_TOKEN` exists.
- `HUBSPOT_TOKEN` arrives later: build the pull sync behind it; without it the CSV path stays the inlet.
- **Priority order:** (1) manual dialer with CallHippo UI/UX, (2) per-rep scoping + 3 reps, (3) Power /
  Burst modes, (4) HubSpot pull sync.

## 9. Amendments (2026-09-06, evening)

- **Shell:** light left sidebar with three tabs — Dialer (default) · Activity · Up next — JustCall-inspired, same tokens
  as the console. Activity and Up next are no longer on the dialer page. The handset shows only on the Dialer tab;
  dialing or a live lead brings the Dialer tab forward on its own so the outcome is never hidden behind a tab.
- **Handset:** country-code picker has a blank entry ("No country code") that leaves just "+" on the chip; the rep
  types the code with the number. Flags are images (flagcdn) because Windows has no flag emoji.
- **Mode names (next step):** **Auto dial** = one lead at a time, next dials after the outcome is saved;
  **Burst dial** = two leads at once, first to answer wins.
- **Dialer page (2026-09-06, late):** handset only, centred; a lead card (facts + outcome) appears on its left only while
  a call is live or waiting for its outcome. "Start calling", the ringing wire diagram and the bottom bar are gone from
  it — Start calling returns on the Auto dial / Burst dial page. Caller-ID usage + CSV upload now sit at the bottom of
  the Activity and Up next tabs. **Tap-to-dial:** an Up next row or an Activity row's call button loads the number
  into the handset and switches to the Dialer tab; the rep presses Call.
- JustCall dialer audit (2026-09-06): worth adding later — Activity search box; wrap-up time as a setting (needed for
  Auto dial anyway); mic/speaker device pickers with Test (half-day, prevents "no audio" tickets). Skip: SMS, voicemail,
  recording, scripts, availability toggle, data-centre routing, Team contacts, click-to-dial from web pages.

## 10. Auto dial / Burst dial (built 2026-09-07)

- **Per-rep leads:** `leads.user_id`. Queue selection, Up next, stats, activity and CSV import are scoped to the
  signed-in rep; a CSV uploaded by rep B moves any shared HubSpot ids to B (latest upload owns). Existing 248
  leads were backfilled to Himanshu. New reps: `node server/scripts/add-user.js`.
- **One queue per rep, both modes draw from it** (user choice). `POST /api/session/burst {legs: 1|2}`.
- **Auto dial** = one lead; **Burst dial** = two, first to answer wins, loser cancelled and retried later.
- **Next is manual** (user choice): after the outcome is saved the rep presses "Next lead" / "Next burst".
  No wrap-up countdown.
- Pages: hero + Start dialing + Upload CSV + "Your queue" (ready now / in queue / next few) + **the tape** —
  one tile per dial this run, coloured by outcome. In a call: run strip (tape, burst race chips, lead card) +
  handset in-call view. The Dialer tab is not auto-selected while the rep is on a campaign page.

## 11. Campaign audit (2026-09-07)

Six-lens audit (JustCall parity, state machine, visual, copy, edge cases, keyboard) -> 77 findings, 70 verified,
synthesised into 31 changes; P0 + P1 shipped, P2 (skip next lead, keypad focus polish) later.
- **State survives everything:** /api/session/state returns the call (ringing legs / lead card + timer / pending outcome);
  the client rehydrates on load and on socket reconnect. Run state (mode, since, end-after) lives in useDialer.
- **Server bugs:** winner claim ignores cancelled legs; a late answer after a winner is 'abandoned' (attempt + lead:abandoned),
  after a red button it stays 'cancelled'; double Start refused by a claim token; caller-ID cap refused before claiming;
  a dial-API failure requeues in 10 min instead of burning an attempt; burst:ended carries every leg; /hangup-lead falls
  back to the DB when the burst is gone; dispositioned_at recorded; 'invalid' (Wrong number) outcome.
- **Stop model:** idle -> Stop run (tape kept as Last run); live/ended -> End run after this call; ringing -> the handset's
  coral button only (with a visible hint). Stopping a ring never ends the run.
- **Screens:** compact status line with lamp + since; one status slot (error > reason > last burst > next preview > import);
  Connect audio on the page; flat grey disabled Start; run bar as a panel; tape-sum doubles as legend with the ready count;
  race chip in Auto too, loser kept while live; lead card: cause-aware eyebrow, 44px outcomes, 1/2/3 keys, callback presets
  on the lead's clock, Wrong number; handset: ringing timer with give-up hint, one note field after the call.
- **Copy:** server errors and feed rows in plain words; two shared queue strings (EMPTY_QUEUE / NOT_DUE) + next-open time.
