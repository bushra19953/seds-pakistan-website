# Workflow CRUD API Spec
## Source: src/app/api/workflows/route.ts (branch feat/remediation-harness-complete)

Exported handlers: `POST`, `GET`, `PATCH`. No `DELETE`. No duplicate endpoint.
Directory listing of `src/app/api/workflows/`: only `route.ts` exists; there is no `[id]` subdirectory.

---

## 1. Auth pattern

### Imports (exact, top of file)
```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { calculateWorkflowDeadlines } from '@/lib/workflow-utils';
import { validateUserStatus } from '@/lib/server/user-status';
import { hasServerPermission, resolveUserRole } from '@/lib/server/permissions';
```
Also set at module top: `export const dynamic = 'force-dynamic';` and `export const runtime = 'nodejs';`.

Note: the route does NOT use `verifyAuthentication` at all. It uses a local helper instead.

### Token extraction (`extractBearerToken`)
1. Reads `request.headers.get('authorization')` (lowercase) or `request.headers.get('Authorization')`. If the value starts with `Bearer `, returns the trimmed remainder.
2. Otherwise reads the `__session` cookie value.
3. Returns undefined if neither exists.

### Local `authenticate(request)` helper
- If `!ensureAdminInitialized()`: returns `{ error: NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 }) }`.
- Missing token: `{ error: NextResponse.json({ error: 'Unauthorized: missing Bearer token' }, { status: 401 }) }`.
- Verifies with `await admin.auth().verifyIdToken(token)`.
- If `FIREBASE_PROJECT_ID` or `NEXT_PUBLIC_FIREBASE_PROJECT_ID` is set, additionally checks `decoded.iss === 'https://securetoken.google.com/<projectId>'` and `decoded.aud === <projectId>`; mismatch gives `{ error: 'Unauthorized: token issued for different project' }, { status: 401 }`.
- Verification throw: `{ error: 'Unauthorized: invalid token' }, { status: 401 }`.
- Success returns `{ decoded }` where `decoded` is `admin.auth.DecodedIdToken`.
- Callers check `if ('error' in auth) return auth.error;` then use `auth.decoded.uid`.

### Permission check (POST and PATCH only)
```ts
const creatorRole = await resolveUserRole(db, decoded.uid); // PATCH names it patcherRole
if (!(await hasServerPermission(creatorRole, 'canManageTasks'))) {
  return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
}
```
Permission key used: `'canManageTasks'` for both POST and PATCH.

### GET auth and visibility
- GET requires auth (401 if unauthenticated) but has no blanket permission gate.
- List mode (no `?workflowId`): viewer role resolved via `resolveUserRole(db, viewerUid)`; `viewerCanManage = hasServerPermission(viewerRole, 'canManageWorkflows') || hasServerPermission(viewerRole, 'canManageTasks')`. Non-managers only see workflows whose `participants` array includes their own uid. Permission keys: `'canManageWorkflows'`, `'canManageTasks'`.
- Detail mode (`?workflowId=...`): no permission gate, but contact masking: assignee WhatsApp/email are nulled unless the viewer is admin-like (live role from `roles/{uid}` doc is `'superadmin'` or includes `'president'` or includes `'admin'`), or is one of the task assignees, or has a `workflow_members/{workflowId}_{uid}` doc.

---

## 2. Zod schemas for POST and PATCH bodies

### StepSchema (per step in POST body)
```ts
const StepSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  role: z.string().optional(),
  assigneeId: z.string().min(1),
  assigneeIds: z.array(z.string().min(1)).optional(),
  estimatedDuration: z.number().int().optional(),
  workflowTags: z.array(z.string()).optional(),
  workflowPriority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  points: z.number().optional(),
  stepSpecificBadgeId: z.string().optional(),
  individualDeadline: z.union([z.string(), z.number(), z.date()]).optional(),
  resources: z.array(z.object({
    type: z.enum(['link', 'drive', 'github', 'doc', 'video', 'other']),
    url: z.string().url(),
    title: z.string()
  })).optional(),
});
```

