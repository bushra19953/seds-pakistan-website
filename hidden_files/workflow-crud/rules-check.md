# Firestore Rules Check: workflow/task deletion (CRUD audit)

Auditor: Agent 19 (read-only). Date: 2026-10-04. Source: firestore.rules (429 lines), branch feat/remediation-harness-complete.

## Verdict up front

- **`tasks` collection delete**: PERMITTED for the right roles. `allow write` (which covers create, update, and delete) is granted to superadmin and any role with the `canManageTasks` permission. A client-side delete by a task manager is allowed by the rules.
- **`workflows` collection delete**: No rule exists at all. There is NO `match /workflows/...` block anywhere in the file (verified by grep). Unmatched collections are default-deny, so EVERY client operation on `workflows` (read, create, update, delete) is denied for EVERY role, including superadmin. This is fine for the new CRUD design because all workflow mutation goes through the Admin SDK API routes, which bypass rules.
- **Post-delete/duplicate UI**: The admin UIs still function. Both `/admin/workflows` and `/admin/tasks` read through server API routes (`/api/workflows`, `/api/tasks`, `/api/workflows?...`), not through client-side Firestore reads of `workflows`. The only client-side read of `tasks` is the one-time `getDocs` of workflow step tasks in the admin tasks edit modal, and admins with `canManageTasks` are covered by the read rule.
- **No rule change is required** for the current architecture. The one rule addition worth considering (optional, not required) is a defensive read rule for `workflows` in case a future client-side read is ever added.

## 1. Exact rules governing delete

### 1a. `workflows` collection: NO RULE (default-deny)

A search of the full 429-line file finds no `match /workflows/...` block. The only workflow-related match blocks are the transient collaboration collections:

```
392:    match /workflow_presence/{id} {
393:      allow read, write: if isSignedIn();
394:    }
395:    match /workflow_typing/{id} {
396:      allow read, write: if isSignedIn();
397:    }
```

Line 95 defines `isWorkflowMember()` which references a `workflow_members` collection, but there is likewise no `match /workflow_members/...` block. That collection is also default-deny for clients and is only touched by server-side Admin SDK code (member writes happen in `src/app/api/workflows/route.ts` via `admin.firestore()`).

Consequence: any client-side Firestore SDK call against `workflows` (get, list, set, update, delete) is denied regardless of role. Only the Firebase Admin SDK (server) can touch it.

### 1b. `tasks` collection: write rule covers delete for task managers

Lines 304-310, quoted verbatim:

```
304:    match /tasks/{taskId} {
305:      allow read, list: if isSuperAdmin() ||
306:                       hasPermission('canManageTasks') ||
307:                       resource.data.assigneeId == request.auth.uid ||
308:                       resource.data.workflowId != null; // Public visibility for national missions
309:      allow write: if isSuperAdmin() || hasPermission('canManageTasks');
310:    }
```

- **Who can delete a task client-side**: `isSuperAdmin()` OR any signed-in user whose resolved role has `canManageTasks == true` in the `permissions` collection. In Firestore rules syntax, `allow write` is the split that covers create, update, AND delete, so delete is included. Assignees and the public (workflowId clause) get NO write/delete rights.
- No role restriction on delete by task attributes: a task manager can delete any task, including one they are not assigned to. That matches the intended admin capability.

## 2. Does the admin UI still function after a server-side delete/duplicate?

Yes. The client-side read surface was checked against the rules:

**`/admin/workflows` page** (`src/app/admin/workflows/page.tsx`):
- Loads the workflow list via `fetch('/api/workflows', ...)` (line 461).
- Loads steps via `fetch('/api/workflows?workflowId=...')` (lines 207, 244).
- Retry/refresh via `fetchWorkflows()` (lines 451, 583, 610).
- All reads go through the Admin SDK API. No client-side Firestore read of `workflows` exists anywhere in `src/` or `app/` (verified by grep; the only `collection('workflows')` hits are Admin SDK calls in `src/app/api/admin/migrations/*` routes). Default-deny on client `workflows` reads therefore breaks nothing.
- After a delete or duplicate, the page re-fetches from `/api/workflows`, which bypasses rules. UI keeps working.

**`/admin/tasks` page** (`src/app/admin/tasks/page.tsx`):
- The task list loads via `fetch('/api/tasks?...')` (line 247); mutations go through `/api/tasks`, `/api/tasks/batch`, `/api/cron/check-deadlines`, `/api/workflows` (lines 440-733, 865, 952). All server-side, rule-independent.
- Auxiliary client-side collections: `users`, `roles`, `badges`, `projects` via `useCollection` (lines 157-168). All permitted: `users` get/list requires `isSignedIn()`; `roles` get/list requires `isSignedIn()`; `badges` and `projects` are public read.
- One direct client read of `tasks`: line 358, a one-time `getDocs(query(collection(firestore, 'tasks'), where('workflowId', '==', wfId), orderBy('sequenceIndex', 'asc')))` to deep-fetch workflow steps into the edit modal. This is a `list`-type query. The rules at lines 305-308 allow it for `isSuperAdmin()` or `hasPermission('canManageTasks')`, which every admin on this page holds. Note the query has no per-doc filter beyond workflowId, so the `resource.data.workflowId != null` public clause also independently satisfies the rule for workflow-linked tasks. Either way it is allowed for the admin.

**Read rules quoted (lines 305-308)**:
```
305:      allow read, list: if isSuperAdmin() ||
306:                       hasPermission('canManageTasks') ||
307:                       resource.data.assigneeId == request.auth.uid ||
308:                       resource.data.workflowId != null; // Public visibility for national missions
```

**Public mission pages** (`src/app/missions/[workflowId]/page.tsx`, `submit/[stepIndex]/page.tsx`): read via `/api/missions/...` server routes, not client SDK. Unaffected by rule state either way.

## 3. Rule changes needed

**None required.** No rule currently blocks a legitimate admin client-side task delete, and no client-side workflow read exists that could break after a server-side delete/duplicate.

### Optional hardening (documented, NOT applied)

If a future change ever adds a client-side read of the `workflows` collection (e.g. a real-time listener for live progress on `/admin/workflows`), it will fail today with a permissions error because of the missing block. A defensive read rule would be:

```
// Suggested future addition only; do not deploy unless client reads are added.
match /workflows/{workflowId} {
  allow read, list: if isSignedIn() && (isSuperAdmin() || hasPermission('canManageTasks'));
}
```

A `delete` rule for `workflows` is deliberately NOT recommended: workflow deletion must stay server-side so the Admin SDK can cascade-delete step tasks and member records in one transaction. Client-side delete of a workflow without a cascade would orphan step tasks in the `tasks` collection.

### Adjacent finding (not in scope, flagging only)

`workflow_members` has no `match` block either; clients cannot read it (fine, the API serves membership). No change proposed.

### Rule-deploy note

Per the task constraints, firestore.rules was NOT edited. Any rule change requires the user to run the Firebase CLI deploy (`firebase deploy --only firestore:rules --project seds-pakistan`), which cannot be done from this sandbox session.
