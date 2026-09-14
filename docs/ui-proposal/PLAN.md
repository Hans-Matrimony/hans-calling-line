# Eazybe Dialer · UI improvement proposal

Status: approved and implemented in the production frontend on 12 September 2026. See [implementation and verification](../ui-implementation/README.md). The sample below remains the original design reference.

The direction is a clearer calling workspace built around the conversation: queue on the left, the current lead and call controls in the center, contact context on the right. It keeps Eazybe’s blue, Hanken Grotesk, Saira Semi Condensed, IBM Plex Mono, and existing icon vocabulary.

## Review the sample

- Open `sample.html` for the interactive prototype. It works locally, including its fonts, and makes no external requests.
- Compare **Current UI** and **Proposed UI** in the top bar. The current view is rendered from the original `HEAD` React/CSS source with fictional state; it is not a screenshot of a live account.
- Try **Ready to dial → Start dialing → Hang up → choose an outcome → Save outcome → Next lead**. The state buttons also jump directly to a review state.
- Search the queue, preview another lead when idle, edit the sample contact, mute the sample call, open the keypad, and preview audio disconnected.
- The other navigation buttons explain the planned treatment of their screens. They are not complete redesigned pages yet.

## What improves

| Area | Current friction | Proposed treatment |
| --- | --- | --- |
| Workspace hierarchy | Run status, the main action, lead identity, history, notes and controls sit in separate blocks. | Keep identity, stage, note/outcome and action in one stable conversation panel. |
| Primary action | Start/Next lives above the card; in-call controls live below another layout. | Use one consistent lower action area that follows Review → Conversation → Outcome. |
| Queue | Names, numbers and local time are dense, while waiting reasons live elsewhere. | Show person and company first; keep ready count, exact local time and a concise waiting breakdown together. |
| Context | Every editable field has equal weight, including blank alternate numbers. | Show the useful populated details first. Open editing deliberately, retaining all existing contact fields and alternate-number controls in the implementation. |
| Outcomes | Some outcome tiles save immediately, while others reveal another step. | Proposed: select an outcome, then press **Save outcome**. Keep **Next lead** as a separate manual action. |
| Run progress | The run tape and call log compete with the lead workspace. | Keep a compact run strip under the workspace; expose the named call log on demand. |
| Reliability feedback | Audio, saving and CRM sync can be easy to overlook. | Keep audio visible. Show distinct **Saving**, **Saved**, **Retry save**, and CRM sync states from real server responses. |
| Small screens | Secondary information can push the current call away. | Put the current conversation first; stack contact details and queue below. Preserve visible call controls and keyboard focus. |

The one deliberate visual signature is the conversation phase rail. It represents the real workflow and is paired with the action that advances that workflow. The rest stays restrained.

## Decision included in this proposal

The approved **Save outcome** step is implemented for all seven outcomes. Number keys select an outcome; the explicit save action writes it. **Next lead** remains a separate action.

## Implementation after approval

| Phase | Scope | Completion check |
| --- | --- | --- |
| 1. Calling workspace | Update `Console`, `Campaign`, `CallCard`, `Handset`, `LeadRail` and scoped rep CSS. Build the approved ready, ringing, live, outcome and saved states. Apply the same conversation panel to manual and Burst dial. | Full call loop works for one lead and two ringing leads; current winner remains clear; notes survive re-render/reconnect; outcome must finish saving before Next is enabled; controls do not move out of reach. |
| 2. Queue and activity | Bring `UpNext` and `Activity` into the same spacing/type system. Show actual attempt ceilings, each lead’s next eligible time, retry reason, local timezone and caller-ID capacity. Improve import and empty/error feedback. | Labels match server values for 6- and 9-attempt leads and 10-minute, 15-minute and 2-hour retries; ownership changes refresh correctly; unknown timezone, no ready leads, all caller IDs capped and failed sync are distinguishable. |
| 3. Admin consistency | Apply shared shell, controls, table density and status vocabulary to Overview, Reps, Calls, Leads, Wallet and Users. Keep reporting definitions, filters, recordings, costs and permissions intact. | Metrics retain the same calculations and IST period boundaries; filters and detail drawers work; recordings remain playable; tables are usable at laptop widths. |
| 4. Release review | Check realistic seeded states and the real integrated build. Review at 1440, 1280, 960/768 and 390px; check keyboard access, reduced motion, readable contrast and zoom. | Rep and admin smoke checks pass; no live call regression, hidden critical action, clipped content or unexpected request; approved screenshots match the build. |

The six functional fixes are a separate delivery. Their correctness labels can ship with those fixes; this visual redesign stays behind the user’s approval.

## States the implementation must cover

- Idle with ready leads, empty queue, waiting on calling hours, retry gaps and callbacks.
- Audio connecting, connected, disconnected during a call, and reconnect failure.
- Manual dialing, one lead ringing, two leads ringing, a Burst winner, the other lead cancelled or answered too late.
- Live call, user hangup, remote hangup, bridge failure and browser refresh/reconnect.
- Every supported outcome, callback scheduling, optional rejection reason, saving, save failure/retry and saved.
- Contact edit success/failure, HubSpot syncing/failed/last synced, import added/updated/skipped/missing timezone.
- Caller-ID daily cap reached and daily reset information.

## Validation performed on this prototype

The prototype was rendered and visually checked in Chromium at desktop and mobile sizes. Automated interaction checks verified note retention across the sample call states, selection before save, separate manual Next lead, callback fields, queue filtering, idle lead preview and the before/after switch. There is no horizontal overflow at 1440, 1280, 960, 768 or 390px. No JavaScript errors or external requests were recorded.

This is a design prototype with in-memory fictional data. It does not prove Telnyx, HubSpot, server recovery, real microphone/audio behavior or production accessibility. Those checks belong to the implementation/release phases above. Prototype date/time values are fixed examples.

## Files

- `sample.html`, `sample.css`, `sample.js`: local review prototype.
- `baseline.html`: original source-rendered comparison.
- `proposed-desktop.png`, `proposed-ready.png`, `proposed-outcome.png`, `proposed-saved.png`, `proposed-mobile.png`, `current-desktop.png`: review images.
- `validation.json`: recorded prototype checks.

## Superdesign status

The Superdesign project was created, but its automatic approval review rejected uploading the source-derived navigation HTML because approval to disclose that internal payload to the external service had not been established. No source components or design drafts were uploaded. The complete local sample was produced instead. Continuing on the external canvas would require approval for the specific files and destination; the local review does not need that upload.
