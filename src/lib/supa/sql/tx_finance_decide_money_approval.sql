-- tx_finance_decide_money_approval.sql — F2/F2b: money-approval
-- DECIDE (approve + reject) as ONE Postgres transaction (cutover,
-- Option A). Replaces the Firestore runTransaction + reject batch in
-- decideMoneyApproval (src/lib/finance/money-approval.ts) — the A21/P1
-- flow. Design §F2. Checker PERMISSION checks stay at the call site
-- (design Q8); p_checker_can_manage_finance arrives as an explicit
-- arg, replacing the __checkerCanManageFinance smuggle.
--
-- LOCK ORDER (fixed, deadlock-safe): idempotency claim -> approval
-- row FOR UPDATE -> expiry re-check inside the lock -> target row
-- FOR UPDATE -> flow extras in this order: budget_approve's approved
-- set (ordered by id), order_refund's posted ledger entry, the
-- ledger_post reversal original, order seat-effect event rows
-- (ordered by event id). Hidden reads that are NON-transactional
-- today (P1 pseudo-atomicity) are IN-TRANSACTION here under these
-- locks — a ratified strengthening (design Q1); WHAT is read/written
-- does not change.
--
-- OUTCOME MAP (all returned, not raised):
--   pending-but-expired -> stamp 'expired' in this tx, 409 'has expired'
--   not pending         -> 409 'Request is already {status}'
--   maker == checker     -> ONLY the MONEY_APPROVAL_SELF_CHECK_DENIED
--                           audit row commits, then 422 MAKER_EQUALS_CHECKER
--   stale snapshot       -> 409, no writes
--   crm gate failure     -> 422 GATE_NOT_SATISFIED, no writes, request
--                           stays pending (gate parity)
--   ledger_post consent  -> approval stamped apply_failed IN this tx,
--     failure               500 APPLY_FAILED, target untouched, NO audit
--                           (today's asymmetry, Q5b preserved)
--   apply precondition   -> same apply_failed shape (a write Firestore
--     failure (missing      would fail at commit: missing target /
--     doc to update)        event / reversal original)
--   reject               -> approval 'rejected' + MONEY_APPROVAL_REJECTED
--   approve              -> applyChange + auditAction row + approval
--                           'approved_applied', one tx
-- Idempotent replay: same key returns the recorded outcome verbatim
-- (+replayed:true) — including a successful decide, where a DIFFERENT
-- checker (different key) still hits the status guard's 409 (V2).

create or replace function tx_finance_decide_money_approval(
  p_approval_id text,
  p_checker_uid text,
  p_checker_role text,
  p_decision text,
  p_note text,
  p_checker_can_manage_finance boolean,
  p_ledger_entry_id text,
  p_receipt_id text,
  p_reversal_entry_id text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_claimed int;
  v_prior jsonb;
  v_prior_fn text;
  v_req jsonb;
  v_table text;
  v_doc_id text;
  v_target jsonb;
  v_target_exists boolean := false;
  v_now jsonb := to_jsonb(now());
  v_result jsonb;
  -- apply state
  v_order jsonb;
  v_apply_error text := null;
  v_blocker text;
  v_gate jsonb;
  v_consent_view jsonb;
  v_posted_id text;
  v_posted jsonb;
  v_items jsonb := '[]'::jsonb;
  v_buyer text;
  v_item jsonb;
  v_event_id text;
  v_missing_event text := null;
  v_with_seats boolean := false;
  v_amount numeric;
  v_entry_date text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
  v_consent_id text;
begin
  /* ---------------- idempotency claim ---------------- */
  insert into finance_write_idempotency (key, fn)
  values (p_idempotency_key, 'tx_finance_decide_money_approval')
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    select result, fn into v_prior, v_prior_fn
      from finance_write_idempotency where key = p_idempotency_key;
    if v_prior_fn <> 'tx_finance_decide_money_approval' then
      raise exception using errcode = 'P0001',
        message = 'IDEMPOTENCY_KEY_FN_MISMATCH: key ' || p_idempotency_key || ' was claimed by ' || v_prior_fn;
    end if;
    if v_prior is null then
      raise exception using errcode = '08006',
        message = 'IDEMPOTENCY_INCOMPLETE: finance write ' || p_idempotency_key || ' is in-flight or crashed; retry later';
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  /* ---------------- (1) approval row FOR UPDATE ---------------- */
  select data into v_req from fs_money_approvals where id = p_approval_id for update;
  if not found then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Approval request not found');
  end if;

  /* ---------------- (2) expiry inside the lock ---------------- */
  if v_req ->> 'status' = 'pending'
     and (v_req ->> 'expiresAt') is not null
     and (v_req ->> 'expiresAt')::timestamptz <= now() then
    update fs_money_approvals set data = data || jsonb_build_object('status', 'expired')
     where id = p_approval_id;
    v_result := jsonb_build_object('ok', false, 'httpStatus', 409, 'message', 'Approval request has expired');
    update finance_write_idempotency set result = v_result where key = p_idempotency_key;
    return v_result;
  end if;
  if v_req ->> 'status' <> 'pending' then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409,
      'message', 'Request is already ' || (v_req ->> 'status'));
  end if;

  /* ---------------- maker != checker (audited denial) ---------------- */
  if p_checker_uid = (v_req ->> 'makerUid') then
    insert into fs_audit_logs (id, firebase_uid, parent_path, data)
    values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
      'action', 'MONEY_APPROVAL_SELF_CHECK_DENIED',
      'actorUid', p_checker_uid,
      'targetUidOrResource', 'money_approvals/' || p_approval_id,
      'payload', jsonb_build_object(
        'approvalId', p_approval_id,
        'targetType', v_req -> 'targetType',
        'targetId', v_req -> 'targetId'),
      'timestamp', v_now,
      'source', 'server-finance'
    ));
    v_result := jsonb_build_object('ok', false, 'httpStatus', 422,
      'code', 'MAKER_EQUALS_CHECKER', 'message', 'Maker cannot check their own request');
    update finance_write_idempotency set result = v_result where key = p_idempotency_key;
    return v_result;
  end if;

  /* ---------------- (3) target row FOR UPDATE ---------------- */
  if (v_req ->> 'targetType') = 'destination_change' then
    if (v_req ->> 'targetId') = 'payment_methods' then
      v_table := 'fs_settings'; v_doc_id := 'payment_methods';
    elsif (v_req ->> 'targetId') = 'pages_donate' then
      v_table := 'fs_pages'; v_doc_id := 'donate';
    else
      -- targetRef() throws this at the call site today (400); kept as
      -- a defensive arm — the request could not have been created
      -- for an unknown store.
      delete from finance_write_idempotency where key = p_idempotency_key;
      return jsonb_build_object('ok', false, 'httpStatus', 400,
        'message', 'Unknown destination store: ' || (v_req ->> 'targetId'));
    end if;
  else
    if (v_req ->> 'targetCollection') not in ('orders', 'finance_budgets', 'ledger_entries', 'sponsors_partners') then
      raise exception using errcode = 'P0001',
        message = 'tx_finance_decide_money_approval: unwhitelisted target collection ' || (v_req ->> 'targetCollection');
    end if;
    v_table := 'fs_' || (v_req ->> 'targetCollection');
    v_doc_id := v_req ->> 'targetId';
  end if;
  execute format('select data from %I where id = $1 for update', v_table)
    into v_target using v_doc_id;
  v_target_exists := found;
  v_target := coalesce(v_target, '{}'::jsonb);

  /* ---------------- (4) flow-specific extra locks ---------------- */
  if (v_req ->> 'targetType') = 'budget_approve' then
    perform id from fs_finance_budgets
     where data ->> 'fyLabel' = (v_target ->> 'fyLabel')
       and data ->> 'status' = 'approved'
     order by id for update;
  end if;
  if (v_req ->> 'targetType') = 'order_refund' then
    select id, data into v_posted_id, v_posted
      from fs_ledger_entries
     where data ->> 'sourceOrderId' = (v_req ->> 'targetId')
       and data ->> 'status' = 'posted'
     limit 1 for update;
  end if;
  if (v_req ->> 'targetType') = 'ledger_post'
     and coalesce(v_target ->> 'reversalOf', '') <> '' then
    perform id from fs_ledger_entries where id = (v_target ->> 'reversalOf') for update;
  end if;
  if (v_req ->> 'targetType') in ('order_verify_payment', 'order_mark_paid', 'order_confirm_seat') then
    v_order := finance_normalize_order(v_target);
    v_items := v_order -> 'items';
    v_buyer := v_order ->> 'buyerUserId';
    v_with_seats := (v_req ->> 'targetType') = 'order_verify_payment'
      or ((v_req ->> 'targetType') = 'order_mark_paid' and jsonb_array_length(v_items) > 0)
      or (v_req ->> 'targetType') = 'order_confirm_seat';
    if v_with_seats and coalesce(v_buyer, '') <> '' then
      for v_item in select * from jsonb_array_elements(v_items) loop
        v_event_id := coalesce(nullif(v_item ->> 'eventId', ''), nullif(v_target ->> 'eventId', ''));
        if (v_item ->> 'type' = 'event_ticket' or v_target ->> 'originatingModule' = 'Events')
           and v_event_id is not null then
          perform id from fs_events where id = v_event_id for update;
          if not found and v_missing_event is null then
            v_missing_event := v_event_id;
          end if;
        end if;
      end loop;
    end if;
  end if;

  /* ---------------- stale-snapshot (both decisions) ---------------- */
  if finance_snapshot_for(v_req ->> 'targetType', v_target)
       is distinct from (v_req -> 'beforeSnapshot') then
    delete from finance_write_idempotency where key = p_idempotency_key;
    return jsonb_build_object('ok', false, 'httpStatus', 409,
      'message', 'Target changed since the request was created (stale approval)');
  end if;

  /* ---------------- reject ---------------- */
  if p_decision = 'reject' then
    update fs_money_approvals
       set data = data || jsonb_build_object(
         'status', 'rejected',
         'checkerUid', p_checker_uid,
         'checkerRole', p_checker_role,
         'decidedAt', v_now,
         'decisionNote', to_jsonb(p_note))
     where id = p_approval_id;
    insert into fs_audit_logs (id, firebase_uid, parent_path, data)
    values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
      'action', 'MONEY_APPROVAL_REJECTED',
      'actorUid', p_checker_uid,
      'targetUidOrResource', 'money_approvals/' || p_approval_id,
      'payload', jsonb_build_object(
        'approvalId', p_approval_id,
        'targetType', v_req -> 'targetType',
        'targetId', v_req -> 'targetId',
        'note', to_jsonb(p_note)),
      'timestamp', v_now,
      'source', 'server-finance'
    ));
    v_result := jsonb_build_object('ok', true, 'status', 'rejected');
    update finance_write_idempotency set result = v_result where key = p_idempotency_key;
    return v_result;
  end if;

  /* ---------------- approve: apply precondition failures ----------------
     Firestore's transaction fails at commit when an update targets a
     missing doc; decide then stamps apply_failed + 500 with the target
     untouched and NO audit row. The same net state is produced here by
     pre-checking existence BEFORE any apply write. */
  if (v_req ->> 'targetType') <> 'destination_change' and not v_target_exists then
    v_apply_error := 'No document to update: ' || (v_req ->> 'targetCollection') || '/' || (v_req ->> 'targetId');
  end if;
  if v_apply_error is null and v_missing_event is not null then
    v_apply_error := 'No document to update: events/' || v_missing_event;
  end if;
  if v_apply_error is null
     and (v_req ->> 'targetType') = 'ledger_post'
     and coalesce(v_target ->> 'reversalOf', '') <> '' then
    perform id from fs_ledger_entries where id = (v_target ->> 'reversalOf');
    if not found then
      v_apply_error := 'No document to update: ledger_entries/' || (v_target ->> 'reversalOf');
    end if;
  end if;
  if v_apply_error is null and (v_req ->> 'targetType') = 'ledger_post' then
    v_blocker := finance_ledger_consent_blocker(v_target);
    if v_blocker is not null then v_apply_error := v_blocker; end if;
  end if;
  if v_apply_error is not null then
    update fs_money_approvals
       set data = data || jsonb_build_object(
         'status', 'apply_failed',
         'checkerUid', p_checker_uid,
         'checkerRole', p_checker_role,
         'decidedAt', v_now,
         'applyError', v_apply_error)
     where id = p_approval_id;
    v_result := jsonb_build_object('ok', false, 'httpStatus', 500,
      'code', 'APPLY_FAILED',
      'message', 'Apply failed: ' || v_apply_error,
      'applyError', v_apply_error);
    update finance_write_idempotency set result = v_result where key = p_idempotency_key;
    return v_result;
  end if;

  /* ---------------- crm_status_active gate (stays pending) ---------------- */
  if (v_req ->> 'targetType') = 'crm_status_active' then
    if coalesce(v_target #>> '{relatedParty,consentRequestId}', '') <> '' then
      v_consent_view := finance_consent_view(v_target #>> '{relatedParty,consentRequestId}');
    end if;
    v_gate := finance_related_party_gate(v_target, v_consent_view);
    if (v_gate -> 'canActivate') <> 'true'::jsonb then
      delete from finance_write_idempotency where key = p_idempotency_key;
      return jsonb_build_object('ok', false, 'httpStatus', 422,
        'code', 'GATE_NOT_SATISFIED',
        'message', 'Related-party gate not satisfied: ' || (
          select string_agg(m, '; ') from jsonb_array_elements_text(v_gate -> 'missing') as m));
    end if;
  end if;

  /* ---------------- applyChange (per targetType) ---------------- */
  case
  when (v_req ->> 'targetType') in ('order_verify_payment', 'order_mark_paid') then
    v_order := finance_normalize_order(v_target);
    v_amount := v_order -> 'totalPkr';
    update fs_orders
       set data = data || jsonb_build_object(
         'status', 'verified',
         'paymentStatus', 'completed',
         'totalPkr', v_amount,
         'total', v_amount,
         'updatedAt', v_now)
     where id = (v_req ->> 'targetId');
    if v_with_seats then
      perform finance_mirror_event_registration(
        v_target, v_req ->> 'targetId', v_now);
    end if;
    -- Income ledger entry (posted only when the checker also holds
    -- canManageFinance — the spec 3.2 exception).
    insert into fs_ledger_entries (id, firebase_uid, parent_path, data)
    values (p_ledger_entry_id, null, 'ledger_entries', jsonb_build_object(
      'date', v_entry_date,
      'fyLabel', finance_derive_fy_label(v_entry_date),
      'type', 'income',
      'category', finance_ledger_category(v_order ->> 'originatingModule'),
      'amountPkr', v_amount,
      'counterparty', coalesce(nullif(v_order #>> '{buyer,fullName}', ''), v_order ->> 'buyerUserId', ''),
      'counterpartyPartnerId', null,
      'description', 'Order ' || (v_req ->> 'targetId') || ' payment verified (' || coalesce(v_order ->> 'originatingModule', 'store') || ')',
      'budgetLineId', null,
      'unbudgeted', false,
      'overThreshold', false,
      'consentId', null,
      'paymentMethod', 'bank_transfer',
      'accountLabel', '',
      'receiptDriveId', v_order -> 'receiptDriveId',
      'receiptHash', null,
      'relatedPartyEntryId', null,
      'enteredBy', v_req -> 'makerUid',
      'status', case when p_checker_can_manage_finance then 'posted' else 'draft' end,
      'postedBy', case when p_checker_can_manage_finance then to_jsonb(p_checker_uid) else 'null'::jsonb end,
      'postedAt', case when p_checker_can_manage_finance then v_now else 'null'::jsonb end,
      'sourceOrderId', v_req ->> 'targetId',
      'reversalOf', null,
      'reversedBy', null,
      'createdAt', v_now,
      'updatedAt', v_now
    ));
    -- Inbound receipt; slaDueAt base 2 (T5): verification instant + 14d.
    insert into fs_finance_receipts (id, firebase_uid, parent_path, data)
    values (p_receipt_id, null, 'finance_receipts', jsonb_build_object(
      'officerUid', v_order -> 'buyerUserId',
      'officerName', coalesce(v_order #>> '{buyer,fullName}', ''),
      'kind', 'inbound_payment',
      'transactionDate', v_entry_date,
      'amountPkr', v_amount,
      'description', 'Order ' || (v_req ->> 'targetId') || ' payment receipt',
      'receiptDriveId', coalesce(v_order ->> 'receiptDriveId', ''),
      'receiptUrl', coalesce(v_order ->> 'receiptUrl', ''),
      'receiptHash', null,
      'sourceOrderId', v_req ->> 'targetId',
      'ledgerEntryId', p_ledger_entry_id,
      'deliveredToTreasurerAt', v_now,
      'slaDueAt', to_jsonb(now() + interval '14 days'),
      'createdBy', v_req -> 'makerUid',
      'createdAt', v_now,
      'updatedAt', v_now
    ));
  when (v_req ->> 'targetType') = 'order_confirm_seat' then
    perform finance_mirror_event_registration(v_target, v_req ->> 'targetId', v_now);
  when (v_req ->> 'targetType') = 'order_refund' then
    v_order := finance_normalize_order(v_target);
    update fs_orders
       set data = data || jsonb_build_object('paymentStatus', 'refunded', 'updatedAt', v_now)
         || case when (v_order ->> 'status') in ('shipped', 'delivered')
              then '{}'::jsonb
              else jsonb_build_object('status', 'refunded') end
     where id = (v_req ->> 'targetId');
    if v_posted_id is not null then
      insert into fs_ledger_entries (id, firebase_uid, parent_path, data)
      values (p_reversal_entry_id, null, 'ledger_entries',
        v_posted || jsonb_build_object(
          'type', case when v_posted ->> 'type' = 'income' then 'expense' else 'income' end,
          'status', 'draft',
          'postedBy', null,
          'postedAt', null,
          'reversalOf', v_posted_id,
          'reversedBy', null,
          'description', 'Refund reversal for order ' || (v_req ->> 'targetId') || ': ' || coalesce(v_req ->> 'reason', ''),
          'enteredBy', v_req -> 'makerUid',
          'createdAt', v_now,
          'updatedAt', v_now
        ));
    end if;
  when (v_req ->> 'targetType') = 'order_soft_delete' then
    update fs_orders
       set data = data || jsonb_build_object(
         'isDeleted', true,
         'status', 'soft_deleted',
         'deletedBy', p_checker_uid,
         'deletedAt', v_now,
         'deleteReason', v_req -> 'reason',
         'deleteApprovalId', p_approval_id,
         'updatedAt', v_now)
     where id = (v_req ->> 'targetId');
  when (v_req ->> 'targetType') = 'destination_change' then
    -- S-W5 (store workstream, executed here): the settings/pages write
    -- commits INSIDE this transaction with the approval + audit —
    -- the isSupaPrimary('store-settings') ON behavior. Firestore set
    -- semantics: the document is REPLACED by the payload +
    -- destinationMeta (no merge), created when absent.
    execute format(
      'insert into %I (id, firebase_uid, parent_path, data) values ($1, null, $2, $3)
       on conflict (id) do update set data = excluded.data',
      v_table)
    using v_doc_id,
      case when v_table = 'fs_settings' then 'settings' else 'pages' end,
      (v_req -> 'changePayload') || jsonb_build_object(
        'destinationMeta', jsonb_build_object(
          'lastChangedBy', v_req -> 'makerUid',
          'lastChangedAt', v_now,
          'approvedBy', p_checker_uid,
          'approvalId', p_approval_id));
  when (v_req ->> 'targetType') = 'budget_approve' then
    update fs_finance_budgets
       set data = data || jsonb_build_object('status', 'superseded', 'supersededBy', v_req ->> 'targetId')
     where data ->> 'fyLabel' = (v_target ->> 'fyLabel')
       and data ->> 'status' = 'approved'
       and id <> (v_req ->> 'targetId');
    v_consent_id := nullif(v_target ->> 'consentId', '');
    update fs_finance_budgets
       set data = data || jsonb_build_object(
         'status', 'approved',
         'approvedBy', p_checker_uid,
         'approvedAt', v_now,
         'approvalId', p_approval_id,
         'consentId', to_jsonb(v_consent_id),
         'consentPending', v_consent_id is null,
         'updatedAt', v_now)
     where id = (v_req ->> 'targetId');
  when (v_req ->> 'targetType') = 'ledger_post' then
    update fs_ledger_entries
       set data = data || jsonb_build_object(
         'status', 'posted',
         'postedBy', p_checker_uid,
         'postedAt', v_now,
         'updatedAt', v_now)
     where id = (v_req ->> 'targetId');
    if coalesce(v_target ->> 'reversalOf', '') <> '' then
      update fs_ledger_entries
         set data = data || jsonb_build_object('reversedBy', v_req ->> 'targetId')
       where id = (v_target ->> 'reversalOf');
    end if;
  when (v_req ->> 'targetType') = 'crm_financial_edit' then
    update fs_sponsors_partners
       set data = data || jsonb_build_object(
         'financials', coalesce(v_req #> '{changePayload,financials}', '{}'::jsonb)
           || jsonb_build_object('currency', 'PKR'),
         'updatedAt', v_now)
     where id = (v_req ->> 'targetId');
  when (v_req ->> 'targetType') = 'crm_status_active' then
    update fs_sponsors_partners
       set data = data || jsonb_build_object('status', 'Active', 'updatedAt', v_now)
     where id = (v_req ->> 'targetId');
  else
    raise exception using errcode = 'P0001',
      message = 'tx_finance_decide_money_approval: unknown targetType ' || (v_req ->> 'targetType');
  end case;

  /* ---------------- audit + decision stamp ---------------- */
  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', v_req -> 'auditAction',
    'actorUid', p_checker_uid,
    'targetUidOrResource', (v_req ->> 'targetCollection') || '/' || (v_req ->> 'targetId'),
    'payload', jsonb_build_object(
      'approvalId', p_approval_id,
      'targetType', v_req -> 'targetType',
      'makerUid', v_req -> 'makerUid',
      'before', v_req -> 'beforeSnapshot',
      'after', v_req -> 'changePayload'),
    'timestamp', v_now,
    'source', 'server-finance'
  ));

  update fs_money_approvals
     set data = data || jsonb_build_object(
       'status', 'approved_applied',
       'checkerUid', p_checker_uid,
       'checkerRole', p_checker_role,
       'decidedAt', v_now,
       'decisionNote', to_jsonb(p_note))
   where id = p_approval_id;

  v_result := jsonb_build_object('ok', true, 'status', 'approved_applied');
  update finance_write_idempotency set result = v_result where key = p_idempotency_key;
  return v_result;
end;
$$;

-- mirrorEventRegistration() port (money-approval.ts): per event_ticket
-- item (or any item when the order originates from Events), append the
-- buyer to the event's attendeeIds (arrayUnion semantics: only when
-- absent) and upsert the buyer's registration with merge semantics.
-- Event rows were locked by the caller; a missing event was already
-- routed to apply_failed before any write.
create or replace function finance_mirror_event_registration(
  p_order jsonb,
  p_order_id text,
  p_now jsonb
) returns void
language plpgsql
as $$
declare
  v_items jsonb := case
    when jsonb_typeof(p_order -> 'items') = 'array' then p_order -> 'items'
    else '[]'::jsonb
  end;
  v_buyer text := coalesce(
    nullif(p_order ->> 'buyerUserId', ''),
    case when jsonb_typeof(p_order -> 'userId') = 'string' then p_order ->> 'userId' end);
  v_item jsonb;
  v_event_id text;
begin
  if coalesce(v_buyer, '') = '' then return; end if;
  for v_item in select * from jsonb_array_elements(v_items) loop
    v_event_id := coalesce(nullif(v_item ->> 'eventId', ''), nullif(p_order ->> 'eventId', ''));
    if (v_item ->> 'type' = 'event_ticket' or p_order ->> 'originatingModule' = 'Events')
       and coalesce(v_event_id, '') <> '' then
      update fs_events
         set data = jsonb_set(data, '{attendeeIds}',
           case
             when jsonb_typeof(data -> 'attendeeIds') = 'array'
                  and (data -> 'attendeeIds') @> jsonb_build_array(v_buyer)
               then data -> 'attendeeIds'
             when jsonb_typeof(data -> 'attendeeIds') = 'array'
               then (data -> 'attendeeIds') || jsonb_build_array(v_buyer)
             else jsonb_build_array(v_buyer)
           end)
       where id = v_event_id;
      insert into fs_group_registrations (id, firebase_uid, parent_path, data)
      values (v_buyer, null, 'events/' || v_event_id || '/registrations', jsonb_build_object(
        'uid', v_buyer,
        'eventId', v_event_id,
        'transactionId', p_order_id,
        'displayName', coalesce(nullif(p_order #>> '{buyer,fullName}', ''), 'Unknown'),
        'email', coalesce(p_order #>> '{buyer,email}', ''),
        'status', 'confirmed',
        'paymentStatus', 'verified',
        'paymentMethod', coalesce(nullif(p_order ->> 'paymentMethod', ''), 'manual'),
        'paymentRef', coalesce(nullif(p_order ->> 'paymentRef', ''), p_order ->> 'receiptUrl', ''),
        'createdAt', p_now,
        'updatedAt', p_now
      ))
      on conflict (parent_path, id) do update
        set data = fs_group_registrations.data || excluded.data;
    end if;
  end loop;
end;
$$;
