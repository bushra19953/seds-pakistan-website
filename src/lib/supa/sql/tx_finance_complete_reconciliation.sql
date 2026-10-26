-- tx_finance_complete_reconciliation.sql — F4: reconciliation
-- COMPLETE as ONE Postgres transaction (cutover, Option A). Replaces
-- the Firestore batch in reconciliations/complete/route.ts
-- (MANUAL_LIST M-FG5-1, distinct-UID law). Design §F4.
--
-- Guard order is today's route order, exactly: (call-site permission
-- canManageFinance OR canApproveMoney stays at the call site) ->
-- completed 409 -> checker == reconciledBy 422 -> missing
-- statementDriveId 422 -> closingBalancePkr null 422 -> recompute ->
-- client-balance mismatch 422 -> difference/explanation 422.
--
-- The ledger balance is RECOMPUTED here from posted entries
-- (computeAccountBalance port): opening + posted income - posted
-- expense for the accountLabel whose date falls inside
-- [periodStart, periodEnd] (string range on the YYYY-MM-DD date, as
-- the TS compares). All sums are exact integer PKR: amountPkr values
-- are cast through numeric and accumulated as bigint — no floats.
--
-- The post-commit stampComplianceObligation stays at the call site
-- (Firestore, best-effort, governance-owned) and is NOT part of this
-- transaction, exactly as today.

create or replace function tx_finance_complete_reconciliation(
  p_rec_id text,
  p_checker_uid text,
  p_client_ledger_balance_pkr numeric,
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
  v_ledger_balance bigint;
  v_difference bigint;
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_complete_reconciliation')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_complete_reconciliation' then
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
  if v_rec ->> 'status' = 'completed' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409, 'message', 'Reconciliation is already completed');
  end if;
  if p_checker_uid = (v_rec ->> 'reconciledBy') then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422,
      'message', 'The completing officer (checkedBy) must not be the officer who reconciled (reconciledBy)');
  end if;
  if coalesce(v_rec ->> 'statementDriveId', '') = '' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422,
      'message', 'A bank statement reference (statementDriveId) is required before completion');
  end if;
  if jsonb_typeof(v_rec -> 'closingBalancePkr') is distinct from 'number' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422,
      'message', 'closingBalancePkr (per the bank statement) must be set before completion');
  end if;

  -- Recompute (computeAccountBalance port, integer-exact).
  select coalesce(finance_jsonb_number(v_rec -> 'openingBalancePkr'), 0)::bigint
       + coalesce(sum(
           case when e.data ->> 'type' = 'income'
             then finance_jsonb_number(e.data -> 'amountPkr')::bigint
             else -finance_jsonb_number(e.data -> 'amountPkr')::bigint
           end), 0)
    into v_ledger_balance
    from fs_ledger_entries e
   where e.data ->> 'accountLabel' = (v_rec ->> 'accountLabel')
     and e.data ->> 'status' = 'posted'
     and e.data ->> 'date' >= (v_rec ->> 'periodStart')
     and e.data ->> 'date' <= (v_rec ->> 'periodEnd');

  if p_client_ledger_balance_pkr is not null
     and p_client_ledger_balance_pkr <> v_ledger_balance then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422,
      'message', 'Client-supplied ledger balance ' || p_client_ledger_balance_pkr::bigint::text
        || ' differs from the recomputed ' || v_ledger_balance::text);
  end if;

  v_difference := finance_jsonb_number(v_rec -> 'closingBalancePkr')::bigint - v_ledger_balance;
  if v_difference <> 0
     and length(trim(coalesce(v_rec ->> 'differenceExplanation', ''))) < 10 then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 422,
      'message', 'A nonzero difference requires an explanation of at least 10 characters');
  end if;

  update fs_finance_reconciliations
     set data = data || jsonb_build_object(
       'status', 'completed',
       'checkedBy', p_checker_uid,
       'completedAt', to_jsonb(now()),
       'computedAt', to_jsonb(now()),
       'ledgerBalancePkr', v_ledger_balance,
       'differencePkr', v_difference,
       'updatedAt', to_jsonb(now()))
   where id = p_rec_id;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_checker_uid,
    'targetUidOrResource', 'finance_reconciliations/' || p_rec_id,
    'payload', jsonb_build_object(
      'differencePkr', v_difference,
      'ledgerBalancePkr', v_ledger_balance,
      'closingBalancePkr', v_rec -> 'closingBalancePkr'),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_rec_id, 'status', 'completed',
    'ledgerBalancePkr', v_ledger_balance, 'differencePkr', v_difference);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
