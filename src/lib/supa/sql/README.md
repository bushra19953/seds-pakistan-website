# Transactional SQL — authoring convention

Transactional Postgres functions (`tx_*`) live HERE, in
`src/lib/supa/sql/`, one file per function: the file is named exactly
after the function (`tx_events_register_paid.sql`,
`tx_elections_cast_ballot.sql`, ...).

Why here and not the migration kit (`~/workspace/supabase-migration/`):
the kit is a one-off dump/push tool that lives outside the repo and is
not versioned with the code that calls it. A `tx_*` function is code —
its signature is a contract the adapter's consumers compile against, its
review belongs in the same diff as the TypeScript that calls it, and its
tests (mocked-transport contracts in `src/lib/supa/__tests__/`) must be
able to name it. The precedent already points this way:
`src/lib/supa/gamification-rpc.sql` (the `apply_points_award` function)
was authored beside the seam that will call it; when C-07 applies it,
that file moves into this directory unchanged. Kit SQL
(`create_group_tables.sql`, `ALL_TABLES_ONE_PASTE.sql`) stays kit SQL:
schema for the landing tables, applied once. Function SQL is app SQL:
applied per release, `create or replace`, idempotent to re-apply.

Rules for every file in this directory:

1. `create or replace function` only; no DDL, no data changes, no
   `drop`. Applying the file twice must be a no-op the second time.
2. The function name follows `tx_<surface>_<op>` and matches the
   adapter's `txFunctionName(surface, op)` output exactly.
3. Parameters are `p_*`-prefixed. A function on a money / vote / award
   path takes `p_idempotency_key text` (see tx-template.sql).
4. The body is one transaction by construction: never emit `commit`,
   `begin`, or exception-swallowing `exception when others` blocks that
   let a partial write survive. An unhandled error rolls back every
   statement in the function — that rollback IS the atomicity contract.
5. Lock order is part of the contract and is stated in the file header:
   idempotency/claim row first, then entity rows in a documented,
   program-wide order. Cross-entity serialisation uses
   `pg_advisory_xact_lock(hashtextextended(<key>, 0))` at the top of the
   function (transaction-scoped: released automatically at commit /
   rollback, no session state to leak).
6. Return a small status object (`returns table` or a single jsonb /
   scalar) that distinguishes APPLIED from DUPLICATE / REJECTED
   outcomes. Business rejections (sold out, ballot on a closed vote)
   are return values, not exceptions; exceptions are for corruption and
   invariant violations only.
7. Timestamps: the function receives instants as arguments
   (`p_timestamp timestamptz default now()` is acceptable for
   server-time fields) and stores document timestamps inside `data`
   jsonb as ISO-8601 UTC strings — the adapter's storage ruling.
8. A file is an APPLY artifact, like `gamification-rpc.sql` before it:
   authoring it in a branch never applies it. Applying happens at the
   surface's flip, by the coordinator, against the live project.
