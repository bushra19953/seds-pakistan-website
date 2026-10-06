# SWARM-B2: Assignee-side submission visibility audit

Agent B2 findings, 2026-10-06. Investigation only, no code changes.
Scope: `src/components/profile/assigned-tasks.tsx` (TaskCard), the submit
flow (`handleFullUpdate` and `handleQuickAction`), and the server-side
submit transition in `src/app/api/tasks/route.ts`.

## TL;DR: the submit form is the gap, not just the views

It is BOTH, but the root cause is the submit side. There are TWO transmit
paths and the prominent one collects zero content:

1. **One-click "TRANSMIT SUCCESS" button** (the fast path, rendered whenever
   `isYourTurn` is true): sends a HARDCODED report string
   `'Objective reached. Direct Transmit.'`, no hours input, no way to attach
   anything. Every submission made through this button is empty of real
   content by construction.
2. **Expanded SITREP form** (the slow path): collects a status pill, an hours
   stepper, and a free-text "Execution Log" textarea, but enforces nothing.
   An empty textarea transmits fine. There is no file upload, no photo
   attachment, and no proof/deliverable link input anywhere in the form.

So "empty submissions" are expected behavior of the current UI, not a data
loss bug. The views then hide whatever little was submitted.

## 1. What the card shows when a task is submitted-for-review

File: `src/components/profile/assigned-tasks.tsx`, expanded SITREP panel
(approx. lines 501-520).

When `task.status === 'submitted-for-review'`, the entire editable panel is
replaced by a locked box:

- Heading: "TRANSMITTED — AWAITING REVIEW"
- Subtext: "Locked while the reviewer decides. Recall it to keep working on it."
- A single "Recall submission" button (reverts to in-progress)

The card otherwise shows: title, status badge, resource chips (assigner
resources), Ends In countdown, Bounty points, Sync %, personnel block,
operational briefing, mission sequence, and chat. NOTHING about the
submission itself:

- Report text: hidden. The textarea the submitter typed into is unmounted by
  the conditional, so even the submitter cannot see what they sent.
- Hours logged: hidden. `task.hoursWorked` is never rendered anywhere in the
  card.
- Submitted timestamp: hidden. The server stamps `submittedAt` on the
  transition (see section 3), but the card never reads it.
- Attachments / proof links: nonexistent. No field, no display.

Net effect: on the assignee's own profile, a transmitted task displays a
locked state with zero information about what was transmitted. The recall
button is the only affordance.

## 2. The full submit flow: what the form actually collects

### Path A: one-click quick transmit (handleQuickAction, approx. lines 267-291)

Visibility: the big "TRANSMIT SUCCESS" button renders on the card whenever
`isYourTurn` is true, i.e. the current user is an assignee and this is the
current workflow step. This is the most prominent transmit affordance on the
card.

Payload sent to `PATCH /api/tasks`:

```json
{ "taskId": task.id, "updates": { "status": "submitted-for-review", "report": "Objective reached. Direct Transmit." } }
```

Inputs collected from the submitter: NONE. Not the report (hardcoded),
not hours (not sent at all), not attachments (no such concept), not a
confirmation of any kind. One click, zero content, confetti.

### Path B: expanded SITREP form (handleFullUpdate, approx. lines 311-331)

Requires the submitter to expand the card, scroll to the Tactical SITREP
panel, and use the form. It offers exactly three inputs:

1. **Status** (segmented pills): Standby / Active / Transmit, mapping to
   `pending` / `in-progress` / `submitted-for-review`. Default is the
   task's current status.
2. **Hours Logged** (stepper input, 0.5 increments): maps to `hoursWorked`.
   Default "0.0". Not sent if it parses to 0/NaN (`parseFloat(inlineHours)
   || undefined`), so zero hours silently drop out of the payload.
3. **Execution Log** (textarea, 5 rows, placeholder "Detail outcomes,
   blockers, and deliverables..."): maps to `report`. Prefilled from the
   task's existing `report`. No minimum length, no required marker, no
   validation on submit.

Payload sent to `PATCH /api/tasks`:

```json
{ "taskId": task.id, "updates": { "status": inlineStatus, "report": inlineReport, "hoursWorked": parseFloat(inlineHours) || undefined } }
```

Things the submit form does NOT offer: file uploads, photo attachments,
proof-of-delivery links, Drive links, external URLs, deliverable
descriptions, reviewer-facing notes. There is no way for the submitter to
attach any evidence of the work.

### What the server does on submit (src/app/api/tasks/route.ts, PATCH)

On transition into `submitted-for-review` the server stamps server-side:

- `submittedBy` = submitter uid
- `submittedAt` = server timestamp
- Clears previous decision stamps (`approvedBy/At`, `rejectedBy/At`)
- Sends reviewer notification + validator chain fan-out

The server does NOT validate that `report` is non-empty, that `hoursWorked`
was provided, or that any proof exists. An empty report is accepted and
stored without complaint. `submittedAt` exists in Firestore but no
assignee-side view reads it.

## 3. Answer to the key question: does the submit UI collect submission content?

Partially, and unreliably:

- The fast path (Path A) collects NOTHING. It fabricates content with a
  canned string.
- The slow path (Path B) collects report text + hours, but optional, with
  no floor and no proof mechanism.
- Neither path collects attachments, photos, or deliverable links.

Therefore empty submissions are primarily a FORM problem: the UI makes it
trivial to transmit with nothing. The VIEW problem is secondary but real:
even when content was submitted, the locked card view hides the report,
hours, and submitted timestamp from the submitter, which is why the
submissions "appear EMPTY in every read-only view" per the Oct 5 review
notes.

## 4. Recommended minimal fix on the submit side

Ordered by impact, keeping to the submitter experience only:

1. **Kill or demote the canned-report quick transmit.** Either remove the
   "TRANSMIT SUCCESS" one-click button, or make it open the expanded SITREP
   form with the Status pill pre-set to Transmit. The hardcoded
   `'Objective reached. Direct Transmit.'` string should never be written
   again. This single change closes the path that manufactures empty
   submissions.
2. **Require a non-empty Execution Log before transmit.** Client side:
   disable the TRANSMIT button (and show an inline hint) when the report is
   blank and the target status is submitted-for-review. Server side: reject
   the transition with a 400 when the resulting `report` is empty or
   whitespace-only. Belt and suspenders; the server check is the real gate.
3. **Add a proof input to the form.** Minimal version: a "Proof / deliverable
   links" textarea (one URL per line) persisted to a `submissionLinks`
   array on the task, consistent with how `resourceLinks` are handled
   elsewhere. Better version: reuse the existing Drive upload stack
   (`ReceiptUploader` pattern / `/api/uploads`) for file/photo proof with
   a cap. Links-only is the smaller change and matches the Drive-folder
   convention already used for resources.
4. **Stop silently dropping zero hours.** The `|| undefined` in
   `handleFullUpdate` means "0 hours" is indistinguishable from "never
   logged". Send the parsed number as-is when the input is present.
5. **Show a read-only submission summary in the locked state.** Replace the
   bare "TRANSMITTED — AWAITING REVIEW" box with: submitted timestamp,
   hours logged, the report text, and any proof links. This is the view-side
   fix that makes submitted content visible on the assignee's own profile.
   The data already exists in Firestore (`report`, `hoursWorked`,
   `submittedAt`, `submittedBy`); only rendering is missing.

Out of scope for this agent but noted: the admin/validator-side read-only
view gap (Group A territory) and the Approve/Request Revisions flow, which
is currently the only place submission content renders.
