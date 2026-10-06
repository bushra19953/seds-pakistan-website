# SWARM-A1: What PATCH /api/tasks stores on submit

Agent A1 (Group A). Investigation only, no code changes.
Date: 2026-10-06. Repo branch: feat/remediation-harness-complete.

## 1. The handler

PATCH /api/tasks is a thin alias. Both PATCH and PUT call the same shared
`handleUpdate` in `src/app/api/tasks/route.ts` (line ~205 onward; the file is
large, the update logic lives in `handleUpdate`).

Pipeline for every update:
1. Bearer token auth via `verifyIdTokenString`.
2. Payload validated against `TaskUpdateSchema` (zod, `.strict()`).
3. Task loaded from `tasks/{taskId}` BEFORE and AFTER to detect transitions.
4. Normalization (deadline strings to Date, dedupe assigneeIds, explicit nulls
   treated as "leave untouched").
5. Server-side stamps added.
6. One Firestore batch write + activity logging.

## 2. Exact schema of what the API accepts on update

`updates` must be an object whose keys are ALL within this allowlist. The
schema is `.strict()`, so any unknown key makes the WHOLE request fail with
400 "Invalid request". There is no silent dropping of unknown fields.

```
status:               enum['pending','in-progress','submitted-for-review',
                           'changes-requested','approved','completed','overdue']
title:                string
description:          string
deadline:             string | number | Date
individualDeadline:   string | number | Date
hoursWorked:          number
report:               string
feedback_text:        string          (transient, see below)
resourceLinks:        string          (newline-separated URLs, plain text)
deliverableFiles:     array of { fileName?, driveFileId?, downloadUrl (req),
                                 sizeBytes?, contentType? }
assigneeId:           string
assigneeIds:         array of string
completionBadgeId:   string | null
projectId:            string | null
points:               number
penaltyPoints:        number
workflowBonusPoints:  number
guidance:            string
finalWorkflowCompletionBadgeId: string | null
resources:           array of { type: enum['link','drive','github','doc',
                                  'video','other'], url, title }
```

Fields that DO NOT EXIST in the schema: `executionLog`, `attachments`,
`proofLinks`, `photos`, `submissionNotes`, `evidence`, `comments`. A grep
confirms `executionLog` appears nowhere in src/, and no profile/app component
references `attachments` or `proofLinks`. So the frontend never sends them,
and if a client ever tried, the strict schema would 400 the entire request
rather than ignore the field.

## 3. What is written to Firestore on transition to submitted-for-review

When `beforeStatus !== 'submitted-for-review'` and the update sets
`status: 'submitted-for-review'` (the `transitionedToSubmitted` block), the
server ADDS these fields itself (after the field-level auth check, so they
never trip the assignee safe-field gate):

- `submittedBy` = authenticated caller's uid (string, from the verified ID
  token, NOT from client input)
- `submittedAt` = `admin.firestore.Timestamp.now()` (Firestore Timestamp,
  server time)
- `approvedBy` = DELETED (FieldValue.delete)
- `approvedAt` = DELETED
- `rejectedBy` = DELETED
- `rejectedAt` = DELETED
  (a resubmission clears prior decision stamps)
- `updatedAt` = `admin.firestore.Timestamp.now()` (set on every update)

Everything else persisted is exactly what the client sent in `updates`:
`report`, `hoursWorked`, `resourceLinks`, `deliverableFiles`, `status`.

So a submit writes, at most: `status`, `report`, `hoursWorked`,
`resourceLinks`, `deliverableFiles`, `submittedBy`, `submittedAt`,
`updatedAt`. There are no hidden "submission content" fields anywhere else.

## 4. Fields the server transforms or removes (never dropped silently)

- `status: 'overdue'` is deleted before write. Overdue is a calculated
  display status and is never persisted.
- `feedback_text` (only used on `changes-requested`) is mandatory and is
  folded into `feedback_history` via arrayUnion as
  `{ admin_id, timestamp, text, previous_status }`, then the flat
  `feedback_text` key is deleted. Not relevant to submissions.
- Explicit null for `projectId`, `completionBadgeId`,
  `finalWorkflowCompletionBadgeId` is treated as "leave untouched".
- `assigneeIds: []` (empty array) is deleted; non-empty is deduped and
  `assigneeId` is set to the first id for backward-compatible readers.

## 5. Field-level authorization: what an assignee may send

Non-managers (assignees submitting their own work) may only send keys in
`ASSIGNEE_SAFE_FIELDS`:

