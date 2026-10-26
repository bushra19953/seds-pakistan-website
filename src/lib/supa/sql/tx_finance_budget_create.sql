-- tx_finance_budget_create.sql — F5g: budget draft CREATE (doc +
-- audit) as ONE transaction. Replaces the budgets POST batch. The
-- docId is deterministic (fyLabel or fyLabel-v{revision}); existence
-- is the fs_finance_budgets PK — an insert that finds the PK taken
-- returns today's 409 (this also sees budgets that exist only in
-- Postgres, which the call site's pre-check cannot). The function
-- re-verifies the money invariant totalAllocatedPkr = sum(lines)
-- before writing (design §F5 pass-in + re-verify rule).

create or replace function tx_finance_budget_create(
  p_caller_uid text,
  p_doc_id text,
  p_budget jsonb,
  p_audit_action text,
  p_audit_payload jsonb,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_inserted int;
  v_sum numeric;
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_budget_create')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_budget_create' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  select coalesce(sum(finance_jsonb_number(line -> 'allocatedPkr')), 0)
    into v_sum
    from jsonb_array_elements(
      case when jsonb_typeof(p_budget -> 'lines') = 'array' then p_budget -> 'lines' else '[]'::jsonb end
    ) as line;
  if v_sum <> finance_jsonb_number(p_budget -> 'totalAllocatedPkr') then
    raise exception using errcode = 'P0001',
      message = 'tx_finance_budget_create: totalAllocatedPkr does not equal sum(lines)';
  end if;

  insert into fs_finance_budgets (id, firebase_uid, parent_path, data)
  values (p_doc_id, null, 'finance_budgets',
    p_budget || jsonb_build_object('createdAt', to_jsonb(now()), 'updatedAt', to_jsonb(now())))
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409,
      'message', 'Budget document ' || p_doc_id || ' already exists');
  end if;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'finance_budgets/' || p_doc_id,
    'payload', p_audit_payload,
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_doc_id, 'status', 'draft');
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
