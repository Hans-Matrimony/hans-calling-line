# Hans Dialer vs JustCall Sales Dialer — gap list (2026-09-07)

Source: the six-lens audit (PLAN-v2 §11) plus JustCall's help centre (Sales Dialer campaign types, Power / Dynamic /
Predictive dialer, mandatory disposition, pause campaign, dialer settings) and their web dialer's Settings screens.
"Ours" = Auto dial (one-to-one) and Burst dial (one-to-many) as of commit c2e8d2d.

Legend: **GAP** = we lack it · **PARTIAL** = we have a thinner version · **DELIBERATE** = left out by owner decision ·
**AHEAD** = ours is better. Effort: S (hours) · M (a day) · L (days+).

## 1. Setting up what to dial

| Step | JustCall | Ours | Status | Effort |
|---|---|---|---|---|
| Campaign object | Named campaigns: a contact list + settings (mode, retry rules, timezone rules, wrap-up, dispositions). Many campaigns per rep, assignable to agents. | One queue per rep, no name, no per-list settings. Both modes draw from the same queue. | **GAP** | L |
| Contact source | Upload CSV, pick from contacts, CRM sync (HubSpot etc.). Dynamic dialer adds contacts in real time without stopping the campaign. | CSV upload only. HubSpot checkbox pull is planned (needs the private-app token). | **PARTIAL** | M (HubSpot pull) |
| Pick which list to run | Agent opens a campaign and starts it. | Start dials whatever is due in the single queue; no way to choose a subset. | **GAP** | L (needs campaigns) |
| Retry rules | Per campaign: attempts, interval, which dispositions retry, order. | Fixed: 6 attempts, 2 h gap, never the same local hour twice, 10-min cooldown for a cancelled leg. | **PARTIAL** | M |
| Timezone rules | Per campaign: allowed local hours / days. | Fixed lead-local 10:00–19:00, from country (fallback dial code). | **PARTIAL** | S (make hours a setting) |
| Re-run a finished campaign | Yes (except Dynamic). | Nothing to re-run: leads simply come back on cadence. | **GAP** | L |

## 2. Before each dial (one-to-one)

| Step | JustCall Power dialer | Ours Auto dial | Status | Effort |
|---|---|---|---|---|
| Preview the contact | Full contact card (history, notes, CRM fields) before the dial. | One line under Next: name · local time · attempt · last outcome; queue panel shows the next 2. | **PARTIAL** | S |
| Call or skip | Agent can skip the previewed contact. | No skip; Next dials whatever is due. | **GAP** | S (server route + button) |
| Auto-advance | Dials the next contact automatically after the cool-off. | Rep presses Next lead. | **DELIBERATE** (owner: manual Next) | — |
| Wrap-up / cool-off timer | Configurable (Disabled … 30 min); no calls during wrap-up; time is reported. | No timer; wrap-up time is now recorded (dispositioned_at) but not shown. | **PARTIAL** | S (show it) |

## 3. During the dial

| Step | JustCall | Ours | Status | Effort |
|---|---|---|---|---|
| What the agent hears/sees while ringing | Connecting sounds; waiting screen says what the dialer is doing. | Tick in the ear (better: in-ear), ringing timer with "gives up at 30s", racer chip. | **AHEAD** on audio, equal on screen | — |
| Answering-machine detection | Yes (Predictive): voicemail detected, optional voicemail drop, agent not connected to machines. | None. Voicemail counts as connected; rep hears it and decides. | **DELIBERATE** (plan §1) — revisit after Monday | M (Telnyx AMD) |
| Local presence caller ID | Number pool chosen to match the lead's area. | Three regional numbers (IN/UK/US) rotated least-used-first. | **PARTIAL** | M (more numbers) |
| Call recording | Toggle, recordings stored and reported. | None. | **GAP** (not in MVP) | M |

## 4. On the call

| Step | JustCall | Ours | Status | Effort |
|---|---|---|---|---|
| Controls | Mute, hold, keypad, transfer, add call, record, notes, scripts/checklist. | Mute, dialpad, note, hang up. | **PARTIAL** (hold/transfer/record deliberately out) | — |
| Contact card beside the call | Yes. | Yes: facts, local time, attempt, last note, HubSpot link. | equal | — |
| Scripts / agent assist | Script & checklist panel. | None. | **DELIBERATE** | — |
| Tags on the call | Yes. | None (note only). | **GAP** | S |

