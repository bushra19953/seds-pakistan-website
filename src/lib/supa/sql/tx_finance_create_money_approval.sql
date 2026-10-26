-- tx_finance_create_money_approval.sql — F1: money-approval CREATE as
-- ONE Postgres transaction (cutover program, Option A: Supabase
-- write-primary for the 'finance' surface behind
-- isSupaPrimary('finance')). Replaces the Firestore batch in
-- createMoneyApprovalRequest (src/lib/finance/money-approval.ts):
-- approval doc + MONEY_APPROVAL_REQUESTED audit, atomically.
-- Design: ~/workspace/supabase-migration/cutover-sections/finance-design.md §F1.
--
-- The 503 flag-paused check (FINANCE_MAKER_CHECKER_ENFORCED) and the
-- reason-required check stay at the call site (finance law / pure
-- input law, identical ON and OFF). Everything else — target read,
-- pending-uniqueness, per-type validation INCLUDING the consent reads
-- (fs_consent_requests) — re-runs HERE, under the lock.
--
-- LOCK ORDER: idempotency claim, then the per-target advisory lock
-- ('money_approval:' || targetType || ':' || targetId — serialises
-- creates per target across processes, closing today's check-then-
-- batch uniqueness race: design Q4, a ratified strengthening), then
-- the target row read.
--
-- IDEMPOTENCY: claim-first against finance_write_idempotency (DDL in
-- finance-build.md deploy steps). A recorded result replays verbatim
-- (+ replayed:true); a NULL result is in-flight/crashed and RAISES
-- IDEMPOTENCY_INCOMPLETE (SQLSTATE 08006) rather than re-applying.
-- Business rejections DELETE the claim before returning, so a retry
-- re-evaluates them against current state.
--
-- TIMESTAMPS (law T1/T4/T6): createdAt = to_jsonb(now());
-- expiresAt = to_jsonb(now() + interval '7 days') — computed HERE;
-- the call site passes no timestamp fields at all.

