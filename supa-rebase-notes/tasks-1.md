# Supabase migration — rebase notes: tasks cluster, group 1 (main tasks route)

Branch: `feat/supa-tasks-1`, built against `feat/integration-wave3 @ 4d5a1e16`.
File group: `src/app/api/tasks/route.ts` ONLY, plus the new seam module
`src/lib/supa/seam-tasks-route.ts` and its tests. No merge, no push, no deploy.

Commits:
- `8bd6e34` docs(supa-tasks): rebase notes skeleton
- `a2481a6` feat(supa-tasks): seam for main tasks route

## Adapter contract (programmed against, not present in this tree)

- The real adapter is being built in parallel at `src/lib/supa/` (surface
  string for this cluster: `tasks`).
- Contract: `getDoc(collection, id)`, `listDocs(collection, {where:
  [[field, op, value]...], orderBy, limit, startAfter})`,
  `countDocs(collection, where)`, `setDoc(collection, id, data)`,
  `updateDoc(collection, id, data)`, `deleteDoc(collection, id)` over
  `fs_<collection>` tables; results are Firestore-shaped plain objects
  `{id, ...data}`.
- MERGE-TIME ACTION 1: the seam reaches the adapter via a lazy dynamic
  import through a variable specifier (env `SUPA_ADAPTER_SPECIFIER`,
  default `@/lib/supa/adapter`) in `loadAdapterModule()` in
  `src/lib/supa/seam-tasks-route.ts`. At merge time re-point that default
  at the real `@/lib/supa/adapter` and confirm its export shape (the seam
  accepts `default`, `adapter`, or the module namespace, and validates
  that listDocs/setDoc/deleteDoc exist). No `@supabase/supabase-js`
  import anywhere in this group.
- MERGE-TIME ACTION 2: the seam implements the flag locally as
  `isTasksSupaFlagOn()` reading the `SUPA_SURFACES` env list (default OFF).
  If the adapter ships its own `useSupa(surface)`, swap that one function
  body to call it with `'tasks'`.
- MERGE-TIME ACTION 3 (assumption to verify against the real adapter):
  the seam passes `orderBy` as a `[field, direction]` tuple, `startAfter`
  for the GET tier-1 cursor as an ISO string for `createdAt`, and where
  operators as Firestore spellings (`==`, `array-contains`). If the real
  adapter's vocabulary differs, translate inside the seam only — the route
  file must not change.

## Design summary

- ALL Supabase access for this route lives in
  `src/lib/supa/seam-tasks-route.ts`. The route file references only the
  seam's exported functions/types; zero adapter/Supabase references.
- Flag OFF, adapter absent/unconfigured, or adapter load failure:
  `resolveTasksSupaAdapter()` returns null and behavior is exactly the
  pre-migration Firestore behavior (response shapes, status codes, error
  bodies untouched). Mirror helpers do not even invoke their re-read
  fetcher when the adapter resolves null, so flag-OFF requests pay zero
  extra reads.
- Flag ON: GET list reads via the seam; POST/PATCH/DELETE execute on
  Firestore exactly as today and then mirror (master doc re-read + setDoc,
  step docs re-read + setDoc, deletes via deleteDoc). Mirror functions
  never throw; failures are logged (`[supa-seam:tasks]`) and the request
  proceeds.

## Per-file sections

### src/lib/supa/seam-tasks-route.ts (new, 368 lines)

- `TasksSupaAdapter` interface: the contract above, declared locally.
- `isTasksSupaFlagOn(env)`: `SUPA_SURFACES` comma list contains `tasks`.
- `resolveTasksSupaAdapter()`: flag-gated, lazy dynamic import via a
  variable specifier, cached promise, contract shape check; test hooks
  `__setTasksSupaAdapterForTests` / `__resetTasksSupaAdapterForTests`
  (injection still respects the flag, so flag-OFF is provably pure).
