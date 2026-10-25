# Supabase migration — tasks cluster, group 4: tasks/delegate route

Branch: `feat/supa-tasks-4` off `4d5a1e16` (feat/integration-wave3).
Owned file ONLY: `src/app/api/tasks/delegate/route.ts`
Seam module created: `src/lib/supa/seam-tasks-delegate.ts`
Surface string for `useSupa(surface)`: exactly `'tasks'`.

## Pre-existing defects — DO NOT FIX HERE (owned by the defect-fix program)

### FD-01 — delegate route always 403s (POST) / always "No pending delegation" (PATCH)

- `src/app/api/tasks/delegate/route.ts` reads the caller id as
  `(auth.user as any).uid` — POST line 34, PATCH line 234 (pre-migration
  numbering).
- `verifyAuthentication` (`src/lib/auth-middleware.ts`) returns
  `auth.user` as an `AuthContext`: `{ user: <decodedToken>, userId, email,
  displayName, emailVerified, role }`. There is NO top-level `uid` field.
  The uid lives at `auth.user.userId` (and nested at `auth.user.user.uid`).
- Therefore `callerUid` is ALWAYS `undefined`:
  - POST: `taskAssigneeIds.includes(undefined)` is false for every real
    task, so POST always ends at
    `403 { error: 'Only the task assignee can delegate' }` (when the task
    exists; 404 when it does not, 401 when unauthenticated).
  - PATCH: see TS-P01 — it exits even earlier, at the delegation check.
- This migration preserves that behavior byte-identically under BOTH flag
  states. The flag-ON path must NOT make this dead route live.

### TS-P01 — nothing writes `task.delegation`; PATCH delegation response is dead

- No code anywhere in the codebase writes a `delegation` field on a task
  document (the POST handler writes `orchestration`, sub-tasks with
  `delegatedBy`, etc., never `task.delegation`).
- PATCH therefore always finds `task.delegation === undefined` and returns
  `400 { error: 'No pending delegation' }` for every existing task.
- The `delegation.delegatedTo !== callerUid` 403 check and the
  accept/reject `taskRef.update(...)` writes below it are unreachable
  twice over (TS-P01 first, FD-01 second).

## Read inventory (ordered, pre-migration behavior)

### POST
1. `verifyAuthentication(request)` — 401 if not authenticated. (Auth
   middleware's own internal reads are unchanged, out of scope.)
2. Request JSON parse + shape validation (`taskId`, `workflowSteps`) —
   400s, no DB reads.
3. `callerUid = (auth.user as any).uid` → `undefined` (FD-01).
4. READ 1 (the only reachable data read): `tasks/{taskId}` doc get.
   Missing → `404 { error: 'Task not found' }`.
5. Assignee check against `task.assigneeIds` / `task.assigneeId`:
   `undefined` never matches → `403 { error: 'Only the task assignee can
   delegate' }`. POST ALWAYS ENDS HERE for an existing task.
6. Everything below is UNREACHABLE in production (kept, structurally
   migrated where the seam has an equivalent):
   - points-total check (400 on mismatch),
   - READ: `users/{callerUid}` doc get (caller display name),
   - dynamic import `@/lib/server/discipline/suspension`:
     `suspensionBlock(db, callerUid, ...)` (403), `findBannedDelegateTarget`,
   - READ: `users` query `where(documentId(), 'in', chunk)` in chunks of
     10 for step-assignee email details,
   - WRITES (one Firestore batch): new sub-task docs in `tasks`,
     `users/{uid}` counter merges, `users/{uid}/notifications` docs,
     `workflow_members/{workflowId}_{uid}` docs, `tasks/{taskId}` update
     (`status`, `orchestration`), `tasks/{taskId}/activity` doc.

### PATCH
1. `verifyAuthentication(request)` — 401 if not authenticated.
2. Request JSON parse + validation (`taskId`, `action` in
   accept/reject) — 400, no DB reads.
3. `callerUid = (auth.user as any).uid` → `undefined` (FD-01).
4. READ 1 (the only data read): `tasks/{taskId}` doc get.
   Missing → `404 { error: 'Task not found' }`.
5. `task.delegation` is always `undefined` (TS-P01) →
   `400 { error: 'No pending delegation' }`. PATCH ALWAYS ENDS HERE for
   an existing task.
6. UNREACHABLE: `delegation.delegatedTo !== callerUid` 403 check;
   accept/reject `tasks/{taskId}` update of `delegation.status` /
   `delegation.respondedAt`.

## Migration design

- All task-doc reads (POST step 4, PATCH step 4) go through the seam
  `getTaskDocViaSeam(taskId)` in `src/lib/supa/seam-tasks-delegate.ts`
  when `useSupa('tasks')` is ON and the adapter loads; any seam error
  falls back to the exact original Firestore read.
- Flag OFF / adapter absent / adapter error → original Firestore code
  path, byte-identical behavior.
- The identity/403 ordering is preserved exactly: auth → validation →
  callerUid (still the FD-01 line, untouched) → task read → checks.
- Unreachable reads/writes below the 403/400 exits are migrated
  structurally behind seam helpers where an adapter equivalent exists
  (doc gets, the PATCH delegation update) WITHOUT altering reachability:
  no condition, ordering, or value on any reachable path changes.
  The POST batch write has no adapter equivalent in the contract (no
  batch primitive; it relies on FieldValue.increment/serverTimestamp and
  subcollection refs), so it stays Firestore — see "Known gaps" below.

## FOR THE FUTURE FD-01 FIXER (fix/tasks-status-semantics)

- The auth fix lands in ONE place per handler: the two
  `const callerUid = (auth.user as any).uid;` lines in
  `src/app/api/tasks/delegate/route.ts` (POST and PATCH). The seam does
  NOT touch identity: `seam-tasks-delegate.ts` receives `taskId` only,
  never auth state. Fix `callerUid` to `auth.user.userId` in the route
  and every read/write below — Firestore and Supa paths alike — picks it
  up unchanged.
- Fixing FD-01 alone does NOT revive PATCH: TS-P01 (nothing writes
  `task.delegation`) must also be fixed, and that writer belongs in the
  POST handler / task-creation flow, not in this seam.
- The tests in `src/app/api/tasks/delegate/__tests__/route.test.ts`
  pin the CURRENT (broken) behavior under both flag states; update them
  in the same commit as the FD-01 fix.

## Known gaps

- POST batch write (sub-tasks, counters, notifications,
  workflow_members, parent update, activity subcollection) remains a
  Firestore batch: the adapter contract
  (getDoc/listDocs/countDocs/setDoc/updateDoc/deleteDoc) has no batch
  or FieldValue primitive. It is unreachable past the FD-01 403 today;
  when FD-01 is fixed, this write set needs an adapter batch decision
  BEFORE the flag is enabled for 'tasks'.

## Gates

- (filled in at completion)
