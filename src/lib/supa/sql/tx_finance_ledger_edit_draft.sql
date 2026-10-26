-- tx_finance_ledger_edit_draft.sql — F5b: ledger draft EDIT (doc +
-- audit) as ONE transaction. Replaces the ledger PUT batch. The
-- owner + draft guards RE-RUN here under the entry's row lock,
-- closing today's read-then-write gap (strengthening, design §F5);
-- guard order and messages are today's loadOwnedDraft order:
-- not-found 404 -> posted 409 -> non-owner 403. Flags are passed in
-- (computed by the call site from the merged entry) and re-verified
-- for the amount invariant when amountPkr is being edited.

create or replace function tx_finance_ledger_edit_draft(
  p_caller_uid text,
  p_entry_id text,
  p_editable jsonb,
  p_fields jsonb,
  p_flags jsonb,
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
  values (p_idempotency_key, 'tx_finance_ledger_edit_draft')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_ledger_edit_draft' then
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
  if p_editable ? 'amountPkr' and (
    jsonb_typeof(p_editable -> 'amountPkr') <> 'number'
    or finance_jsonb_number(p_editable -> 'amountPkr') <= 0
    or finance_jsonb_number(p_editable -> 'amountPkr') <> trunc(finance_jsonb_number(p_editable -> 'amountPkr'))
  ) then
    raise exception using errcode = 'P0001',
      message = 'tx_finance_ledger_edit_draft: amountPkr must be a positive integer';
  end if;

  update fs_ledger_entries
     set data = data || p_editable || p_flags || jsonb_build_object('updatedAt', to_jsonb(now()))
   where id = p_entry_id;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'ledger_entries/' || p_entry_id,
    'payload', jsonb_build_object('fields', p_fields),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_entry_id,
    'fyLabel', p_flags ->> 'fyLabel',
    'unbudgeted', coalesce(p_flags -> 'unbudgeted', 'false'::jsonb),
    'overThreshold', coalesce(p_flags -> 'overThreshold', 'false'::jsonb));
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
