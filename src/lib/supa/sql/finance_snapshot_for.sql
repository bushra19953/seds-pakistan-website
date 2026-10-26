-- finance_snapshot_for.sql — SQL port of snapshotFor()
-- (src/lib/finance/money-approval.ts), the money-relevant snapshot used
-- for stale-approval protection. Used by tx_finance_create_money_
-- approval (stored as beforeSnapshot) and tx_finance_decide_money_
-- approval (recomputed under lock and compared). Plain helper, not a
-- tx_* function: it performs no writes and is called only from inside
-- other functions' transactions.
--
-- Field-for-field parity with the TS original: every field is the raw
-- stored value, or JSON null when absent (the TS `?? null`). Extra
-- target fields are ignored, exactly as today — except
-- destination_change, whose snapshot is the whole document minus
-- destinationMeta. Comparison note: the TS deepEqual is JSON.stringify
-- (key-order sensitive); jsonb equality here is key-order insensitive,
-- which accepts exactly the same VALUE sets (a strengthening of the
-- comparison, recorded in finance-build.md).

create or replace function finance_order_snapshot(p_data jsonb) returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'status', coalesce(p_data -> 'status', 'null'::jsonb),
    'paymentStatus', coalesce(p_data -> 'paymentStatus', 'null'::jsonb),
    'total', coalesce(p_data -> 'total', 'null'::jsonb),
    'totalPkr', coalesce(p_data -> 'totalPkr', 'null'::jsonb),
    'amount', coalesce(p_data -> 'amount', 'null'::jsonb),
    'isDeleted', coalesce(p_data -> 'isDeleted', 'null'::jsonb)
  );
$$;

create or replace function finance_crm_snapshot(p_data jsonb) returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'status', coalesce(p_data -> 'status', 'null'::jsonb),
    'financials', coalesce(p_data -> 'financials', 'null'::jsonb),
    'isRelatedParty', coalesce(p_data -> 'isRelatedParty', 'null'::jsonb)
  );
$$;

create or replace function finance_snapshot_for(
  p_target_type text,
  p_data jsonb
) returns jsonb
language sql
immutable
as $$
  select case p_target_type
    when 'order_verify_payment' then finance_order_snapshot(p_data)
    when 'order_mark_paid' then finance_order_snapshot(p_data)
    when 'order_confirm_seat' then finance_order_snapshot(p_data)
    when 'order_refund' then finance_order_snapshot(p_data)
    when 'order_soft_delete' then finance_order_snapshot(p_data)
    when 'budget_approve' then jsonb_build_object(
      'status', coalesce(p_data -> 'status', 'null'::jsonb),
      'revision', coalesce(p_data -> 'revision', 'null'::jsonb),
      'fyLabel', coalesce(p_data -> 'fyLabel', 'null'::jsonb)
    )
    when 'ledger_post' then jsonb_build_object(
      'status', coalesce(p_data -> 'status', 'null'::jsonb),
      'amountPkr', coalesce(p_data -> 'amountPkr', 'null'::jsonb),
      'consentId', coalesce(p_data -> 'consentId', 'null'::jsonb),
      'unbudgeted', coalesce(p_data -> 'unbudgeted', 'null'::jsonb),
      'overThreshold', coalesce(p_data -> 'overThreshold', 'null'::jsonb)
    )
    when 'crm_financial_edit' then finance_crm_snapshot(p_data)
    when 'crm_status_active' then finance_crm_snapshot(p_data)
    when 'destination_change' then coalesce(p_data, '{}'::jsonb) - 'destinationMeta'
    else '{}'::jsonb
  end;
$$;

