# Supa migration — Workflows+Missions cluster, Group 5 (wf-5)

Branch: `feat/supa-wf-5` off `feat/integration-wave3` @ `4d5a1e16`.
Scope: the read inputs of the workflow DETAIL route —
`GET /api/workflows?workflowId=` in the PINNED file
`src/app/api/workflows/route.ts` — i.e. the data chain behind the
PDF export: the handler assembles
`{ ok, tasks, progress, analytics, assigneeInfo, chapterName }`
(consumed by `src/components/admin/workflows/missions-tab.tsx`
`handleExportPDF` and `src/lib/workflow-pdf-export.ts`).

PINNED-FILE LAW held on this branch: `src/app/api/workflows/route.ts`
and `src/lib/gamification-transaction.ts` are byte-identical to base
(verified at the end of this work:
`git diff 4d5a1e16 -- src/app/api/workflows/route.ts` = empty,
same for gamification-transaction.ts). The route wiring is
merge-plan step 17's act, not this group's. This group delivers the
seam step 17 will call, plus the contract proof that the baseline
chain is intact.

Adapter contract (landed on `feat/supa-adapter` @ 85e657f + f7defc3,
NOT merged/cherry-picked into this branch):

```ts
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
// gate: if (useSupa('workflows') && getSupaClient()) { getSupaAdapter()... }
// ops: getDoc / listDocs / countDocs / setDoc / updateDoc / deleteDoc
// getSupaClient() -> null when env unset (never throws); useSupa reads
// SUPA_SURFACES, case-insensitive, default OFF.
// SupaAdapterError / SupaUnavailableError -> fall back to Firestore.
```

All Supa access for this group goes through ONE seam module,
`src/lib/server/workflow-detail-supa.ts`. Because the adapter is not
in this tree (and must not be merged in), the seam loads
`@/lib/supa` lazily through a variable-specifier dynamic import
typed against a local mirror of the adapter interface — the wf-4 /
tasks-2 seam precedent — so tsc and jest stay green pre-merge. At
merge, once `src/lib/supa/` lands, the loader resolves the real
module and NO seam code change is needed: the seam's gate is exactly
`useSupa('workflows') && getSupaClient()`, then `getSupaAdapter()`.

## Inventory — the detail route's GET reads

