# 03 — Submit API: technical trace of the TRANSMIT flow

Source files:
- `src/components/profile/assigned-tasks.tsx` (client: `handleQuickAction`, `handleFullUpdate`, `handleRecall`)
- `src/app/api/tasks/route.ts` (server: `handleUpdate`, used by both PATCH and PUT)

---

## 1. What the client sends

### `handleQuickAction` — the big TRANSMIT button on the collapsed task card

```
PATCH /api/tasks
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "taskId": "<task-id>",
  "updates": {
    "status": "submitted-for-review",
    "report": "Objective reached. Direct Transmit."
  }
}
```

Notes:
- The `report` is a hardcoded string. A quick-action transmit carries **no actual
  work product** — no files, no written summary. The real deliverable only exists
  if the user opened the expanded card and filled the Execution Log.
- Auth is a Firebase ID token minted client-side at click time.

### `handleFullUpdate` — the expanded card's TRANSMIT FOR REVIEW / SUBMIT SITREP

```
PATCH /api/tasks
Authorization: Bearer <firebase-id-token>

{
  "taskId": "<task-id>",
  "updates": {
    "status": "<inlineStatus>",        // from segmented pills: pending | in-progress | submitted-for-review
    "report": "<inlineReport>",        // Execution Log textarea
    "hoursWorked": <number|undefined>  // Hours stepper
  }
}
```

The button label changes with the pill selection: picking "Transmit" shows
"TRANSMIT FOR REVIEW", otherwise "SUBMIT SITREP".

### `handleRecall` — undo a submission

```
PATCH /api/tasks
{ "taskId": "<task-id>", "updates": { "status": "in-progress" } }
```

Available when the task is already `submitted-for-review`. Puts it back to Active.

---

## 2. Status transition

`pending` / `in-progress` → **`submitted-for-review`**

That is the only status the submit buttons can set. Approval happens later by a
reviewer (`approved` / `completed` / `changes-requested`), never by the submitter.

---

## 3. Client success vs failure handling

### `handleQuickAction`
| Case | What the user sees |
|---|---|
| Network + server OK | Green check, `toast.success("Mission Success Transmitted!")`, confetti burst, list refreshes after 1.5s |
| Server returns 4xx/5xx | **Same success UI.** The handler never checks `res.ok` — it fires confetti on any HTTP response. |
| Network throws (offline, timeout) | **Nothing.** The catch block only resets the spinner. No error toast at all. |

### `handleFullUpdate`
| Case | What the user sees |
|---|---|
| `res.ok` | `toast.success("Operational Log Saved.")`, list refreshes after 1.5s |
| Any failure | `toast.error("Fail.")` — generic, no reason given |

So the expanded form at least tells the user something failed, but never says
why (auth? validation? conflict? server down?). The quick button is worse: it
celebrates on failure.

---

## 4. Server PATCH handler (`handleUpdate`)

### Authentication
Firebase ID token verified with the Admin SDK. Missing/invalid token → 401.
No token, no write. Period.

### Request validation (zod, strict)
- `taskId` required, non-empty string.
- `updates` is a strict object — unknown fields are rejected with 400.
- `status` must be one of: `pending`, `in-progress`, `submitted-for-review`,
  `changes-requested`, `approved`, `completed`, `overdue`.
- `overdue` is silently stripped (it is a calculated display status, never persisted).
- `changes-requested` requires non-empty `feedback_text`, else 400.
- Optimistic concurrency: if the client sends `lastUpdatedAt` and it does not
  match the server's `updatedAt`, the request fails with **409 Conflict**.

### Authorization — can anyone submit anyone's task?
**No.** The rules, in order:

1. **Managers** (`canManageTasks` via claims/role, anyone above an assignee in the
   reporting hierarchy, or the original assigner) may update anything.
2. **Non-managers must be an assignee.** The server reads the task's
   `assigneeIds`/`assigneeId` from Firestore (never trusts the client) and
   returns **403 "you are not assigned to this task"** otherwise.
3. **Assignees are field-restricted.** They may only touch:
   `status`, `hoursWorked`, `report`, `resourceLinks`, `feedback_text`,
   `deliverableFiles`. Any other field → 403.
4. **Decision statuses** (`completed`, `approved`, `changes-requested`) additionally
   require hierarchical validation: the caller must be above the submitter in the
   reporting chain, the assigner, or a task manager. **Self-approval is always
   denied** (403), even for managers.

So a transmit (`submitted-for-review`) is allowed for the assignee themselves;
approving it is not.

### What the server does on a transmit (all server-side, client cannot spoof)
- Stamps `submittedBy` = caller uid and `submittedAt` = server timestamp.
- Clears any previous `approvedBy`/`rejectedBy` stamps (resubmission resets decisions).
- Always stamps `updatedAt` with server time.
- Writes an activity log entry (`status` change, from → to).
- **Notifications (all non-blocking, wrapped in try/catch):**
  - In-app notification + email attempt to the assigner/manager.
  - Fan-out in-app notification to everyone in the validator chain above the submitter.
  - If any notification fails, the submission still succeeds — the user is never told.
- Commits via a single Firestore batch. On batch failure → 500 and a DLQ retry record.

### Success response
```json
{ "ok": true, "taskId": "...", "taskBefore": {...}, "taskAfter": {...}, ... }
```

---

## 5. What guarantees a submission went through

1. The API returned HTTP 200 with `"ok": true` **and** `taskAfter.status ===
   "submitted-for-review"`.
2. The task card flips to the amber "IN REVIEW" / "Transmit" state after the
   1.5s refresh.
3. The reviewer sees the task in their profile validation queue.

Everything else (toasts, confetti) is cosmetic.

## 6. What can silently fail

1. **`handleQuickAction` celebrates on HTTP errors.** It never checks `res.ok`.
   A 403 (not the assignee), 401 (expired token), 400 (bad payload), or 500
   still triggers "Mission Success Transmitted!" + confetti. This is the single
   most dangerous gap: a user can believe they submitted when nothing happened.
2. **Network failures on quick action are invisible.** No toast, no message —
   the button just stops spinning.
3. **`handleFullUpdate` says only "Fail."** A 409 conflict (someone else edited
   the task), a 403, or a 500 all look identical. The user cannot self-diagnose.
4. **Notifications are fire-and-forget.** If the assigner email or validator
   fan-out fails, nobody is told. The submission exists but the reviewer may
   never notice it (mitigated by the profile validation queue, which is a pull
   model and does not depend on notifications).
5. **Quick transmit carries no deliverable.** The hardcoded report string means a
   reviewer opening a quick-transmitted task sees "Objective reached. Direct
   Transmit." with no files or summary unless the user used the expanded form.
6. **Deadline display is fine.** The profile normalizes
   `individualDeadline || deadline` into the card's `deadline` field, so workflow
   step deadlines render on the countdown. No gap here.
