# Supa rebase notes — tasks cluster, group 2 (secondary task routes)

Branch: feat/supa-tasks-2, base 4d5a1e16 (feat/integration-wave3).
Surface string: exactly 'tasks'.
Seam: src/lib/supa/seam-tasks-lists.ts — the ONE seam for this group; all five
route files call only the seam, zero direct adapter references elsewhere.

## Adapter contract + merge-time re-point

The adapter (src/lib/supa/) is NOT in this base. The seam reaches it through a
lazy dynamic import via a VARIABLE specifier (`const specifier: string =
'@/lib/supa'; await import(specifier)`) typed against the locally declared
`SupaAdapterLike` interface in seam-tasks-lists.ts, so tsc stays clean while
the module is absent and the loader resolves to null when unavailable.
MERGE-TIME RE-POINT (verify, no code change expected):
- src/lib/supa/index.ts must export `getSupaAdapter()` and `useSupa(surface)`
  with these shapes (matching wt-supa-adapter's adapter.ts/flags.ts):
  getDoc(collectionPath, id) -> {id, ...data} | null;
  listDocs(collectionPath, {where, orderBy, limit, startAfter}) -> {id, ...data}[];
  countDocs(collectionPath, where?) -> number;
  setDoc(collectionPath, id, data, {merge?}?) / updateDoc(collectionPath, id, updates)
  / deleteDoc(collectionPath, id), over fs_<collection> jsonb tables
  (subcollections as 3-segment paths, e.g. 'tasks/{id}/activity',
  'users/{uid}/notifications').
- If the landed module exports different names, change ONLY the loader in
  seam-tasks-lists.ts; routes never reference the adapter.
- Fallback chain everywhere: flag OFF (SUPA_SURFACES lacks 'tasks'/'*') /
  module absent / adapter factory throws / any adapter operation errors ->
  the seam helper returns null and the route runs EXACTLY today's Firestore
  code (the original code is preserved verbatim in every route as the
  fallback branch). The seam also has a local flag parser mirroring
  flags.ts semantics in case the landed module lacks useSupa.

## Per-file changes (what re-applies onto the defect-fixed tree)

### src/app/api/tasks/team/route.ts
- Hunk 1 (imports): add the seam import block (getUserDocViaSeam,
  listDocsViaSeam, listTasksViaSeam, teamChapterWhereClause,
  type SupaWhereClause) after the chapter-scoping import.
- Hunk 2 (new helpers, inserted before getUserNames): getSubordinateIdsSupa
  (BFS twin: reporting_relationships managerId 'in' chunk + users managerId
  'in' chunk, chunks of 10, maxDepth 10, same visited/order semantics;
  returns null on any seam null) and getUserNamesSupa (per-id getDoc on
  'users'; returns null on any seam null). Pure insertions.
- Hunk 3 (GET, caller doc): `seamUserSnap ?? Firestore get` for users/{userId}.
- Hunk 4 (GET, subordinates): `getSubordinateIdsSupa(userId) ?? getSubordinateIds(db, userId)`.
- Hunk 5 (GET, task fetch): a seam block FIRST builds the same legs
  (assigneeId 'in' per chunk; assigneeIds 'array-contains' per member;
  assignerId '==' userId; createdBy '==' userId), each ANDed with
  teamChapterWhereClause(userScopeData) (see chapter note below); all legs
  must return non-null or the whole block is discarded. The ORIGINAL
  Firestore block (applyChapterScope + Promise.all) follows verbatim under
  `if (!taskSnaps)`.
- Hunk 6 (GET, names): `getUserNamesSupa(...) ?? getUserNames(db, ...)`.
- Chapter scope: applyChapterScope is called by this route WITHOUT a uid,
  so its legacy branch runs (DEFAULT_ROLE_SCOPES, then resolveUserScope
  national fallback; 'global' = no filter; 'chapter' = chapterId == caller
  chapterId or the RESTRICTED_NO_CHAPTER sentinel from src/lib/scope.ts).
  teamChapterWhereClause in the seam reproduces exactly that branch from
  the same inputs/imports. If chapter-scoping's legacy branch changes,
  update teamChapterWhereClause in the same commit.

### src/app/api/tasks/review-queue/route.ts
- Hunk 1 (imports): seam import (getUserDocViaSeam, listTasksViaSeam).
- Hunk 2 (queue read): `listTasksViaSeam([['status','==','submitted-for-review']],
  {orderBy:{field:'submittedAt',direction:'desc'}, limit:100})` first;
  on null, the ORIGINAL Firestore query + its .catch no-order fallback,
  verbatim. KNOWN DIVERGENCE: the Firestore fallback exists because the
  ordered query fails when submittedAt is missing on legacy docs; the
  adapter orders by the text extraction (data->>'submittedAt') and does
  not fail that way, so on the Supa path docs without submittedAt sort by
  null text ordering instead of triggering a re-query. Accepted for
  migration parity of shapes; flag if product wants the fallback
  replicated as a second seam query.
- Hunk 3 (resolveSubmitter): `getUserDocViaSeam(uid) ?? Firestore get`.
- NOT migrated (stays Firestore on both paths): canValidateTask
  (src/lib/server/hierarchy.ts) walks reporting data internally; it is a
  shared helper outside this file group.

### src/app/api/tasks/approval-rate/route.ts
- Hunk 1 (imports): seam import (getApprovalRateViaSeam).
- Hunk 2 (compute): `getApprovalRateViaSeam(uid) ?? getLast10ApprovalRate(db, uid)`.
  The seam version runs the three Firestore legs (assigneeId '==',
  assigneeIds 'array-contains', submittedBy '==') via listDocs, dedupes by
  id, attributes via the SHARED resolveTaskSubmitterUid, and computes via
  the SHARED computeApprovalRate from src/lib/server/task-approval-rate.ts
  (that module is unchanged and shared by both paths). One seam leg
  failure returns null (full Firestore recompute) rather than a partial
  rate — deliberately stricter than the Firestore helper's per-leg
  tolerance, because the fallback is exact.
- NOT migrated: the canManageTasks gate (hasServerPermissionForUser,
  src/lib/server/permissions.ts) stays on Firestore on both paths.

### src/app/api/tasks/[id]/activity/route.ts
- GET Hunk 1 (imports): seam import (getTaskDocViaSeam, getUserDocViaSeam,
  listActivityViaSeam, mirrorSetViaSeam).
- GET Hunk 2 (task doc): seam ?? Firestore get.
- GET Hunk 3 (activity list): `listActivityViaSeam(taskId)` = listDocs on
  the 3-segment path `tasks/{taskId}/activity`, orderBy createdAt desc,
  limit 100; on null, the original subcollection query verbatim.
- GET Hunk 4 (user names): per-uid seam ?? Firestore get.
- POST Hunk 1 (task doc): seam ?? Firestore get.
- POST Hunk 2 (WRITE — mirror): the activity entry is written to Firestore
  exactly as today (serverTimestamp sentinel included), then mirrored via
  mirrorSetViaSeam(`tasks/{taskId}/activity`, activityRef.id, {...}) with
  createdAt as an ISO string (the sentinel cannot cross into jsonb) and
  the SAME generated id. Mirror failure never fails the request.
- POST Hunk 3 (manager name read): seam ?? Firestore get.
- POST Hunk 4 (WRITE — mirror): the rejection-feedback notification is
  written to Firestore exactly as today, then mirrored via
  mirrorSetViaSeam(`users/{assigneeId}/notifications`, notifRef.id, {...})
  with timestamp as an ISO string and the same id; the body string is
  hoisted into `notifBody` so both writes use identical text. Mirror
  failure never fails the request (and the whole notification block was
  already best-effort).

### src/app/api/tasks/[id]/validation/route.ts
- Hunk 1 (imports): seam import (getTaskDocViaSeam).
- Hunk 2 (task read): seam ?? Firestore get.
- WRITES: NONE. This route is GET-only (a capability check). The task
  brief's "validation decisions write task status" writes do NOT live in
  this file: decision writes (approve/reject status stamps) live in
  src/app/api/tasks/route.ts (group 1) and the universal-review route,
  outside this group. Nothing to mirror here.
- NOT migrated: canValidateTask stays on Firestore internally (see
  review-queue note).

## KNOWN LIVE FACT — team route has NO status filter (do not "fix")

At base, team/route.ts returns the caller's tasks + the whole reporting
subtree's tasks + everything they assigned/created, with NO status
filter, forever (completed/cancelled included). This migration preserves
that behavior byte-for-byte on both paths: the seam legs are exactly the
Firestore legs plus the chapter clause.
COLLISION / DEFECT-BRANCH INTERACTION: fix/tasks-status-semantics is
fixing this separately and merges FIRST. When that fix lands, its
terminal-status exclusion (whatever literal set it adopts) must be
applied IDENTICALLY in the seam query legs in Hunk 5 above — i.e. re-apply
this file's hunks onto the defect-fixed tree and add the same status
exclusion to both the Firestore legs and the seam legWheres array. The
tests in supa-group2-team-review.test.ts pin the CURRENT (unfiltered)
behavior; update them in the same commit as the defect rebase.
fix/tasks-profile-board: no file in this group overlaps its surfaces
(profile board lives in the group-1 tasks route / profile code); if it
touches team/route.ts, the same per-hunk re-apply above covers it.

## Status-literal inventory (every status literal this group touches)

team/route.ts (base line refs):
- 'pending' — default when data.status is missing (response shaping,
  base L133). Response shaping only, both paths.
- 'completed' — isOverdue exclusion: `data.status !== 'completed'`
  (base L140). No other literal; NO status filter anywhere in the route.
review-queue/route.ts:
- 'submitted-for-review' — the queue query literal (base L52, L58; seam
  where clause carries the identical literal).
approval-rate/route.ts + seam (via shared task-approval-rate.ts):
- Decided set: 'completed', 'approved', 'rejected', 'changes-requested'.
- Approved set: 'completed', 'approved'. (This is the 'completed' vs
  'approved' spelling collision: both spellings count as approvals
  because /api/tasks stamps 'completed' while universal-review stamps
  'approved'. Preserved faithfully, shared module unchanged.)
- Explicitly excluded by the shared helper: 'pending', 'in-progress',
  'submitted-for-review', 'overdue' (display-only, never persisted),
  'cancelled' (no writer sets it).
[id]/activity/route.ts:
- 'completed' — silence signal: `status !== 'completed'` means the task
  is incomplete (base L64).
- Activity type literals (not task statuses): 'comment', 'rejection',
  'feedback'; notification type 'task_feedback'.
[id]/validation/route.ts:
- NO task status literal in the route itself. Status semantics flow
  through canValidateTask (hierarchy.ts, unchanged, outside this group).

## Timestamp consumer inventory (.toDate()/Timestamp, base 4d5a1e16 lines)

team/route.ts:
- L126 serializeTs: `typeof ts.toDate === 'function'` -> toDate().toISOString()
  (consumes deadline, createdAt, completedAt).
- L140 isOverdue: `data.deadline.toDate?.()` inside new Date(...).
review-queue/route.ts:
- L103 toIso: `typeof v.toDate === 'function'` -> toDate().toISOString()
  (consumes submittedAt, individualDeadline ?? deadline).
[id]/activity/route.ts:
- L48: `data.createdAt?.toDate?.()` -> toDate().getTime() (activity rows).
- L65-66: `taskDataForSilence.createdAt?.toDate?.()` -> toDate().getTime()
  (task doc, silence baseline).
approval-rate/route.ts: none in the route; the shared
task-approval-rate.ts toMillis() consumes .toDate() on
approvedAt/rejectedAt/reviewedAt/completedAt/updatedAt/decidedAt/createdAt
on BOTH paths (the seam normalizes first, see below).
[id]/validation/route.ts: none.
Normalization: jsonb timestamps arrive as ISO strings (or
{seconds, nanoseconds}). The seam's normalizeDocData wraps the known
top-level timestamp fields (createdAt, updatedAt, deadline,
individualDeadline, submittedAt, completedAt, approvedAt, rejectedAt,
reviewedAt, decidedAt, timestamp) into Timestamp-like objects exposing
toDate()/seconds/nanoseconds, so every consumer above behaves identically
on the Supa path. Nested objects are NOT normalized (no route in this
group consumes a nested timestamp). All other string fields pass through
untouched.

## Flows through untouched code (per brief)

- src/lib/server/gamification-transaction.ts: NOT touched, and no route
  in this group calls it directly; no seam at that layer from this group.
- src/app/api/tasks/route.ts (group 1) and src/app/api/workflows/route.ts:
  NOT touched.
- canValidateTask (hierarchy.ts) and hasServerPermissionForUser
  (permissions.ts): read Firestore internally on both paths; migrating
  them belongs to their owning clusters.

## Gates

- New tests: src/app/api/tasks/__tests__/supa-group2-team-review.test.ts
  (5 tests) + supa-group2-misc.test.ts (9 tests) + shared fakes
  supa-group2-fakes.ts — flag OFF parity + flag ON mocked-adapter reads
  per route, POST mirror assertions for activity.
- Existing touched suite: approval-rate route-parity (2 tests).
- tsc: see branch report for the count vs the 151 baseline.
- Zero live reads were performed; all data above is from the base tree.
