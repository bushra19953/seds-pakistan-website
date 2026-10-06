# VERIFY-09: View Submission Dialog Field Coverage (Worker 9)

Date: 2026-10-06. Investigation only — no code changes.

## Read path under test

1. Firestore `tasks/{id}` doc (raw; Workers 1–3 are reading these directly)
2. `GET /api/tasks` serializer → `src/app/api/tasks/route.ts` (~line 1271)
3. Admin "View Submission" dialog → `src/app/admin/tasks/page.tsx` (~line 1503)
   - Button gated to `task.status === 'submitted-for-review'` (line 1337), passes the
     table-row object (which came from the GET serializer) straight in:
     `setViewSubmissionTask(task)` (line 1339).

## Step 1 — Fields the DIALOG renders (page.tsx lines 1503–1578)

The dialog body reads exactly these task fields (via `t = viewSubmissionTask as any`):

| Field read in dialog code | Rendered section |
|---|---|
| `title` | DialogTitle ("Submission: {title}") |
| `submittedBy` (fallback `submittedById`) | "Submitted by" (resolved via usersMap; raw id; else "No submitter recorded") |
| `submittedAt` (fallback `updatedAt`, labeled honestly as "Updated at (no submission timestamp recorded)") | "Submitted at" (dd/MM/yyyy hh:mm a) |
| `hoursWorked` | "Hours worked" badge ("{hours}h" or "No hours logged") |
| `report` | "Report" block (whitespace-pre-wrap, or "No report submitted") |
| `resourceLinks` (string split on `\n`, or string array) | "Deliverable links" (clickable anchors, or "No deliverable links submitted") |

That is the full list. The dialog reads nothing else.

## Step 2 — Fields the API SERIALIZER includes (route.ts lines 1271–1294)

```js
return {
  id: d.id,
  ...data,                       // <-- full Firestore doc spread: nothing dropped
  deadline: serializeTs(data.deadline),
  individualDeadline: serializeTs(data.individualDeadline),
  createdAt: serializeTs(data.createdAt),
  updatedAt: serializeTs(data.updatedAt),
  completedAt: serializeTs(data.completedAt),
  releasedAt: serializeTs(data.releasedAt),
  // Submitted-at is shown in the admin review dialog; serialize it like
  // the other Timestamp fields so the raw Timestamp object is not JSON-mangled.
  submittedAt: serializeTs(data.submittedAt),
};
```

Because of `...data`, the serializer passes through **every** doc field — no
task-doc field is dropped at the API layer. The only transformation is
Timestamp → ISO normalization for the 7 named timestamp fields (fix from commit
`84b4f3b`, which closed the submittedAt gap). Any *other* Timestamp-typed field
not in that list would JSON-mangle, but none of the submission fields are
Timestamps. `deliverableFiles`, `feedback_text`, `approvedBy`, etc. all pass
through intact.

**Verdict on step 2: no field is dropped by the serializer.**

## Step 3 — Three-column mapping

Known Firestore submission fields (from the PATCH update schema, lines 270–294,
and server stamps, lines 473–495 of route.ts). "Known in Firestore" means the
field is written by the submit/approve flow and therefore *could* exist on a doc.

| Field | In API response? | Rendered in View Submission dialog? |
|---|---|---|
| `title` | ✅ (`...data`) | ✅ (dialog title) |
| `report` | ✅ | ✅ |
| `hoursWorked` | ✅ | ✅ |
| `resourceLinks` | ✅ | ✅ ("Deliverable links") |
| `submittedAt` | ✅ (ISO-normalized) | ✅ ("Submitted at") |
| `submittedBy` | ✅ | ✅ ("Submitted by") |
| `deliverableFiles` (assignee-safe submit field: `[{fileName, driveFileId, downloadUrl, sizeBytes, contentType}]`) | ✅ — passes through `...data` | ❌ **NOT rendered. No reference to `deliverableFiles` anywhere in `src/app/admin/tasks/page.tsx` (grep: zero hits).** |
| `feedback_text` (reviewer revision-request note; also an assignee-safe field) | ✅ | ❌ NOT rendered |
| `approvedBy` / `approvedAt` / `approvedByRole` | ✅ | ❌ NOT rendered |
| `rejectedBy` / `rejectedAt` / `rejectedByRole` | ✅ | ❌ NOT rendered |
| `validatorDepth` / `validatedVia` | ✅ | ❌ NOT rendered |
| `statusHistory` | ✅ (if present; not a field this codebase writes — grep count 0 in route.ts) | ❌ |
| `reviewerNotes` | — not a field in this codebase's task schema | ❌ |
| `attachments` | — not a field in this codebase's task schema (schema uses `deliverableFiles`) | ❌ |

Notes:
- `feedback_text` is written only by the reviewer on the `changes-requested`
  path (`task-detail-dialog.tsx` line 413) — it is a review output, not
  assignee submission content, but it is still invisible in the admin dialog.
- `resources` (step resources added at task creation, route.ts lines 288–293)
  is also ✅ in the API response but ❌ not rendered in the View Submission
  dialog. It is assignment-side content (links given *to* the doer), not
  submission content — but a reviewer verifying "did the doer use the provided
  resources" can't see them here either.

## Step 4 — Verdict

**The API read path is complete: the serializer drops nothing (full `...data`
spread). The hiding, if any, happens in the dialog itself.**

The View Submission dialog renders: `title`, `submittedBy`, `submittedAt`
(with honest `updatedAt` fallback), `hoursWorked`, `report`, `resourceLinks` —
and nothing else. One genuine submission-content field that exists in
Firestore and reaches the client is **never rendered**:

- **`deliverableFiles`** — the schema-sanctioned file-attachment field
  (`z.array` of `{fileName, driveFileId, downloadUrl, sizeBytes, contentType}`),
  in the assignee-safe write set. If a Task 02 doc (or any task) carries
  `deliverableFiles`, the admin reviewer looking at "View Submission" will
  never see them. Zero references to `deliverableFiles` in the entire admin
  tasks page.

Practical impact for the current Task 02 docs: if Workers 1–3 find that
`L5Kv8tmIsb6yGi44zkyT`, `z20ZnLAPd3q8ZWRPnRVr`, or `UHtT8yldnfIjWFmnnhGM` have
**empty or absent** `deliverableFiles` (the known pattern is Google Doc links
pasted into `report`), then the dialog currently shows everything that matters.
But any future submission that uploads files to `deliverableFiles` will be
invisible to admin reviewers through this dialog — a real coverage gap in the
read path that predates the 20-agent swarm fix.

**So: the dialog is NOT fully complete. It renders all the scalar submission
fields but silently drops `deliverableFiles` (and the decision-stamp /
revision-note fields). It could be hiding submission content whenever a task
carries uploaded files.**
