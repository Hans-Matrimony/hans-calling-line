# Eazybe Dialer — MVP Plan (FINAL)

**Goal:** prove automated burst dialing + retry cadence raises connects on non-India leads.
**Rep:** Himanshu (ROTW inbound). **Baseline to beat: 13% connect rate.**

| Day | Work | Judge on |
|---|---|---|
| **Sat (today)** | Build v1. Plumbing test on India leads. | Does it dial, bridge, show the card, retry? |
| **Sun** | Add browser audio. Keep phone leg as fallback. | Does WebRTC audio hold up? |
| **Mon 14:00 IST** | Real test, non-India backlog. | Connect rate, dials/day, reach |

Weekends are dead for Europe/US/APAC connect rates (UAE is Sat–Sun off). Do not measure
success before Monday.

---

## 1. Decisions locked

| Question | Answer | Why |
|---|---|---|
| Web app or extension | **Web app** | MV3 service workers die after ~30s idle and kill the websocket pushing the lead card. No store review, instant deploys, stays out of the product codebase. |
| Rep audio | **Phone today, browser Sunday** | One config field. Phone leg stays as fallback forever. |
| Numbers | **3, region-rotated** | Telnyx allows many concurrent calls per caller ID, but one number firing 3 legs and cancelling 2 repeatedly is a strong spam signal. |
| Legs per burst | **2** | At ~13% connect: 2 legs abandons 1.6% of bursts, 3 legs 4.5%, 5 legs 13%. These are warm installs. |
| AMD | **No** | Voicemail counts as connected; rep sets next call time. |
| Auth | Email + password, rows inserted by hand | One user. |
| HubSpot | **Read-only, manual CSV export** | No API sync, no write-back in v1. |

---

## 2. Baseline

HubSpot, Aug 2026. India calls happen on personal mobiles and never reach HubSpot, so
**this data is already almost entirely non-India**:

| Metric | Value |
|---|---|
| Logged calls | 1,931 (~88/day, whole team) |
| Calls >30s talk | 247 (**12.8%**) |
| Avg talk time | 2.25 min |
| Attempts per lead | ~2 → ~24% lead reach |

India runs ~60% but is unlogged. **Keep India out of the success measure.**

---

## 3. Lead set

Himanshu's last 30 days: ~252 contacts. India 128 (51%), US 14, UAE 12, UK 8,
China/Nigeria/Singapore 5 each, 40+ country long tail.

**Load the full 30-day backlog, both segments:**

| Segment | Count | Purpose |
|---|---|---|
| non_india | ~124 | The measured segment |
| india | ~128 | Volume + control group, reported separately |

Non-India is only ~6 new leads/day — nowhere near a full test day. 124 leads × 6 attempts
= ~740 available dials. **Re-working given-up leads is the hypothesis.**

**Export from HubSpot:** name, phone, country, hubspot_contact_id.

---

## 4. Timezone

**Derive from the HubSpot `country` property, NOT the phone dial code.** This kills the
+1-number-but-not-actually-US problem — an Indian lead with a US number has
`country = india` and gets called correctly. Fall back to dial code only for the ~6% blank.

Static lookup table, ~50 rows, `country -> utc_offset`. No library.

**Eligible = both true:** rep shift 14:00–23:00 IST **and** lead local 10:00–19:00.

| Region | Usable hrs | Share of non-India |
|---|---|---|
| UK / Europe / Nigeria | 8.5 | ~27% |
| UAE / Middle East | 6.5 | ~18% |
| US East | 3.5 | ~21% |
| Singapore / China / Malaysia | 2.5 | ~18% |
| Australia | 0.5 | ~3% |

Don't change the shift for the MVP — it covers ~73% of the book well. APAC is the casualty;
revisit after the test.

---

## 5. Numbers

| Number | Used for |
|---|---|
| +91 India | India leads |
| +44 UK/EU | Europe, Middle East, Africa |
| +1 US | Americas, APAC fallback |

**Cap 50 dials per number per day.** Fine at 100 dials/day for one rep.

⚠️ **Before adding Shubhankar and Riddick:** 3 reps × 100 dials ÷ 3 numbers = 100/number/day,
over the ceiling. **Buy 5–6 more numbers first.**

---

## 6. Data model

**users** — `id, email, password_hash, phone, rep_leg_destination, telnyx_session_call_id`
`rep_leg_destination`: PSTN number today, `sip:…` Sunday. **The only field that changes.**

**leads** — `id, hubspot_contact_id, name, phone, country, utc_offset, segment,
attempt_count, last_call_at, next_call_at, status`
`status`: queued | in_flight | connected | later | exhausted | stopped

**calls** — `id, lead_id, telnyx_call_id, from_number, started_at, answered_at, duration,
disposition`

---

## 7. Cadence

- Max **6 attempts** per lead
- Min **2 hours** between attempts
- Vary hour-of-day — never dial a lead at the same hour twice
- Select `next_call_at ASC`, filtered to leads inside their local window

| Disposition | Effect |
|---|---|
| Connected | exits queue |
| No answer | `next_call_at = now + 2h`, attempt_count + 1 |
| Call later | rep picks datetime, doesn't consume an attempt |

---

## 8. Session flow

**Once at 14:00:** log in → enter phone → **Connect me** → phone rings once → he answers →
**this call stays open all session**. He hears silence.

**Per burst:**

| Time | Himanshu | Lead |
|---|---|---|
| 0s | Clicks **Start calling**, silence | 2 leads ring |
| ~12s | **Beep in ear** + lead card on laptop | Lead A answers |
| ~12.3s | Bridged, talking | ~0.3s of silence after "hello" |
| same | — | Lead B cancelled mid-ring |

