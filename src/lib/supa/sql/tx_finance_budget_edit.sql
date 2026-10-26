-- tx_finance_budget_edit.sql — F5h: budget draft EDIT (update +
-- audit) as ONE transaction. Replaces the budgets PUT batch. The
-- draft-only guard re-runs under the budget's row lock; the total is
-- re-verified against the lines before writing.

create or replace function tx_finance_budget_edit(
  p_caller_uid text,
  p_budget_id text,
  p_lines jsonb,
  p_total_allocated_pkr numeric,
  p_audit_action text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_budget jsonb;
  v_sum numeric;
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_budget_edit')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_budget_edit' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  select data into v_budget from fs_finance_budgets where id = p_budget_id for update;
  if not found then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Budget not found');
  end if;
  if v_budget ->> 'status' <> 'draft' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409, 'message', 'Only a draft budget can be edited; create a new revision instead');
  end if;

  select coalesce(sum(finance_jsonb_number(line -> 'allocatedPkr')), 0)
    into v_sum
    from jsonb_array_elements(
      case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end
    ) as line;
  if v_sum <> p_total_allocated_pkr then
    raise exception using errcode = 'P0001',
      message = 'tx_finance_budget_edit: totalAllocatedPkr does not equal sum(lines)';
  end if;

  update fs_finance_budgets
     set data = data || jsonb_build_object(
       'lines', p_lines,
       'totalAllocatedPkr', p_total_allocated_pkr,
       'updatedAt', to_jsonb(now()))
   where id = p_budget_id;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'finance_budgets/' || p_budget_id,
    'payload', jsonb_build_object('totalAllocatedPkr', p_total_allocated_pkr),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_budget_id, 'totalAllocatedPkr', p_total_allocated_pkr);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
