-- tx_finance_reconciliation_create.sql — F5j: reconciliation draft
-- CREATE (doc + audit) as ONE transaction. Replaces the
-- reconciliations POST batch. The id is deterministic
-- ({accountSlug}-{periodMonth}); existence is the PK — an insert
-- that finds it taken returns today's 409, including for records
-- that exist only in Postgres.

create or replace function tx_finance_reconciliation_create(
  p_caller_uid text,
  p_rec_id text,
  p_rec jsonb,
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
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_reconciliation_create')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_reconciliation_create' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  insert into fs_finance_reconciliations (id, firebase_uid, parent_path, data)
  values (p_rec_id, null, 'finance_reconciliations',
    p_rec || jsonb_build_object('createdAt', to_jsonb(now()), 'updatedAt', to_jsonb(now())))
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409,
      'message', 'Reconciliation already exists for ' || p_rec_id);
  end if;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'finance_reconciliations/' || p_rec_id,
    'payload', p_audit_payload,
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_rec_id, 'status', 'draft');
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
