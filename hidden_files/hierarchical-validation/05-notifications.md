# Notification System — Task Submission & Approval
**Research agent 5/8 · 2026-10-04 · read-only, no code changed**

## TL;DR
- **Submission** (`submitted-for-review`): only the **single assigner** (`assignerId` / fallback `createdBy`) is notified — **if they aren't the submitter themselves**. Assigner gets in-app + FCM push + email (Brevo/Gmail SMTP, `task_submitted_for_review` template).
- **Approval** (`approved`/`completed` by someone with `canManage`): every **unpaid assignee** gets an in-app `submission_feedback` notification ("Task Approved! 🎉"). The approver and all other managers get nothing. No push/email on approval (in-app only, written inside the points transaction).
- There is **no** "notify my reports" / broadcast-to-subordinates helper today. Role broadcasts exist (`notificationService.broadcastByRoles`, `createAdminNotification`) but are used for chapter applications, events, store orders, tickets — never for task review.
- **Critical gap for hierarchical validation:** auth already grants approve power to *any manager above any assignee* (`isManagerAbove` in PATCH /api/tasks), but the submission notification still pings only the original assigner. If hierarchical review is expanded, that single notify target must change or submissions will stall silently when the assigner is idle.

---

## 1. Current notify paths (file + function)

### 1a. On task SUBMISSION
**Trigger:** `PATCH /api/tasks` — `src/app/api/tasks/route.ts`, PATCH handler, "status change notifications" block (lines ~556–598).

Conditions:
- `updatesToApply.status === 'submitted-for-review'`
- Target = `(taskBefore).assignerId || (taskBefore).createdBy`
- Skipped if `assignerId === actorId` (submitter who assigned it to themselves gets no ping)

Sender function: `createNotification(db, userId, notification, emailOptions)` — local helper defined at the top of the same file (lines ~127–198).

Channels (all three fire):
1. **In-app**: write to `users/{assignerId}/notifications` — `{ type: 'task_status_change', title: 'Task Submitted for Review', body: '"<title>" has been submitted for your review', link: '/admin/tasks?taskId=<taskId>', taskId, isRead: false, timestamp: serverTimestamp() }`. Always.
2. **FCM push**: to the assigner's `fcmTokens` (if `pushEnabled !== false` and tokens exist). Non-blocking, failures only logged.
3. **Email**: `sendEmailNotification(email, 'task_submitted_for_review', { recipientName, taskTitle, taskLink, actorName })` via `src/lib/mailer.ts` (Resend keys → Gmail SMTP fallback; daily cap 1000; each send logged to the top-level `email_logs` collection, viewable at `/admin/email-logs`).

Who can submit: any assignee of the task (non-managers may touch only their own tasks — field-level authorization at route.ts ~406–425). So the submitter is always an assignee, and the pinged validator is the assigner only.

### 1b. On task APPROVAL
**Trigger:** `PATCH /api/tasks` with `status` → `'approved'` or `'completed'`, executed by a caller with `canManage` (`decoded.uid` as `actorUid`). Who can manage today (route.ts ~241–321):
- ID-token claims with `manageTasks`/`canManageTasks` permission, or
- `roles/{uid}.role` granting `canManageTasks`, or
- **hierarchy-aware grant**: `isManagerAbove(caller, anyAssignee)` via `src/lib/server/hierarchy-utils.ts`, or
- the original `assignerId` (always).

**Notify code:** inside the Firestore transaction `executeGamificationTransaction()` — `src/lib/server/gamification-transaction.ts`, "Notifications" block (~lines 222–236) and delegatee block (~268–284).

Recipients:
- Each **unpaid assignee** (`unpaidAssigneeIds` = assignees with no existing COMPLETION ledger entry — prevents double-dipping) gets an in-app `submission_feedback` doc: title `'Task Approved! 🎉'` (or `'Task Approved (Late) ⚠️'`), body includes the title, final points, and any late penalty; `link: '/profile/unified?uid=<uid>&task=<taskId>'`, `taskId`, `isRead: false`, `timestamp`.
- If the task had an **accepted delegation**, the original delegator gets the points-kept variant of that message, and the **delegatee** (person who did the work) gets a separate `submission_feedback` doc ("Delegated Task Completed! 🎉", their earned points).

Channels on approval: **in-app only**. No FCM push, no email — written inline in the points transaction (atomic with point awards), unlike submission which uses the helper with all three channels.