All line numbers are the base file @ 4d5a1e16
(`src/app/api/workflows/route.ts`, GET at L340; the
`!workflowId` LIST branch at L350-447 is a different surface and is
NOT in this group's scope — see "Out of scope" below). The detail
branch runs L449-607; the response is returned at L604-606.

| # | Site (base line) | Read | Consumed as | Seam mapping |
|---|---|---|---|---|
| D1 | L451 | `db.collection('tasks').where('workflowId','==',workflowId).get()` | `snap.docs[]` of `{ id, data() }`; handler maps fields, runs `serializeTs` (L452-457) over deadline/individualDeadline/createdAt/updatedAt/completedAt/releasedAt, sorts by `sequenceIndex` (L458-475) | `listWorkflowTasksViaSupa(workflowId)` -> `adapter.listDocs('tasks', { where: [['workflowId','==',workflowId]] })`, returned as `{ docs: [{ id, data() }], empty }`. Unordered, like the Firestore query — the handler's own sort is untouched. |
| D2 | L489 (block L486-495) | `db.collection('chapters').doc(firstTaskWithChapter.chapterId).get()`, first task (post-sort) carrying a `chapterId` | `chapSnap.exists`, `chapSnap.data()?.name` -> top-level `chapterName`. Wrapped in try/catch: a throw leaves `chapterName = null` | `getWorkflowChapterViaSupa(chapterId)` / aggregate field `workflowChapterSnap` (null in the aggregate when no task carries a chapterId — the handler skips the read entirely). |
| D3 | L501-503 (block L498-546) | `Promise.all(uniqueAssigneeIds.map(uid => db.collection('users').doc(uid).get()))`; `uniqueAssigneeIds` derived at L481 from both assignee forms via `taskAssigneeIds` (L477-480): `assigneeIds[]` if non-empty else `[assigneeId]` | each snapshot's `.id`, `.exists`, `.data()` -> `assigneeInfo[uid]` (name/photoURL/position/role/whatsapp/email/chapterName with the fallbacks at L524-534); a missing user yields `assigneeInfo[uid] = { name: uid }` | `getWorkflowUserViaSupa(uid)` per uid / aggregate fields `uniqueAssigneeIds` + `userSnaps` (parallel order). The derivation is mirrored purely by `detailTaskAssigneeIds(task)`. |
| D4 | L516 (block L506-528) | `db.collection('chapters').doc(chapterId).get()` per user whose doc has a `chapterId` and NO `chapterName`, deduped via `chapterCache` | `chapSnap.exists`, `(chapSnap.data())?.name` -> the user's `chapterName` in `assigneeInfo` | `getWorkflowChapterViaSupa(chapterId)` / aggregate field `userChapterSnaps: Record<chapterId, snap>`, pre-filled under exactly the handler's cache condition (chapterId present, chapterName absent, first-seen wins). |
| D5 | L569 | `db.collection('roles').doc(decoded.uid).get().catch(() => null)` | `roleSnap && roleSnap.exists ? String(roleSnap.data()?.role || '') : ''` -> `liveRole` -> `isAdmin` (masking input). A failed/missing read falls back to the token claim `decoded.role` | `getWorkflowRoleViaSupa(viewerUid)` / aggregate field `roleSnap`. Seam semantics preserve both handler cases: adapter doc missing -> `{ exists: false }` (claim fallback); seam null -> step 17 keeps the Firestore read (which itself may yield null). |
| D6 | L576-578 | `db.collection('workflow_members').doc(memberId).get()`, `memberId = ${workflowId}_${decoded.uid}` (L576) | ONLY `memberDoc.exists` -> `isWorkflowMember` -> `canViewContact = isAdmin \|\| isParticipant \|\| isWorkflowMember`; when false, L583-588 null `assigneeWhatsapp`/`assigneeEmail` on every task (assigneeInfo is NOT masked — pinned current behavior) | `getWorkflowMemberViaSupa(workflowId, uid)` / aggregate field `memberSnap`. The seam returns the full snapshot shape even though only `.exists` is consumed today. This is the wf-4 membership surface (their M2): the same doc the wf-4 inventory deferred to step 17. |

Not reads, unchanged by any wiring: `computeWorkflowProgress`
(statuses -> progress, L592), the `analytics` literal (L595-602),
the response shape and `Cache-Control: private, max-age=60,
stale-while-revalidate=300` header (L604-606).

Timestamp note: the seam passes adapter data through VERBATIM.
D1's `serializeTs` already accepts all three shapes the data can
arrive in — a Timestamp (`toDate()`), a `{ seconds }` object, or an
ISO string (returned as-is) — and the adapter fix-wave ruling puts
ISO normalization in the kit + Timestamp rehydration in the
adapter, so no revival is needed or performed in the seam. The
wf-6 contract suite (copied in, below) proves the route's response
is byte-identical for Firestore-shaped (Timestamp) and jsonb-shaped
(ISO string) inputs.

## What was built

- `src/lib/server/workflow-detail-supa.ts` (new): the one seam.
  Exported surface:
  - `getWorkflowsSupaAdapter()` — the gate
    (`useSupa('workflows') && getSupaClient()` -> `getSupaAdapter()`),
    null on any failure.
  - `listWorkflowTasksViaSupa(workflowId)` -> D1 snapshot | null.
  - `getWorkflowUserViaSupa(uid)` -> D3 snapshot | null.
  - `getWorkflowChapterViaSupa(chapterId)` -> D2/D4 snapshot | null.
  - `getWorkflowRoleViaSupa(uid)` -> D5 snapshot | null.
  - `getWorkflowMemberViaSupa(workflowId, uid)` -> D6 snapshot | null.
  - `fetchWorkflowDetailReadsViaSupa(workflowId, viewerUid)` ->
    `WorkflowDetailReads | null`: the whole chain in the handler's
    derivation order (tasks -> first-task chapter -> users ->
    per-user chapters -> viewer role -> membership doc). Returns
    null if ANY read is unavailable/throws, so step 17 never mixes
    stores mid-response.
  - `detailTaskAssigneeIds(task)` — pure mirror of L477-480.
  - `__setWorkflowDetailSupaLoaderForTests(loader)` — test injection.
  - Types: `SupaAdapterLike`, `SupaDoc`, `SupaDocSnapshotLike`
    (`{ id, exists, data() }`), `SupaQuerySnapshotLike`
    (`{ docs: [{ id, data() }], empty }`), `WorkflowDetailReads`,
    `SupaLoader`, `SupaWhereClause`, `SupaListOptions`,
    `SupaOrderSpec`; constants `WORKFLOWS_SUPA_SURFACE` +
    the five collection names.
  - Null-vs-empty law: gate failure / adapter throw -> null
    (Firestore fallback). Empty store -> REAL empty results
    (`{ docs: [], empty: true }`, `{ exists: false,
    data: () => undefined }`), never null — step 17 can distinguish
    "not in Supa" from "Supa unavailable".
- Copied UNMODIFIED from `feat/supa-wf-6` (byte-identical, verified
  with diff at copy time):
  - `src/lib/__tests__/supa-wf-fixtures.ts` (shared fixtures +
    fake adapter module builder).
  - `src/app/api/workflows/__tests__/supa-pdf-export-data.contract.test.ts`
    (465 lines: chain contract, masking pins incl. the D6
    membership gate, flag-state behavior). Passes unmodified on
    this branch — proof the baseline chain is intact.
- `src/lib/server/__tests__/workflow-detail-supa.test.ts` (new,
  mocked only): (a) adapter consultation — flag ON + the fixtures'
  fake adapter, seam output deep-equals the fixture doc sets after
  the jsonb round-trip, for tasks/users/chapters/roles/
  workflow_members, individually and through the aggregate;
  (b) the membership-gate case — a workflow_members doc ALONE (the
  viewer is not an assignee of any step) is surfaced faithfully
  (`exists` + full data), and a doc for a different workflow is not;
  (c) flag ON + adapter throws -> null everywhere; flag OFF (or a
  different surface) -> null with the adapter never consulted
  (`state.calls` stays empty); flag ON + empty store -> empty sets,
  NOT null.

## Step-17 wiring instructions (for the coordinator)

The minimal diff to `src/app/api/workflows/route.ts` at step 17.
Everything not mentioned stays exactly as-is; in particular the
LIST branch (L350-447), POST, PATCH, auth, `serializeTs`, the
task mapping/sort, `assigneeInfo` assembly, masking, progress and
analytics computation, and the response (shape + headers) are
untouched.

1. Add one import at the top of route.ts:

   ```ts
   import { fetchWorkflowDetailReadsViaSupa } from '@/lib/server/workflow-detail-supa';
   ```

2. In the detail branch, immediately after L450
   (`const decoded = auth.decoded;`), insert:

   ```ts
   const supaReads = await fetchWorkflowDetailReadsViaSupa(workflowId, decoded.uid);
   ```

3. Replace ONLY the read expressions, each guarded by `supaReads`
   (when it is null the Firestore expression runs verbatim):

   - L451: `const snap = supaReads ? supaReads.tasksSnap : await db.collection('tasks').where('workflowId', '==', workflowId).get();`
     (the seam's snapshot exposes the same `.docs[].{id,data()}`
     shape the L458 map consumes).
   - L489: `const chapSnap = supaReads ? supaReads.workflowChapterSnap! : await db.collection('chapters').doc(firstTaskWithChapter.chapterId).get();`
     (non-null whenever this block runs: the aggregate fetched it
     for exactly the first task carrying a chapterId).
   - L501-503: `const userSnapshots = supaReads ? supaReads.userSnaps : await Promise.all(uniqueAssigneeIds.map(uid => db.collection('users').doc(uid).get()));`
     (`userSnaps` is parallel to the L481 `uniqueAssigneeIds` —
     the aggregate derives the ids with the same L477-480 rule;
     keep the handler's own derivation for the response fields).
   - L516: inside the cache-miss branch, `const chapSnap = supaReads ? supaReads.userChapterSnaps[chapterId] : await db.collection('chapters').doc(chapterId).get();`
     and treat a present `userChapterSnaps[chapterId]` as a cache
     hit (the aggregate pre-filled exactly the handler's cache
     keys). The snapshot may have `exists: false` — the handler's
     existing `if (chapSnap.exists)` guard handles it.
   - L569: `const roleSnap = supaReads ? supaReads.roleSnap : await db.collection('roles').doc(decoded.uid).get().catch(() => null);`
   - L577: `const memberDoc = supaReads ? supaReads.memberSnap : await db.collection('workflow_members').doc(memberId).get();`

4. Do NOT change the `.catch(() => null)` semantics of D5 on the
   Firestore path, and do not "improve" the masking asymmetry
   (assigneeInfo unmasked) in the same step — both are pinned by
   the contract suite.

That is the entire step-17 diff for this surface: 1 import, 1
inserted line, 6 guarded read expressions.

## Faithfulness — what the seam could NOT reproduce

Nothing in the detail chain's read pattern resisted reproduction:
all six reads are one-shot gets / one filtered list, and every
consumed shape (`snap.docs[].data()`, `.exists`, `.data()?.name`,
`.data()?.role`, `.exists`-only) maps 1:1 onto adapter
`listDocs`/`getDoc` results. Two honest caveats, neither a seam
defect:

- D3's Firestore path fetches users with `Promise.all` (parallel);
  the aggregate fetches sequentially for deterministic failure
  semantics (any failure -> whole-chain null). Result sets are
  identical; only latency profile differs, and only on the Supa
  path.
- D2/D4's Firestore reads sit inside try/catch blocks that swallow
  errors per-read (a chapter failure degrades to a missing name,
  never a 500). The seam's all-or-nothing aggregate instead falls
  back to the ENTIRE Firestore chain on any adapter error — a
  superset of the current degradation behavior, never a subset:
  no input the handler can consume today becomes unavailable.

## Out of scope / not copied

- The LIST branch (`!workflowId`, L350-447): its tasks read
  (`where workflowId != null` + `orderBy workflowId`, L353-356) and
  the `hasServerPermissionForUser` visibility check (L435-436)
  belong to a different surface (admin list view); the wf-6
  contract suite pins only the detail chain. Not seamed here.
- POST (workflow creation, incl. the L321-331 workflow_members
  batch writes — wf-4's M1) and PATCH (L653 task query, L688/L695
  user/chapter gets): pinned-file writes/other surfaces, untouched.
- `supa-workflows-probe.test.ts` (on wf-6) is a MERGE-TREE GATE,
  not copied here: it `jest.mock`s `@/lib/supa`, which cannot
  register while the module is absent from this branch. It belongs
  to the merged tree where `src/lib/supa/` exists; copying it in
  would fail module resolution on this branch. Do not copy it in
  during rebase either — it arrives with wf-6's branch at merge.

## Gates (run 2026-10-25, all mocked, zero live reads)

- Contract suite (copied, unmodified):
  `src/app/api/workflows/__tests__/supa-pdf-export-data.contract.test.ts`
  — 14/14 green (chain payload, timestamp serialization, personnel
  fields, assigneeInfo, Firestore-vs-jsonb byte identity, assembled
  WorkflowPDFData identity, real-exporter QR payloads, 3 masking
  pins, 4 flag-state pins).
- Seam tests: `src/lib/server/__tests__/workflow-detail-supa.test.ts`
  — 14/14 green.
- Pre-existing workflows route suites in the tree, still green:
  `route-parity.test.ts` + `route-assignment-notifications.test.ts`
  (with the seam suite: 3 suites, 24 tests, all passing).
- Scoped tsc (temp tsconfig extending the repo config, include =
  the seam, its tests, the fixtures, the contract suite): ZERO
  errors in any touched file. The only errors in the scoped run are
  6 pre-existing TS1117 duplicate-property errors in untouched
  baseline files `src/config/permission-registry.ts` (3) and
  `src/config/permissions.config.ts` (3), pulled in via the route's
  import graph — part of the repo's known 151-error baseline, to be
  re-measured at the merge gate (full-repo tsc not run here, per
  the wf-4 precedent on sandbox heap limits).
- Pinned files: `git diff 4d5a1e16 -- src/app/api/workflows/route.ts`
  empty; `git diff 4d5a1e16 -- src/lib/gamification-transaction.ts`
  empty.
- Environment note: this worktree had no node_modules; tests ran
  against a symlink to the wf-6 worktree's node_modules (jest
  29.7.0). The symlink is gitignored and not part of any commit.