Lead hangs up → back to silence → pick disposition → **Start calling** again.
**No auto-advance.** Wrap-up is rep-controlled.

**Three details that matter:**
1. **Beep before bridging** — he may be looking at HubSpot, not your tool. Without it he misses the first 2 seconds of every call.
2. **No ringback in his ear** — silence lets him write notes.
3. **Handle his leg dropping** — show **Disconnected** + Reconnect, don't fail silently.

---

## 9. Sunday: browser audio

Swap `rep_leg_destination` from PSTN to SIP. **Nothing else changes** — burst logic,
bridging, cancelling, queue, lead card all identical.

### Read this repo first, do not fork it

**`team-telnyx/telnyx-demo-contact-center`** — official Telnyx, v5.1.0 (Mar 2026).
Same stack as yours: Next.js 15 + Express + PostgreSQL + Socket.IO + Telnyx WebRTC SDK +
Telnyx Node SDK v6.

**Why not fork it:** it is built around *inbound* — call arrives, enters a queue, ACD routes
to an available agent. Yours is the inverse. Forking means inheriting an IVR builder with
30+ node types, an ACD engine, SMS/MMS, Google SSO, Sequelize and Redux Toolkit you would
have to understand before deleting.

**Copy exactly three concerns:**

| File | Take |
|---|---|
| `server/routes/userRoutes.js` | SIP credential auto-provisioning via `telnyx.credentialConnections.create()` |
| `client/app/components/TelnyxRTCWrapper.jsx` | TelnyxRTC client lifecycle, connect/ready/teardown |
| `client/app/components/Softphone.jsx` | answer / hangup / mute handlers |

Ignore everything else in the repo.

Also useful: **`team-telnyx/telnyx-samples-pwc`** has an outbound dialer using Telnyx premium
AMD — reference for v2, not now.

⚠️ Their own README notes SDK v6 `.get()` doesn't pass query params correctly — **use
`.list()` resource methods**. Saves you an hour of confusion.

### Steps

1. Telnyx portal: SIP Connection, auth type **Credentials**, one per rep
2. Backend mints a short-lived login token per session
   (`/telephony_credentials/{id}/token`). **Never ship SIP passwords to the browser.**
3. Browser: `@telnyx/webrtc` → `new TelnyxRTC({ login_token })` → `connect()` →
   wait for `telnyx.ready` → auto-answer the incoming leg
4. Session start places the rep leg to `sip:<credential>@sip.telnyx.com`

**Keep the phone fallback as a per-user toggle.** If WebRTC misbehaves Sunday night, flip
Himanshu back to his phone Monday morning. Audio plumbing must never block the measurement day.

**Prerequisites, sort out today:**
- **HTTPS on the deployment** — `getUserMedia` won't run on plain http outside localhost.
  Deploy behind TLS from the start or you'll redo it.
- **Wired headset**, not laptop speakers. Echo will look like a code bug.
- **Test his actual office network.** Restrictive NAT can cause one-way audio.

**Payoff:** holding a PSTN leg open 9 hrs/day costs ~$5–10/day/rep — ~$1,500/month at 12 reps.
A SIP leg is free. It also removes the "his phone dropped" failure mode.

---

## 10. Screens — 2 only

**Login** — email, password.

**Dialer** — phone field + Connect me, Start calling, lead card (name, company, country,
attempt #, last outcome), 3 disposition buttons, counters for dialed/connected today,
CSV upload.

No settings, no admin, no reporting UI. Pull results with SQL.

---

## 11. Build order

**Step 1 first. Test with two real phones before writing anything else.** If bridging
doesn't work, nothing else matters.

| # | Task | Est. |
|---|---|---|
| 1 | Telnyx: call rep, burst 2 legs, webhook, bridge winner, cancel loser | **4–6 hrs** |
| 2 | Schema + CSV import + country→offset table | 2 hrs |
| 3 | Queue selection + cadence + window filter | 3 hrs |
| 4 | Login | 1 hr |
| 5 | Dialer UI + websocket lead card + beep | 3 hrs |
| 6 | Disposition → next_call_at | 1 hr |
| 7 | *(Sunday)* Browser softphone — lift 3 files from telnyx-demo-contact-center, §9 | 2–3 hrs |

**~15 hrs for v1.** Step 1 is where vibe-coded builds stall — the cancel-the-losing-leg race
is the most likely thing to misbehave.

---

## 12. Success criteria — Monday, non-India only

| Metric | Baseline | Target |
|---|---|---|
| Dials/day | ~30 | 100+ |
| Connect rate | ~13% | ≥13% (must not drop) |
| Connects/day | ~4 | 12+ |
| Attempts per lead | ~2 | 3+ |
| Abandoned calls | — | <2% |

**Reading the result:**
- Dials up **and** rate holds → working. Roll out to Shubhankar and Riddick.
- Dials up, rate drops sharply → bursts abandoning people, or caller IDs flagged. Drop to 1 leg, re-test.
- Dials flat → the tool isn't saving time. Stop and find out why before building more.

---

## 13. Rollout gate

Before adding Shubhankar and Riddick: buy 5–6 more numbers · abandon rate <2% ·
no caller ID flagged.

---

## 14. NOT in the MVP

HubSpot write-back · HubSpot live sync · AMD · call recording · transcription ·
availability toggle · manager mode · outbound CSV mode · multi-rep · reporting UI ·
AceConnect migration
