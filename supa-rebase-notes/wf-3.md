# WF-3 rebase notes — workflow progress surface (feat/supa-wf-3)

Base: 4d5a1e16. Scope: `src/lib/workflow-progress.ts` (34 lines, pure) and
every place workflow progress is computed, with or without the helper.
**No production code was changed on this branch** — see the conversion
verdict below. This branch adds tests and this note only.

## What landed here

| Commit | Content |
|---|---|
| 2aba0c0 | wf-6 CONTRACT 2 suite + shared fixtures copied byte-identical (md5-verified against `wt-supa-wf-6`): `src/lib/__tests__/workflow-progress-supa-equivalence.test.ts`, `src/lib/__tests__/supa-wf-fixtures.ts`. Green UNMODIFIED: 35/35. |
| 9c35f264 | Supplement in a SEPARATE file (`workflow-progress-supa-extra.test.ts`) so the copied suite stays byte-identical: missing-`status`-key docs, true JSON round-trip (undefined keys dropped, explicit null survives), exact-match (case/whitespace-sensitive) status pins. 9 tests, all green, no pinned expectation changed. |

## Pinned semantics (CONTRACT 2, reference = current Firestore path)

From `src/lib/workflow-progress.ts`:

- work-done (`isStepWorkDone`) = `'completed'` | `'submitted-for-review'`
- approved (`isStepApproved`) = `'completed'` ONLY
- `progressPercentage` = `total > 0 ? Math.round(workDone / total * 100) : 0`
- `isCompleted` = `total > 0` AND every step `'completed'`
  (implemented as `approvedSteps === totalSteps`)
- Equivalence claim, proven by the copied suite: statuses from
  Firestore-shaped docs and from jsonb-round-tripped docs (timestamps
  become ISO strings; statuses are plain strings and survive verbatim)
  yield identical progress objects, across a 16-row status matrix
  including null / undefined / empty statuses and rounding rows.

## The 'approved' divergence pin — DO NOT unify here

| File | Treatment of status `'approved'` |
|---|---|
| `src/lib/workflow-progress.ts` (`isStepWorkDone` / `isStepApproved`) | Counts as NEITHER work-done NOR approved: 0% progress, not completed. |
| `src/lib/task-pdf-adapter.ts` (`COMPLETED_STATUSES = {'completed','approved'}`, lower-cased compare; `taskToWorkflowPDFData`) | Counts as DONE for a single task: `progressPercentage: 100`, `completedSteps: 1`, `isCompleted: true`. |

This divergence is deliberate and pinned on BOTH sides by the copied
suite ("DIVERGENCE PIN" test). Status-semantics unification is owned by
the tasks team on `fix/tasks-status-semantics`. When that branch lands,
the `'approved'` rows in the CONTRACT 2 matrix and both sides of the
divergence pin must be updated IN THAT CHANGE — never silently here, and
never by editing `workflow-progress.ts` or `task-pdf-adapter.ts` on a
Supabase branch. WF-3 changed neither file.

## Consumer audit

Method: `grep -rn 'computeWorkflowProgress|isStepWorkDone|isStepApproved|workflow-progress' src`,
plus `progressPercentage|progressPercent`, plus
`Math.round(...completed|done|steps...)`, plus `completedSteps`, across
all of `src` at base 4d5a1e16. Every hit is classified below.

Classes: (a) converted by wf-1 · (b) pinned file, step 17 ·
(c) client-side listener/poll surface (never bulk-converted; stays
Firestore client-side per cluster T dispositions) · (d) other.

