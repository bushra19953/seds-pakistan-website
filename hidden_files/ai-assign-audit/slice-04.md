Audit complete. Here is my full report for slice 4/20.

---

# AUDIT SLICE 4/20 — Active task counts / workload balancing input

## TL;DR
**Two bugs found.** (1) The "active task count" fed to the AI is not active at all — it is a lifetime cumulative assignment counter that is never decremented on completion, so the AI systematically avoids experienced members and overloads light-history ones. (2) The admin task-creation AI flow (the "Generate Suggestions" path) sends **no workload field whatsoever**, so the prompt's promise of workload balancing is silently false in that path.

## How the pipeline works (file:line evidence)

The AI route (`src/app/api/ai-task-generator/route.ts`) takes the `subordinates` registry **from the client** — it never queries workload itself. Its system prompt claims (`route.ts:63-66`):

> "assign them to the BEST fit team members based on their roles and current workload"
> "3. Team Registry: List of AUTHORIZED team members with their current roles and **active task counts**."

There are two client paths that build this registry:

**Path A — delegate dialog** (`src/components/profile/delegate-task-dialog.tsx:153`): fetches `GET /api/admin/hierarchy/workload`, which returns per-user `taskCount` and passes it straight through to the AI (`delegate-task-dialog.tsx:198`).

**Path B — admin task form** (`src/components/admin/tasks/task-form.tsx:528`): builds the registry inline as `usersChapter.map(u => ({ uid, name, role }))` — **no count field at all**.

## Bug 1 — `taskCount` is lifetime cumulative, not active (Path A)

`src/app/api/admin/hierarchy/workload/route.ts:101`:
```ts
taskCount: userData.tasksAssignedCount || 0
```

There is **no task query** in this path — it is a denormalized counter read. The counter's lifecycle across the codebase:

| Event | File:line | Effect |
|---|---|---|
| Task assigned | `app/api/tasks/route.ts:912` | +1 |
| Task reassigned | `app/api/tasks/route.ts:440,447` | −1 old, +1 new |
| Task deleted | `app/api/tasks/route.ts:1120` | −1 |
| Batch delete | `app/api/tasks/batch/route.ts:86` | −count |
| Delegated sub-task | `app/api/tasks/delegate/route.ts:106` | +1 |
| Workflow task created | `app/api/workflows/route.ts:224` | +1 |
| **Task completed/approved** | `lib/server/gamification-transaction.ts:158,236` | **no change** (only `tasksCompletedCount` +1) |

**No status is treated as "active"** — the counter does not distinguish statuses at all. The repair script confirms the intended semantics are cumulative: `scripts/recalculate-user-aggregates.ts:95` defines `assignedCount = allTaskDocs.size` over **all** tasks where the user is assignee, any status.

**Impact:** A veteran with 40 completed tasks shows `taskCount: 40`; a newcomer with 3 genuinely in-flight tasks shows `3`. The AI, instructed to balance on "current workload," will prefer the newcomer and shun the veteran — exactly backwards. A wrong workload number makes the AI prefer the wrong people: confirmed.

## Bug 2 — Admin flow sends zero workload signal (Path B)

`task-form.tsx:528` sends only `{uid, name, role}`. The AI receives no workload numbers in the admin "Generate Suggestions" flow, so workload balancing **silently does not happen** there — even though the system prompt tells the model it is working from "active task counts." The model will either ignore workload or hallucinate it.

## Staleness / caching assessment

- **Not HTTP-cached:** the workload route is `export const dynamic = 'force-dynamic'` and the dialog refetches on open (`delegate-task-dialog.tsx:148-162`). Each call reads the counter fresh from Firestore.
- **Semantically stale by design:** the denormalized counter only moves on assign/reassign/delete, never on completion — so it drifts upward monotonically over a user's lifetime. Any out-of-band task deletion (e.g. direct Firestore deletes bypassing the API) also leaves it inflated; the existence of `scripts/recalculate-user-aggregates.ts` (a drift-repair script) implies this drift is a known recurring problem.

## Recommended fix direction (for whoever implements; no code changed in this audit)

- In `workload/route.ts`, replace the counter read with a live query: count tasks where `assigneeId == uid` (and `assigneeIds array-contains uid`) with `status in ['pending','in-progress','submitted-for-review', ...active statuses]`. Alternatively, decrement `tasksAssignedCount` on completion in `gamification-transaction.ts`.
- In `task-form.tsx:528`, add the workload field to the `subordinates` payload (or reuse the workload endpoint) so Path B matches what the prompt promises.

No code was modified. No browser work was needed (all facts established from source).