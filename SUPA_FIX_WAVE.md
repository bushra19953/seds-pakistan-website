# Adapter fix wave — response to the GAPS verdict (2026-10-25)

Branch feat/supa-adapter, commits 4273db6 (contract suite imported),
d218b6b (the fixes), 238d2a9 (typecheck cleanup). Written after three
dispatched fix attempts died in sandbox restarts; the wave was executed
in-session by the parent agent. Baseline reproduced before any change:
19/27 contracts, exactly the verifier's numbers.

## Result

- Verifier contract suite: **27/27 pass** (unmodified assertions; two
  stray-argument resolveTarget call sites in the suite file corrected to
  the shipped 1-arg signature — runtime behavior unchanged).
- Adapter suites (adapter + contracts + client + flags): **80/80 pass.**
  Five adapter.test.ts tests that pinned the old translations were
  rewritten to assert corrected behavior; five tests added (G1 in-list,
  rehydration depth, ISO-on-write, countDocs fallback, Date deferral).
- Scoped tsc over src/lib/supa (adapter + all tests): **clean, exit 0.**
- FULL-repo tsc vs baseline 151: **not completed.** Three attempts were
  killed by sandbox restarts / memory contention (the same wall the
  workflows cluster hit five times). Nothing outside src/lib/supa imports
  the adapter on this branch, so the delta's type surface is the scoped
  check; the full confirmation belongs to the merge gate and is still owed
  there. Do not read this report as claiming it.

## Per-gap fixes (all in src/lib/supa/adapter.ts unless noted)

- **G1** — whereColumn() routes id/__name__ to the `id` column for every
  operator, including `in` (was: only ordering special-cased it).
- **G2** — fetchAllRows(): id-keyset paged loop, page size 1000, dedupe by
  id; every unbounded read and every client-finished query goes through
  it. 1005 seeded docs return 1005.
- **G3/G5/G6 + the timestamp ruling** — implemented as ruled, in one place:
  (b) storage ISO: kit normalizeTimestamps() at dump AND push
  (~/workspace/supabase-migration/migrate_db.js, idempotent for old dumps)
  + adapter normalizeForStorage() on every write; (c) reads rehydrate the
  dumped {_seconds,_nanoseconds} shape into SupaTimestamp (seconds,
  nanoseconds, toDate, toMillis, toISOString), deeply. Timestamp-valued
  and null clauses are DEFERRED out of PostgREST text comparison entirely
  and evaluated client-side via compareFieldValues (true chronological /
  Firestore type-rank order); data-field orderBy and data-field cursors
  are client-finished the same way, including the millis-cursor idiom.
- **G4** — finishing applies the orderBy existence rule (missing field
  excluded; explicit null kept) and always ends the sort with document id
  ascending (also settles **G7**).
- **G8** — == null / != null are deferred clauses evaluated on key
  presence: explicit null matches ==, missing matches neither.

## Also fixed

- migrate_db.js push() required '@supabase/supabase-client', which is not
  installed (the kit depends on '@supabase/supabase-js'); would have
  crashed the first --push. Corrected.

## Named follow-ups (not done, by design)

- **Projection support** in ListOptions (the verdict's inexpressible
  item): the directory roles-overlay and dashboard pending-sample reads
  lose their read-cost contract through the adapter until this lands.
- **instanceof Timestamp**: exactly one site in the tree
  (src/lib/task-management.ts:318, confirmedAt). SupaTimestamp is
  structural, not an SDK instance; the tasks cluster must handle that
  site before any surface feeding it flips.
- Full-repo tsc confirmation at the merge gate (see Result).

## Flip readiness after this wave

Dashboard counts were already ready. Directory/picker (G1+G2),
announcements (G3+G4), tasks list (G4+G6) are unblocked at the ADAPTER
level; each surface still flips only behind its cluster's own contracts.
