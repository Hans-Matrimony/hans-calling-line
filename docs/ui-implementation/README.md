# Approved UI implementation

Implemented on 12 September 2026 in the production frontend. The earlier six reliability fixes remain in place. The static production build has been generated locally; nothing has been deployed.

## What changed

- Manual, auto and burst dialing share a queue–conversation–contact workspace with a three-step progress rail.
- All seven outcomes now require **Save outcome**. Callback dates must be in the future. Optional reasons select without saving. Saving shows a pending state; failures keep the notes and selection for retry.
- Successful saves retain the completed contact and show the saved outcome. **Next lead** / **Next 2 leads** is a separate action. Inspecting another queued contact does not silently change who the server will call next.
- Notes survive hangup, reconnect and reload in the same browser tab through per-user, per-call session storage. Successful saves remove the draft. Storage-restricted browsers retain notes in memory only.
- Contact details have a deliberate edit form, including alternate numbers. Displayed contact data changes only after the server confirms the save.
- Queue search, waiting counts, sync health, caller ID capacity, import results and loading failures use the existing APIs. Manual dialing is disabled when no caller ID has capacity.
- Run history is available on demand. Ending a run after the current call also works when a burst receives no answer.
- Queue, activity and all six admin screens share the new spacing, navigation and control styling. Admin metrics, reporting filters, permissions and API contracts are preserved.
- Mobile navigation remains available. The conversation appears first, followed by contact context and the queue. Keyboard focus and reduced motion are supported.

## Screenshots

Screenshots use fictional contacts with the actual production components and state hook.

| View | Capture |
| --- | --- |
| Live conversation | [Desktop](live-desktop.png) · [Mobile](live-mobile.png) |
| Ready to dial | [Desktop](ready-desktop.png) |
| Outcome and failed-save retry | [Desktop](outcome-desktop.png) |
| Saved confirmation | [Desktop](saved-desktop.png) |
| Burst dialing | [Desktop](burst-desktop.png) |
| Outcome form | [Mobile](ended-mobile.png) |
| Queue and activity | [Queue](queue-mobile.png) · [Activity](activity-mobile.png) |
| Admin overview | [Desktop](admin-desktop.png) |

## Verification

Passed:

- `npm run build` in `client`: optimized Next.js build and static export, including lint and type validation.
- `npm run lint` and `npx tsc --noEmit` in `client`.
- `npm run test:ui` in `client`: **64 browser checks**, with no browser runtime errors or unmocked API calls. Full results: [validation.json](validation.json).
- Calling layouts at 1440, 1280, 960, 768 and 390 pixels; queue, activity and every admin screen at desktop and mobile widths. Separate mobile navigation target checks supplement the overflow checks.
- Visual inspection of desktop, mobile and admin captures. Corrected the local-time strip, mobile navigation overlap and admin metric grid found during inspection.
- `git diff --check`.

The browser suite builds the actual page, components and `useDialer` hook. It replaces the audio driver and Socket.IO transport, fulfills HTTP requests with local fixtures and blocks non-loopback network requests. It does not place real calls, request microphone access or write to HubSpot. Live carrier/audio behavior was not exercised by this UI pass.

The test runner uses an installed Playwright package or the Codex bundled Node packages. `CODEX_NODE_MODULES` can point to an alternate bundle. Generated test assets go into ignored `client/.ui-test/`; fixture code is outside the production app routes and is not included in the static export.
