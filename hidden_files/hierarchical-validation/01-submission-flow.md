# Task Submission & Approval Flow — Current State (2026-10-04)

Branch: `feat/remediation-harness-complete`. Read-only research; no code modified.

## 1. Status lifecycle values

Persisted statuses come from two enums that do **not** fully agree:

- **Server schema** (`src/app/api/tasks/route.ts:258`): `z.enum(['pending', 'in-progress', 'submitted-for-review', 'changes-requested', 'approved', 'completed', 'overdue'])`
- **Canonical type** (`src/lib/task-types.ts:74`): `TaskStatus = 'pending' | 'in-progress' | 'submitted-for-review' | 'completed' | 'overdue'` — no `'approved'` or `'changes-requested'`

**Rules at the server (`src/app/api/tasks/route.ts:377-403`):**
- `'overdue'` is **never persisted** — the server deletes it; it's a display-only computed status (`admin/tasks/page.tsx:1258-1264`, `team-tasks.tsx` `actualStatus` pattern).
- `'completed'` or `'approved'` → **403 for non-managers**: `"Forbidden: only admins can mark tasks as completed"`.
- `'changes-requested'` requires non-empty `feedback_text` (400 otherwise); the text is archived into `feedback_history` (arrayUnion with `{admin_id, timestamp, text, previous_status}`) and the flat field is deleted.
- Approval in practice always uses **`completed`** (never `approved`): both admin UIs PATCH `status: 'completed'`.

### Status transition table

| From → To | Who | How |
|---|---|---|
| `pending` → `in-progress` | Assignee (also manager) | Select "ACTIVE (IN PROGRESS)" in Task Detail Dialog, inline card, or public submit page (`forReview=false`) |
| `in-progress` → `submitted-for-review` | Assignee | "SUBMIT INTELLIGENCE (REVIEW)" / "Transmit for review" |
| `submitted-for-review` → `completed` | **Manager only** | "Approve Mission" / "Approve" buttons |
| `submitted-for-review` → `changes-requested` | **Manager only** | "Request Revision" + mandatory feedback text |
| `changes-requested` → `in-progress` | Assignee | Re-submits work after seeing `feedback_history` |
| `submitted-for-review` → `in-progress` (recall) | Assignee | "Recall submission" button |
| `pending` ↔ `in-progress` (manager) | Manager | Status selects on profile pages / admin table |

No `rejected` state exists. `approved` is accepted by the schema and treated like `completed` in the gamification trigger but is never produced by any UI.

## 2. Submission by assignees — components and fields

All submission paths PATCH **`/api/tasks`** with `{ taskId, updates: { status: 'submitted-for-review', ...workProduct } }`. Assignees (non-`canManage`) are limited to the `ASSIGNEE_SAFE_FIELDS` set: `status`, `hoursWorked`, `report`, `resourceLinks`, `feedback_text`, `deliverableFiles` (`src/app/api/tasks/route.ts:422`).

| Surface | File | Lines | Fields set |
|---|---|---|---|
| **Task Detail Dialog** (profile "My Tasks" + admin views) | `src/components/profile/task-detail-dialog.tsx` | `handleUpdateMission` (266-291): builds `updates = { status, hoursWorked?, report?, resourceLinks? }`; status options `pending` / `in-progress` / `submitted-for-review` (Select, 692-701) | `status`, `hoursWorked` (number, step 0.5), `report` (SITREP textarea), `resourceLinks` (artifact links textarea) |
| **Mission card inline** (quick submit on the profile task card) | `src/components/profile/assigned-tasks.tsx` | 495-562: "TRANSMIT FOR REVIEW" inline button; `handleInlineUpdate`-style quick transmit at 275 sends `{ status: 'submitted-for-review', report: 'Objective reached. Direct Transmit.' }` | `status` + default report |
| **Task card inline** | `src/components/profile/mission-card.tsx` | `handleInlineUpdate` (71+); `ExpandedContent` + `SubmitButton` (314-347) | `status`, inline report/hours/links |
| **Public QR submit page** (logged-in, linked from workflow PDF per-step QR) | `src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx` | `handleTransmit(forReview)` (99-136): `status: forReview ? 'submitted-for-review' : 'in-progress'`; sets `report`, `hoursWorked`, `resourceLinks`, **`deliverableFiles`** (array of `{fileName, driveFileId, downloadUrl, sizeBytes, contentType}` from Drive uploads) | `status`, `report`, `hoursWorked`, `resourceLinks`, `deliverableFiles` — the only surface that sets `deliverableFiles` |
| **Recall** | `task-detail-dialog.tsx` | `handleRecallSubmission` (294-312): PATCH `{ status: 'in-progress' }` while in `submitted-for-review` | `status` only |

While awaiting review, the assignee sees a locked "Transmitted — awaiting review" panel with a **Recall submission** option (task-detail-dialog.tsx:722-738).

**Side effect on submit** (`src/app/api/tasks/route.ts:561-595`): on transition to `submitted-for-review`, the server creates a `task_status_change` notification to the **assigner** (`assignerId` field, falling back to `createdBy`) with an email (`emailTemplate: 'task_submitted_for_review'`) — skipped if the submitter is the assigner.

## 3. Approval / validation — where and how

### UI surfaces that approve

