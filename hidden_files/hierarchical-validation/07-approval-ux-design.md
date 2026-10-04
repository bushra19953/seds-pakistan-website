# Approval UX Design — Hierarchical Validation (Design Agent 7/8)

Status: **DESIGN ONLY — read-only, no code changes.**

This document specifies what seniors see and how they approve/reject submissions
under hierarchical validation, without breaking the assigner's existing flow.

## 0. Ground facts (verified in code on branch `feat/remediation-harness-complete`)

- Task statuses: `pending` → `in-progress` → `submitted-for-review` → `completed`
  (or → `changes-requested` → back to `in-progress`/`submitted-for-review`).
  `overdue` is a **display-only** status, never persisted (PATCH `/api/tasks`
  strips it before saving).
- The approve path today is `PATCH /api/tasks` with
  `updates: { status: 'completed' }`. Server-side gate `canManage` is TRUE when
  ANY of: custom-claims permission (`manageTasks`/`canManageTasks`), role
  permission `canManageTasks`, **`isManagerAbove(caller, any assignee)`**
  (walks the `reporting_relationships` collection upward, BFS, max depth 20,
  plus legacy `users.managerId` field), or `assignerId === caller`.
  → **The backend already authorizes hierarchical validation. The gap is UX:**
  seniors in the chain have no queue and the dialog's `isManager` prop is only
  driven by `isOwner || isAdmin` (profile) / hardcoded `true` (TeamTasks page).
- Reject path today is "Request Revision": `PATCH /api/tasks` with
  `updates: { status: 'changes-requested', feedback_text }`.
  **Server enforces mandatory reason** (400 without `feedback_text`), appends to
  `feedback_history[]` (`admin_id`, `timestamp`, `text`, `previous_status`).
- On approve (`status → completed`), `executeGamificationTransaction`
  (`src/lib/server/gamification-transaction.ts`) runs: sets `completedAt`,
  computes deadline-lateness penalty (penaltyPoints deducted from awarded
  points, floored at 0), credits assignee (+ delegator/delegatee split when
  delegated), writes `points_ledger` entries, awards completion badges, and
  notifies the submitter (in-app → `users/{uid}/notifications`, FCM push,
  email): `"X" has been approved and marked complete. You earned N pts…`
- On submit (`status → submitted-for-review`) the server notifies **only the
  assigner** (in-app + FCM + email, link `/admin/tasks?taskId=…`).
- Current review UI (`src/components/profile/task-detail-dialog.tsx`):
  amber **"AWAITING REVIEW"** banner with a **Review Now** button (jumps to the
  Report tab), and in the Report tab, when `isManager && submitted-for-review`,
  two full-width buttons: **"Approve Mission"** and **"Request Revision"**
  (the latter opens a feedback modal; empty feedback is blocked client-side
  too). All changes re-render via live Firestore `onSnapshot`.
- Queue-like surfaces that exist: `AssignedTasks` ("Mission Control") on the
  profile page, and `TeamTasks` (team kanban). Neither shows "things awaiting
  YOUR validation" for non-admin seniors.

---

## 1. "Awaiting your validation" queue

### 1.1 Placement decision: profile page section (not admin, not a new route)

Rationale, from the code:
- Admin routes are gated for admins; many seniors (e.g. the VP in oversight
  roles) are **not** admins and will never see `/admin/tasks`. The standing
  pattern for non-admin surfaces is the profile page (`isOwner || isAdmin`
  gating in `assigned-tasks.tsx`).
- A brand-new route adds navigation, header links, and deep-link machinery for
  a feature whose content is one short list — the "nothing dummy or useless"
  bar applies: the queue is a section, not a page.
- The profile page already owns "Mission Control" (`AssignedTasks`); the queue
  is its natural sibling.

**Placement:** a new card `<ValidationQueue />` rendered at the top of the
viewer's own profile page (the `src/app/profile/page.tsx` / unified profile
view), **above** the Mission Control section, visible **only when it contains
≥ 1 item** and only to the signed-in user viewing **their own** profile
(`isOwner` pattern). Empty queue → the card does not render at all.