Notably **not** notified on approval:
- The approver/validator themselves (no audit receipt).
- The original assigner (unless they are also an assignee).
- Any other manager in the hierarchy.

The approval actor is passed as `actorUid` but is **not persisted** on the task (no `approvedBy`/`reviewedBy` field exists).

### 1c. Related (not submission/approval, for context)
- Task **assignment**: same `createNotification` helper + email, fires per assignee at POST /api/tasks (~944–974).
- **Delegation fan-out**: `src/app/api/tasks/delegate/route.ts` (~125–162) writes `type: 'task_delegation'` in-app docs + `task_assigned` email to every delegatee on the step.
- Workflow next-step handoff: inside gamification-transaction (~352–368), `task_assigned` to the next-step assignee and `task_status_change` to all `workflowParticipantIds`.
- **Deadline crons**: `src/app/api/cron/check-deadlines/route.ts` and `remind-deadlines/route.ts` use `notificationService.send(assigneeId, …)` — assignees only, never validators.

## 2. Notification doc shape

Two variants exist today (inconsistent):

**Variant A — route.ts `createNotification` (submission, assignment):**
```json
{
  "type": "task_status_change" | "task_assigned" | "task_delegation",
  "title": "Task Submitted for Review",
  "body": "\"…\" has been submitted for your review",
  "link": "/admin/tasks?taskId=<taskId>",
  "taskId": "<taskId>",
  "isRead": false,
  "timestamp": "<serverTimestamp>"
}
```

**Variant B — gamification-transaction.ts (approval):**
```json
{
  "type": "submission_feedback",
  "title": "Task Approved! 🎉",
  "body": "\"…\" has been approved and marked complete. …",
  "link": "/profile/unified?uid=<uid>&task=<taskId>",
  "taskId": "<taskId>",
  "isRead": false,
  "timestamp": "<serverTimestamp>"
}
```

Notes:
- **Inconsistent read flag**: route.ts and gamification-transaction use `isRead`; `notification-service.ts` (`NotificationService.send`) uses `isRead: false` too, but the legacy `notification-helper.ts` (`createNotificationToUser`) uses `read: false`. Two different keys for the same concept in the same subcollection.
- **Inconsistent timestamp**: `timestamp` (route/gamification) vs `createdAt` (helpers/service). The client `NotificationCenter` sorts by `timestamp` only.
- **`notificationService`** also writes `priority` and a `deliveryStatus: { push, email }` object with async status updates — this is the "production-grade" path, but **task submission/approval do not use it**. They use the bespoke paths above.
- No TTL/expiry on task notification docs.

Storage location: `users/{uid}/notifications/{autoId}` (per-user subcollection).
Firestore rules (`firestore.rules:419–422`): `read: if isOwner(userId)`, `write: if isSuperAdmin()`. Note the default-deny principle: all in-app task notifications are server-side Admin-SDK writes, which bypass rules entirely — the rules only gate client reads.

## 3. Client display

