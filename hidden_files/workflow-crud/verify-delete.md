# DELETE /api/workflows/[id] - Code Inspection Verification

Date: 2026-10-04 (PKT)
Verifier: agent 13 (read-only, code inspection only; no live browser, no runtime tests)
Branch: feat/remediation-harness-complete
Route file: src/app/api/workflows/[id]/route.ts
Cascade helper: src/lib/server/workflow-cascade.ts

Method note: the [id]/route.ts file did not exist when verification started; it appeared
during the window (found 06:09:30) and workflow-cascade.ts appeared later (~90s after the
first retry). Both files were read in full after they existed.

---

## Check 1: route.ts exports DELETE - PASS

- src/app/api/workflows/[id]/route.ts:15 - `export async function DELETE(`
- Signature: `DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> })`

---

## Check 2: unauthenticated -> 401; authenticated non-admin without canManageTasks -> 403 - PASS

Exact auth call chain traced through three files:

1. src/app/api/workflows/[id]/route.ts:20
   `const auth = await verifyAuthentication(req);`
   (imported from '@/lib/auth-middleware, route.ts:4)
2. src/app/api/workflows/[id]/route.ts:21
   `if (!auth.authenticated || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });`
3. src/app/api/workflows/[id]/route.ts:22
   `if (!(await hasServerPermission(auth.user.role || '', 'canManageTasks'))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });`

verifyAuthentication internals (src/lib/auth-middleware.ts):
- Missing token -> returns { authenticated: false } at auth-middleware.ts:58-64
  ("No authentication token provided").
- Invalid token -> `admin.auth().verifyIdToken(token)` throws at line 120, caught at
  lines 165-176, returns { authenticated: false } at auth-middleware.ts:171-175.
  So both missing and invalid tokens reach the 401 branch. (A banned account also
  returns authenticated:false at lines 138-144, which maps to 401 here.)
- Valid token -> user.role is read live from the `roles/{uid}` doc at line 135
  (`roleSnap.data()?.role || 'member'`), returned at lines 146-156 as
  `user: { ..., role: userRole }`.

hasServerPermission internals (src/lib/server/permissions.ts):
- src/lib/server/permissions.ts:10-11 - accepts `role: UserRole | string | null | undefined`;
  empty role returns false immediately.
- Line 16: 'superadmin' short-circuits to true.
- Lines 30-38: looks up `roleDefinitions/{normalizedSlug}`; the permissions array is
  authoritative - if 'canManageTasks' is absent there, returns false.
- A member-tier user without canManageTasks therefore hits the 403 branch at route.ts:22.

Result: unauthenticated -> 401 via route.ts:21; authenticated non-admin lacking
canManageTasks -> 403 via route.ts:22. Note the permission gate is 'canManageTasks',
not a literal "admin" role check.

---

## Check 3: missing ?confirm=<id> -> 400; wrong confirm value -> 400 - PASS

- src/app/api/workflows/[id]/route.ts:40-41 - `const { searchParams } = new URL(req.url);`
  `const confirm = searchParams.get('confirm');`
- src/app/api/workflows/[id]/route.ts:43-47:
  `if (confirm !== id) { return NextResponse.json({ error: 'Confirmation required: pass ?confirm=<workflowId>' }, { status: 400 }); }`
- Missing ?confirm gives `confirm === null`, which !== id -> 400.
- Wrong value !== id -> 400.

Ordering caveat: the nonexistent-id 404 (route.ts:35-38) is evaluated BEFORE the
confirm check. So "missing confirm + nonexistent id" returns 404, not 400. The 400
only fires for an existing workflow id.

---

## Check 4: nonexistent id -> 404 JSON (not a thrown 500) - PASS

- src/app/api/workflows/[id]/route.ts:34-38:
  `const wfSnap = await db.collection('workflows').doc(id).get();`
  `if (!wfSnap.exists) { return NextResponse.json({ ok: false, error: 'Workflow not found' }, { status: 404 }); }`
- Returns a JSON body with status 404; nothing is thrown on this path.
- The whole handler is wrapped in try/catch (route.ts:19, 77-82); an unexpected
  exception still returns JSON ({ error: 'Internal Server Error', details }) with
  status 500 rather than an unhandled throw.

Caveat (data-model, not this check): the existence gate reads `workflows/{id}` as a
document, but workflow creation in src/app/api/workflows/route.ts (POST) never writes
a `workflows` doc - it creates `tasks` docs with workflowId plus `workflow_members`
docs. Some workflows only exist as task-embedded workflowIds (migration scripts in
src/app/api/admin/migrations/ do write `workflows` docs). A task-embedded workflow
with no `workflows/{id}` doc would return 404 here even though it has step tasks.

---

## Check 5: cascade helper invoked and task docs deleted - PASS with caveat

Invocation (not dead code):
- src/app/api/workflows/[id]/route.ts:66 - `const { deletedTasks } = await deleteWorkflowCascade(db, id);`
- The import is at route.ts:7 (`import { deleteWorkflowCascade } from '@/lib/server/workflow-cascade'`).
- A second live caller exists: src/app/api/workflows/bulk-delete/route.ts:81.

Helper behavior (src/lib/server/workflow-cascade.ts):
- collectWorkflowDeletions (lines 10-28): gathers `tasks` docs where workflowId == id
  (lines 14-15) AND `workflow_members` docs whose id starts with `{workflowId}_`
  (lines 17-22).
- deleteWorkflowCascade (lines 30-44): batch-deletes every collected ref
  (line 39: `batch.delete(ref)`), chunked at 400 ops per batch (line 35), and returns
  `{ deletedTasks: taskRefs.length, deletedMembers: memberRefs.length }` (line 43).
- So step task docs ARE deleted (not just the workflow record).

Caveat: the helper deletes task docs and member docs, but it never deletes the
`workflows/{id}` doc that the route used as its existence gate (route.ts:34). After a
successful DELETE, `workflows/{id}` still exists while its step tasks are gone.
The response shape also only reports deletedTasks; deletedMembers is computed but
discarded by the route.

Minor observation (performance, not correctness): member refs are found via a full
`workflow_members` collection `.get()` with an in-code prefix filter (workflow-cascade.ts:19-22)
rather than a range/prefix query.

---

## Check 6: response shape { ok:true, deletedTasks:number } on success - PASS

- src/app/api/workflows/[id]/route.ts:76 - `return NextResponse.json({ ok: true, deletedTasks });`
- `deletedTasks` is destructured at route.ts:66 from the helper return where it is
  `taskRefs.length` (workflow-cascade.ts:43), so it is a number.

---

## Items not verifiable (code inspection only)

- Actual HTTP behavior (401/403/400/404/200 codes in practice), since this was
  static inspection only; no live browser or runtime execution was available.
- Whether the route compiles under the project tsconfig (no build was run).
- The 409 "Workflow has completed steps" guard (route.ts:49-63): DONE_STATUSES at
  route.ts:13 covers 'completed' and 'approved' (comment at route.ts:9-12 notes
  sync with 'pending', 'completed', 'overdue' in the POST route; 'overdue' is
  deliberately not a done state). Requires ?force=true to delete a workflow with
  done steps. Verified by reading only.
- logWorkflowAudit (route.ts:69-74) writes a 'workflow_deleted' audit entry;
  the audit helper file src/lib/server/workflow-audit.ts was not inspected in depth.