### CreateWorkflowSchema (POST body)
```ts
const CreateWorkflowSchema = z.object({
  workflowId: z.string().min(1),
  workflowTitle: z.string().min(1),
  finalDeadline: z.union([z.string(), z.number(), z.date()]),
  steps: z.array(StepSchema).min(1),
  projectId: z.string().nullable().optional(),
  chapterId: z.string().nullable().optional(),
  finalWorkflowCompletionBadgeId: z.string().optional(),
  basePoints: z.number().optional(),
  penaltyPoints: z.number().optional(),
  workflowBonusPoints: z.number().optional(),
  guidance: z.object({
    description: z.string().optional(),
    steps: z.array(z.string()).optional(),
    estimatedTime: z.number().optional(),
  }).optional(),
  resources: z.array(z.object({
    type: z.enum(['link', 'drive', 'github', 'doc', 'video', 'other']),
    url: z.string().url(),
    title: z.string()
  })).optional(),
});
```
- `resources` appears at both the workflow level and the step level; the step task doc merges them: `resources: [...(data.resources || []), ...(step.resources || [])]`.
- `assigneeId` is required per step; `assigneeIds` is optional. Server normalizes to a deduped non-empty array: if `assigneeIds` is present and non-empty it wins, otherwise `[assigneeId]`; singular `assigneeId` is persisted as the first element of the array for backward-compatible readers.

### PATCH body schema (inline in handler, not exported)
```ts
z.object({
  workflowId: z.string().min(1),
  sequenceIndex: z.number().int(),
  updates: z.object({
    assigneeId: z.string().optional(),
    assigneeIds: z.array(z.string()).optional(),
    status: z.string().optional(),
  }),
  reason: z.string().optional(),
});
```
PATCH targets a single step by `(workflowId, sequenceIndex)`: queries `tasks` where `workflowId == workflowId` and `sequenceIndex == sequenceIndex`, limit 1. 404 `{ error: 'Step not found' }` if empty.

---

## 3. How a workflow doc links to its step tasks

There is NO `workflows` collection and NO workflow document. A workflow is a virtual aggregate computed by grouping `tasks` documents on the shared string field `workflowId`.

### Task doc fields that carry the linkage (created in POST, exact field names)
```ts
const taskDoc: any = {
  ...
  workflowId: data.workflowId,          // shared key, client-supplied string id
  workflowTitle: data.workflowTitle,    // repeated on every step task
  workflowParticipantIds: wfParticipantIds, // deduped array of ALL step assignees in the workflow
  sequenceIndex: i,                    // 0-based step order
  ...
  isCurrentStep,                       // true only for i === 0 at creation
  releasedAt: isCurrentStep ? admin.firestore.FieldValue.serverTimestamp() : null,
  ...
};
```
- Answer to the specific questions: yes, each task doc has a `workflowId` field; no, there is no `taskIds` array on any workflow (no workflow doc exists); no, there is no embedded `steps` array in Firestore (the `steps` array exists only in the POST request body).
- `workflowParticipantIds` on each task doc is the union of all step assignees.
- GET list mode finds all workflows via `db.collection('tasks').where('workflowId', '!=', null).orderBy('workflowId')` and groups in memory.
- GET detail mode: `db.collection('tasks').where('workflowId', '==', workflowId).get()`, sorted by `sequenceIndex`.

### Side collections written by this route
1. `workflow_members`, doc id `${workflowId}_${uid}`:
   `{ workflowId, userId, joinedAt, role }` where `role` is `'owner'` for the creator uid, `'member'` otherwise. Written with `{ merge: true }`.
2. `workflow_audits` (PATCH only): `db.collection('workflow_audits').add({ workflowId, sequenceIndex, updates, reason: reason || null, actorId: decoded.uid, createdAt: serverTimestamp })`.
3. On POST, for every assignee of every step, `users/{uid}` gets `{ tasksAssignedCount: increment(1), lastTaskAssignedAt: serverTimestamp }` with `{ merge: true }`.

---

## 4. Status values for tasks and workflows

### Task status strings (exact, as stored in `tasks.status`)
- `'pending'`: set at creation for every step task (`status: 'pending'`).
- `'completed'`: counted in GET (`data.status === 'completed'`, detail: `String(t.status) === 'completed'`).
- `'overdue'`: counted in list mode (`data.status === 'overdue'`).
- PATCH accepts any string for `updates.status` (`z.string().optional()`), so other values (if any) come from the separate tasks API, not this route. The exact strings this route knows about are `'pending'`, `'completed'`, `'overdue'`.

### Workflow-level "status" (derived, never stored)
There is no status field on any workflow doc. The list and detail responses derive:
- `isCompleted`: `totalSteps > 0 && completedSteps === totalSteps`.
- `progressPercentage`: `Math.round((completedSteps / totalSteps) * 100)`.
- `efficiencyScore`: same ratio as progressPercentage.
- `overdueSteps`: count of steps with status `'overdue'`.
- `currentStepIndex`: `sequenceIndex` of the task with `isCurrentStep` true.

