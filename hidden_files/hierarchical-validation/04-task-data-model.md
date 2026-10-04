# 04 — Task Data Model & Submission Lifecycle

**Research agent 4/8 · 2026-10-04 · branch `feat/remediation-harness-complete` · read-only research**

Primary sources: `src/app/api/tasks/route.ts` (POST/PATCH/PUT/DELETE zod schemas + handler),
`src/lib/task-types.ts` (Task interface), `src/lib/task-management.ts` (client CRUD),
`src/lib/server/gamification-transaction.ts` (points engine),
`src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx` + its API `route.ts` (QR submit flow),
`src/components/profile/task-detail-dialog.tsx` (assignee + manager UI), `src/app/admin/tasks/page.tsx` (admin console),
`firestore.rules` (match /tasks).

---

## 1. Field Inventory — the `tasks` document (submission/approval-relevant)

| Field | Type | Written by | Notes |
|---|---|---|---|
| `id` | string (doc id) | Firestore | — |
| `title` | string | Creator | Required on POST |
| `description` | string | Creator | Required on POST |
| `assignerId` | string (uid) | POST (from auth token) | Original assigner; also grants review rights later |
| `assigneeId` | string (uid) | POST/PATCH | **Primary/first** co-assignee; kept for backward-compat readers |
| `assigneeIds` | string[] | POST/PATCH (deduped) | Full co-assignee team array |
| `status` | TaskStatus (see §2) | Actor-dependent | Terminal on approval; `overdue` never persisted |
| `points` | number | Creator | Base pool; split or duplicated per `pointDistributionMode` |
| `penaltyPoints` | number | Creator (optional) | Deducted from award if approved after deadline |
| `workflowBonusPoints` | number | Creator (optional) | Awarded to all workflow participants on final step |
| `report` | string | Any assignee | **Shared field** — one per task, not per submitter |
| `hoursWorked` | number | Any assignee | **Shared field** — last writer wins |
| `resourceLinks` | string | Any assignee | **Shared field** |
| `deliverableFiles` | array of {fileName, driveFileId, downloadUrl, sizeBytes, contentType} | QR submit page attempts it | **Broken**: in `ASSIGNEE_SAFE_FIELDS` but REJECTED by the strict zod update schema (400 "Unrecognized key"). Never in `Task` interface |
| `deadline` | Timestamp | Creator | Hard deadline; `individualDeadline` wins for workflow steps |
| `individualDeadline` | Timestamp (nullable) | Creator/edit | Per-step deadline; takes precedence for on-time/penalty math |
| `workflowId` | string (nullable) | Creator | — |
| `sequenceIndex` | number | Creator | 1-based; drives auto-handoff of next step |
| `dependsOnTaskId` | string (nullable) | Creator | — |
| `role` | string (nullable) | Creator | Intended role for assignee |
| `releasedAt` | Timestamp (nullable) | System (auto-handoff) | Next step released when previous completes |
| `isCurrentStep` | boolean | System | Set false on completion; set true on the handoff target |
| `startedAt` | Timestamp | System | Stamped on first transition to `in-progress` |
| `completedAt` | Timestamp (server) | `executeGamificationTransaction` | Server time; compared to deadline for on-time/penalty |
| `createdAt` / `updatedAt` | Timestamps (server) | System | — |
| `feedback_history` | array of {admin_id, timestamp, text, previous_status} | System on `changes-requested` | Flat `feedback_text` input is consumed and deleted; only history persists |
| `delegation` | TaskDelegation (see task-types.ts) | Assignee + delegatee | Points-as-currency split (pointsKept/pointsShared); must be accepted |
| `completionBadgeId` | string (nullable) | Creator | Awarded to all paid assignees (+ delegatee) on completion |
| `stepSpecificBadgeId` | string | Creator (workflow step) | Awarded on step completion |
| `finalWorkflowCompletionBadgeId` | string (nullable) | Creator | Awarded to all participants on final step |
| `resources` | array of {type, url, title} | Creator | Link-based logistics |
| `guidance` | {description, steps[], estimatedTime?} | Creator | — |
| `projectId` | string (nullable) | Creator | — |
| `workflowParticipantIds` | string[] | POST | Assignee + assigner + explicit participants |
| `chapterId` | string (nullable) | Creator (task-form) | Chapter scoping for assignment |
| `assignmentType` | 'individual' \| 'collective' | Creator (rarely used) | 'collective' routes points to chapter doc, not users |
| `pointDistributionMode` | 'split' \| 'duplicate' (default) | Creator | 'split' = base/assignees each; 'duplicate' = full base each |
| `reminderSent24h` | boolean | Cron | Deadline reminder bookkeeping |
| `workflowTitle`, `workflowTags`, `workflowPriority`, `estimatedDuration`, `workflowMetadata` | various | Creator | Phase-3 workflow enrichment |
| `parentTaskId`, `isSubTask`, `subTaskCount`, `subTaskCompletedCount` | various | Creator/system | Sub-task delegation roll-up (note: gamification tx reads legacy `parent_task_id` / `parentData.completion_bonus_points`) |
| `startedAt` | Timestamp | System | First `in-progress` transition |