Also add an **"Awaiting review" quick-filter** to the existing `/admin/tasks`
board for admins (reuses the same API with `mine=false`), but the profile
section is the primary surface.

### 1.2 Row contents

Each row (compact task-card style, matching the Mission Control aesthetic):

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠ AWAITING YOUR VALIDATION                            [3]   │  ← header, amber
├─────────────────────────────────────────────────────────────┤
│ [avatar] "Executive 4-Page Portfolio (Step 2)"       45 PTS │
│          submitted by Maira Batool · chair_design           │
│          Step 2 of 3 · "Endorsement Letters" workflow       │
│          submitted 2h ago · due Oct 5, 8:00 PM (OVERDUE?)   │
│          role in chain: "Senior (VP oversight)"             │
│                              [Review] [Reject]              │
└─────────────────────────────────────────────────────────────┘
```

Columns/fields per row:
- Task title (truncated 1 line), points value (bounty chip), priority badge.
- Submitter: avatar + name + role title (from `users/{uid}` doc).
- Position in workflow: "Step N of M · workflowTitle" (when `workflowId`
  present; else "Standalone task").
- Submitted-at: `updatedAt` relative ("2h ago"), plus the task deadline with an
  overdue badge if past-due.
- Reviewer's relation: why this landed here — `"Assigner"` vs
  `"In validator chain (senior, 2 levels above)"`. One line, plain language;
  this is the disambiguation that makes hierarchical approval legible.
- Two actions: **Review** (opens the task detail dialog at the Report tab in
  review mode) and **Reject** (opens the dialog's reject modal directly).
- Sort order: overdue first, then oldest-submitted first (validation SLA),
  then highest points.

### 1.3 Data source: new API `GET /api/tasks/review-queue`

The server already has every primitive; the endpoint is a composition:

1. Authenticate (`authenticateRequest`), get caller uid.
2. Fetch all `tasks` where `status == 'submitted-for-review'` (limit, e.g. 100).
3. For each task, compute `canValidate` = the exact same `canManage`
   predicate as `PATCH /api/tasks`: claims/role permission, OR
   `isManagerAbove(caller, assigneeId)` for every id in `assigneeIds`,
   OR `assignerId === caller`.
4. Return only the tasks where `canValidate` is true, each decorated with
   `reviewContext: { isAssigner, inChain, levelsAbove, roleLabel }` and
   hydrated submitter display fields (name, photoURL, role).
5. Client polls/refetches on the profile page (same `listen` pattern as
   `useCollection`), and on focus. No new Firestore rule needed: it's a
   server API with caller verification.

Permission edge: the endpoint must NOT leak task content to users who fail the
predicate — only title/submitter/points/status basics for the queue rows, with
full report detail loaded in the dialog via the existing per-task path.

---

## 2. Task detail view — Approve / Reject

### 2.1 Visibility rule (plain language)

> **Show the Approve and Reject buttons on a submitted task if and only if
> ALL of these are true:**
> 1. The task's status is `submitted-for-review`;
> 2. You are logged in; and
> 3. You are **the assigner of this task**, OR you are **anywhere above the
>    submitter in the reporting hierarchy** (their direct senior, their
>    senior's senior, up to the top — not just their direct manager), OR you
>    hold the `canManageTasks` permission (admins).
>
> **Otherwise you see the report read-only.** Being the submitter never shows
> the buttons to you; being merely "on the same team" never shows them.

Implementation: the dialog fetches a lightweight
`GET /api/tasks/{taskId}/review-context` on open → `{ canValidate,
isAssigner, inChain, roleLabel }`, computed with the same `isManagerAbove`
logic. The dialog's existing `isManager` prop **keeps working** and the new
condition is OR-ed in:

```tsx
const canReview = isManager || reviewContext?.canValidate;
const needsReview = canReview &&
  (displayTask.status === 'submitted-for-review' || displayTask.actualStatus === 'submitted-for-review');
