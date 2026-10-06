# SWARM A4: Does submission data exist in Firestore?

Investigation only, no code changed, no Firestore writes performed. All findings are from
code and rules analysis on branch `feat/remediation-harness-complete`.

## 1. Data access layer

- Server API routes use firebase-admin via a service-account cert
  (`src/lib/server/firebase-admin.ts`, `getDb()` at line ~183). Admin SDK calls
  bypass Firestore security rules entirely.
- Client live views (e.g. the task detail dialog's `onSnapshot` listener) use the
  client SDK and ARE subject to `firestore.rules`.

## 2. Task document fields (collection `tasks`)

From the Task type (`src/lib/task-types.ts`) and the write schema
(`TaskUpdateSchema` in `src/app/api/tasks/route.ts`):

- Core: id, title, description, assignerId, assigneeId, assigneeIds,
  projectId, workflowId, workflowTitle, sequenceIndex, status, deadline,
  individualDeadline, points, penaltyPoints, createdAt, updatedAt,
  completedAt, guidance, resources[], delegation.
- Submission-related: `report` (string), `hoursWorked` (number),
  `resourceLinks` (string), `feedback_text` (string, only used for change
  requests), `deliverableFiles[]` (objects with fileName, driveFileId,
  downloadUrl, sizeBytes, contentType), `submittedBy` (server-stamped uid),
  `submittedAt` (server-stamped Timestamp), `feedback_history[]`
  (server-built on changes-requested).

On every transition into `submitted-for-review`, the PATCH handler stamps
`submittedBy` and `submittedAt` server-side (route.ts ~lines 469-476).

## 3. Firestore rules for `tasks` (firestore.rules, line 314)

```
match /tasks/{taskId} {
  allow read, list: if isSuperAdmin() ||
                   hasPermission('canManageTasks') ||
                   resource.data.assigneeId == request.auth.uid ||
                   resource.data.workflowId != null; // public mission visibility
  allow write: if isSuperAdmin() || hasPermission('canManageTasks');
}
```

- An admin (superadmin or any role with `canManageTasks` per the
  `permissions/{role}` docs) can read the WHOLE task document, including
  report, hoursWorked, deliverableFiles, submittedBy, submittedAt.
- Firestore rules have NO field-level read blocking: a permitted read returns
  all fields. No submission field is read-blocked or write-blocked in the rules.
- Assignees cannot write task docs directly via the client SDK, but all
  submits go through PATCH /api/tasks (Admin SDK), which bypasses rules.
- The server enforces field-level auth for assignee writes in code:
  non-managers may only send `status, hoursWorked, report, resourceLinks,
  feedback_text, deliverableFiles` (`ASSIGNEE_SAFE_FIELDS`, route.ts ~line 462).

## 4. Server-side stripping check

- GET /api/tasks (admin list API) maps docs with `{ id: d.id, ...data, ... }`,
  serializing only Timestamp fields. There is NO projection, DTO, or
  sanitizer. Whatever is on the Firestore doc reaches the client.
- There is no GET /api/tasks/[id] route (the [id] folder only holds
  `activity` and `validation` subroutes), so no single-task API sanitizer exists.
- GET /api/missions/[workflowId]/submit/[stepIndex] deliberately projects a
  subset (title, description, status, points, deadlines, report, hoursWorked,
  resourceLinks) and EXCLUDES deliverableFiles. That is the submitter's own
  form endpoint, not the admin path.

Conclusion: the server does NOT strip submission fields on the admin read path.

## 5. What the write paths actually send (why data may never exist)

Three submit paths, and what each sends to PATCH /api/tasks:

1. Public submit page (`/missions/[workflowId]/submit/[stepIndex]`):
   sends `status`, plus `report` / `hoursWorked` / `resourceLinks` ONLY when
   non-empty, plus `deliverableFiles` ONLY when files were uploaded in that
   session. Empty report and hours are simply never written.
2. Profile quick "Transmit" button (`handleQuickAction` in
   `src/components/profile/assigned-tasks.tsx`): sends ONLY
   `{ status: 'submitted-for-review', report: 'Objective reached. Direct Transmit.' }`.
   No hours, no files, ever. The report is a hardcoded placeholder string.
3. Profile full update (`handleFullUpdate`): sends `status`, plus `report` /
   `hoursWorked` only when non-empty.

Nothing on the server requires report, hours, or files to be present before
accepting a `submitted-for-review` transition.

## 6. What the read views render

- Admin tasks table (`src/app/admin/tasks/page.tsx`): title, assignee,
  project, status badge, deadline, points, efficiency, createdAt, and action
  buttons. It does NOT render report, hours, or files. Approve / Request
  Revisions buttons fire immediately with no content preview.
- `deliverableFiles` (photos / proof files): written by the submit page and
  accepted by the API, but NO component anywhere in the codebase renders
  them. Grep for `deliverableFiles` across src/ finds only the API write
  path, the submit page, and the duplicate route. Uploaded photos are
  stored on the task document but invisible in every UI.
- `report` and `hoursWorked`: rendered ONLY in the profile
  task-detail-dialog "Mission Report" tab, and report is also loaded into
  the admin Edit dialog form. List and table views never show them.

## Verdict: partially present-but-unrendered, partially actually missing

- Photos/proof (deliverableFiles): if Maira uploaded files via the public
  submit page, they EXIST in Firestore but are unrenderable, since no UI
  reads that field. If she used the profile quick-transmit path, they were
  never uploaded and are actually missing.
- Report/hours: present-or-missing depends entirely on what the submitter
  typed, because every submit path only writes non-empty values and the
  server requires nothing. A quick-transmit leaves only the placeholder
  report string and no hours. The read-only views (admin table, profile
  lists) would not show report/hours even if present, so an "empty" view
  cannot distinguish the two cases.
- Server stripping is ruled out: GET /api/tasks returns full docs, and the
  rules allow full-doc reads for admins with no field-level blocking.
- The observed symptom is fully consistent with the data never being
  entered: status transitions work with zero payload, the UI allows empty
  submits, and the one payload-bearing field for files has no renderer.

Recommended confirmation step (for whoever has production access): read one
of the three `tasks` docs directly in the Firebase console and check for
`report`, `hoursWorked`, `deliverableFiles`, `submittedBy`, `submittedAt`.
If those fields are absent, the data was never submitted; if present, the
gap is purely rendering.