create or replace function tx_finance_create_money_approval(
  p_maker_uid text,
  p_maker_role text,
  p_target_type text,
  p_target_id text,
  p_change_payload jsonb,
  p_reason text,
  p_new_id text,
  p_target_collection text,
  p_audit_action text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_table text;
  v_doc_id text;
  v_target jsonb;
  v_pending_id text;
  v_order jsonb;
  v_blocker text;
  v_result jsonb;
begin
  -- Idempotency claim (first statement after no lock: the claim IS the
  -- first lock, per the file header's lock order).
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_create_money_approval')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_create_money_approval' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  -- Per-target advisory lock: serialises creates for this target.
  perform pg_advisory_xact_lock(hashtextextended('money_approval:' || p_target_type || ':' || p_target_id, 0));

  -- Target location, mirroring targetRef()/targetLocation() exactly
  -- (destination_change special cases + the 400 on an unknown store).
  if p_target_type = 'destination_change' then
    if p_target_id = 'payment_methods' then
      v_table := 'fs_settings'; v_doc_id := 'payment_methods';
    elsif p_target_id = 'pages_donate' then
      v_table := 'fs_pages'; v_doc_id := 'donate';
    else
      delete from finance_write_idempotency where key = p_idempotency_key;
      return jsonb_build_object('ok', false, 'httpStatus', 400,
        'message', 'Unknown destination store: ' || p_target_id);
    end if;
  else
    if p_target_collection not in ('orders', 'finance_budgets', 'ledger_entries', 'sponsors_partners') then
      raise exception using errcode = 'P0001',
        message = 'tx_finance_create_money_approval: unwhitelisted target collection ' || p_target_collection;
    end if;
    v_table := 'fs_' || p_target_collection;
    v_doc_id := p_target_id;
  end if;

  execute format('select data from %I where id = $1', v_table)
    into v_target using v_doc_id;
  if v_target is null and p_target_type <> 'destination_change' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Target not found');
  end if;
  v_target := coalesce(v_target, '{}'::jsonb);

  -- Pending uniqueness (spec 3.4), inside the advisory lock.
  select id into v_pending_id
    from fs_money_approvals
   where data ->> 'targetType' = p_target_type
     and data ->> 'targetId' = p_target_id
     and data ->> 'status' = 'pending'
   limit 1;
  if found then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409,
      'message', 'A pending request already exists for this target',
      'existingId', v_pending_id);
  end if;

  -- Per-type request-time validation, mirroring the TS order and
  -- messages (validateOrderTransition + the ledger/budget/consent arms).
  if p_target_type like 'order\_%' then
    v_order := finance_normalize_order(v_target);
    if p_target_type in ('order_verify_payment', 'order_mark_paid') then
      if (v_order -> 'isDeleted') = 'true'::jsonb or (v_order ->> 'status') in ('cancelled', 'soft_deleted') then
        delete from finance_write_idempotency where key = p_idempotency_key;
        return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Cannot verify payment on a cancelled or deleted order');
      end if;
      if v_order ->> 'paymentStatus' = 'completed' then
        delete from finance_write_idempotency where key = p_idempotency_key;
        return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Payment is already completed for this order');
      end if;
      if v_order ->> 'status' <> 'pending_verification' then
        delete from finance_write_idempotency where key = p_idempotency_key;
        return jsonb_build_object('ok', false, 'httpStatus', 422,
          'message', 'Order in status ' || (v_order ->> 'status') || ' cannot move to verified');
      end if;
    elsif p_target_type = 'order_confirm_seat' then
      if v_order ->> 'paymentStatus' <> 'completed' then
        delete from finance_write_idempotency where key = p_idempotency_key;
        return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Seat confirmation requires a completed payment');
      end if;
    elsif p_target_type = 'order_refund' then
      if v_order ->> 'paymentStatus' <> 'completed' then
        delete from finance_write_idempotency where key = p_idempotency_key;
        return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Cannot refund an order whose payment is not completed');
      end if;
    elsif p_target_type = 'order_soft_delete' then
      if (v_order -> 'isDeleted') = 'true'::jsonb then
        delete from finance_write_idempotency where key = p_idempotency_key;
        return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Order is already soft-deleted');
      end if;
    end if;
  end if;

  if p_target_type = 'ledger_post' then
    if coalesce(v_target ->> 'status', '') <> 'draft' then
      delete from finance_write_idempotency where key = p_idempotency_key;
      return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Only a draft entry can be posted');
    end if;
    v_blocker := finance_ledger_consent_blocker(v_target);
    if v_blocker is not null then
      delete from finance_write_idempotency where key = p_idempotency_key;
      return jsonb_build_object('ok', false, 'httpStatus', 422, 'code', 'CONSENT_REQUIRED', 'message', v_blocker);
    end if;
  end if;

  if p_target_type = 'budget_approve' then
    if coalesce(v_target ->> 'status', '') <> 'draft' then
      delete from finance_write_idempotency where key = p_idempotency_key;
      return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'Only a draft budget can be approved');
    end if;
    if coalesce(v_target ->> 'consentId', '') <> '' then
      if not finance_consent_approved(finance_consent_view(v_target ->> 'consentId')) then
        delete from finance_write_idempotency where key = p_idempotency_key;
        return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'The linked Founder Consent is not decided-approved');
      end if;
    end if;
  end if;

  if p_target_type = 'destination_change' then
    if p_change_payload is null or p_change_payload = '{}'::jsonb then
      delete from finance_write_idempotency where key = p_idempotency_key;
      return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'destination_change requires the complete proposed value set');
    end if;
  end if;

  if p_target_type = 'crm_financial_edit' then
    if jsonb_typeof(p_change_payload -> 'financials') is distinct from 'object' then
      delete from finance_write_idempotency where key = p_idempotency_key;
      return jsonb_build_object('ok', false, 'httpStatus', 422, 'message', 'crm_financial_edit requires the full proposed financials map');
    end if;
  end if;

  -- Writes: approval doc + audit, one transaction.
  insert into fs_money_approvals (id, firebase_uid, parent_path, data)
  values (p_new_id, null, 'money_approvals', jsonb_build_object(
    'targetType', p_target_type,
    'targetId', p_target_id,
    'targetCollection', p_target_collection,
    'changePayload', coalesce(p_change_payload, '{}'::jsonb),
    'beforeSnapshot', finance_snapshot_for(p_target_type, v_target),
    'reason', to_jsonb(p_reason),
    'makerUid', p_maker_uid,
    'makerRole', p_maker_role,
    'checkerUid', null,
    'checkerRole', null,
    'status', 'pending',
    'auditAction', p_audit_action,
    'createdAt', to_jsonb(now()),
    'decidedAt', null,
    'expiresAt', to_jsonb(now() + interval '7 days')
  ));

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', 'MONEY_APPROVAL_REQUESTED',
    'actorUid', p_maker_uid,
    'targetUidOrResource', 'money_approvals/' || p_new_id,
    'payload', jsonb_build_object('targetType', p_target_type, 'targetId', p_target_id, 'approvalId', p_new_id),
    'timestamp', to_jsonb(now()),
    'source', 'server-finance'
  ));

  v_result := jsonb_build_object('ok', true, 'id', p_new_id);
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;
