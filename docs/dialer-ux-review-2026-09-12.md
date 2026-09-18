Hans Auto dial and Burst dial — usability review
Research date: 12 September 2026

**Recommendation: build a three-day follow-up sequence connected to HubSpot, with continuous dialing during an active SDR session.** The system should own retry scheduling and progression; the SDR should handle conversations and meaningful outcomes. The screen must explain the active person, sequence progress, next attempt and HubSpot write status.

The user's clarification establishes the business objective: inbound-team leads come from HubSpot; reps previously used CallHippo and Ace Connect UK for individual click-to-call. They want less manual dialing, automatic retries for unresponsive leads over three days, and more complete contact coverage than the current roughly six attempts. Their main friction is confusing call transitions, outcome/follow-up tracking and coordinating work with HubSpot. Whether today's local redesign is deployed is unknown.

This review compares the current local source and saved product screenshots with official competitor documentation. I visually inspected CallHippo, Aircall, JustCall and Orum product images. Close's documentation was readable, but its standalone control image did not render in the browser. Acefone is a probable match for the user's Ace Connect UK product; exact account/version equivalence is unconfirmed. These are documented capabilities and design observations, not hands-on trials or measured performance comparisons.

The local UI implementation note says the three-column redesign was built on 12 September but had not been deployed. Its screenshots use fictional contacts with the production components. Whether the team is already using that design remains unconfirmed; some visual recommendations may already improve the earlier deployed screen. No production changes or calls were made for this review.

**What we already have**

The existing foundation is useful: a persistent queue column, contact details, local time, call history, HubSpot queue sync, alternate phone numbers, scheduled callbacks with local-time presets, seven outcome choices, number-key outcome selection, explicit saving, note drafts that survive reload in the same tab, call recovery, caller-ID capacity, recordings and admin reporting. An older local JustCall comparison lists several of these as missing; those entries are stale.

Two important distinctions:

- Auto dial currently places one call per explicit start/Next action. It does not automatically continue after saving. The project records manual Next as an earlier owner preference.
- Burst places up to two calls for one rep; the first answer wins. This is closest to single-rep parallel dialing. It is not a shared predictive campaign routing answered calls to whichever rep is free.

**The most important gaps against the clarified goal**

| Need | Current source behavior | Product consequence |
| --- | --- | --- |
| Automatic dialing | Every next call/burst requires a rep action. Missed leads are requeued, not autonomously dialed by a running session. | Scheduling automation exists, but the daily calling loop still needs repeated clicks. |
| A three-day sequence | Base limit is six attempts; minimum normal retry gap is two hours; there is no explicit three-day enrollment/expiry model in the inspected queue. | Raising the attempt limit alone will not produce a dependable three-day follow-up process. |
| A clear contact-level budget | Attempt ceiling is max(6, 3 × phone count); changing to an alternate can use a 15-minute gap. | A contact with three numbers can get nine attempts while one with one number gets six. Reps need a contact-level policy they can understand. |
| Predictable time variation | Automatic dialing excludes a local hour if the contact was previously tried at that hour on any day. | A repeated daily schedule can be silently blocked; time variation should be intentional and visible. |
| HubSpot follow-up coordination | Durable call logging and recordings exist; write-back is primarily Call activities. No task/sequence-status write-back was found in the inspected integration. | A logged call is not the same as an owned, visible next follow-up. |
| Trustworthy sync feedback | The rep's Queue synced label reports the inbound contact pull. | It must not be interpreted as confirmation that the latest outcome or next action is saved in HubSpot. |

Current reconciliation refreshes CRM fields and ownership while protecting in-flight calls. Do not use the older documentation's snapshot-only description as evidence that field refresh is absent.

**Build first: automatic follow-up with a visible schedule**

Create a manager-defined sequence, for example **Inbound — three-day contact attempt**. Eligible new HubSpot leads enroll automatically according to agreed source, owner, status and contactability rules. Enrollment should not require the SDR to keep ticking individual contacts or recreating call tasks. Confirm available HubSpot workflow features before choosing the implementation mechanism.

Keep the schedule on the server, including enrollment time, sequence day, completed attempts, next eligible attempt, expiry and stop reason. The SDR starts one calling session; due leads are dialed automatically while that rep is available. A server schedule remains active when the browser closes, but human calling waits for a staffed session. If the owner is away, show an overdue/uncovered item or use an explicitly configured backup owner. Never dial into an absent rep.

