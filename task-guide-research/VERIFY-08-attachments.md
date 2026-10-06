# VERIFY-08: Attachment / Drive-file hunt across Task 02 submissions

Worker 8 — deep-verification swarm. Investigation only; no code changes.
Date: 2026-10-06 ~07:30 PKT. Method: Firestore REST reads via `NEXT_PUBLIC_FIREBASE_API_KEY`
(project `seds-pakistan`) + codebase collection search + `firestore.rules` review.

## Verdict

**No proof file beyond the single blank template doc exists.** All three task documents were
read in full (every field scanned for URLs, drive/file/upload keys, nested objects). The
`deliverableFiles` mechanism exists in the codebase (`/missions/[workflowId]/submit/[stepIndex]`
writes `updates.deliverableFiles`, PATCH `/api/tasks` allows it as an assignee-safe field) but
**none of the three task docs contains a `deliverableFiles` field at all** — no Drive uploads,
no `driveFileId`, `downloadUrl`, `fileName`, `contentType`, `sizeBytes` keys anywhere in any doc.
The only assignee-supplied artifact across all three submissions is the known blank checklist
template doc `18KZZX5MK39tN-WNEkVdWBGqDK--osuZ2`.

## Complete inventory of file/Drive references

### Task 1 — `tasks/L5Kv8tmIsb6yGi44zkyT` ("Executive Document Audit, Verification & Print File Preparation", Audit step, submitted-for-review)
- `report`: `"Objective reached. Direct Transmit."` — the literal dummy canned text (transmit bug). No link.
- `resourceLinks` (string): `https://docs.google.com/document/d/18KZZX5MK39tN-WNEkVdWBGqDK--osuZ2/edit?usp=sharing&ouid=108789080876588241975&rtpof=true&sd=true` — the known blank template doc.
- `resources` (array of {title, type: "drive", url}) — **6 guidance/input links, all reference materials, NOT proof:**
  1. "Task 02 Package Folder (all files)" — `https://drive.google.com/drive/folders/18m2HyqzQv2CyelgqRvEaxBCUqz3v2KBX`
  2. "Master Portfolio Text" — `https://drive.google.com/file/d/1tPVc3o9MM1fRz9K1niXDq_EFqmjb8gah/view?usp=drivesdk`
  3. "Institutional Endorsement Letter" — `https://drive.google.com/file/d/1gwS_VTKeGzDD3Q-HYqIWjVKt5m3Avj0N/view?usp=drivesdk`
  4. "Print Specifications & QC" — `https://drive.google.com/file/d/1EKSm1XvE0GtESnBlENCAQIN7OuoWlaDX/view?usp=drivesdk`
  5. "Meeting Choreography" — `https://drive.google.com/file/d/1L034sPJQ9_7w7bjGTNn6jo24TiBXLTfA/view?usp=drivesdk`
  6. "Platform Work Order" — `https://drive.google.com/file/d/1SMfNpzWAoYDpN3aJH13yzSZ-NMkM2YNX/view?usp=drivesdk`
- 7 unique URLs total in this doc. No `deliverableFiles` / `attachments` / `proofLinks` / `files` / `links` / `images` fields exist.

### Task 2 — `tasks/z20ZnLAPd3q8ZWRPnRVr` ("Assembly, 5-Point Quality Control & Final Delivery", submitted-for-review)
- `report`: the blank template doc URL (`.../document/d/18KZZX5MK39tN-WNEkVdWBGqDK--osuZ2/edit?usp=sharing&ouid=108789080876588241975&rtpof=true&sd=true`).
- `resources`: empty. `resourceLinks`: empty map `{}`.
- 1 unique URL total. No attachment/upload fields of any kind.

### Task 3 — `tasks/UHtT8yldnfIjWFmnnhGM` ("Print Production & Material Procurement", submitted-for-review)
- `report`: the blank template doc URL (same as Task 2).
- `resources`: empty. `resourceLinks`: empty map `{}`.
- 1 unique URL total. No attachment/upload fields of any kind. (`hoursWorked` is absent on this doc.)

### Drive metadata check (blocked, noted)
Attempted anonymous `drive.files.get` metadata lookup on the 5 guidance file IDs — the
`NEXT_PUBLIC_FIREBASE_API_KEY` is API-restricted and the Drive API v3 returned `400 "API key
not valid"` for all 5. File titles/nature come from the task doc itself; they are labeled
reference materials (portfolio text, endorsement letter, print specs, choreography, work order)
and predate the submissions as task inputs.