- Timestamp normalization: `normalizeTaskDocData()` wraps the fields in
  `TASK_TIMESTAMP_FIELDS` (createdAt, updatedAt, deadline,
  individualDeadline, completedAt, releasedAt, submittedAt, approvedAt,
  rejectedAt, acceptedAt, startedAt, availabilityConfirmedAt,
  lastTaskAssignedAt), plus `acceptanceBy.*.acceptedAt` and
  `feedback_history[].timestamp`, into `SeamTimestamp` values
  ({seconds, nanoseconds, toMillis(), toDate(), toISOString()}) whenever
  the jsonb value is an ISO string or a {seconds, nanoseconds} /
  {_seconds, _nanoseconds} object. Null stays null; non-date strings are
  left untouched.
- `toSnapshotDoc()`: adapts a plain `{id, ...data}` row to the
  `{id, exists, data(), get(field)}` shape the route already consumes.
- `listTasksDocs(adapter, options)`: throws if `limit` is not a finite
  positive number (an unbounded read through the seam is a programming
  error, not a fallback); otherwise forwards where/orderBy/limit/
  startAfter to `adapter.listDocs('tasks', ...)` and snapshot-wraps rows.
- Mirror: `mirrorTaskDocById(id, fetchData)`,
  `mirrorTaskDocsByIds(ids, fetchDataById)`,
  `mirrorTaskDeletesByIds(ids)` — all never-throw, all no-ops when the
  adapter resolves null. `sanitizeForMirror()` deep-converts Dates and
  Timestamp-like values (`.toDate()`) to ISO strings and drops
  FieldValue sentinels (objects carrying `_methodName`: serverTimestamp,
  increment, delete, arrayUnion) and undefined values, since jsonb cannot
  represent them. NOTE: a mirrored doc therefore lacks any field whose
  only write was a serverTimestamp sentinel resolved server-side — the
  mirror re-reads the committed Firestore doc, so in practice the fields
  arrive as real Timestamps and convert cleanly; the sentinel drop only
  bites if a caller ever mirrors an uncommitted payload.

### src/app/api/tasks/route.ts (2,115 -> 2,229 lines)

Per-hunk re-application list for the rebase onto the defect-fixed tree.
Every hunk is a call-site swap or a one-line mirror call; no logic,
validation, status code, or response shape was changed.

- H1 (import, ~line 13): import `resolveTasksSupaAdapter`,
  `listTasksDocs`, `mirrorTaskDocById`, `mirrorTaskDocsByIds`,
  `mirrorTaskDeletesByIds`, types `SupaWhereClause`, `SeamSnapshotDoc`
  from `@/lib/supa/seam-tasks-route`. Re-apply verbatim.
- H2 (`handleUpdate`, step-write path, ~line 622): declare
  `const createdStepIds: string[] = [];` right after
  `delete updatesToApply.steps;`. Re-apply verbatim.
- H3 (`handleUpdate`, new-step branch, ~line 713):
  `createdStepIds.push(stepRef.id);` after
  `const stepRef = db.collection('tasks').doc();`. Re-apply verbatim.
- H4 (`handleUpdate`, completion path, ~line 924): after the gamification
  transaction succeeds and before the success return, three mirror calls:
  master (`mirrorTaskDocById(taskId, re-read via taskRef.get())`), steps
  (`mirrorTaskDocsByIds([...existing step ids from stepWrites,
  ...createdStepIds], re-read by id)`), removed steps
  (`mirrorTaskDeletesByIds(removedStepIds)`). INTERACTION RISK: the
  defect branch (`fix/tasks-status-semantics`) may reshape the completion
  / terminal-status flow around `executeGamificationTransaction`; the
  mirror must stay AFTER the transaction's successful return value is in
  hand and BEFORE the response, on whatever the post-fix success path is.
  The gamification module itself is NOT seamed (defect branch owns it).
- H5 (`handleUpdate`, normal path, ~line 1089): same three mirror calls
  immediately after the final `batch.commit()` try/catch (i.e. only on
  commit success; the DLQ/500 return inside the catch must stay
  mirror-free). INTERACTION RISK: if the defect fix moves the commit or
  adds early returns after it, mirrors belong after the last successful
  commit and before the response.
- H6 (`handleAcceptanceAction`, ~line 1314):
  `await mirrorTaskDocById(taskId, ...)` immediately after
  `await taskRef.update(updateData);`. Re-apply verbatim.