For a controlled pilot, **up to three well-spaced attempts per eligible calling day, up to nine over three days**, is a reasonable candidate to compare against today's six-attempt process. This is a proposed experiment, not an established optimal frequency. Keep the total budget per contact across all phone numbers and across any calling tools still in use. Start the first attempt promptly when local hours and staffing allow; spread subsequent attempts across available times. Do not cram missed attempts into the end of a shift or turn a new alternate number into a fresh budget.

Define whether three days means calendar days or eligible business days before rollout. Late enrollment, unavailable reps or short calling windows may leave fewer completed attempts. At expiry, distinguish **No response after completed sequence** from **Sequence incomplete — insufficient calling coverage**. The latter belongs in a manager exception list. Adding nine attempts to a configuration is not proof nine attempts happened.

Stop the no-response sequence when a human conversation is confirmed, a meeting is booked, the lead becomes ineligible or an opt-out is recorded. A requested callback replaces the generic retry schedule with the promised time. A reply in HubSpot or another integrated channel should pause the sequence for review where that signal is available. Voicemail must not be treated as a successful human conversation. Keep actual attempts and short canceled Burst rings separately observable, and include all ringing exposure when applying contact-frequency limits.

**Build alongside it: a complete HubSpot working loop**

Use HubSpot as the authority for contact identity, ownership and sales status; let the dialer own call execution and the retry schedule, mirrored back through clearly defined properties. Do not let independent HubSpot and dialer automations each launch a retry for the same lead.

| Rep decision | Dialer behavior | HubSpot result to confirm |
| --- | --- | --- |
| No answer / busy / voicemail | Record the technical outcome, schedule the next allowed attempt and continue automatically. | One call activity with the right outcome; update attempt count and next-attempt time. |
| Callback requested | Stop ordinary retries; schedule a single call at the requested time. | One owned callback task, associated with the contact, plus next-action time. |
| Interested / meeting booked | Stop the no-response sequence; capture the agreed next action. | Call outcome, mapped sales update and an owned task/meeting where required. |
| Not interested / not qualified | Finish or pause according to the team's agreed policy. | A matching sales outcome and sequence stop reason. |
| Do not call again | Suppress across all dialing entry points. | A durable opt-out reflected in both systems. |

Avoid generating a task for every automatic unsuccessful attempt. Mirror the sequence's next-attempt property and keep one current actionable task for promised callbacks or rep work. Otherwise nine attempts create task clutter instead of reducing workload.

Show a concise status on both sides: **Day 2 of 3 · 4/9 attempted · Next 15:30 their time · Owner Alex**. In the dialer, separately show **Saved in dialer**, **HubSpot pending**, **Synced to HubSpot** or **Sync failed — retrying** for the specific outcome and next action. A transient HubSpot delay should not make the rep re-enter an outcome; retries must update the same activity/task without duplicates. A local save failure must block the next call. If current ownership or eligibility cannot be trusted, pause affected contacts rather than silently treating stale CRM data as current.

While CallHippo or AceConnect remain active, ingest their relevant CRM call/outcome events or assign a single dialing owner/tool per contact. Otherwise an SDR can connect in one tool while Hans continues its no-response sequence. Call history, suppression and attempt limits need to account for that migration period.

Start by exposing sequence status, attempts and next action as HubSpot properties and saved views. A later embedded HubSpot panel can show the same context and session controls if feasible. A full CRM extension rewrite is not necessary to prove the automation.

**What competitors teach us**

