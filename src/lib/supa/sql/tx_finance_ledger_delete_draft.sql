-- tx_finance_ledger_delete_draft.sql — F5c: ledger draft DELETE
-- (doc + audit) as ONE transaction. Replaces the ledger DELETE batch.
-- Guards re-run under the row lock in loadOwnedDraft's order
-- (404 -> posted 409 -> non-owner 403). The audit payload
-- {amountPkr, type} is taken from the LOCKED row, not the call site.

create or replace function tx_finance_ledger_delete_draft(
  p_caller_uid text,
  p_entry_id text,
  p_audit_action text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_entry jsonb;
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_ledger_delete_draft')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_ledger_delete_draft' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  select data into v_entry from fs_ledger_entries where id = p_entry_id for update;
  if not found then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Ledger entry not found');
  end if;
  if v_entry ->> 'status' = 'posted' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409, 'message', 'Posted entries are immutable; corrections are reversing entries');
  end if;
  if v_entry ->> 'enteredBy' <> p_caller_uid then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 403, 'message', 'Only the maker can edit or delete a draft entry');
  end if;

  delete from fs_ledger_entries where id = p_entry_id;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'ledger_entries/' || p_entry_id,
    'payload', jsonb_build_object('amountPkr', v_entry -> 'amountPkr', 'type', v_entry -> 'type'),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_entry_id, 'deleted', true);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