- H7 (`POST`, ~line 1768): `await mirrorTaskDocById(docRef.id, ...)`
  after the create activity log. The idempotency dedupe early-return is
  intentionally NOT mirrored (no write happened). The dedupe query
  itself (`.where('dedupeKey','==',...).limit(5)`) stays on Firestore in
  this wave — it is part of the write path, not the list read path.
- H8 (`GET`, ~line 1923): after cursor parsing, resolve
  `const supaAdapter = await resolveTasksSupaAdapter();` and build
  `supaWhere` alongside the Firestore constraints (status push at ~1926,
  projectId push at ~1944 inside the existing projectId branch).
- H9 (`GET` assignee branch, ~line 1955): when `supaAdapter` is present,
  the two union queries run through `listTasksDocs`, EACH bounded by
  `limit: limitParam`, wrapped as `{docs}`; on any seam error the code
  falls back to the original Firestore `Promise.all` (kept verbatim).
  NOTE: the Firestore shapes here are the pre-existing UNBOUNDED
  `.get()` calls (no limit) from the base tree — pre-existing behavior,
  left byte-identical on the Firestore path; the seam path is strictly
  bounded. Filtering/sort/cursor/limit slicing downstream is shared and
  unchanged (it consumes `data()`/`id`, which the seam's snapshot docs
  provide).
- H10 (`GET` main ladder, ~line 2067): `snap` redeclared as
  `let snap!: QuerySnapshot | { docs: any[] }`. When `supaAdapter` is
  present, the bounded ladder runs against the seam first:
  tier 1 `listTasksDocs({where: supaWhere, orderBy: ['createdAt','desc'],
  limit: limitParam, startAfter: cursor ISO string or undefined})`;
  tier 2 `{where: supaWhere, limit: limitParam}` + in-memory createdAt
  desc sort (same helper semantics as the Firestore tier 2); tier 3
  `{orderBy: ['createdAt','desc'], limit: limitParam}`. If all seam tiers
  throw, the ORIGINAL Firestore ladder runs verbatim (its internal
  tier 2/tier 3 and the outer-catch 500 are unchanged). INTERACTION
  RISK (highest in this group): `fix/tasks-status-semantics` is expected
  to touch status semantics — if it changes the terminal-status filters
  or the status constraint construction in GET, re-derive `supaWhere`
  from the NEW constraint code so the seam filters match the Firestore
  filters exactly, and re-check the tier-2 in-memory sort and tier-3
  unfiltered shape against the new ladder text. The invariant to
  preserve: whichever store serves, tier shapes and limits are identical
  and no tier is ever unbounded.
- H11 (`DELETE`, ~line 2205): `await mirrorTaskDeletesByIds([taskId]);`
  immediately after `await taskRef.delete();` and before the CRM counter
  decrement. Re-apply verbatim.

### Tests (new)

- `src/lib/supa/__tests__/seam-tasks-route.test.ts` (17 tests): flag
  parsing; flag OFF resolves null even with an adapter injected; flag ON
  returns the injected adapter; ISO / {seconds,nanoseconds} normalization
  incl. acceptanceBy; listTasksDocs limit forwarding, unbounded-limit
  rejection (adapter never called), error propagation; mirror sanitized
  setDoc payload; mirror failure tolerance (adapter throws, fetcher
  throws); flag OFF mirror performs no adapter call and never invokes
  the fetcher; delete mirroring with id dedupe; sanitizeForMirror.
- `src/app/api/tasks/__tests__/route-supa-seam.test.ts` (7 tests):
  flag OFF GET is the pure Firestore path (adapter untouched); flag ON
  GET serves from the seam with ISO-serialized timestamps and a correct
  nextCursor, Firestore query count 0; flag ON tier-1 failure degrades
  to seam tier 2 with every seam query bounded; flag ON total seam
  failure falls back to the Firestore ladder; DELETE mirrors on success,
  tolerates a throwing mirror, and does not mirror when flag OFF.

## Supporting Firestore reads that stay on Firestore in this wave

Only the `tasks` collection's list reads (GET) route through the seam;
only `tasks` doc writes/deletes are mirrored. Everything else below
remains a Firestore dependency of this route (known, intentional):

- Auth/permission: `roles/{uid}` doc get in PATCH/PUT, POST, GET;
  `hasServerPermissionForUser`, `assertChapterAccess` internals.
