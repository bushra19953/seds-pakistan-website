# Supabase Migration — Tasks Cluster, Group 3: Admin Tasks Page Data Paths

Branch: `feat/supa-tasks-3`
Base: `feat/integration-wave3 @ 4d5a1e16`
Surface string (adapter flag `SUPA_SURFACES`): exactly `tasks`
Seam module (ONE for this group, server-side only): `src/lib/supa/seam-admin-tasks.ts`

Status: SKELETON — inventory first, implementation sections filled as commits land.

## Scope (file group)

- (a) `src/app/admin/tasks/page.tsx` — CLIENT side only. The task-list route
  (`GET /api/tasks`, group 1) is NOT touched.
- (b) `src/lib/task-management.ts` — client helpers `getAllTasks`,
  `getUserTasks` (the brief's "getTasksByUser": two unbounded assignee
  queries), `getTasksCreatedBy`, `getTask`.
- (c) `src/app/api/tasks/batch/route.ts` — bulk DELETE serving the page.
- (d) Picker/projects data the page consumes — INVENTORY ONLY unless a path
  reads Firestore task/user data directly (see inventory).

## Architecture rule

The adapter (`src/lib/supa/`, built in parallel, NOT in this base) is
SERVER-side (service key). Client components/helpers must NEVER import it or
hold Supabase credentials. Client data paths migrate by routing reads
through a server endpoint that uses the seam — the pattern the page already
follows for `/api/tasks` and `/api/users/picker`.

