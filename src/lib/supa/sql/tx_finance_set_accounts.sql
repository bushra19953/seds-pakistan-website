-- tx_finance_set_accounts.sql — F6: finance accounts SET (doc +
-- audit) as ONE transaction. Replaces the setFinanceAccounts batch
-- (src/lib/finance/ledger.ts): settings/finance {accounts} with
-- MERGE semantics (Firestore set + merge:true — other settings/
-- finance fields survive), plus FINANCE_ACCOUNTS_UPDATED whose
-- payload is the full accounts array, as today.

create or replace function tx_finance_set_accounts(
  p_caller_uid text,
  p_accounts jsonb,
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
  values (p_idempotency_key, 'tx_finance_set_accounts')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_set_accounts' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  insert into fs_settings (id, firebase_uid, parent_path, data)
  values ('finance', null, 'settings', jsonb_build_object(
    'accounts', p_accounts,
    'updatedAt', to_jsonb(now())
  ))
  on conflict (id) do update
    set data = fs_settings.data || jsonb_build_object(
      'accounts', p_accounts,
      'updatedAt', to_jsonb(now()));

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', 'FINANCE_ACCOUNTS_UPDATED',
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'settings/finance',
    'payload', jsonb_build_object('accounts', p_accounts),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
