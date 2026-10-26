-- tx_finance_expire_money_approval.sql — F3: money-approval EXPIRE as
-- ONE guarded UPDATE (cutover, Option A). Replaces expireIfNeeded's
-- Firestore update. Design §F3.
--
-- Parity laws: NO audit row (expire has none today — Q3); the guard
-- (status='pending' AND expiresAt <= now()) lives in the UPDATE itself,
-- so concurrent expirers cannot double-stamp (the value written is
-- identical either way, exactly the benign race today). expiresAt is
-- parsed from its jsonb ISO-string form (timestamp law T4) — the
-- never-expire regression shape. Naturally idempotent; the claim row
-- is still written for uniformity. No row lock needed beyond the
-- guarded update.

create or replace function tx_finance_expire_money_approval(
  p_approval_id text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_expired boolean;
  v_result jsonb;
begin
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_expire_money_approval')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_expire_money_approval' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  update fs_money_approvals
     set data = data || jsonb_build_object('status', 'expired')
   where id = p_approval_id
     and data ->> 'status' = 'pending'
     and (data ->> 'expiresAt')::timestamptz <= now();
  v_expired := found;

  v_result := jsonb_build_object('ok', true, 'expired', v_expired);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