### Zod schemas in `src/app/api/tasks/route.ts`

**POST `TaskCreateSchema`** — title, description, points, deadline (required); status (default `pending`); workflowTitle, individualDeadline, isCurrentStep, workflowParticipantIds, projectId, completionBadgeId, workflowId, sequenceIndex, dependsOnTaskId, role, releasedAt, assigneeId, assigneeIds, report, resources[]. One Firestore doc is created **per final assignee**, each carrying the full deduped `assigneeIds` array and `assigneeId` = that doc's assignee.

**PATCH/PUT `TaskUpdateSchema`** — `{ taskId, lastUpdatedAt?, updates }` where `updates` is a **`.strict()`** object allowing exactly: `status, title, description, deadline, individualDeadline, hoursWorked, report, feedback_text, resourceLinks, assigneeId, assigneeIds, completionBadgeId, projectId, points, penaltyPoints, workflowBonusPoints, guidance, finalWorkflowCompletionBadgeId, resources[]`. Anything else → **400**.

### Approval-specific fields — what exists and what does NOT

| Field | Status |
|---|---|
| `completedAt` | ✅ stamped server-side on approval |
| `feedback_history[]` | ✅ admin id + timestamp + text on `changes-requested` |
| `penaltyPoints` / penalty applied | ✅ in gamification tx + `points_ledger` |
| **`submittedBy` / `submittedAt`** | ❌ **DO NOT EXIST anywhere on task docs** (verified: only appear in unrelated bug-report/chapter-application/form-response features) |
| **`approvedBy` / `approvedAt`** | ❌ **DO NOT EXIST.** The approver's uid is recorded only inside the `points_ledger` entry? No — not even there. The only trace is the `tasks/{id}/activity` subcollection entry `{type:'approval', userId: actorUid}` written inside the gamification transaction, plus the actor uid passed into `executeGamificationTransaction` |
| `rejectionReason` | ❌ **DO NOT EXIST.** Rejection = `changes-requested` with mandatory `feedback_text` → appended to `feedback_history` and the flat text deleted. A hard reject back to `in-progress` (admin tasks page `requestRevisions`) carries **no reason field at all** |

---

## 2. Status Lifecycle

### 2.1 The status set

- **API zod enum** (`TaskStatusEnum`, POST + PATCH): `'pending' | 'in-progress' | 'submitted-for-review' | 'changes-requested' | 'approved' | 'completed' | 'overdue'`
- **Shared TS type** (`src/lib/task-types.ts` `TaskStatus`): only `'pending' | 'in-progress' | 'submitted-for-review' | 'completed' | 'overdue'` — `changes-requested` and `approved` are API-only, invisible to the TS interface.
- **`overdue` is never persisted**: the PATCH handler explicitly deletes it (`"overdue" is a calculated display status`); client code computes it as `isOverdue && status not in (completed, submitted-for-review)` and keeps the real status in `actualStatus` (team-tasks.tsx:492-494, admin/tasks/page.tsx:1264).