| Reference | Documented behavior | Useful lesson for Hans |
| --- | --- | --- |
| [CallHippo Power Dialer](https://help.callhippo.com/power-dialer/) | Automatic progression and configurable per-contact retries by attempts, interval and outcome/status. | Your existing vendor offers an automation benchmark beyond the click-to-call workflow you used. Compare that behavior, not just its dialpad. |
| [CallHippo HubSpot integration](https://help.callhippo.com/hubspot/) | CRM calling, call logging and outcome mapping; its guide limits after-call-work sync to changes made in that screen. | Outcome mapping and when edits sync must be explicit. We should support reliable correction of a saved result. |
| [Acefone HubSpot integration](https://www.acefone.com/integrations/hubspot/) | Browser-extension calling, contact pop-ups, notes/reminders and log/recording sync are documented. | Preserve the CRM context the team is accustomed to. Exact AceConnect UK parity has not been verified. |
| [Aircall Power Dialer](https://support.aircall.io/en-gb/articles/23996034990493) | Ordered dialing list, skip and pause controls, wrap-up time and automatic progression; can requeue a contact. | Make the running list and the rep's control over pacing obvious. |
| [Close Power Dialer](https://help.close.com/feature-guide/power-predictive-dialing/using-the-power-dialer) | Calls from filtered Smart Views; supports pause and Continue Calling; prevents reps dialing the same lead in a shared view. | Start with saved calling views and resumable sessions before building a large campaign-management system. |
| [JustCall campaign setup](https://help.justcall.io/en/articles/10510795-how-to-create-a-sales-dialer-campaign) and [settings](https://help.justcall.io/en/articles/11065197-sales-dialer-account-settings-explained) | Campaign-level caller-number selection, scripts and retry configuration; configurable after-call work and mandatory dispositions. | Let managers establish sensible defaults while reps see a small set of daily controls. |
| [Orum Parallel Dialer](https://support.orum.com/en-US/orum/article/PwEHqAiA-parallel-dialer) and [Connect Screen](https://support.orum.com/en-US/orum/article/PZ6izQKs-connect-screen) | Human detection, automatic handling of unsuccessful calls and limits on simultaneous dials; conversation screen includes contact context, logging and pause/resume. | Burst needs a clear transition into the answered conversation, with control over what happens next. |

JustCall's [mode guide](https://help.justcall.io/en/articles/10520971-choosing-the-right-sales-dialer-campaign) also distinguishes single-agent Power, shared sequential Dynamic and shared multi-call Predictive campaigns. Do not assume similarly named modes have the same architecture as ours.

**Specific observations from product screenshots**

| Screen inspected | What is visible | Design implication |
| --- | --- | --- |
| CallHippo's retry-settings image in its [guide](https://help.callhippo.com/power-dialer/#sec-create-campaign) | A single group brings together attempt count, time between attempts and the statuses that qualify for retry. | Make the three-day policy reviewable in one place; show its resulting schedule to reps. |
| Our [ready screen](ui-implementation/ready-desktop.png) | Contact context is useful, but a large central readiness block separates the contact from Start calling. Caller capacity occupies space below it. | Use this space for a concise last-note preview and call purpose; put the primary action in a stable, reachable position. |
| Our [Burst screen](ui-implementation/burst-desktop.png) | One person's full identity dominates while both contacts appear in smaller ringing rows. | Before an answer, give both people equal prominence. Otherwise the rep may prepare an opening for the wrong person. This is a usability hypothesis to test. |
| Our [outcome screen](ui-implementation/outcome-desktop.png) | History, seven outcomes, notes, error messaging and Save create a long page. | Keep Save & next visible in a sticky action area. Collapse older history when writing the result. |
| Aircall's pause-session image in its [guide](https://support.aircall.io/en-gb/articles/23996034990493) | A compact session block brings together list identity, remaining calls and a prominent Pause session control. | Keep session control beside session status. |
| JustCall's team-member settings image in its [guide](https://help.justcall.io/en/articles/11065197-sales-dialer-account-settings-explained#h_9de7f400af) | A limited settings screen exposes cool-off time, data-center selection and incoming-call forwarding. | Give reps a few relevant preferences; reserve operational configuration for managers. |
| Orum's [Connect Screen image](https://support.orum.com/en-US/orum/article/PZ6izQKs-connect-screen) | The connected row is highlighted; contact information fills the workspace, with logging and next-contact context on the right. | Make the answered person visually unmistakable and keep the next action nearby. Its information density is not a reason to copy the whole layout. |

**Usability changes to ship with the automatic sequence**

| Priority | Change | Exact behavior to build | Why it matters |
| --- | --- | --- | --- |
| 1 | Automatic continuation | After no answer, schedule the retry and continue. After a conversation, use **Save & continue**, with **Save & pause** beside it. Start another call only after the save succeeds. | Removes repeated Next clicks while keeping conversation outcomes deliberate. |
| 2 | Skip and snooze | **Skip this session** leaves the lead available for a later session without consuming an attempt. **Snooze** sets a future time. Show a confirmation with Undo. | Reps can handle an unsuitable lead without calling it or inventing an outcome. |
| 3 | Persistent session controls | Put **Pause after this call**, **Resume** and **End session** in a stable toolbar. Persist session ID, selected view, mode and progress. Recover to a paused state after reload. | A break or refresh should not make the rep reconstruct what they were doing. Current call recovery already exists; run persistence is the gap. |
| 4 | Clear Burst states | Show two equal contact cards while ringing; promote the answered person and show the other call's final state. Say when only one lead is eligible. | Reduces uncertainty about who is on the line and what happened to the other person. |
| 5 | Headset check | Add microphone/speaker selection, input-level feedback and a test tone. Remember preferences where supported. Link audio failures to the corrective action. | “Audio on” confirms a connection but cannot tell the rep that the correct headset works. |

For Auto dial, offer **Continue automatically** as the normal mode for this team's stated goal, with **Review each lead** available when the rep needs more preparation. The user's clarification supersedes the earlier manual-Next preference for this proposal. A short configurable countdown starts only after the outcome is saved; Pause cancels it. Never progress while a required outcome is missing, a save has failed or audio has disconnected. Unanswered calls advance after their result is recorded. Revalidate eligibility before every new dial.

For Burst, keep the current two-call ceiling during this work. Prefer one-at-a-time dialing for fresh high-intent inbound leads and promised callbacks; use two-at-once for eligible, previously unanswered leads when the rep selects it. This is a proposed routing default to test. A clearer screen and safe progression are more valuable than immediately adding more simultaneous calls. Preserve the difference between pausing future dialing and hanging up the current conversation.

**Next: let reps choose useful work**

Add saved calling views such as **Callbacks due**, **New leads**, **Never reached** and a relevant region or language group. Start with filters over the existing per-rep queue. Full campaign objects and shared team queues can follow if the team actually needs them.

The current left-column search covers only the next ten leads. Clicking a row previews it; it does not make that contact the next server-selected call. Keep a label such as **Previewing — next call remains Maya** until the product has an explicit **Call this lead next** action. If that action is added, the server must reserve and validate the selected contact, and the confirmation must name the actual person to be called.

Make due callbacks a distinct priority lane. Today they become eligible at the chosen time, but the queue sorts by next_call_at alongside other leads; that does not guarantee a promised callback goes first. Present due and overdue callbacks prominently and dial them one at a time. Do not put a promised callback into a two-person race where someone else may answer first.

**Important missing features**

1. **Do not call again.** Add an explicit opt-out distinct from Not interested and Wrong number. Enforce it across Auto, Burst, manual dialing, imports and HubSpot sync. Store it durably at the appropriate contact/number scope so importing the same number cannot quietly re-enable it. A stopped queue row is not a complete suppression system. JustCall documents CRM-to-DNC synchronization in its [API FAQ](https://help.justcall.io/en/articles/11173742-faqs-apis-and-webhooks). This recommendation concerns honoring a person's request; it does not assert that a feature alone satisfies every jurisdiction's calling rules.

2. **Voicemail outcome and clearer conversation measurement.** Our UI offers No answer and Wrong number but no Voicemail outcome, while machine detection is explicitly disabled. Let reps identify voicemail without distorting the result. Separate carrier answers, confirmed human conversations, interested leads and booked meetings in reporting. Add automatic machine detection later only after testing the tradeoff between saved rep time, missed humans and connection delay; JustCall's [settings FAQ](https://help.justcall.io/en/articles/11065197-sales-dialer-account-settings-explained#h_d7a97993db) describes a detection delay in its implementation. Do not assume our provider would behave identically.

3. **Second-answer recovery in Burst.** The server already identifies a second answered call as abandoned, hangs it up and schedules a retry. Improve this with an appropriate region-configured identification/callback message, a visible recovery task and a separate one-at-a-time recovery queue. Keep ringing cancellations separate from answered-but-unserved calls. A message is not a substitute for controlling how often this happens. JustCall documents an abandonment-message path in its [mode guide](https://help.justcall.io/en/articles/10520971-choosing-the-right-sales-dialer-campaign).

4. **Inbound callback ownership.** Verify what happens when someone calls back each outbound number. I did not find an inbound-callback workflow in the inspected application handlers, but forwarding may exist in Telnyx outside the repository. If missing, route to the original rep or team, show the prior call context and create a missed-callback task. Orum documents [inbound callback handling](https://support.orum.com/en-US/orum/article/P7K72jGF-fielding-inbound-callbacks); JustCall explicitly includes callback forwarding in campaign setup.

5. **A complete next step.** “Interested” should lead naturally to Book meeting, Create follow-up or Open a prepared message. A saved note alone may leave the rep with more work in another tab. Add confirmed HubSpot task status beside the outcome, rather than treating a successful dialer save as proof every external action completed.

**An Hans-specific direction to explore**

A compact **Why this call?** brief could show the last meaningful interaction, last promise, relevant HubSpot stage and suggested next action. If the team works from WhatsApp, combine that context with a prepared WhatsApp follow-up that the rep reviews and sends. Keep permissions and matching explicit; the dialer code reviewed here does not establish access to the team's WhatsApp conversations.

This is a product hypothesis, not a claim that competitors lack similar features. Its value would be reducing repeated reading, copying and switching between systems. A simple structured brief is worth testing before adding AI generation.

**Proposed calling flow**

```text
Eligible HubSpot lead → Enroll in three-day sequence → Next eligible attempt
                                                            ↓
                              SDR starts session → Automatic dialing
                                                            ↓
                           No answer → Log + schedule retry + next lead
                           Conversation → Outcome + next action + continue
                                                            ↓
                               HubSpot shows outcome, progress and next action
```

Keep the contact workspace stable. The toolbar shows the selected view, mode, progress and pause state. Details expand as needed. When the queue is blocked, explain the reason and the next opening time in place, with a relevant action.

**How to decide whether the changes worked**

Run a short usability pilot with three to five reps, including a less experienced caller. Use the same tasks before and after: start a session, skip a lead, schedule a callback, handle two ringing contacts, recover from an audio problem, save a failed outcome and resume after refresh.

Measure setup time, actions between completed conversations, hesitation about who is being called, failed saves, callback lateness and rep comfort on a simple 1–5 scale. For a live pilot, compare unique leads reached within three days, first-attempt delay, scheduled-attempt completion and extra leads reached on attempts 7–9, alongside human conversations per calling hour, useful outcomes and answered-but-unserved calls. More attempts should earn additional conversations, not just larger totals. Compare similar lead sources and time windows so list quality does not masquerade as a UX improvement. Proposed acceptance criteria include:

- After a normal conversation, outcome selection plus Save & next is sufficient to continue.
- Save failure never starts another call and retains notes and selection.
- Pause never hangs up the current conversation; resume never repeats a completed attempt.
- A refreshed session restores its scope and progress, paused until the rep resumes.
- The rep can correctly identify the active Burst contact and the other call's result.
- An opted-out number cannot be called through any entry point.
- Several unanswered leads progress without Next clicks; each gets one correctly scheduled retry.
- Callback promises replace the ordinary retry sequence and appear as one owned HubSpot task.
- A meeting or conversation recorded through another integrated calling tool stops inappropriate retries.
- Day-three expiry distinguishes unreachable leads from leads the team did not fully cover.

I would defer higher parallelism, a predictive team-routing engine, mandatory call ratings, a large script editor and broad AI coaching until these basics work comfortably.

**Decisions still needed before implementation**

- Which HubSpot source/status combination should enroll an inbound lead, and which statuses or events should stop it?
- Does three days mean calendar days or eligible business days? Which recipient countries and staffed hours must the schedule support?
- Is up to three attempts per day/nine total the pilot policy, or does the team need a different contact-level cap?
- Should an unavailable owner's due leads wait or go to a designated backup rep?
- Confirm the deployed UI version and whether AceConnect UK is the Acefone product before treating account-specific functionality as verified.

**Local evidence for implementation planning**

- [Current UI and screenshot provenance](ui-implementation/README.md)
- [Calling workspace and queue preview](../client/components/Campaign.tsx)
- [Outcome choices, scheduling and save behavior](../client/components/CallCard.tsx)
- [Navigation and audio connection](../client/components/Console.tsx)
- [Session recovery and in-memory run state](../client/lib/useDialer.ts)
- [Browser audio behavior](../client/lib/useSoftphone.ts)
- [Queue ordering, manual dialing and retries](../server/src/lib/queue.js)
- [Winner selection and second-answer handling](../server/src/lib/burst.js)
- [Machine detection configuration](../server/src/telnyx.js)
- [Current reporting](../server/src/lib/metrics.js)
- [Current attempt limits and windows](../server/src/config.js)
- [HubSpot reconciliation](../server/src/lib/hubspotReconcile.js)
- [HubSpot call write-back](../server/src/lib/hubspotCalls.js)

Effort should be estimated after the desired pacing and queue behavior are agreed. Visible buttons such as Skip, Save & next and Call this lead next also require durable state and server-side behavior; they are not purely styling changes.
