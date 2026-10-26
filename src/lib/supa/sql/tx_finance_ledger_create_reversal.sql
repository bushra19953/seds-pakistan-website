-- tx_finance_ledger_create_reversal.sql — F5d: reversal draft CREATE
-- (doc + audit) as ONE transaction. Replaces the ledger/reverse POST
-- batch. The guards re-run under the ORIGINAL's row lock — posted /
-- not-yet-reversed / not-itself-a-reversal — closing today's
-- read-then-write double-reversal race (two concurrent reverses of
-- the same posted entry both succeed today; here exactly one does —
-- strengthening, design §F5). The reversal draft is built from the
-- LOCKED original, field-for-field as the route builds it (note:
-- fyLabel is the ORIGINAL's, not re-derived from the reversal date).
-- The original is NOT modified, as today.

create or replace function tx_finance_ledger_create_reversal(
  p_caller_uid text,
  p_new_id text,
  p_entry_id text,
  p_reason text,
  p_date text,
  p_audit_action text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_orig jsonb;
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_ledger_create_reversal')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_ledger_create_reversal' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  select data into v_orig from fs_ledger_entries where id = p_entry_id for update;
  if not found then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Ledger entry not found');
  end if;
  if v_orig ->> 'status' <> 'posted' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Only a posted entry can be reversed');
  end if;
  if coalesce(v_orig ->> 'reversedBy', '') <> '' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Entry has already been reversed');
  end if;
  if coalesce(v_orig ->> 'reversalOf', '') <> '' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'A reversing entry cannot itself be reversed');
  end if;
  -- Race closure (design §F5 / verifier V3): reversedBy is only
  -- stamped when a reversal POSTS (ledger_post apply), so the guards
  -- above cannot see a reversal draft created moments earlier. Under
  -- this row lock, a live draft reversal for the same original is
  -- therefore also a bar — without it, two concurrent (or sequential)
  -- reverses would both mint drafts. A deleted draft no longer bars.
  if exists (
    select 1 from fs_ledger_entries
     where data ->> 'reversalOf' = p_entry_id and data ->> 'status' = 'draft'
  ) then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Entry already has a pending reversal draft');
  end if;

  insert into fs_ledger_entries (id, firebase_uid, parent_path, data)
  values (p_new_id, null, 'ledger_entries', jsonb_build_object(
    'date', p_date,
    'fyLabel', v_orig -> 'fyLabel',
    'type', case when v_orig ->> 'type' = 'income' then 'expense' else 'income' end,
    'category', v_orig -> 'category',
    'amountPkr', v_orig -> 'amountPkr',
    'counterparty', v_orig -> 'counterparty',
    'counterpartyPartnerId', v_orig -> 'counterpartyPartnerId',
    'description', 'Reversal of ' || p_entry_id || ': ' || p_reason,
    'budgetLineId', v_orig -> 'budgetLineId',
    'unbudgeted', false,
    'overThreshold', false,
    'consentId', null,
    'paymentMethod', v_orig -> 'paymentMethod',
    'accountLabel', v_orig -> 'accountLabel',
    'receiptDriveId', null,
    'receiptHash', null,
    'relatedPartyEntryId', v_orig -> 'relatedPartyEntryId',
    'enteredBy', p_caller_uid,
    'status', 'draft',
    'postedBy', null,
    'postedAt', null,
    'sourceOrderId', null,
    'reversalOf', p_entry_id,
    'reversedBy', null,
    'createdAt', to_jsonb(now()),
    'updatedAt', to_jsonb(now())
  ));

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'ledger_entries/' || p_new_id,
    'payload', jsonb_build_object('reversalOf', p_entry_id, 'reason', p_reason),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_new_id, 'reversalOf', p_entry_id);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