- **`src/components/notifications/notification-center.tsx`** (header bell): real-time `onSnapshot` on `users/{uid}/notifications` ordered by `timestamp` desc (limit 50). Tabs All / Personal / Announcements; combined unread badge; sound "ding" on unread-count increase (toggleable, localStorage `notification-sound-muted`); click opens `n.link` and marks `isRead: true`. Shows `title`, `body`, time-ago, and optional event-style extras (`deadline`, `location`, `capacity` — rendered if present).
- **`src/app/notifications/page.tsx`**: full-page list view of the same subcollection.
- **`src/components/profile/user-notifications-listener.tsx`**: profile-level listener for real-time toast on new notifications.
- Approval notifications link to `/profile/unified?uid=<uid>&task=<taskId>` (the assignee's unified profile with the task auto-opened); submission notifications link to `/admin/tasks?taskId=<taskId>` (the review surface).

## 4. Existing broadcast / hierarchy helpers

| Helper | File | Used for |
|---|---|---|
| `createAdminNotification(db, payload { targetRoles })` | `src/lib/notification-helper.ts` | none found in task flows (utility only) |
| `notificationService.broadcastByRoles(roles[], payload)` | `src/lib/server/notification-service.ts` | chapter applications, events, store orders, ticket issue — all role-based (`permissionsConfig.canManageX` arrays), **never tasks** |
| `notificationService.send(uid, payload, priority)` | same | deadline crons, chapter applications, store orders |
| `createNotificationToUser(db, uid, payload)` | `src/lib/notification-helper.ts` | utility, no known callers in task flows |

There is **no helper that walks the hierarchy** (e.g. "notify all managers above user X") and **no "notify my direct reports"** helper. The hierarchy infra (`src/lib/server/hierarchy-utils.ts`: `isManagerAbove`) is used for *permission grants*, never for *notification fan-out*. The workload route (`src/app/api/admin/hierarchy/workload/route.ts`) builds the subordinate map from `users.managerId` / `reports` collections — the only existing code that traverses the manager chain, and it is read-only for a dashboard.

## 5. Fan-out design options for hierarchical validation

Context: hierarchical review authorization already exists (any manager above any assignee may approve via `isManagerAbove` in PATCH /api/tasks). The question is only **who gets the "submitted for review" ping**. Currently exactly one person: `assignerId || createdBy`.

### Option A — Keep the assigner-only ping (status quo)
- *How:* no change.
- *Pros:* minimal noise; single clear owner; least spam; no new dedup state.
- *Cons:* under hierarchical validation, approval authority no longer equals the assigner — the ping goes to the one person who may not be the one available. If the assigner is idle, the submission sits silently; the manager who *could* approve never learns about it. This directly conflicts with the "leader in the loop" standing rule (VP oversight should see what's submitted).

### Option B — Fan out to all eligible validators (full chain)
- *How:* on `submitted-for-review`, walk the manager chain(s) above every assignee (via `hierarchy-utils.ts`-style traversal) plus the assigner, and write a notification to each.
- *Pros:* fastest time-to-review; any available superior can act; matches the existing authorize-any-superior semantics 1:1.
- *Cons:* spam — a deep chain means N notifications per submission; first-come review conflicts (two managers approving simultaneously → one hits the idempotency guard `Task already marked as completed idempotently` and gets a 500, confusing); no "claimed by" state today so races are silent; email volume multiplies (daily cap 1000 in mailer.ts).

### Option C — Direct lead only (immediate superior of the doer)
- *How:* notify the doer's direct `managerId` (single hop) instead of / in addition to the assigner.
- *Pros:* aligns with the "leader in the loop" rule — the VP/lead who owns oversight sees submissions; noise stays at ~1 ping; cheap to implement (one lookup).
- *Cons:* diverges from authorize semantics (a higher-up can approve but isn't pinged); the assigner may be a *different* person than the direct manager (e.g. Task 02's assigner is the president, while oversight is the VP) — you must decide assigner AND direct lead vs OR.

### Option D — Escalation ladder (time-based, not chain-wide)
- *How:* notify the assigner (Option A) immediately; a cron (extend the existing `check-deadlines` cron infra) re-pings the next level up if the submission is still unreviewed after X hours; final fallback broadcasts to `canManageTasks` role holders (reuses `broadcastByRoles`).
- *Pros:* preserves single-owner accountability first; spam bounded by escalation steps; matches existing cron + broadcast machinery; no race conflicts until fallback.
- *Cons:* slower worst-case review latency (waits the full window); needs new state (`lastEscalatedAt` / escalation level on the task doc) and a cron schedule decision; fallback broadcast can still spam the whole admin bench.

### Recommended framing for the decision
1. **The notify target should be derived from the same authority set the review logic uses.** Today authority = assigner + any-superior-above + canManageTasks role holders; notify = assigner only. That's the mismatch to close.
2. **Whatever option is chosen, a "claimed/reviewing" marker is missing infrastructure.** Today two approvers race into `executeGamificationTransaction` and the loser gets a 500 (idempotency error). With wider notify targets this gets worse. Any fan-out option should persist `reviewedBy`/`claimedBy` on the task doc alongside the notify change.
3. **Email is the binding constraint on fan-out scale**: `mailer.ts` has a 1000/day in-memory cap and Gmail-app-password SMTP. Per-validator emails on every submission would burn this fast in a busy chapter. In-app-only for validators, email only for the primary owner, is a natural split (already the precedent: approval uses in-app only).
4. **Doc-shape cleanup is a prerequisite to any fan-out:** unify `isRead` vs `read` and `timestamp` vs `createdAt` first, or every new writer adds to the confusion. The client only sorts/reads `timestamp` + `isRead`.

### Open questions for the parent orchestrator
- Is the intended validator set "anyone who *can* approve" (role-based) or "anyone above the assignee" (hierarchy-based), or the intersection? The fan-out target differs.
- Should a superior's approval be constrained (e.g. only after the assigner hasn't acted in 24h), or is immediate any-superior approval the intended semantics? (The authorize code already permits immediate approval by any superior.)
