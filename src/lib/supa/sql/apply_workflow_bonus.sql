-- apply_workflow_bonus — Gamification workflow-completion bonus RPC
-- (Phase 2 of the gamification flip, 2026-10-29; closes B-GAME-1).
--
-- The WORKFLOW_BONUS award in the pinned transaction
-- (src/lib/server/gamification-transaction.ts, final workflow step)
-- could not ride apply_points_award: its ledger row carries NO
-- task_id (it is keyed by workflowId) and its user write increments
-- workflowsCompletedCount — neither shape exists in that function.
-- This variant mirrors apply_points_award's structure exactly:
-- claim-first, counters under a row lock, finalize in the same
-- transaction. Authoring this file does NOT apply it; applying is a
-- coordinator step (Management API / SQL editor), `create or replace`
-- only — re-applying is a no-op.
--
-- Semantics (pinned by the Phase 2 spec):
--   - p_points > 0: claim-insert into fs_points_ledger with
--     id = p_ledger_id (the seam's deterministic
--     pa_wf_<workflowId>_<userId>_WORKFLOW_BONUS). ON CONFLICT DO
--     NOTHING → no row claimed means duplicate=true and NOTHING else
--     is touched (no counters, no badge).
--   - Counters (points, total_points, workflowsCompletedCount) move
--     only when p_points > 0.
--   - The badge union is INDEPENDENT of the points claim: it happens
--     even when p_points <= 0 (no ledger row is claimed at all in
--     that case), under the same user-row lock.
--   - A claimed ledger row is finalized to PROCESSED in the same
--     transaction, so a claim can never strand.
-- Lock order (shared with apply_points_award): ledger claim first,
-- then the user row FOR UPDATE, then finalize.

create or replace function apply_workflow_bonus(
  p_ledger_id text,
  p_user_id text,
  p_workflow_id text,
  p_points integer,
  p_badge_id text default null,
  p_timestamp timestamptz default now()
) returns table (applied boolean, duplicate boolean, new_total_points integer)
language plpgsql
as $$
declare
  v_claimed integer := 0;
  v_user jsonb;
  v_total integer;
begin
  -- 1. Claim (points-bearing bonuses only): insert the ledger row;
  --    conflict = already awarded, and a duplicate touches nothing.
  if p_points > 0 then
    insert into fs_points_ledger (id, firebase_uid, parent_path, data)
    values (
      p_ledger_id, p_user_id, 'points_ledger',
      jsonb_build_object(
        'user_id', p_user_id, 'action', 'WORKFLOW_BONUS',
        'workflowId', p_workflow_id,
        'points_awarded', p_points, 'status', 'CLAIMED',
        'idempotency_key', p_ledger_id,
        'timestamp', to_char(p_timestamp at time zone 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )
    on conflict (id) do nothing;
    get diagnostics v_claimed = row_count;
    if v_claimed = 0 then
      return query select false, true, null::integer;
      return;
    end if;
  end if;

  -- 2. Counters + badge: jsonb arithmetic under a row lock (never a
  --    blind read-modify-write from the client). The user row is
  --    upserted exactly as apply_points_award upserts it.
  select data into v_user from fs_users where id = p_user_id for update;
  v_user := coalesce(v_user, '{}'::jsonb);
  v_total := coalesce((v_user->>'total_points')::integer, 0);
  if p_points > 0 then
    v_total := v_total + p_points;
    v_user := v_user
      || jsonb_build_object('total_points', v_total)
      || jsonb_build_object('points',
           coalesce((v_user->>'points')::integer, 0) + p_points)
      || jsonb_build_object('workflowsCompletedCount',
           coalesce((v_user->>'workflowsCompletedCount')::integer, 0) + 1);
  end if;
  if p_badge_id is not null then
    v_user := v_user || jsonb_build_object('badges', (
      select coalesce(jsonb_agg(distinct b), '[]'::jsonb)
      from (
        select jsonb_array_elements_text(coalesce(v_user->'badges', '[]'::jsonb)) as b
        union select p_badge_id
      ) s));
  end if;
  insert into fs_users (id, firebase_uid, parent_path, data)
  values (p_user_id, p_user_id, 'users', v_user)
  on conflict (id) do update set data = excluded.data;

  -- 3. Finalize the claim in the same transaction (claimed rows only;
  --    a badge-only call claimed nothing and writes no ledger row).
  if v_claimed > 0 then
    update fs_points_ledger
       set data = data || jsonb_build_object('status', 'PROCESSED')
     where id = p_ledger_id;
  end if;

  return query select true, false, v_total;
end;
$$;
