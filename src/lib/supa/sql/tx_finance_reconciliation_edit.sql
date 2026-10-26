-- tx_finance_reconciliation_edit.sql — F5k: reconciliation draft
-- EDIT (update + audit) as ONE transaction. Replaces the
-- reconciliations PUT batch. Guards re-run under the row lock in
-- today's order: not-found 404 -> not-draft 409 -> non-maker 403.
-- Only the statement-side fields arrive in p_updates (the call site
-- whitelists them, as today); updatedAt is stamped HERE (law T6).

create or replace function tx_finance_reconciliation_edit(
  p_caller_uid text,
  p_rec_id text,
  p_updates jsonb,
  p_fields jsonb,
  p_audit_action text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_rec jsonb;
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_reconciliation_edit')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_reconciliation_edit' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  select data into v_rec from fs_finance_reconciliations where id = p_rec_id for update;
  if not found then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Reconciliation not found');
  end if;
  if v_rec ->> 'status' <> 'draft' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409, 'message', 'Completed reconciliations are immutable');
  end if;
  if v_rec ->> 'reconciledBy' <> p_caller_uid then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 403, 'message', 'Only the maker (reconciledBy) can edit a draft');
  end if;

  update fs_finance_reconciliations
     set data = data || p_updates || jsonb_build_object('updatedAt', to_jsonb(now()))
   where id = p_rec_id;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'finance_reconciliations/' || p_rec_id,
    'payload', jsonb_build_object('fields', p_fields),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_rec_id);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
