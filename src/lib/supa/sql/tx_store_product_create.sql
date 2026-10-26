-- tx_store_product_create.sql — S-W1/P1: product create + money-audit
-- as ONE Postgres transaction (cutover program, Option A: Supabase
-- write-primary for 'store-products-api' behind
-- isSupaPrimary('store-products-api')). Spec: store-design.md §3.1 P1.
-- Flip-time APPLY artifact: authoring applies nothing.
--
-- What this replaces: the products route POST's NON-atomic pair
-- (products.add, then a separate audit_logs.add whose failure surfaced
-- a 500 with the product already persisted). Under primacy the pair is
-- atomic — the named P1 delta (design §3.1, open question Q2): on audit
-- failure the product ROLLS BACK; the response is the same 500.
--
-- p_data carries the product fields WITHOUT timestamps: createdAt /
-- updatedAt are stamped here from p_timestamp (ISO strings, the
-- adapter's storage ruling). p_audit carries the money-audit fields
-- the route derived via buildMoneyAuditDoc (action / actorUid /
-- actorRole / targetType / targetId / orderId / changedFields /
-- reason / source); the audit row's payload.after is the product
-- exactly as inserted, and its timestamp / createdAt are SQL-side
-- ISO (to_jsonb(now())) — the FieldValue.serverTimestamp() sentinel
-- has no Postgres meaning.
--
-- No stock / balance side effects exist on product writes (design
-- §3.1) and none are invented here.

create or replace function tx_store_product_create(
  p_id text,
  p_data jsonb,
  p_audit jsonb,
  p_timestamp timestamptz default now()
) returns jsonb
language plpgsql
as $$
declare
  v_now_iso text := to_char(p_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_product jsonb := p_data || jsonb_build_object('createdAt', v_now_iso, 'updatedAt', v_now_iso);
begin
  insert into fs_products (id, firebase_uid, parent_path, data)
  values (p_id, null, 'products', v_product);

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', p_audit ->> 'action',
    'actorUid', p_audit ->> 'actorUid',
    'actorRole', coalesce(p_audit ->> 'actorRole', ''),
    'targetUidOrResource', p_id,
    'targetType', 'product',
    'orderId', null,
    'payload', jsonb_build_object(
      'before', null,
      'after', v_product,
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