```
status, hoursWorked, report, resourceLinks, feedback_text, deliverableFiles
```

Any other key from a non-manager returns 403 "Forbidden: only task managers
may edit these fields". All submission content fields the clients send
(report, hoursWorked, resourceLinks, deliverableFiles) are in this safe set,
so a legitimate submit is never blocked or truncated by this gate.

## 6. What each frontend submit path actually sends

A. `assigned-tasks.tsx` handleQuickAction (the "TRANSMIT" quick button):
```json
{ "taskId": "...", "updates": {
    "status": "submitted-for-review",
    "report": "Objective reached. Direct Transmit."
} }
```
The report is a HARDCODED dummy string. No hoursWorked, no resourceLinks, no
deliverableFiles. A quick-transmit submit stores only status, the canned
report text, submittedBy, submittedAt, updatedAt.

B. `assigned-tasks.tsx` handleFullUpdate (the expanded editor save):
```json
{ "taskId": "...", "updates": {
    "status": inlineStatus,          // whatever status is selected in the UI
    "report": inlineReport,          // free text, may be ""
    "hoursWorked": parseFloat(inlineHours) || undefined   // omitted if empty
} }
```
No deliverableFiles, no resourceLinks, no photo upload field in this card.
Hours are only written if the user typed a number.

C. `task-detail-dialog.tsx` handleUpdateMission (dialog save):
```json
{ "taskId": "...", "updates": {
    "status": status,                                  // dialog status value
    "hoursWorked": parseFloat(hoursWorked) | omitted,
    "report": report | omitted,
    "resourceLinks": resourceLinks | omitted
} }
```
No deliverableFiles. Empty fields are omitted client-side.

D. `mission-card.tsx` inline save: sends status, report, hoursWorked,
resourceLinks (same four fields as C).

E. `app/missions/[workflowId]/submit/[stepIndex]/page.tsx` handleTransmit
(the QR-linked public submit page; the only full submit form):
```json
{ "taskId": "...", "updates": {
    "status": "submitted-for-review" | "in-progress",
    "report": "..." | omitted,
    "hoursWorked": number | omitted,
    "resourceLinks": "..." | omitted,
    "deliverableFiles": [ { fileName, driveFileId, downloadUrl, sizeBytes, contentType } ] | omitted
} }
```
This is the ONLY client that can attach files, via uploadedFiles mapped to
the `deliverableFiles` schema shape. Empty fields are omitted.

F. `team-tasks.tsx` line ~283 and `task-detail-dialog` handleRecall: send
`{ status }` only (status flips, no content).

## 7. Direct answers to the task questions

1. The PATCH handler is `handleUpdate` in src/app/api/tasks/route.ts.
2. On transition to submitted-for-review, the server writes exactly:
   `submittedBy` (uid string), `submittedAt` (Firestore Timestamp), deletes
   the four decision stamps, and sets `updatedAt`. Client-sent `report`,
   `hoursWorked`, `resourceLinks`, `deliverableFiles`, `status` are persisted
   verbatim.
3. Shapes:
   - `submittedBy`: string (Firebase uid)
   - `submittedAt`: Firestore Timestamp (server time)
   - `report`: string (free text)
   - `hoursWorked`: number
   - `resourceLinks`: string (newline-separated URLs)
   - `deliverableFiles`: array of { fileName?, driveFileId?, downloadUrl,
     sizeBytes?, contentType? }
4. The handler NEVER drops submission fields the client sends: the zod
   schema is strict, so unknown fields fail the whole request with 400
   instead of being ignored. Compared against all five frontend submit
   paths, every field any client sends (report, hoursWorked, resourceLinks,
   deliverableFiles, status) is accepted, within the assignee safe-field set,
   and persisted. The storage side is lossless for what is sent.

## 8. Why a submission can still LOOK empty

The API persists whatever the client sends, and the clients send very
little. The quick-transmit button (path A) sends only status plus a canned
report string; the detail dialog and cards (paths C, D) omit empty fields
entirely, so an assignee who hits "submit" without typing anything stores
no report, no hours, no links, and no files. Only the dedicated submit page
(path E) has fields for hours, links, and file uploads. If the reviewer
sees empty submissions in every read-only view, the first thing to verify
is WHICH client path each submitter used, not the API: the data genuinely
is not there. (Which of the three reviewed tasks used which path is a
data question for the Firestore check, Group B/C territory.)
