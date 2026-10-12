# Step 1 Resource Clobber — Bug and Fix

**Date:** 2026-10-12
**Status:** Fixed
**File:** `src/app/api/tasks/route.ts`, `handleUpdate` (starts line 229)

## Bug title and symptoms

Editing a workflow through the admin Edit dialog (opened from a step's task row on `/admin/tasks`) silently replaced the step's per-step resources with stale resources from the dialog's top-level "Resources & Logistics" section. The "Step Resources" section the admin actually edited appeared to save, then reverted to the stale top-level values on the next read.

## Root cause

The Edit dialog sends a single PATCH with **two copies of resources** (see `src/app/admin/tasks/page.tsx`):

- `updates.resources` — line 581, the top-level "Resources & Logistics" section value (stale, not what the admin was editing).
- `updates.steps[i].resources` — line 611, the fresh per-step resources from the "Step Resources" section.

In `handleUpdate` (`src/app/api/tasks/route.ts`):

1. Line 573–576: the `steps` array is extracted into `stepWrites` so it never lands on the master task doc.
2. Line 639: each step doc is written via `batch.update(stepRef, stepDoc)` — **queued first**, carrying the fresh step resources.
3. Line 776: the master task update runs via `batch.update(taskRef, updatesToApply)` — **queued last**, carrying the stale top-level `updatesToApply.resources`.

When the admin opens Edit from a step's task row, the PATCH `taskId` **is that step's Firestore doc ID** — so `taskRef` and the step's `stepRef` are the same document. Firestore batch writes apply in order with **last write wins per field**, so the stale top-level `resources` (queued last) overwrote the fresh step resources (queued first). A dual-write clobber on the same document.

## Why Step 1 was affected but not Steps 2–4

The clobber only happens when the edited task's doc ID equals one of the step doc IDs. In the observed incident the admin opened the Edit dialog from **Step 1's task row**, so `taskId === steps[0].id` and both writes hit Step 1's document. Steps 2–4 were written only once (their own step-doc write, no competing second write), so their resources were never clobbered. Any step edited from its own task row would be vulnerable in the same way; Steps 2–4 simply weren't the edit entry point.

## The fix

In `handleUpdate`, right after `stepWrites` is extracted (`src/app/api/tasks/route.ts`, lines 577–591): if the edited `taskId` matches a step that carries its own `resources` array, delete the top-level `resources` from the master payload so it can never win the same-doc race:

```ts
// The edited task can itself be one of the workflow step docs (taskRef
// === step doc). In that case the batch writes the step's resources
// FIRST (queued above in the step-doc write path) and the master task
// update LAST; a stale top-level `resources` on the master payload would
// clobber the fresh step resources because Firestore applies same-doc
// writes in batch order. Drop the stale top-level resources here so the
// step's resources survive.
if (stepWrites && stepWrites.length > 0) {
  const editedStep = stepWrites.find(
    (s: any) => s && s.id && String(s.id) === String(taskId)
  );
  if (editedStep && Array.isArray(editedStep.resources)) {
    delete updatesToApply.resources;
  }
}
```

Notes on the design:

- The drop is **conditional, not blanket**: when the admin edits a standalone master task (not a step doc), the top-level `resources` still persist normally.
- `delete` is only applied when the matching step actually has a `resources` array; a step edited without resources leaves the master payload untouched, preserving any intentional master-level resource edit.
- The guard sits alongside the other "never land on the master doc" extractions (`steps` at line 576, `removedStepIds` at line 596), keeping all payload-separation logic in one place.

## How to verify the fix

1. Open `/admin/tasks`, find a workflow, and open the **Edit** dialog from **Step 1's task row**.
2. In the "Step Resources" section for Step 1, add or change a resource (give it a unique title you can recognize later). Leave the top-level "Resources & Logistics" section with different/stale values.
3. Save, then reload the dialog and check Step 1's resources — the fresh Step Resources value must survive.
4. Confirm in Firestore that the Step 1 doc's `resources` field matches what was entered in "Step Resources", not the top-level section.
5. Regression: edit a standalone (non-workflow) task's top-level resources and confirm they still save — the fix must not have broken that path.
6. Regression: edit a workflow from a row that is **not** a step doc (if the workflow has a separate master task doc) and confirm top-level resources on the master still save.

## Prevention: avoiding similar dual-write bugs

- **One source of truth per field per request.** If a field can arrive at two levels of the same payload (top-level `updates.resources` and `updates.steps[].resources`), the server must explicitly namespace or drop one before writing — never write both to the same document.
- **Watch for doc-identity collisions.** Any code that extracts sub-entities (steps) out of a parent payload and writes them to the same collection must check whether the edited parent doc **is** one of the sub-entity docs. That check is cheap and catches this whole class of bug.
- **Keep "never lands on the master doc" extractions together.** `steps`, `removedStepIds`, and any future sub-entity fields must all be extracted (and guarded) in the same block before `batch.update(taskRef, updatesToApply)`.
- **Test from every entry point.** Write an integration test that edits a workflow from each step's task row and asserts the step doc's `resources` afterward — the dialog can be opened from any row, so every row is a write-path entry point.
- **Add an audit assertion for same-doc double writes in a batch.** If a batch writes to the same doc twice with different values for a field, that should at least be logged loudly in development; two writes to one doc in one batch is almost never intentional.
