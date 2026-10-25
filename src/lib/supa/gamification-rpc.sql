-- Gamification points RPC (Cluster Q, step 14) — DESIGN / FLIP ARTIFACT.
-- NOT applied by this branch (no live DB writes in the build). Apply at
-- flip time, together with the adapter `rpc()` amendment (adapter gap:
-- src/lib/supa/adapter.ts exposes no rpc method at build time).
--
-- One transaction spanning fs_users / fs_points_ledger — the Postgres
-- equivalent of the Firestore transaction family (design doc sections
-- 2-4 intent). Idempotency: the ledger primary key IS the key
-- `pa_<taskId>_<userId>_<action>`; ON CONFLICT DO NOTHING is the claim.
-- Lock order (shared with cluster T's approval paths): ledger claim
-- first, then the user row FOR UPDATE, then finalize — every caller
-- takes locks in this order, so no caller can deadlock another by
-- holding the user row while claiming.

create or replace function apply_points_award(
  p_ledger_id text,
  p_user_id text,          -- null = collective/chapter award
  p_chapter_id text,       -- collective target when p_user_id is null
  p_task_id text,
  p_action text,
  p_reason text,
  p_points integer,
  p_count_completion boolean default false,
  p_on_time boolean default null,
  p_hours_worked integer default 0,
  p_badge_ids text[] default '{}',
  p_timestamp timestamptz default now()
) returns table (applied boolean, duplicate boolean, new_total_points integer)
language plpgsql
as $$
declare
  v_claimed integer;
  v_user jsonb;
  v_total integer;
begin
  -- 1. Claim: insert the ledger row; conflict = already awarded.
  insert into fs_points_ledger (id, firebase_uid, parent_path, data)
  values (
    p_ledger_id, p_user_id, 'points_ledger',
    jsonb_build_object(
      'user_id', p_user_id, 'task_id', p_task_id, 'action', p_action,
      'reason', p_reason, 'chapter_id', p_chapter_id,
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

  -- 2. Counters: jsonb arithmetic under a row lock (never a blind
  --    read-modify-write from the client).
  if p_user_id is not null then
    select data into v_user from fs_users where id = p_user_id for update;
    v_user := coalesce(v_user, '{}'::jsonb);
    v_total := coalesce((v_user->>'total_points')::integer, 0) + p_points;
    v_user := v_user
      || jsonb_build_object('total_points', v_total)
      || jsonb_build_object('points',
           coalesce((v_user->>'points')::integer, 0) + p_points);
    if p_count_completion then
      v_user := v_user
        || jsonb_build_object('tasksCompletedCount',
             coalesce((v_user->>'tasksCompletedCount')::integer, 0) + 1)
        || jsonb_build_object('lastTaskCompletedAt',
             to_char(p_timestamp at time zone 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
      if p_on_time is true then
        v_user := v_user || jsonb_build_object('tasksCompletedOnTimeCount',
          coalesce((v_user->>'tasksCompletedOnTimeCount')::integer, 0) + 1);
      elsif p_on_time is false then
        v_user := v_user || jsonb_build_object('tasksCompletedLateCount',
          coalesce((v_user->>'tasksCompletedLateCount')::integer, 0) + 1);
      end if;
    end if;
    if p_hours_worked > 0 then
      v_user := v_user || jsonb_build_object('totalHoursWorked',
        coalesce((v_user->>'totalHoursWorked')::integer, 0) + p_hours_worked);
    end if;
    if coalesce(array_length(p_badge_ids, 1), 0) > 0 then
      v_user := v_user || jsonb_build_object('badges', (
        select coalesce(jsonb_agg(distinct b), '[]'::jsonb)
        from (
          select jsonb_array_elements_text(coalesce(v_user->'badges', '[]'::jsonb)) as b
          union select unnest(p_badge_ids)
        ) s));
    end if;
    insert into fs_users (id, firebase_uid, parent_path, data)
    values (p_user_id, p_user_id, 'users', v_user)
    on conflict (id) do update set data = excluded.data;
  elsif p_chapter_id is not null then
    update fs_chapters set data = data
      || jsonb_build_object('collective_score',
           coalesce((data->>'collective_score')::integer, 0) + p_points)
      || jsonb_build_object('tasks_completed',
           coalesce((data->>'tasks_completed')::integer, 0) + 1)
    where id = p_chapter_id;
    v_total := null;
  end if;

  -- 3. Finalize the claim in the same transaction.
  update fs_points_ledger
     set data = data || jsonb_build_object('status', 'PROCESSED')
   where id = p_ledger_id;

  return query select true, false, v_total;
end;
$$;
