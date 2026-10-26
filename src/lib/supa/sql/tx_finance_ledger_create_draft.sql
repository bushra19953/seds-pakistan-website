-- tx_finance_ledger_create_draft.sql — F5a: ledger draft CREATE
-- (doc + audit) as ONE transaction. Replaces the ledger POST batch.
-- Design §F5. Guards/validation (permission, field validation,
-- account-label, related-party, computeEntryFlags) stay at the call
-- site — they are pure reads of the request; the function re-verifies
-- the one money-critical invariant (integer amountPkr > 0) before
-- writing. Timestamps: createdAt/updatedAt = to_jsonb(now()) HERE
-- (law T6); the call site passes no timestamp fields.

create or replace function tx_finance_ledger_create_draft(
  p_caller_uid text,
  p_new_id text,
  p_entry jsonb,
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
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_ledger_create_draft')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_ledger_create_draft' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  if jsonb_typeof(p_entry -> 'amountPkr') <> 'number'
     or finance_jsonb_number(p_entry -> 'amountPkr') <= 0
     or finance_jsonb_number(p_entry -> 'amountPkr') <> trunc(finance_jsonb_number(p_entry -> 'amountPkr')) then
    raise exception using errcode = 'P0001',
      message = 'tx_finance_ledger_create_draft: amountPkr must be a positive integer';
  end if;

  insert into fs_ledger_entries (id, firebase_uid, parent_path, data)
  values (p_new_id, null, 'ledger_entries',
    p_entry || jsonb_build_object('createdAt', to_jsonb(now()), 'updatedAt', to_jsonb(now())));

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'ledger_entries/' || p_new_id,
    'payload', p_audit_payload,
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_new_id,
    'fyLabel', p_entry ->> 'fyLabel',
    'unbudgeted', coalesce(p_entry -> 'unbudgeted', 'false'::jsonb),
    'overThreshold', coalesce(p_entry -> 'overThreshold', 'false'::jsonb));
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