### 2.2 Lifecycle diagram (actor → transition → file)

```
pending ──(assignee)──▶ in-progress ──(assignee)──▶ submitted-for-review
   │                          ▲                              │
   │                          │                              ▼
   │            (assignee, recall)               ┌─── (manager) ──▶ changes-requested ──(assignee)──▶ in-progress
   │                          │                 │        (task-detail-dialog.tsx:handleRequestRevision;
   ▼                          │                 │         route.ts requires feedback_text, appends feedback_history)
(creator sets on create)       │                 │
   │                          │                 └─── (manager, admin console) ──▶ in-progress   [reason-less]
   │                          │                         (admin/tasks/page.tsx:requestRevisions — no feedback captured)
   │                          │                              │
   └──────────────────────────┘                              ▼
                                                    (manager, approves) ──▶ completed / approved
                                                            (admin/tasks/page.tsx:approveTask → {status:'completed'};
                                                             task-detail-dialog.tsx:handleApprove → {status:'completed'};
                                                             route.ts ALSO accepts 'approved'; gamification tx treats both identically,
                                                             stamps status: updatesToApply.status==='approved' ? 'approved' : 'completed')
```

**Who sets each status:**

| Status | Set by | Enforced how |
|---|---|---|
| `pending` | Creator on POST (default); manager edits | — |
| `in-progress` | Any assignee (self-start); manager (revise without reason); assignee recall | Assignee may set via PATCH (field auth); server stamps `startedAt` on first transition (route.ts: ~line 555) |
| `submitted-for-review` | Any assignee (their own uid must be in `assigneeIds`) | PATCH; notify assigner via in-app + email (`task_submitted_for_review`) — note: notification goes only to `taskBefore.assignerId`, not to other co-assignees |
| `changes-requested` | Manager (role/claims/hierarchy/assigner) | Server mandates non-empty `feedback_text`; appends to `feedback_history`, deletes flat text. Manager UI: task-detail-dialog.tsx only. Admin console `requestRevisions` does NOT use this — it goes straight to `in-progress` with no feedback |
| `completed` | Manager (role/claims/hierarchy-above-any-assignee/assigner) | **403 for non-managers.** Triggers the gamification transaction (§4). Idempotent: tx throws if already completed/approved |
| `approved` | Manager (same gate as `completed`) | Same gate + same transaction; only differs in the final stored status string. Rarely used by UI (all current UIs send `completed`) |
| `overdue` | Nobody (display-only) | Deleted by server if sent; computed client-side |

**Authorization summary (route.ts PATCH):** `canManage` = custom claims (`manageTasks`/`canManageTasks`) → `roles/{uid}.role` → `isManagerAbove(caller, anyAssigneeId)` hierarchy check → original `assignerId`. Non-managers who are in `assigneeIds` are limited to `ASSIGNEE_SAFE_FIELDS` = `{status, hoursWorked, report, resourceLinks, feedback_text, deliverableFiles}` — but note `deliverableFiles` fails the strict zod gate before field-auth runs. Firestore rules themselves only allow task writes for superAdmin/`canManageTasks` — **all assignee writes go through the API, not direct Firestore writes** (the live `onSnapshot` in task-detail-dialog is read-only).

---

## 3. Co-assignee interaction with submission today (Maira + Huzaifah model)

**Task 02 shape:** 3 step-task docs, each with `assigneeIds = [mairaUid, huzaifahUid]`, `assigneeId = mairaUid` (primary). Findings apply to any co-assigned task:

1. **Both see everything.** `isAssignee = assigneeIds.includes(uid)` — Huzaifah gets the same submit/report UI as Maira (task-detail-dialog.tsx:170-172; QR submit route.ts allows `isAssignee || isManagerAbove`). His QR opens the same step's submit page, pre-filled with the shared `report`/`hoursWorked`/`resourceLinks`.

