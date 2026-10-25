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

NEW server surface created by this group (flag-gated, seam-backed):
- `GET /api/tasks/by-user?userId=<uid>&mode=assigned|created` — serves the
  `getUserTasks` / `getTasksCreatedBy` query shapes, which have no existing
  server counterpart. Auth: Bearer ID token + `canManageTasks` permission
  when the seam is ON (mirrors the batch route's gate); when the flag is
  OFF the route answers 404 so today's behavior (direct client Firestore)
  is byte-identical and the endpoint is undiscoverable in production.
- `GET /api/tasks/all?limit=<n>` — serves `getAllTasks`. Same gating.
  NOTE boundedness: see the risk flag below.

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

(Filled in the inventory commit — file:line against base 4d5a1e16.)

## Boundedness risk — getAllTasks (FOR THE MERGE PLANNER)

`getAllTasks` today is an UNBOUNDED full `tasks` getDocs with no limit.
This wave migrates it faithfully (call semantics unchanged for existing
callers) BUT the seam version accepts and forwards a `limit` parameter, and
the new `/api/tasks/all` endpoint requires/defaults a limit server-side.
The planner should schedule a follow-up to bound or retire `getAllTasks`
(it is imported by the admin tasks page at page.tsx:12 but never called
there — dead import, verified by grep).

## Timestamp consumers (.toDate() / Timestamp)

(Filled in the inventory commit — file:line. jsonb returns ISO strings;
seam-served docs are normalized so these consumers keep working.)

## Gates

- Touched jest suites green (incl. picker/combobox suites).
- New tests: flag-OFF parity for the helpers; flag-ON path with a MOCKED
  adapter at the server endpoint.
- tsc: zero NEW errors vs baseline 151.
- ZERO live reads. No merge / push / deploy.
