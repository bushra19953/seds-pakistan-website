-- tx-template.sql — SKELETON for a transactional function (foundation wave).
-- NOT a runnable migration: copy it, rename the function, replace the
-- <...> placeholders, and delete this banner. Authoring rules:
-- src/lib/supa/sql/README.md.
--
-- This skeleton carries the two program-wide patterns every consumer
-- (events, elections, motions, gamification) builds on:
--
-- (A) ADVISORY LOCK (pg_advisory_xact_lock): serialises one logical
--     entity ACROSS PROCESSES — any number of server instances calling
--     this function for the same <entity key> execute the body one at a
--     time. The lock is transaction-scoped: it is held until the
--     function's implicit transaction commits or rolls back and can
--     never leak into a pooled session. Use ONE lock per function, on
--     the entity the operation mutates (event id, vote id, motion id),
--     taken FIRST, before any read the decision depends on — a check
--     performed before the lock is not a check.
--
-- (B) IDEMPOTENCY KEY (money / vote / award paths): the caller supplies
--     a key that names ONE logical operation (generated at the
--     operation's origin, reused across its retries — never per HTTP
--     attempt). The function records the key in fs_tx_idempotency
--     INSIDE the same transaction, before applying effects:
--
--       create table if not exists fs_tx_idempotency (
--         key text primary key,
--         fn text not null,
--         result jsonb not null,
--         created_at timestamptz not null default now()
--       );
--
--     (Table DDL belongs to the coordinator's flip-time schema step,
--     not to a function file.) A replay finds the row and returns the
--     recorded result verbatim: no effect is applied twice, and the
--     caller cannot distinguish a replay from the original outcome —
--     which is exactly the point. Gamification is the ONE exception to
--     the side table: its key is the fs_points_ledger primary key
--     itself (see ../gamification-rpc.sql); do not give it a second
--     mechanism.

create or replace function tx_<surface>_<op>(
  p_<entity>_id text,
  p_idempotency_key text,          -- required on money/vote paths
  p_timestamp timestamptz default now()
  -- ... operation arguments, p_* prefixed ...
) returns table (applied boolean, duplicate boolean /*, ... outcome columns ... */)
language plpgsql
as $$
declare
  v_prior jsonb;
  v_result jsonb;
begin
  -- (A) Serialise per entity, across processes, for this transaction.
  perform pg_advisory_xact_lock(hashtextextended('tx_<surface>_<op>:' || p_<entity>_id, 0));

  -- (B) Idempotency: replay short-circuit BEFORE any effect.
  if p_idempotency_key is not null then
    select result into v_prior
      from fs_tx_idempotency
     where key = p_idempotency_key;
    if found then
      -- Return the recorded outcome in this function's return shape.
      return query select false, true /*, ... recorded outcome ... */;
      return;
    end if;
  end if;

  -- (C) Re-read the state the decision depends on — AFTER the lock,
  --     never from a caller-supplied snapshot. Row locks (for update)
  --     on the mutated rows follow the header's stated lock order.
  --     Business rejection (sold out / closed / ineligible) = return
  --     (false, false, ...) here, having written nothing.
  --
  -- (D) Apply every effect: claim row, counters, ledger/doc writes —
  --     all inside this one implicit transaction.
  --
  -- (E) Record the outcome under the idempotency key, last, still in
  --     the same transaction, so key and effects commit or roll back
  --     together.
  if p_idempotency_key is not null then
    v_result := jsonb_build_object('applied', true /*, ... outcome ... */);
    insert into fs_tx_idempotency (key, fn, result)
    values (p_idempotency_key, 'tx_<surface>_<op>', v_result);
  end if;

  return query select true, false /*, ... outcome ... */;
end;
$$;
