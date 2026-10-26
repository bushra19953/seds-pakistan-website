-- tx_store_order_patch.sql — S-W2/O2: fulfilment-only order patch +
-- money-audit as ONE Postgres transaction. Spec: store-design.md
-- §3.2 O2. Flip-time APPLY artifact: authoring applies nothing.
--
-- What this replaces: the orders route PATCH's already-atomic
-- Firestore batch (order update + money-audit, fail closed) — the
-- atomicity is PRESERVED. The route's money-field / money-status 409
-- guard runs in the route BEFORE this function is called and stays
-- un-bypassable: this function takes EXPLICIT SCALAR params (status,
-- fulfilmentNote) — never an arbitrary patch object — so it cannot be
-- used to move a money field even by a caller that skips the guard.
-- p_has_status / p_has_fulfilment_note distinguish "field absent"
-- from "field set" (the route's sanitizer keys off !== undefined).
--
-- The audit's before/after are computed from the LOCKED row inside
-- the transaction (the route under primacy holds no pre-read):
-- before = { status, paymentStatus } of the row as found; after =
-- the same pair with the status change applied — exactly the pair
-- the route's batch writes today. The updated row is returned as
-- order_data so the route can run its buyer notification off the
-- committed state, as it does today off its pre-read snapshot.
--
-- RECONCILIATION POINT (merge with feat/supa-cut-finance-build): the
-- order's MONEY-state transitions (verify / mark paid / confirm seat /
-- refund / soft delete) are NOT this function and NOT the store
-- route — they are finance's money-approval apply cases
-- (order_verify_payment / order_mark_paid / order_confirm_seat /
-- order_refund / order_soft_delete), which finance's build inverts
-- inside tx_finance_decide_money_approval. Both writers target
-- fs_orders; nothing here conflicts mechanically, but the
-- store-orders-api SUPA_PRIMARY token may only flip AFTER finance is
-- merged AND Supa-primary (design §3.2 constraint / task S-W6).

create or replace function tx_store_order_patch(
  p_id text,
  p_status text default null,
  p_has_status boolean default false,
  p_fulfilment_note text default null,
  p_has_fulfilment_note boolean default false,
  p_audit jsonb default '{}'::jsonb,
  p_timestamp timestamptz default now()
) returns jsonb
language plpgsql
as $$
declare
  v_now_iso text := to_char(p_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_before jsonb;
  v_before_pair jsonb;
  v_after_pair jsonb;
  v_updates jsonb := jsonb_build_object('updatedAt', v_now_iso);
  v_updated jsonb;
begin
  select data into v_before
    from fs_orders
   where id = p_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Order not found');
  end if;

  if p_has_status then
    v_updates := v_updates || jsonb_build_object('status', p_status);
  end if;
  if p_has_fulfilment_note then
    v_updates := v_updates || jsonb_build_object('fulfilmentNote', p_fulfilment_note);
  end if;

  v_before_pair := jsonb_build_object(
    'status', v_before -> 'status',
    'paymentStatus', v_before -> 'paymentStatus'
  );
  v_after_pair := jsonb_build_object(
    'status', case when p_has_status then to_jsonb(p_status) else v_before -> 'status' end,
    'paymentStatus', v_before -> 'paymentStatus'
  );

  update fs_orders
     set data = v_before || v_updates
   where id = p_id
  returning data into v_updated;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit ->> 'action',
    'actorUid', p_audit ->> 'actorUid',
    'actorRole', coalesce(p_audit ->> 'actorRole', ''),
    'targetUidOrResource', p_id,
    'targetType', 'order',
    'orderId', p_id,
    'payload', jsonb_build_object(
      'before', v_before_pair,
      'after', v_after_pair,
      'changedFields', coalesce(p_audit -> 'changedFields', '[]'::jsonb),
      'reason', null,
      'source', p_audit ->> 'source'
    ),
    'timestamp', to_jsonb(p_timestamp),
    'createdAt', to_jsonb(p_timestamp)
  ));

  return jsonb_build_object('ok', true, 'orderId', p_id, 'order_data', v_updated);
end;
$$;
