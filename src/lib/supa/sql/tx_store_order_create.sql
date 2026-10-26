-- tx_store_order_create.sql — S-W2/O1: route order create as ONE
-- Postgres transaction, with the design §3.5 idempotency dedupe and
-- the price re-read inside the transaction snapshot. Spec:
-- store-design.md §3.2 O1 + §3.5. Flip-time APPLY artifact.
--
-- What this replaces: the orders route POST's single orders.add —
-- single-row, so the atomicity need is IDEMPOTENCY, not multi-row tx:
-- both order-create paths mint a brand-new document per attempt, so a
-- double-submit / retry duplicates a paid manual-transfer order.
--
-- IDEMPOTENCY (design §3.5, verbatim):
--   * p_idempotency_key (nullable) names ONE checkout attempt, minted
--     by the client per attempt and reused across its retries. It is
--     scoped per buyer: the dedupe lookup is (buyerUserId, key).
--   * Found -> return { created: false, orderId: <existing> } and
--     write NOTHING. The route gates its notifications on
--     created = true, so a replay notifies nobody twice.
--   * Otherwise the key is stored on the order (data.idempotencyKey,
--     additive field) for the life of the order.
--   * Race safety is the unique partial index in
--     store_keyset_indexes.sql; a unique violation on the insert is
--     caught (the block below is scoped to the insert alone, so the
--     catch cannot let a partial write survive — the insert is the
--     function's first and only write at that point) and converted to
--     the replay response after re-reading the winning row.
--   * No key (all current clients) -> the insert proceeds exactly as
--     today's .add() does; behaviour is byte-identical.
--
-- PRICE VERIFICATION inside the tx snapshot (design §3.2 O1): when a
-- product id is given and the fs_products row exists with a numeric
-- price, the claimed amount must equal price * quantity — a mismatch
-- returns today's 422 as a VALUE (no insert). On a pass the verified
-- totals are recomputed from the SERVER price with the route's own
-- formulas (donation / USD-certificate exceptions preserved):
--   totalPkr = null when donation or USD, else price * qty
--   total    = claimed when USD or donation, else price * qty
-- When the product is missing / unpriced, today's route verifies
-- nothing and trusts the claim — preserved (p_data passes through).
--
-- p_data carries the canonical order shape the route built, with
-- timestamps already ISO strings (the route converts its
-- Timestamp.now() values for the primacy path).

create or replace function tx_store_order_create(
  p_id text,
  p_data jsonb,
  p_idempotency_key text default null,
  p_product_id text default null,
  p_claimed numeric default null,
  p_quantity numeric default 1,
  p_is_donation boolean default false,
  p_is_usd boolean default false
) returns jsonb
language plpgsql
as $$
declare
  v_buyer text := p_data ->> 'buyerUserId';
  v_existing_id text;
  v_product jsonb;
  v_price numeric;
  v_order jsonb := p_data;
begin
  -- Dedupe first: a replay writes nothing at all.
  if p_idempotency_key is not null then
    select id into v_existing_id
      from fs_orders
     where data ->> 'buyerUserId' = v_buyer
       and data ->> 'idempotencyKey' = p_idempotency_key
     limit 1;
    if found then
      return jsonb_build_object('ok', true, 'created', false, 'orderId', v_existing_id);
    end if;
    v_order := v_order || jsonb_build_object('idempotencyKey', p_idempotency_key);
  end if;

  -- Price re-read inside the transaction snapshot.
  if not coalesce(p_is_donation, false) and p_product_id is not null then
    select data into v_product from fs_products where id = p_product_id;
    if found and jsonb_typeof(v_product -> 'price') = 'number' then
      v_price := (v_product ->> 'price')::numeric;
      if p_claimed is null or p_claimed <> v_price * coalesce(p_quantity, 1) then
        return jsonb_build_object(
          'ok', false, 'httpStatus', 422,
          'message', 'Price verification failed: claimed amount does not match the server price'
        );
      end if;
      v_order := v_order || jsonb_build_object(
        'totalPkr', case when p_is_usd then null else v_price * coalesce(p_quantity, 1) end,
        'total', case when p_is_usd then p_claimed else v_price * coalesce(p_quantity, 1) end
      );
    end if;
  end if;

  begin
    insert into fs_orders (id, firebase_uid, parent_path, data)
    values (p_id, null, 'orders', v_order);
  exception when unique_violation then
    -- The (buyer, key) race: if the winning attempt has committed,
    -- its row is visible to this lookup and we return the replay
    -- shape; if it is still in flight the lookup misses and we
    -- re-raise — the caller's retry then dedupes cleanly. Either way
    -- no second order is written by this call.
    select id into v_existing_id
      from fs_orders
     where data ->> 'buyerUserId' = v_buyer
       and data ->> 'idempotencyKey' = p_idempotency_key
     limit 1;
    if found then
      return jsonb_build_object('ok', true, 'created', false, 'orderId', v_existing_id);
    end if;
    raise;
  end;

  return jsonb_build_object('ok', true, 'created', true, 'orderId', p_id);
end;
$$;