| Surface | File | Lines | Behavior |
|---|---|---|---|
| **Admin tasks table** (the "awaiting approval" queue) | `src/app/admin/tasks/page.tsx` | `approveTask` (483-513): PATCH `{ status: 'completed' }`; `requestRevisions` (515+): PATCH `{ status: 'changes-requested', feedback_text }`. Row action buttons (1305-1313) render **only when `status === 'submitted-for-review'`**; "Submitted for Review" violet badge on title (1186-1190) | Approves → `completed`, triggers points/badge via gamification transaction |
| **Task Detail Dialog — manager view** | `src/components/profile/task-detail-dialog.tsx` | `handleApprove` (333-349): PATCH `{ status: 'completed' }`; `handleRequestRevision` (351-368): PATCH `{ status: 'changes-requested', feedback_text }`. Manager Controls block (661-670) renders only `isManager && status === 'submitted-for-review'`; "AWAITING REVIEW" banner with "Review Now" (388-397) | Same transitions |
| **Manager profile views** | `src/components/profile/team-tasks.tsx` (`isManager={true}`, line 646), `assigned-tasks.tsx` (`isManager={isOwner \|\| isAdmin}`, line 851) | Kanban/list status Selects (`handleStatusChange`, 275-291) let managers move any task to any status incl. `completed`; cards in `submitted-for-review` get `ring-amber` + "Review needed" badge (493-510) | Review queue for the manager's team |
| Mission Command dashboard | `src/app/admin/mission-command/page.tsx` | 28, 166-180 | Read-only display; treats `submitted-for-review` as 95% |

> **Review queues today:** there is **no single dedicated "pending approvals" page**. The queues are: (a) the admin tasks table rows filtered/highlighted at `submitted-for-review` with inline Approve/Request Revisions buttons; (b) `team-tasks.tsx` on a manager's profile (amber "Review needed" badges, review status filter); (c) the "AWAITING REVIEW" banner inside `TaskDetailDialog` for managers.

### Current approval authorization logic (server)

`src/app/api/tasks/route.ts`, `handleUpdate` (lines 241-318):

```ts
// 1. Custom claims
let canManage = !!(
  (claims.permissions && claims.permissions.manageTasks === true) ||
  claims.manageTasks === true ||
  claims.canManageTasks === true
);
// 2. Role lookup fallback
if (!canManage) {
  const roleSnap = await db.collection('roles').doc(claims.uid).get();
  const role = roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
  canManage = await hasServerPermission(role, 'canManageTasks');
}
// ...
// 3. HIERARCHY-AWARE REVIEW (lines 300-318): caller above ANY assignee in
//    reporting_relationships → canManage
if (!canManage) {
  const beforeIds: string[] = /* assigneeIds or assigneeId */;
  try {
    for (const aid of beforeIds) {
      const callerIsAbove = await isManagerAbove(decoded.uid, aid);
      if (callerIsAbove) { canManage = true; break; }
    }
  } catch (e) { /* non-blocking */ }
}
// 4. Original assigner always manages their own tasks
if (!canManage && (taskBefore as any).assignerId === decoded.uid) {
  canManage = true;
}
```

Then (lines 385-387):

```ts
} else if ((updatesToApply.status === 'completed' || updatesToApply.status === 'approved') && !canManage) {
  return NextResponse.json({ error: 'Forbidden: only admins can mark tasks as completed' }, { status: 403 });
}
```

**So approval is NOT assigner-only.** It is granted to anyone who satisfies **any one** of:
1. Custom claim `permissions.manageTasks === true` (or `manageTasks`/`canManageTasks` claim);
2. Firestore `roles/{uid}.role` resolving `canManageTasks` via `hasServerPermission`;
3. **Hierarchy**: `isManagerAbove(callerUid, assigneeUid)` (`src/lib/server/hierarchy-utils.ts:17` — BFS walk up `reporting_relationships`) true for **any** assignee (doer or co-assignee/oversight) — "any manager above the task assignees can review/approve/reject";
4. **Original assigner**: `task.assignerId === callerUid` — always allowed.

**What happens on approval** (`src/app/api/tasks/route.ts:503-517`): if transition to `completed`/`approved` and `canManage`, `executeGamificationTransaction(taskId, updatesToApply, taskBefore, decoded.uid)` (`src/lib/server/gamification-transaction.ts:3`) runs an idempotent Firestore transaction: stamps `completedAt`, computes on-time vs deadline, awards points (split/duplicate across assignees per `pointDistributionMode`), applies late penalties (from the 2026-10-03 deadline-penalty engine), increments `tasksCompletedCount`/`tasksCompletedOnTimeCount`, and awards `completionBadgeId`. Non-manager "completions" can't reach this path (403 above).

### Notable gaps (observation, not a recommendation)

- **Anyone "above" an assignee — including a co-assignee who happens to be managerial — can approve**, not just the assigner. The in-loop VP (oversight co-assignee) can approve via path 3 only if the hierarchy walk puts them above the doer.
- `approveTask` in admin/tasks sends `completed` directly with no dialog/confirmation; `handleStatusChange` selects in team-tasks also allow a manager to jump straight `pending → completed` without review.
- `assigned-tasks.tsx:851` grants `isManager` (thus the approve buttons in the dialog) to the **profile owner** (`isOwner`) as well as admins — on one's own profile, the assignee sees manager controls, but the server still 403s their approval attempt unless they're the assigner / above the assignee / have the claim (they're the assignee themselves, so normally 403).
- `isManagerAbove` failure is **non-blocking** (catch → continue without granting), so a broken `reporting_relationships` graph silently narrows approvers to claims/roles/assigner.
- No notification is sent on approval/rejection to the assignee from the admin table path (`approveTask` only toasts the approver); the gamification transaction module "now handles" completed notifications per the comment at route.ts:594, while submission notifications do fire to the assigner.