---

## 5. Response and error JSON shapes

### Success shapes
- POST (200): `{ ok: true, created }` where `created` is `Array<{ id: string; assigneeId: string; sequenceIndex: number }>` (`id` is the new task doc id, `assigneeId` is the primary/first assignee).
- GET list (200): `{ ok: true, workflows: [...] }`; each item:
  `{ id, title, totalSteps, completedSteps, currentStepIndex, progressPercentage, isCompleted, participants: string[], createdAt, updatedAt, overdueSteps, efficiencyScore }`.
  List responses carry header `Cache-Control: private, max-age=30, stale-while-revalidate=120`.
- GET detail (200): `{ ok: true, tasks, progress, analytics, assigneeInfo, chapterName }`.
  - Each task is enriched with `assignees: [{ id, name, photoURL, role, chapterName }]` (primary first) plus singular `assigneeName, assigneePhoto, assigneePosition, assigneeRole, assigneeWhatsapp, assigneeEmail, assigneeChapter` for the primary.
  - Timestamps serialized to ISO strings: `deadline, individualDeadline, createdAt, updatedAt, completedAt, releasedAt`.
  - Detail responses carry header `Cache-Control: private, max-age=60, stale-while-revalidate=300`.
- PATCH (200): `{ ok: true, step: { ...afterData, assignees } }` where `afterData` is the merged pre/post update fields of the step task doc and `assignees` is the same enriched array as in GET detail.

### Error shapes (all `{ error: string }` JSON, plus extras noted)
- 500: `{ error: 'Server misconfiguration: Firebase Admin not initialized' }`
- 500: `{ error: 'Internal Server Error: Firestore not initialized' }`
- 401: `{ error: 'Unauthorized: missing Bearer token' }`
- 401: `{ error: 'Unauthorized: invalid token' }`
- 401: `{ error: 'Unauthorized: token issued for different project' }`
- 403: `{ error: 'Forbidden: task management permission required' }` (POST and PATCH permission check)
- 400 (POST): `{ error: 'Validation failed', issues: parsed.error.flatten() }`
- 400 (PATCH): `{ error: 'Invalid request', details: parsed.error.flatten() }`
- 400: `{ error: 'Invalid final deadline' }` and `{ error: 'Final deadline must be in the future' }` (POST only)
- 403 (banned assignee): `{ error: 'Cannot assign workflows to banned users', message: 'The following user is banned: <name>. Please select different assignees.' }`
- 403 (invalid assignee): `{ error: 'Cannot assign workflows to invalid users', message: <statusCheck.error or 'User <name> is not valid for assignment.'> }`
- 404 (PATCH): `{ error: 'Step not found' }`
- 500 (catch-all): `{ error: 'Internal Server Error', details: <message> }`

---

## 6. DELETE or duplicate endpoint status

Confirmed absent. Facts:
- `grep "^export async function" route.ts` returns exactly three handlers: POST (line 82), GET (line 273), PATCH (line 544).
- `src/app/api/workflows/` contains only `route.ts`; no `[id]` directory exists.
- The word "duplicate" appears once, only in a log line: `console.warn('[workflows:POST] Duplicate step titles detected:', stepTitles);` (dedupe warning, not an endpoint).
- The word "delete" appears once, only as a JS object-key operation: `delete updatesToApply.assigneeIds;` (removes an empty array before persisting).
- No Firestore delete calls exist anywhere in this route; nothing in the file removes a workflow, a step task, or a `workflow_members` doc.
- Builders adding DELETE or duplicate must create them from scratch; there is no existing pattern to copy in this route.

---

## Notes for builders
- Because there is no workflow document, a DELETE workflow operation would need to delete all `tasks` where `workflowId == X`, plus `workflow_members/{X}_{uid}` docs, and decide what to do with `users/{uid}.tasksAssignedCount` counters (POST increments them; no existing decrement path).
- The `workflowId` is a client-supplied string (from `CreateWorkflowSchema.workflowId`), not an auto-generated doc id; duplicate workflowIds across POSTs would merge into one virtual workflow. There is no uniqueness check.
- PATCH merges updates via `d.ref.set({ ...updatesToApply, updatedAt: serverTimestamp }, { merge: true })`; it does not validate the `status` value or transition rules.
- For a per-step DELETE (delete one step), builders must decide how to handle `sequenceIndex` gaps and `isCurrentStep` advancement; the current code only ever sets `isCurrentStep` true for step 0 at creation and never advances it in this route.
