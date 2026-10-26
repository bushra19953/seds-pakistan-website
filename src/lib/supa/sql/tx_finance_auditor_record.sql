-- tx_finance_auditor_record.sql — F5i: auditor appointment UPSERT
-- (doc + audit) as ONE transaction. Replaces the auditor PUT batch
-- (Firestore set without merge on auditor_appointments/{fyLabel}).
-- Validation incl. the fallback-consistency 422 stays at the call
-- site; the stored appointment arrives complete in p_appointment.

create or replace function tx_finance_auditor_record(
  p_caller_uid text,
  p_fy_label text,
  p_appointment jsonb,
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
  values (p_idempotency_key, 'tx_finance_auditor_record')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_auditor_record' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  insert into fs_auditor_appointments (id, firebase_uid, parent_path, data)
  values (p_fy_label, null, 'auditor_appointments',
    p_appointment || jsonb_build_object('updatedAt', to_jsonb(now())))
  on conflict (id) do update set data = excluded.data;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit_action,
    'actorUid', p_caller_uid,
    'targetUidOrResource', 'auditor_appointments/' || p_fy_label,
    'payload', p_audit_payload,
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'fyLabel', p_fy_label,
    'fallback', coalesce(p_appointment -> 'fallback', 'false'::jsonb));
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
