-- tx_finance_receipt_deliver.sql — F5f: receipt delivery STAMP
-- (update + audit) as ONE transaction. Replaces the receipts/deliver
-- POST batch. Guards re-run under the receipt's row lock in today's
-- order: not-found 404 -> already-delivered 409 -> officer stamping
-- their own officer_expense 422. Audit payload {officerUid, kind}
-- comes from the LOCKED row.

create or replace function tx_finance_receipt_deliver(
  p_caller_uid text,
  p_receipt_id text,
  p_audit_action text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_receipt jsonb;
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_receipt_deliver')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_receipt_deliver' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  select data into v_receipt from fs_finance_receipts where id = p_receipt_id for update;
  if not found then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Receipt not found');
  end if;
  if v_receipt -> 'deliveredToTreasurerAt' is not null
     and jsonb_typeof(v_receipt -> 'deliveredToTreasurerAt') <> 'null' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409, 'message', 'Receipt is already marked delivered');
  end if;
  if v_receipt ->> 'kind' = 'officer_expense' and v_receipt ->> 'officerUid' = p_caller_uid then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'The officer who spent the money cannot stamp their own receipt delivery');
  end if;

  update fs_finance_receipts
     set data = data || jsonb_build_object(
       'deliveredToTreasurerAt', to_jsonb(now()),
       'updatedAt', to_jsonb(now()))
   where id = p_receipt_id;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'finance_receipts/' || p_receipt_id,
    'payload', jsonb_build_object('officerUid', v_receipt -> 'officerUid', 'kind', v_receipt -> 'kind'),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_receipt_id, 'delivered', true);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
