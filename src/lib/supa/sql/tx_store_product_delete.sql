-- tx_store_product_delete.sql — S-W1/P3: product hard delete +
-- money-audit as ONE Postgres transaction. Spec: store-design.md
-- §3.1 P3. Flip-time APPLY artifact: authoring applies nothing.
--
-- What this replaces: the products route DELETE's already-atomic
-- Firestore batch (batch.delete + money-audit, fail closed) — the
-- atomicity is PRESERVED. The before-image for the audit payload is
-- captured from the locked row inside the transaction; its keys are
-- the audit's changedFields, exactly as the route computes them
-- today (Object.keys(beforeData)).

create or replace function tx_store_product_delete(
  p_id text,
  p_audit jsonb,
  p_timestamp timestamptz default now()
) returns jsonb
language plpgsql
as $$
declare
  v_before jsonb;
  v_changed_fields jsonb;
begin
  select data into v_before
    from fs_products
   where id = p_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'httpStatus', 404, 'message', 'Product not found');
  end if;

  select coalesce(jsonb_agg(k), '[]'::jsonb) into v_changed_fields
    from jsonb_object_keys(v_before) as k;

  delete from fs_products where id = p_id;

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
      'after', null,
      'changedFields', v_changed_fields,
      'reason', null,
      'source', p_audit ->> 'source'
    ),
    'timestamp', to_jsonb(p_timestamp),
    'createdAt', to_jsonb(p_timestamp)
  ));

  return jsonb_build_object('ok', true, 'deleted', p_id);
end;
$$;