```

Everything else — the banner, the tab layout, the buttons' handlers — is
unchanged. This is the "same buttons, wider visibility" coexistence.

### 2.2 Button placement

- **Banner:** the existing amber "AWAITING REVIEW" banner now reads
  `"AWAITING YOUR VALIDATION"` for chain reviewers (or keep "AWAITING REVIEW"
  for the assigner), with a sub-line: `Reviewing as: {roleLabel}`
  (e.g. "Reviewing as: Assigner" / "Reviewing as: VP (oversight, 2 levels up)").
  The **Review Now** button jumps to the Report tab, unchanged.
- **Report tab:** the two-button row stays exactly as-is, relabeled:
  - **Approve** → `PATCH /api/tasks` `{ status: 'completed' }` (label keep as
    "Approve Mission" — same handler `handleApprove`).
  - **Reject → request changes** → opens the existing feedback modal (label
    "Request Revision"), `PATCH /api/tasks`
    `{ status: 'changes-requested', feedback_text }`.
  Both keep their optimistic-locking (`lastUpdatedAt` → 409 on conflict),
  toasts, and `onTaskUpdated` refresh.

### 2.3 Reject flow requirements (mandatory, mirroring server)

- Reject opens the feedback modal; the textarea is **required** (submit button
  disabled until non-empty, min ~10 characters client-side; the server's 400
  remains the hard gate).
- The modal shows the submitter's report summary above the textarea so the
  reason can reference specifics ("what must change"), and a short hint:
  *"The submitter will be notified and can resubmit — rejections are
  instructive, not terminal."*
- On confirm: status → `changes-requested`, feedback appended to
  `feedback_history`, dialog switches to show the feedback inline.

### 2.4 Multi-validator semantics (race handling)

- **First decision wins.** If two seniors open the same task, both see the
  buttons; whoever submits first transitions the status. The second submitter
  gets the existing 409 conflict path — the dialog should surface:
  `"Decision already recorded by {name} — refresh to see the outcome"` (name
  from the activity log entry).
- The Activity tab logs every validation decision with actor name + timestamp
  (existing `logTaskActivity` covers this), giving the audit trail the
  hierarchy needs.
- After YOUR decision, the queue row disappears on next refresh (status no
  longer `submitted-for-review`).

---

## 3. State transitions

### 3.1 On approve

```
submitted-for-review ──(PATCH status=completed, canValidate)──▶ completed
```

1. `completedAt = now`, `updatedAt = now`.
2. `executeGamificationTransaction`: lateness check against deadline /
   `individualDeadline`; if late and `penaltyPoints > 0`, deduct from awarded
   points (floor 0). Credit assignee (and delegator/delegatee split when the
   task was delegated). Write `points_ledger` entries
   (`task_completion` / `task_completion_penalty`). Award `completionBadgeId`
   if set. **Unchanged — same code path as the assigner's approve today.**
3. Notifications (handled inside the gamification module, unchanged):
   submitter gets in-app + FCM + email: `"X" has been approved and marked
   complete. You earned N pts…` (with penalty note when applied).
4. Live dialog `onSnapshot` flips to completed; queue row drops out.

**Design note:** the notification copy should name the approver role:
`"Approved by {name} (VP oversight)"` vs `"Approved by {name} (assigner)"` —
small change, large clarity for the submitter.

### 3.2 On reject (request changes)

```
submitted-for-review ──(PATCH status=changes-requested + feedback_text)──▶ changes-requested
```

1. `feedback_text` required (server 400 otherwise); appended to
   `feedback_history[]`; `feedback_text` field deleted, never stored flat.
2. **Notify the submitter** — this is a NEW requirement: today only
   submit→assigner and approve→submitter notify. Add symmetric createNotification
   (in-app + FCM + email): `"Changes requested on \"X\" by {name}
   ({roleLabel})"` with a 200-char feedback preview and a deep link to the
   task; email template `task_changes_requested`.
3. Task leaves every validator's queue (status filter), shows up in the
   submitter's Mission Control with the amber feedback panel (already exists).

### 3.3 Resubmission path