2. **Shared single-copy fields — last writer wins:**
   - `report` (string), `hoursWorked` (number), `resourceLinks` (string), `status` (string) live **once per task doc**. If Maira submits a report and Huzaifah later submits his own (or edits), **Huzaifah overwrites Maira's report entirely** — no merge, no per-person history.
   - **No `submittedBy`/`submittedAt` exists**, so the doc cannot tell who submitted what. Only `tasks/{id}/activity` subcollection entries (`type: 'progress' | 'hours' | 'status'`, each with `userId`) record *who* changed *what* — Huzaifah's overwrite leaves Maira's original report text only in the activity summary (first 200 chars, truncated), not recoverable in full.

3. **Yes — overwrite is possible and unrestricted.** Field-level auth lets any co-assignee write the safe fields. There is optimistic concurrency (`lastUpdatedAt` → 409) on the detail dialog, but the QR submit page does NOT send `lastUpdatedAt`, so its submissions never conflict — silent overwrite.

4. **Visibility on submit:** when anyone submits (`submitted-for-review`), only the **assigner** is notified (`route.ts` "Submitted for review → notify the assigner/manager"). Huzaifah receives **no notification** that Maira submitted, unless he reads the task. (Known limitation: "12 co-assignee visibility gaps" — memory note from 2026-10-04 workflow-edit fix.)

5. **Double-approval is safe; double-points partially so.** The gamification tx throws if status is already completed/approved (idempotent status), and the `points_ledger` has a per-(task,user,COMPLETION) double-dipping lock; re-approval of an already-paid task throws. **Caveat:** points are paid to **every uid in `assigneeIds`** (duplicate mode: full base points each; split mode: floor(base/n) each) — the model cannot distinguish doer from oversight: Maira and Huzaifah earn the same completion points.

6. **Recall:** any assignee can recall a submission back to `in-progress` (`handleRecallSubmission`) — including a co-assignee recalling the *other* person's submission.

---

## 4. Points/penalty award — the trigger point

**Single trigger:** `src/app/api/tasks/route.ts` → PATCH/PUT `handleUpdate` detects
`transitionedToCompleted = before ∉ {completed, approved} && after ∈ {completed, approved} && canManage`,
then calls **`executeGamificationTransaction(taskId, updatesToApply, taskBefore, decoded.uid)`** (`src/lib/server/gamification-transaction.ts`, 419 lines). Failure → writes a `dlq_points_retry` doc (`action: 'gamification_tx_failed'`, `status: 'PENDING_RETRY'`).

**What the transaction does (single Firestore transaction, reads-first then writes):**

1. Re-reads task; throws if already completed/approved (idempotent).
2. Resolves assignees from `assigneeIds` (fallback `assigneeId`).
3. **Deadline/penalty math:** `deadlineDate = individualDeadline ?? deadline`; `completedAt = now (server)`; `onTime = now ≤ deadlineDate`; `penaltyToApply = late && penaltyPoints>0 ? penaltyPoints : 0`.
4. **Stamps task:** `completedAt`, `updatedAt`, `isCurrentStep: false`, `status: 'completed'|'approved'`.
5. **Per unpaid assignee** (checked against `points_ledger` where task_id+user_id+COMPLETION — already-paid assignees are skipped, others still paid):
   - `finalPoints = max(0, (delegation ? pointsKept : pointsToAward) − penaltyToApply)` where `pointsToAward = distributionMode==='split' ? floor(base/n) : base`.
   - `users/{uid}`: `tasksCompletedCount +1`, `tasksAssignedCount −1`, `tasksCompletedOnTimeCount` or `tasksCompletedLateCount` +1, `total_points` & `points` += finalPoints, `totalHoursWorked` += hoursWorked.
   - `points_ledger` entry: `{user_id, task_id, reason: task_completion[_delegator|_delegatee|_penalty], action: COMPLETION|PENALTY, points_awarded, points_before_penalty, penalty_applied, completed_late, timestamp, status: PROCESSED}`.
   - Badges: `completionBadgeId`, `stepSpecificBadgeId` via arrayUnion.
   - `submission_feedback` notification to each assignee (incl. penalty note).