## Related collections search

- **No `deliverables`, `uploads`, or `taskAttachments` collections exist in the codebase.**
  Client-side `collection(...)` references span: users, tasks, events, chapters, projects, blogs,
  audit_logs, roles, organizations, orders, badges, announcements, workflow_presence, timeline,
  role_requests, messages, forms, analyticsEvents, workflow_typing, roleDefinitions, resources,
  products, legalDocuments, certificates, auditLogs, workshops, **submissions**,
  sponsors_partners, skills, pageVisits, leave_audit, invites, explore, eventTickets,
  competitions, chapter_applications, bug_reports, applications.
- **`submissions`** (top-level) is the competition/opportunity-link inbox (`src/lib/submission-types.ts`:
  types `competition | opportunity | resource | other`) — unrelated to task proof. Rules: read
  requires `canManageInbox`; anonymous create allowed.
- **`universal_submissions`** is an admin-inbox index mirror (webhook creates `tasks_{taskId}`
  docs). Anonymous REST reads of `universal_submissions/tasks_{id}` for all three tasks → **403**.
- **Task subcollections**: only `activity` exists in code (`api/tasks/route.ts`,
  `api/tasks/[id]/activity/route.ts`, `api/tasks/delegate/route.ts`). Anonymous REST reads of
  `tasks/{id}/activity` for all three tasks → **403** (no rule match → denied).
- **`/api/uploads`** exists but is a pure Drive upload proxy (`handleDriveUpload` from
  `src/lib/drive/upload-handler`) — it writes **no Firestore log**. Uploaded file metadata only
  lands in the task's `deliverableFiles` field, which is absent on all three docs.
- **`points_ledger`, `audit_logs`** list queries → **403** anonymous (not investigated further;
  not file stores).

## Workflow doc check

`workflows/wf_1791096197560_ugmmt1` via Firestore REST → **403 "Missing or insufficient
permissions"** (`firestore.rules` has no `match /workflows/...` rule → denied by default).
The sanitized public API `https://sedspakistan.live/api/missions/wf_1791096197560_ugmmt1`
(HTTP 200) returns **zero URLs** — steps/titles/descriptions/assignees only, no resource links.
No local seed of the workflow exists in the repo (no hits for the workflow ID or any Drive file
ID in `src/` or `scripts/`) — it was created via the live UI/API. **Best available proxy:** the
6 guidance links mirrored on Task 1's `resources` field (folder + 5 files) are almost certainly
the workflow's 6 known links; no 7th/8th link exists on any step task.

## Access summary (per firestore.rules)

| Target | Anonymous read | Basis |
|---|---|---|
| `tasks/{id}` (the 3 docs) | ✅ READABLE | rule: `resource.data.workflowId != null` → public for national missions |
| `tasks/{id}/activity` | ❌ 403 | no rule match |
| `workflows/wf_...` | ❌ 403 | no rule match in firestore.rules |
| `universal_submissions/tasks_{id}` | ❌ 403 | no rule match |
| `points_ledger`, `audit_logs` | ❌ 403 | admin-only |
| Public mission API `/api/missions/[workflowId]` | ✅ 200 | sanitized, no URLs |

## Bottom line

The three Task 02 submissions contain **zero** attached proof files. The data model supports
attachments (`deliverableFiles` on the task doc, written by the missions submit page and allowed
by the PATCH serializer), but none of the three docs uses it. What exists is:

1. The blank template doc `18KZZX5MK39tN-WNEkVdWBGqDK--osuZ2` referenced 3 times (Task 1's
   `resourceLinks`, Task 2's `report`, Task 3's `report`) — **input/template, not proof**.
2. Task 1's 6 `resources` guidance links (package folder + 5 reference files) — **inputs, not proof**.
3. Task 1's `report` = literal dummy text "Objective reached. Direct Transmit."

Caveats: `activity` subcollections, `universal_submissions` index, and the workflow doc itself
are not anonymously readable (403 per rules); a signed-in admin read could double-check those,
but per the data model, task-file attachments live only on the task doc (`deliverableFiles`),
which was fully read and is empty on all three.
