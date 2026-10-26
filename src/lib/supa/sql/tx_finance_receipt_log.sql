-- tx_finance_receipt_log.sql — F5e: officer-expense receipt CREATE
-- (doc + audit) as ONE transaction. Replaces the receipts POST batch.
-- TIMESTAMP LAW T5 (base 1 of 2): slaDueAt = transactionDate
-- 00:00:00Z + 14 days, derived HERE from p_transaction_date — the
-- decide-created inbound receipts in tx_finance_decide_money_approval
-- use the verification-instant base instead; the two bases are
-- different on purpose and both are preserved.

create or replace function tx_finance_receipt_log(
  p_caller_uid text,
  p_new_id text,
  p_transaction_date text,
  p_receipt jsonb,
  p_audit_action text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_sla jsonb := to_jsonb(((p_transaction_date::date + 14)::timestamp) at time zone 'UTC');
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_receipt_log')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_receipt_log' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  if jsonb_typeof(p_receipt -> 'amountPkr') <> 'number'
     or finance_jsonb_number(p_receipt -> 'amountPkr') <= 0
     or finance_jsonb_number(p_receipt -> 'amountPkr') <> trunc(finance_jsonb_number(p_receipt -> 'amountPkr')) then
    raise exception using errcode = 'P0001',
      message = 'tx_finance_receipt_log: amountPkr must be a positive integer';
  end if;

  insert into fs_finance_receipts (id, firebase_uid, parent_path, data)
  values (p_new_id, null, 'finance_receipts', p_receipt || jsonb_build_object(
    'slaDueAt', v_sla,
    'createdAt', to_jsonb(now()),
    'updatedAt', to_jsonb(now())
  ));

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'finance_receipts/' || p_new_id,
    'payload', jsonb_build_object('amountPkr', p_receipt -> 'amountPkr', 'transactionDate', p_transaction_date),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_new_id, 'slaDueAt', v_sla);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