| # | Consumer | Kind | Class | Notes |
|---|---|---|---|---|
| 1 | `src/app/api/missions/[workflowId]/route.ts:3,141-142` — `computeWorkflowProgress(tasks.map(t => t.status))` over Admin-SDK `tasks` reads | server | (a) | The wf-1 branch owns this file's Supa conversion. WF-3 touches nothing here. Output fields: `completedSteps`, `progressPercentage`, `isCompleted: allApproved`. |
| 2 | `src/app/api/workflows/route.ts` — BOTH progress blocks (see step-17 note) | server | (b) | PINNED. No changes permitted on this branch (nor to `src/lib/gamification-transaction.ts`). |
| 3 | `src/components/profile/workflow-visualizer.tsx:14,122` — `computeWorkflowProgress` over `useCollection(tasks where workflowId ==, listen: realtime flag)` | client | (c) | Firestore client listener surface. Stays as-is. |
| 4 | `src/app/projects/page.tsx:18,110,119` — `isStepWorkDone` over an `onSnapshot` tasks query (`workflowId != null`); progress % recomputed inline at :111 (`Math.round(completed/total*100)`, same formula) | client | (c) | National Mission Hub listener. The roadmap blocks at :646/:731 are NOT this: they render the project doc's precomputed `taskCount`/`completedTaskCount` counters, no status reads. |
| 5 | `src/app/projects/detail/page.tsx:18,127-128` — `isStepWorkDone` fallback over `useCollection(tasks where projectId ==)`; percent inline at :128 | client | (c) | Prefers the project doc's `taskCount`/`completedTaskCount` counters when present; status-based count is only the fallback. |
| 6 | `src/app/admin/tasks/page.tsx:33,1492-1494` — `isStepWorkDone` over already-fetched tasks filtered by `projectId`; percent inline | client | (c) | Per-project admin stats card, not workflow-grouped progress. Data already on the client; no server read to convert. |
| 7 | `src/components/profile/assigned-tasks.tsx:459-460` — INLINE, no helper: `syncPercentage = Math.round(completedSteps/steps*100)` where `completedSteps` counts ONLY `status === 'completed'` | client | (c) | Steps are fetched from the PINNED detail route (`fetch /api/workflows?workflowId=`, :274), so its data source flips at step 17, not here. DIVERGENCE (client-only, pre-existing): submitted-for-review steps contribute 0 to `syncPercentage`, unlike the helper's work-done counting. Recorded, not fixed — semantics unification belongs to `fix/tasks-status-semantics`. |
| 8 | `src/components/profile/workflow-steps-inline.tsx:115` — INLINE, no helper: `completedCount = steps.filter(s => s.status === 'completed').length`, shown as an `X/Y Complete` badge (no percentage) | client | (c) | Also fed by the PINNED detail route (fetch at :58, with `workflowCache`). Approved-count semantics, consistent with `isCompleted`, not with work-done progress. |
| 9 | `src/lib/task-pdf-adapter.ts:36-39,118-121` — INLINE single-task progress (`done ? 100 : 0`) | library | (d) | The divergence pin above. Single-task PDF adapter, not a workflow-steps consumer. Do not change. |
| 10 | `src/app/missions/[workflowId]/page.tsx:173-183` — renders `mission.progressPercentage` / `completedSteps` | client display | (d) | Computes nothing; consumes route #1's output (flips with wf-1). |
| 11 | `src/components/admin/workflows/missions-tab.tsx` — renders, filters and sorts on `workflow.progressPercentage` / `completedSteps` / `isCompleted`; passes them into the PDF-export assembly (:327) | client display | (d) | Computes nothing; consumes the PINNED list route #2's output (flips at step 17). |
| 12 | `src/lib/workflow-pdf-export.ts:437`, `src/lib/task-types.ts:126` | render/type | (d) | Render a supplied `progressPercentage`; compute none. |
| — | `src/components/blog/LaunchMetricsCard.tsx`, `src/lib/blog-data-utils.ts` (`progressPercentage` on blog launch metrics); `src/hooks/use-enhanced-toast.tsx:190` (batch-toast item statuses) | — | excluded | Same identifiers, unrelated domains. Not workflow step progress. |

Test-only references (not consumers): the missions route test mocks
`@/lib/workflow-progress`; the workflows route tests
(`route-parity`, `route-assignment-notifications`) mock it entirely.

## Conversion verdict: NONE warranted on this branch