6. **Delegation branch:** if `delegation.status === 'accepted'`, delegatee gets `pointsShared − penalty` with `task_completion_delegatee` ledger entry + notification.
7. **Collective mode** (`assignmentType === 'collective'`): points go to `chapters/{chapterId}` (`collective_score`, `tasks_completed`).
8. **Parent rollup** (legacy snake_case fields): if all siblings completed and parent has `completion_bonus_points`, parent → completed and bonus split to parent assignees (`COMPLETION_ROLLUP` ledger).
9. **Workflow auto-handoff:** if `workflowId` + `sequenceIndex`, next step gets `releasedAt: now`, `isCurrentStep: true`, and notifications (`task_assigned` to next assignee, `task_status_change` to participants). Else (final step): each participant gets `workflowBonusPoints` (default 10) + `WORKFLOW_BONUS` ledger + `finalWorkflowCompletionBadgeId`.
10. **Activity log:** `tasks/{id}/activity` entry `{type:'approval', userId: actorUid, data:{action:'approved', previousStatus}}`.

**Approver attribution today:** the approver uid appears **only** as `userId` on that single activity-log entry (and in server logs). It is NOT on the task doc, NOT in the ledger entries.

---

## 5. SubmittedBy / SubmittedAt tracking — gap analysis

| Question | Answer |
|---|---|
| Is there a `submittedBy` field on tasks? | **No.** |
| Is there a `submittedAt` field on tasks? | **No.** |
| Is there `approvedBy`/`approvedAt`? | **No** (only server-stamped `completedAt`). |
| Is there a `rejectionReason`? | **No.** Rejections use `changes-requested` + mandatory `feedback_text`, persisted only inside `feedback_history[]` entries `{admin_id, timestamp, text, previous_status}`. |
| How is "who submitted" reconstructable today? | Only via `tasks/{taskId}/activity` subcollection: entries of type `status` (`{from, to, userId}`), `progress` (200-char summary, `userId`), `hours` (`{from, to, userId}`), all with server timestamps. The submitter's uid is there, but full report text is not preserved on overwrite, and nothing joins submitter → submission on the task doc. |
| How is "who approved" reconstructable? | Only via the single `activity` entry `{type:'approval', userId: actorUid}` written inside the gamification transaction. |

### Gaps relevant to hierarchical validation

1. **No per-submitter submission record** — with co-assignees, "Maira submitted" vs "Huzaifah submitted" is indistinguishable on the task doc; overwrite is silent. A validation model that needs doer-vs-oversight sign-off (e.g., Huzaifah *verifies* Maira's work before it goes to the manager) cannot be expressed: any co-assignee can flip `status` to `submitted-for-review` or `completed`-blocking states, and the shared `report`/`hoursWorked` fields are a single copy.
2. **No `approvedBy` on the doc** — approval attribution lives only in the activity subcollection.
3. **Schema/API mismatch on `deliverableFiles`** — the QR submit page uploads files and sends `updates.deliverableFiles`, but the strict PATCH zod schema rejects it (400). The `Task` interface also omits it. Deliverable files from the QR flow currently fail to persist (field-auth whitelist intends to allow it).
4. **`changes-requested` bypass** — the admin console's `requestRevisions` sends plain `in-progress` with no feedback, so the mandatory-feedback invariant exists only in the API handler's `changes-requested` branch, not in all manager UI paths.
5. **`approved` vs `completed`** — both accepted by the API and both trigger the identical transaction; UIs exclusively use `completed`. `TaskStatus` TS type doesn't include `approved` or `changes-requested`, so client code branching on status must use casts/strings.