## 5. After the call

| Step | JustCall | Ours | Status | Effort |
|---|---|---|---|---|
| Disposition | Mandatory, configurable list (Busy, Voicemail, Not interested, custom groups); retry rules keyed to it. | Mandatory, fixed: Connected · No answer · Call later · Wrong number. | **PARTIAL** | M (configurable list) |
| Notes & rating screen | Notes + call rating after every call (can be disabled). | Notes; no rating. | **PARTIAL** | S |
| Schedule callback | Date/time step; callback fires for that agent. | Presets on the lead's clock (In 2 h / Tomorrow 10:00 their time / In 3 days) + Pick…; lead comes back first in the queue at that time. | **AHEAD** (lead-local) | — |
| Persistence | After-call screen persists until saved. | Persists across reload/restart (since c2e8d2d). | equal | — |
| Keyboard | — | 1 / 2 / 3 keys, Enter = Next, focus follows the loop. | **AHEAD** | — |

## 6. One-to-many (JustCall Predictive vs our Burst dial)

| Step | JustCall Predictive | Ours Burst dial | Status | Effort |
|---|---|---|---|---|
| How many lines | Pacing algorithm sets lines per agent from live answer rates. | Fixed 2 legs per rep. | **PARTIAL** (2 is the plan's abandon-rate choice) | M (make legs 1–3 a setting) |
| Team pooling | Lines are shared across all agents on the campaign; an answered call goes to any free agent. | Per rep only. | **DELIBERATE** (leads are never shared) | — |
| Abandoned calls | Abandon-rate control; an "Abandoning Call Message" is played to the person hung up on. | Late answerer is hung up on silently (now recorded as abandoned + rep told). | **GAP** | S (play a short message on the losing leg) |
| Voicemail / AMD | Yes. | No. | **DELIBERATE** for MVP | M |
| Losing leg handling | Not surfaced to the agent. | Cancelled leg back in 10 min; chip shows it; "held back" note when only one lead was ready. | **AHEAD** | — |

## 7. Controlling a run

| Step | JustCall | Ours | Status | Effort |
|---|---|---|---|---|
| Pause / resume | Pause Calling finishes the current call, then stops; campaign resumable later. | Stop run · End run after this call; Last run tape stays. No resume of a stopped run (just Start again; the queue is the same). | **PARTIAL** | S |
| Live progress | Dialed / connected / remaining per campaign. | Tape (per-dial outcome sequence), counts, ready count. | equal (**AHEAD** on the sequence) | — |
| Run survives reload | Campaign progress is server-side. | Call state survives; the run itself (tape, since, end-after) is in browser memory and is lost on reload. | **GAP** | S–M (store runs server-side) |
| Supervisor view | Live monitoring, listen / whisper / barge, agent status. | None. | **GAP** (post-Monday) | L |
| Availability toggle | Agent Available / Busy. | None (audio on/off only). | **GAP** — only matters with inbound | — |

## 8. Reporting & audio

| Step | JustCall | Ours | Status | Effort |
|---|---|---|---|---|
| Campaign reports | Per campaign / agent: dials, connects, dispositions, talk time, recordings, wrap-up. | Topbar counters for today + Activity feed; everything else by SQL. | **GAP** | M |
| Audio device settings | Speaker / mic / ringtone pickers with Test, auto-gain, noise cancellation. | Browser default device only. | **GAP** | M (Telnyx SDK supports it) |
| Desktop app / browser extension | Both; click-to-dial from any web page. | Web app only. | **DELIBERATE** (plan §1) | — |

## What to close first (for a team switching from JustCall)

1. **Skip next lead** (S) — the one Power-dialer step reps use every day that we lack.
2. **Run state on the server** (S–M) — reload should bring back the tape, "since", and Next, not just the call.
3. **Abandoning message on the losing leg** (S) — the person we hang up on should hear a one-line apology; it also protects the caller IDs.
4. **Legs per burst as a setting (1–3)** and **calling hours as a setting** (S each).
5. **Audio device pickers with Test** (M) — prevents "no audio" tickets.
6. **Configurable dispositions + call rating** (M) — needed before HubSpot write-back maps outcomes.
7. **Campaigns as named lists** (L) — only if reps need to run different lists on different days; the HubSpot checkbox inlet may cover most of this need.
