# Telnyx coverage audit — which countries can we actually call?

Audited 2026-09-07 against the live Telnyx account (read-only API), plus Telnyx's own docs.

## 1. What we own today

| Number | Country | Type | Status | Connection |
|---|---|---|---|---|
| +1 302 417 0301 | US (Delaware) | local | active | hans-dialer |
| +1 315 597 0155 | US (New York) | local | active | hans-dialer |

That is the whole inventory — **two US numbers, nothing else**. `FROM_NUMBER_EU` and
`FROM_NUMBER_INDIA` are blank in `server/.env`, so `pickFromNumber()` falls through to
"least-used anywhere" and **every lead on Earth is dialled from a +1 CLI**, including the
rep leg (`session.js` asks for `'india'` and gets a US number back).

Balance: **$8.32**, credit limit $0, no daily spend limit on the profile.

## 2. Three independent gates decide "can we call country X"

1. **Outbound Voice Profile whitelist** — Telnyx config, ours to set.
2. **Telnyx termination + sanctions** — Telnyx says it terminates "in every country";
   embargoes are the real carve-out.
3. **Destination-country CLI regulation** — what a +1 caller ID is allowed to do there.

## 3. Gate 1 — the whitelist is wide open, but wired to the wrong profile

The Call Control app `hans-dialer` (`3042168655686141391`) points at the OVP named
**"Default"** (`2919259967326258179`): **all 255 destinations** whitelisted, plus the five
special destinations (`uitf`, `inmarsat`, `gmss`, `intlnetworks`, `upt`), no concurrent-call
limit, `service_plan: global`.

The purpose-built OVP **"hans-dialer"** (`3042244496378038171`, 84 destinations,
concurrency 10) exists but **is attached to nothing**.

**So right now no country is blocked by whitelist.** But this is fragile:
`server/scripts/telnyx-setup.mjs:41` re-points the app at the 84-country profile on every
run. Running it today would silently break 8 countries already in `countries.js`:

> **YE, GE, LA, BO, PR, EC, CL, CR** — Yemen, Georgia, Laos, Bolivia, Puerto Rico,
> Ecuador, Chile, Costa Rica (all added 2026-09-05 from Himanshu's priority list;
> `DESTINATIONS` in the script was never updated to match).

Failure mode is a SIP `403 Dialed Number is not included in whitelisted countries (D13)`.
It would also cap concurrency at 10.

Fix: add those 8 to `DESTINATIONS`, or drop the OVP step and stay on Default.

## 4. Gate 2 — where Telnyx will not carry the call

- **Embargoed / sanctioned: Cuba, Iran, North Korea, Syria**, and Russian-occupied
  Ukrainian oblasts. Whitelisting does not override this — expect `503 No routes found`.
  **`IR` is whitelisted on both profiles and Iran is a live entry in `countries.js`
  (offset 3.5, region `eu`).** It should come out of the routing map.
- **Special destinations are ON** (satellite/Inmarsat/GMSS, UIFN, UPT, international
  networks). These are premium-rate at $1–10+/min and the classic toll-fraud target.
  With $8.32 of balance and no daily spend limit, this is the largest open exposure.
  Recommend switching all five off.

## 5. Gate 3 — the CLI problem (this is the real answer)

Telnyx **rejects international caller-ID spoofing** (`503`). We can only present numbers we
own, and we own only US numbers. So every international leg is a +1 CLI. Consequences:

- **EEA destinations** (DE, FR, NL, ES, IT, BE, AT, SE, NO, DK, PL, CZ, HU, HR, FI, GR,
  RO, BG, IE, PT, EE, LV, LT) require a valid P-Asserted-Identity with a real, dialable
  number. Our +1 numbers qualify, so calls connect — but anonymous/invalid CLI would be
  rejected or surcharged.
- **India** — Telnyx sells **no Indian numbers** (API returns 0 available). A +91 CLI
  terminating in India would be rejected by local operators anyway, so a foreign CLI is
  Telnyx's own recommendation. It works technically; TRAI reserves the 140/160 series for
  telemarketing, so a +1 sales call to India is exactly what DND/DLT enforcement targets.
- **UAE** — also **0 numbers available** on Telnyx. Same forced +1 CLI.
- Everywhere else: a US CLI connects but tanks answer rates.

## 6. Countries where a *local* number wouldn't help either

Telnyx's local-calling article lists ~95 countries with outbound local calling. 26 of our
92 routing countries are **not** on it — meaning even if we bought a DID there, outbound
local calling isn't guaranteed:

> IN, UA, TR, QA, KW, JO, LB, IQ, IR, MA, DZ, TN, SN, CI, ZW, BW, EG, TZ, UG, ET, KH, LK,
> NP, YE, LA, PR

This only matters for a future local-presence strategy. It does **not** block today's
model of dialling them internationally from +1.

## 7. Bottom line

**Countries we cannot call at all: Iran** (sanctions; currently in our routing map and
should be removed). Cuba, North Korea and Syria are likewise unreachable but were never in
the map.

**Everything else in `countries.js` is reachable today** — the binding constraints are the
$8.32 balance, the +1-only caller ID, and the setup script that would revoke 8 countries
the moment someone runs it.

### Actions, highest value first
1. Top up the balance and set a daily spend limit on the OVP.
2. Turn off the five special destinations (satellite / UIFN / UPT / intl networks).
3. ~~Remove Iran from `server/src/lib/countries.js`.~~ Done 2026-09-11: a +98 lead now has no timezone and sits in Up next's "No country" group instead of failing every 10 minutes.
4. Reconcile `telnyx-setup.mjs` `DESTINATIONS` with `countries.js` (or delete the OVP step).
5. Buy a **+44** number to fill `FROM_NUMBER_EU` — GB numbers are available and the EU/MEA
   region already routes to it.

## Sources
- [More About Outbound Voice Profiles](https://support.telnyx.com/en/articles/4320411-more-about-outbound-voice-profiles)
- [PSTN / Local Calling with Telnyx](https://support.telnyx.com/en/articles/6622229-pstn-local-calling-with-telnyx)
- [Countries that Telnyx Offers Termination in](https://support.telnyx.com/en/articles/1130664-countries-that-telnyx-offers-termination-in)
- [Caller ID Number Policy](https://support.telnyx.com/en/articles/3546251-caller-id-number-policy)
- [Troubleshooting Call Completion](https://support.telnyx.com/en/articles/5025298-troubleshooting-call-completion)
- [New Special Destinations Available](https://telnyx.com/release-notes/new-special-destinations-available)
- [Telnyx Acceptable Use Policy](https://telnyx.com/acceptable-use-policy)
