# Supabase migration — rebase notes: tasks cluster, group 1 (main tasks route)

Branch: `feat/supa-tasks-1`, built against `feat/integration-wave3 @ 4d5a1e16`.
File group: `src/app/api/tasks/route.ts` ONLY, plus the new seam module
`src/lib/supa/seam-tasks-route.ts` and its tests.

## Adapter contract (programmed against, not present in this tree)

- The real adapter is being built in parallel at `src/lib/supa/` (surface
  string for this cluster: `tasks`).
- Contract: `getDoc(collection, id)`, `listDocs(collection, {where:
  [[field, op, value]...], orderBy, limit, startAfter})`,
  `countDocs(collection, where)`, `setDoc(collection, id, data)`,
  `updateDoc(collection, id, data)`, `deleteDoc(collection, id)` over
  `fs_<collection>` tables; results are Firestore-shaped plain objects
  `{id, ...data}`.
- MERGE-TIME ACTION: the seam reaches the adapter via a lazy dynamic import
  through a variable specifier (env `SUPA_ADAPTER_SPECIFIER`, default
  `@/lib/supa/adapter`). At merge time re-point that default at the real
  `@/lib/supa/adapter` export shape and swap the seam-local `useSupa`
  check for the adapter's `useSupa('tasks')` helper if its signature
  differs. No `@supabase/supabase-js` import anywhere in this group.

## Per-file sections

### src/lib/supa/seam-tasks-route.ts (new)

- (filled in when the seam lands)

### src/app/api/tasks/route.ts

- (per-hunk re-application list filled in when the route edits land)

## Supporting Firestore reads that stay on Firestore in this wave

- (listed per handler when the route edits land)

## Timestamp (.toDate() / Timestamp arithmetic) sites on seam-served docs

- (listed with file:line when the route edits land)

## Collision notes (defect branches merging before this branch)

- `fix/tasks-status-semantics` edits this route, the team route, and
  gamification-transaction; `fix/tasks-profile-board` edits
  assigned-tasks.tsx / task-management.ts. Route edits here are kept
  minimal and mechanical (call-site swaps into the seam) so the rebase
  is mechanical. Per-hunk re-application list below when edits land.