The only server-side files that import the helper or compute workflow
progress from Firestore step statuses are #1 (missions route — class
(a), owned by wf-1) and #2 (workflows route — class (b), pinned to
step 17). There is NO other non-pinned server-side consumer disjoint
from wf-1's file; the grep evidence is the audit above. Per brief, no
surface was invented and no wf-4-style seam was built: a seam with no
caller would be dead code. All remaining surfaces are client-side
(class (c), never-bulk per cluster T dispositions) or pure
display/render (class (d)).

## Step-17 note — the pinned route's progress blocks

`src/app/api/workflows/route.ts` GET has TWO progress computations, and
they are NOT identical in construction. When step 17 flips this route
behind the 'workflows' flag, both must keep producing byte-identical
output to today, verified against the CONTRACT 2 matrix:

1. **List block** (`workflowId` absent, ~:354-433): does NOT call the
   helper. It hand-replicates it while grouping tasks by `workflowId`:
   `isStepWorkDone(data.status)` increments `completedSteps` (:401),
   `data.status === 'completed'` increments `approvedSteps` (:402),
   `progressPercentage = Math.round(completedSteps/totalSteps*100)`
   (:422), `isCompleted = totalSteps > 0 && approvedSteps === totalSteps`
   (:423 in the map), and `efficiencyScore` duplicates the same
   percentage (:429). Statuses are read RAW (`data.status`, no
   `String()` coercion). Any Supa-side difference in status values
   (e.g. missing field) flows straight into these comparisons — the
   supplement suite's missing-key cases pin the expected result (counts
   as not done).
2. **Detail block** (`workflowId` present, ~:451-602): DOES call the
   helper — `computeWorkflowProgress(tasksWithNames.map(t => String(t.status)))`
   (:590) — but takes only `completedSteps` and `isCompleted` from it
   and RE-derives `progressPercentage` inline
   (`totalSteps ? Math.round(completedSteps/totalSteps*100) : 0`, :592),
   discarding the helper's own `progressPercentage`. Same formula today;
   the flip must not "clean this up" silently. Note the `String(...)`
   coercion here (absent in the list block): a null status becomes the
   string `'null'`, which still counts as not done — equivalence holds,
   but by a different path.
3. Output shapes to preserve: list items carry
   `{ id, title, totalSteps, completedSteps, currentStepIndex, progressPercentage, isCompleted, participants, createdAt, updatedAt, overdueSteps, efficiencyScore }`;
   the detail response carries
   `progress = { workflowId, totalSteps, completedSteps, currentStepIndex, progressPercentage, isCompleted }`.
   Downstream display consumers #10/#11 and poll consumers #7/#8 read
   exactly these fields.

## Gates (this branch)

- Copied CONTRACT 2 equivalence suite, UNMODIFIED: **35/35 pass**.
- Copied suite + wf-3 supplement: **44/44 pass**.
- Pre-existing pdf/progress suites: `pdf-geometry` PASS,
  `task-pdf-adapter` PASS, `task-pdf-cover-role-lines` PASS,
  `workflow-pdf-export-edge` PASS, `workflow-pdf-fellow-rows` PASS.
  `workflow-pdf-export-geometry`: 4 tests hit the default 5 s jest
  timeout under heavy parallel-agent disk load (no assertion failures;
  files byte-identical to wf-6, where the suite passes at default
  timeout); re-run here with `--testTimeout=60000`: **7/7 pass**.
- Missions route consumer suite (`src/app/api/missions`): **8/8 pass**.
- Scoped tsc (temporary config over `workflow-progress.ts`,
  `task-pdf-adapter.ts`, fixtures + both new suites; removed after):
  **exit 0**. No full-repo tsc, per brief.
- Zero live reads; no changes to `src/app/api/workflows/route.ts` or
  `src/lib/gamification-transaction.ts`; nothing pushed or deployed.
  Local test runs used a `node_modules` symlink to `wt-supa-wf-6`'s
  install (gitignored, not committed) after a hardlink copy stalled
  under parallel load.