```
changes-requested ──(assignee submits)──▶ in-progress ──▶ submitted-for-review
```

- The assignee edits the report and re-transmits (existing inline SITREP /
  "TRANSMIT FOR REVIEW" buttons; the `changes-requested` feedback panel stays
  visible for reference).
- Re-entering `submitted-for-review` re-adds the task to **all** validators'
  queues and re-notifies (extend the existing submit notification from
  assigner-only to **assigner + every validator in the chain**, excluding the
  actor). The queue row should show a `"Resubmitted (round 2)"` chip when
  `feedback_history.length > 0` so seniors see the history at a glance.

---

## 4. Backwards compatibility — the two paths coexist

| Aspect | Assigner path (today) | Senior-chain path (new) |
|---|---|---|
| Endpoint | `PATCH /api/tasks` | **Same** `PATCH /api/tasks` |
| Server gate | `assignerId === caller` (line 320) | `isManagerAbove(caller, assignee)` (line 302–316) — **already live** |
| UI buttons | Same two buttons in `TaskDetailDialog` Report tab | **Same buttons**, visibility widened by `canReview = isManager \|\| canValidate` |
| Points/penalty/ledger | `executeGamificationTransaction` | **Same** — untouched |
| Reject semantics | `changes-requested` + mandatory `feedback_text` | **Same** — untouched |

Concrete compat rules:
1. **No change to existing call sites.** `AssignedTasks` (`isManager={isOwner || isAdmin}`),
   `TeamTasks` (`isManager={true}`), `task-history` (`isManager={false}`) keep
   their props. The new `reviewContext` fetch is additive and only widens
   visibility.
2. **A user who is BOTH assigner and senior sees exactly one button pair.**
   The `roleLabel` prefers "Assigner" when `isAssigner` is true (their original
   role is what they know).
3. **Server logic untouched.** The design assumes zero changes to the PATCH
   gate, the gamification transaction, and the submitter-side form — only the
   new read-only queue endpoint, the new submit-notification fan-out, and the
   new changes-requested notification are additive.
4. **Optimistic concurrency is the conflict resolver.** Overlapping validators
   collide on `lastUpdatedAt` → 409 → dialog shows the recorded decision. No
   locks, no new states.

---

## 5. Mobile / responsive considerations

- The queue section is a vertical stack of cards on `<sm` (already the card
  pattern in `assigned-tasks.tsx`); no table layout anywhere.
- Each row is one thumb-friendly unit: the whole row opens Review; the Reject
  action is a **secondary text button** (prevents fat-finger rejections).
  Minimum touch target 44px on all actions.
- The dialog is already `w-[95vw] h-[95vh]` on mobile with stacked
  `flex-col` action buttons — no changes needed; verify the roleLabel line
  wraps instead of truncating.
- The feedback modal: textarea min-height 120px, full-width submit; on reject
  confirm show a one-line undo window? **No** — keep parity with desktop
  (rejection is cheap to fix via resubmit; no undo machinery).
- Queue polling: refetch on visibility/focus change so a validator picking up
  their phone sees the current list without a manual pull-to-refresh.
- Push: the new FCM notification for "task awaiting your validation" is the
  primary mobile discovery path — it must carry the deep link
  `/profile?validate={taskId}` that opens the dialog straight at the Report
  tab (mirrors the existing QR `?task=` deep-link pattern in
  `assigned-tasks.tsx`).

## 6. Open questions for the orchestrator / implementer

1. Should a senior who approves a task get any points/credit? (Today: only
   assignee/delegator are credited. Recommend: no — validation is a duty, not
   a bounty.)
2. Should chain notification on resubmission skip seniors who already approved
   a previous round? (Recommend: no — everyone re-validates the new work.)
3. Escalation: if nobody in the chain validates within N days, does it fall to
   the assigner? (Recommend: assigner was always notified; no escalation
   timer for v1.)
4. Workflow steps with co-assignees: `isManagerAbove` checks **every**
   assignee id — confirm this is the intended "validator chain of any doer"
   semantic vs. only the primary `assigneeId`.
