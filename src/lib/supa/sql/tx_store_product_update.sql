-- tx_store_product_update.sql — S-W1/P2: product update + money-audit
-- as ONE Postgres transaction. Spec: store-design.md §3.1 P2.
-- Flip-time APPLY artifact: authoring applies nothing.
--
-- What this replaces: the products route PATCH's already-atomic
-- Firestore batch (product update + money-audit, fail closed) — the
-- atomicity is PRESERVED, not changed. The 404 pre-read moves inside:
-- the row is locked FOR UPDATE and its absence returns today's 404 as
-- a value, never an exception.
--
-- Audit payload parity with today's batch: before = the row as found;
-- after = { ...before, ...updates } (the route's `after` deliberately
-- excludes the updatedAt stamp — preserved); the stored row itself
-- gets updatedAt stamped from p_timestamp.

create or replace function tx_store_product_update(
  p_id text,
  p_updates jsonb,
  p_audit jsonb,
  p_timestamp timestamptz default now()
) returns jsonb
language plpgsql
as $$
declare
  v_now_iso text := to_char(p_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_before jsonb;
begin
  select data into v_before
    from fs_products
   where id = p_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Product not found');
  end if;

  update fs_products
     set data = v_before || p_updates || jsonb_build_object('updatedAt', v_now_iso)
   where id = p_id;

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit ->> 'action',
    'actorUid', p_audit ->> 'actorUid',
    'actorRole', coalesce(p_audit ->> 'actorRole', ''),
    'targetUidOrResource', p_id,
    'targetType', 'product',
    'orderId', null,
    'payload', jsonb_build_object(
      'before', v_before,
      'after', v_before || p_updates,
      'changedFields', coalesce(p_audit -> 'changedFields', '[]'::jsonb),
      'reason', null,
      'source', p_audit ->> 'source'
    ),
    'timestamp', to_jsonb(p_timestamp),
    'createdAt', to_jsonb(p_timestamp)
  ));

  return jsonb_build_object('ok', true, 'productId', p_id);
end;
$$;