- POST: assignee `users/{uid}` doc gets inside the validateUserStatus
  failure branches and the covering-officer lookups; assigner
  `users/{uid}` get; per-assignee `users/{uid}` gets for email;
  `users/{uid}` counter sets; `projects/{id}` counter set;
  `workflow_members` batch sets; `tasks/{id}/activity` add; the dedupe
  query on `tasks` (write-path check, stays Firestore, see H7);
  `notifyAcceptanceRequest` internals.
- PATCH/PUT (`handleUpdate`): the task doc get (before-state) on
  Firestore — PATCH semantics (optimistic concurrency, validation gate,
  gamification transaction) all read the Firestore doc, not the seam;
  `roles/{uid}` get; step-assignee `users/{uid}` gets; the
  workflow-steps query `tasks.where('workflowId','==',...)` used for
  sequenceIndex allocation (a tasks-collection read that stays on
  Firestore in this wave — bounded only by the workflow, note for the
  next wave); step doc gets for membership guards; user counter sets in
  the batch; the gamification transaction's own reads/writes
  (`executeGamificationTransaction`, defect branch owns that module);
  DLQ writes to `dlq_points_retry`; notification user-doc gets.
- Acceptance (`handleAcceptanceAction`): task doc get/update on
  Firestore (mirror only after the update); activity subcollection add;
  validator-chain helpers' reads.
- DELETE: task doc get, permission/chapter helpers, `users/{uid}`
  counter set — all Firestore; only the delete itself is mirrored.
- GET: the `roles/{uid}` get and permission check stay Firestore.

## Timestamp (.toDate() / Timestamp arithmetic) sites on seam-served docs

Seam-served docs only reach consumers inside GET (this route) in this
wave, because PATCH/POST/DELETE before-state reads stay on Firestore.
Sites that consume seam-served docs (line numbers on the migrated tree):

- `src/app/api/tasks/route.ts:1994` — assignee branch `createdAtMs`:
  calls `ts.toMillis()` and reads `ts.seconds`. Covered by seam
  normalization (SeamTimestamp implements both).
- `src/app/api/tasks/route.ts:2007` — assignee branch `serializeTs`:
  calls `ts.toDate()` when present, else reads `ts.seconds`, else passes
  the value through. Seam values hit the `.toDate()` path and serialize
  to the same ISO strings the Firestore path produces.
- `src/app/api/tasks/route.ts:2113` — main ladder tier-2 `createdAtMs`
  (Firestore path only) and `:2075` — seam tier-2 `seamCreatedAtMs`
  (same contract). Covered.
- `src/app/api/tasks/route.ts:2128` — main list `serializeTs`: same as
  the assignee branch. Covered.
- `src/app/api/tasks/route.ts:2149-2150` — `last.get('createdAt')` +
  `lastCreated.toMillis()` for nextCursor: the seam snapshot doc's
  `get()` returns the normalized SeamTimestamp, so the cursor is the
  same epoch-ms string the Firestore path emits.
- `src/app/api/tasks/route.ts:398` — `handleUpdate` optimistic
  concurrency: `serverUpdatedAt.toDate()`. NOT seam-served in this wave
  (PATCH before-state reads Firestore), but if a later wave serves PATCH
  reads from the seam, normalization covers it — flagged here per the
  timestamp rule.
- `src/app/api/tasks/route.ts:1674` — POST dedupe `createdAt.toMillis()`.
  NOT seam-served (dedupe query stays Firestore); flagged for the same
  future-wave reason.
- Downstream consumers of the GET JSON response receive ISO strings on
  both paths already (the route serializes before responding), so no
  client `.toDate()` site is affected by which store served the list.

## Collision notes (defect branches merging before this branch)

- `fix/tasks-status-semantics` edits this route: expected interactions
  are H4/H5 (completion/terminal-status flow) and H10 (GET status
  filters/ladder). Both are flagged inline above. All other hunks are in
  code the defect branch is not expected to touch (imports, acceptance,
  POST create tail, DELETE).
- `fix/tasks-profile-board` edits assigned-tasks.tsx / task-management.ts
  — no file overlap with this group.
- `src/app/api/workflows/route.ts` and
  `src/lib/server/gamification-transaction.ts` were NOT touched.