NEW server surfaces created by this group (flag-gated, seam-backed):
- `GET /api/tasks/by-user?userId=<uid>&mode=assigned|created` — serves the
  `getUserTasks` / `getTasksCreatedBy` query shapes, which have no existing
  server counterpart. Auth: Bearer ID token + `canManageTasks` permission
  when the seam is ON (mirrors the batch route's gate); when the flag is
  OFF the route answers 404 so today's behavior (direct client Firestore)
  is byte-identical and the endpoint is undiscoverable in production.
- `GET /api/tasks/all?limit=<n>` — serves `getAllTasks`. Same gating.
  NOTE boundedness: see the risk flag below.
- `GET /api/tasks/by-workflow?workflowId=<id>` — serves the page's
  edit-dialog workflow-steps query. Same gating.

Client-gate design note: client helpers cannot read the server-only
SUPA_SURFACES flag, so they attempt the endpoint only when a user is
signed in (the partners.ts getAuth() pattern); a 404 / any error falls
back silently to Firestore. Flag-OFF parity is in RESULTS and in the
Firestore path taken; the only flag-OFF difference is one inert 404
request per helper call in signed-in contexts.

## Collision boundary — src/lib/task-management.ts (CRITICAL)

`fix/tasks-profile-board` is editing this file RIGHT NOW (the `updateTask`
status-mapping fix: today non-whitelisted statuses incl. 'approved' /
'changes-requested' are force-mapped to 'in-progress' at lines 79-84) and
merges BEFORE this branch.

Boundary, hunk by hunk:
- This branch changes ONLY the data-FETCHING functions:
  `getTask`, `getAllTasks`, `getUserTasks`, `getTasksCreatedBy`
  (each gains an optional trailing options param + a seam-endpoint attempt
  with Firestore fallback).
- This branch does NOT touch, byte for byte:
  - `updateTask` (lines 70-92 in base, incl. the status-mapping block
    lines 79-84) — the defect branch owns it.
  - `createTask`, `deleteTask`, `calculateWorkflowDeadlines`,
    `recordAvailabilityConfirmation`, `isAvailabilityStale`,
    `requiresOnSite`, all interfaces/types.
- Expected rebase: the defect branch's `updateTask` hunk and this branch's
  fetch hunks are in disjoint regions of the file; a conflict inside
  `updateTask` during rebase means THIS branch drifted — resolve by taking
  the defect branch's `updateTask` wholesale.

## Data-path inventory (what the page actually consumes)

All lines against base 4d5a1e16, `src/app/admin/tasks/page.tsx` unless noted.

### Task list (scope a)
- L384 `fetchTasks()`: `GET /api/tasks?status&assigneeId&projectId&limit&cursor`
  — bounded (pageSize default 100), Bearer token. ALREADY server-mediated;
  the route is group 1's. NO client change needed or made.
- Response normalization L396-401 via `toDate()` from `@/lib/date-utils`
  (handles ISO strings, Dates, Timestamps) — already jsonb-safe.
- Other `/api/tasks` calls (group 1's route, untouched): DELETE L685,
  PATCH L710/L742, POST L834/L944/L1025; `POST /api/cron/check-deadlines`
  L426; `POST /api/workflows` L1164 (pinned route, untouched).

### task-management.ts imports in the page
- Imported L11-16: createTask, getAllTasks, updateTask, deleteTask, getTask.
  ONLY `getTask` is ever called (L514, edit dialog). The other four are
  DEAD IMPORTS (grep-verified, 0 call sites). Left untouched — not this
  wave's churn; planner may drop them with the getAllTasks follow-up.

### Direct Firestore reads remaining in the page (base)
- L514 `getTask(firestore, taskId)` — single-doc, bounded. task-management
  `getTask` left on Firestore in this wave (no single-doc endpoint in
  this group's surfaces; the edit flow's `.toDate()` guards also accept
  ISO strings, so a future seam switch needs no page change).
- L581-582 workflow-steps deep-fetch: `tasks where workflowId == orderBy
  sequenceIndex` — MIGRATED: page tries `GET /api/tasks/by-workflow`
  (NEW surface) first, falls back to the exact query on any non-OK.
- L1247 `getDocs(collection 'chapters')` — chapters, not task/user data;
  tiny, export-time only. INVENTORY ONLY.
- L1273 `getDoc(doc 'users', uid)` — single user doc per assignee,
  export-time only, the deliberate post-burn-fix design (picker rows
  carry no email/whatsapp; the PDF needs them). Bounded, intentional.
  INVENTORY ONLY — no users seam in this group.
- L1344 `getCustomRoleDefinitions(firestore)` — cached role definitions
  module. INVENTORY ONLY.

### task-management.ts helpers (scope b)
- `getAllTasks` L57-69 (base): UNBOUNDED `getDocs(collection 'tasks')`.
  Migrated: optional `{ limit }` param, seam-endpoint attempt, Firestore
  fallback byte-identical. See boundedness risk below.
- `getUserTasks` L111-131 (base; the brief's "getTasksByUser"): two
  UNBOUNDED queries (`assigneeId ==`, `assigneeIds array-contains`),
  deduped union. Migrated via `GET /api/tasks/by-user?mode=assigned`.
- `getTasksCreatedBy` L136-149 (base): `assignerId ==`. Migrated via
  `GET /api/tasks/by-user?mode=created`.
- Callers of all three across src/: NONE besides the page's dead import
  (grep-verified). The helpers are library surface, not page-hot paths.

### Batch route (scope c)
- `src/app/api/tasks/batch/route.ts` DELETE: auth (claims, then
  roles-doc + `hasServerPermissionForUser` fallback), max 500 ids,
  `db.getAll` per-id reads, one Firestore batch (task deletes + user
  `tasksAssignedCount`/`tasksCompletedCount` increment decrements).
  Migrated: after `batch.commit()`, seam mirror (deletes + absolute
  counter adjustments) when the adapter resolves; never fails request.

### Picker / projects (scope d) — burn-fix behavior preserved exactly
- Picker: L257 `GET /api/users/picker?limit=1000` (5-min server cache in
  the route; the page adds NO cache of its own and still honours the
  `users-updated` refresh event). userRoles derived from picker rows
  L289-292 — no roles collection read. UNCHANGED.
- Projects: L20/L315 `getAllProjectsCached(firestore)` from
  `src/lib/projects-cached.ts` (module cache, 5-min TTL, single-flight).
  It reads the `projects` collection client-side — projects are neither
  task nor user data, and rule 4 pins this path. UNCHANGED.
- Badges: page fetches none (TaskForm loads its own). UNCHANGED.

## Boundedness risk — getAllTasks (FOR THE MERGE PLANNER)

`getAllTasks` today is an UNBOUNDED full `tasks` getDocs with no limit.
This wave migrates it faithfully (call semantics unchanged for existing
callers) BUT the seam version accepts and forwards a `limit` parameter, and
the new `/api/tasks/all` endpoint requires/defaults a limit server-side.
The planner should schedule a follow-up to bound or retire `getAllTasks`
(it is imported by the admin tasks page at page.tsx:12 but never called
there — dead import, verified by grep).

## Timestamp consumers (.toDate() / Timestamp)

jsonb returns ISO strings. Seam-served docs are normalized by
`normalizeTaskDoc` in the seam (ISO string -> SeamTimestamp with
toDate/toMillis/toISOString/toJSON), and the by-user/all endpoints
serialize SeamTimestamps back to ISO strings, so every consumer below
keeps working on either path.

- page.tsx:521 `deadlineTs.toDate()` (edit dialog, from getTask)
- page.tsx:526 `createdAtTs.toDate()`
- page.tsx:531 `updatedAtTs.toDate()`
- page.tsx:538 `indDeadlineTs.toDate()` (individualDeadline)
- page.tsx:592 step `individualDeadline.toDate()` inside the workflow
  steps map — the by-workflow path returns ISO strings; this consumer
  already falls back to `new Date(ind)` when `.toDate` is absent.
- page.tsx:396-401 `toDate()` (date-utils) on deadline /
  individualDeadline / createdAt / updatedAt of /api/tasks list rows —
  already string-safe.
- task-management.ts:319 `isAvailabilityStale`: `instanceof Timestamp`
  check then `.toDate()`; accepts Date and string/number too — the
  flag-ON helper path revives ISO strings as Dates, covered.
- task-management.ts Timestamp.now() WRITES (unchanged, Firestore path
  only): createTask L23-24 (base), updateTask L86, 
  recordAvailabilityConfirmation L288/L293/L295.
- batch route: no timestamp consumers (FieldValue.increment only).

## Gates

- Touched jest suites green (incl. picker/combobox suites).
- New tests: flag-OFF parity for the helpers; flag-ON path with a MOCKED
  adapter at the server endpoint.
- tsc: zero NEW errors vs baseline 151.
- ZERO live reads. No merge / push / deploy.
