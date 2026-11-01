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
-- PRICE VERIFICATION inside the tx snapshot (design §3.2 O1; audit
-- item 4, FAIL CLOSED): EVERY priced line is re-read from fs_products
-- inside the transaction — the items array p_items when given, else
-- the legacy single (p_product_id, p_quantity) line. A line whose
-- product is missing, inactive (isActive = false), or unpriced, an
-- item with no product reference, an invalid quantity, or a claimed
-- amount that differs from the server-priced total returns today's
-- 422 as a VALUE (no insert). On a pass the verified totals are
-- recomputed from the SERVER prices with the route's own formulas
-- (donation / USD-certificate exceptions preserved):
--   totalPkr = null when donation or USD, else server total
--   total    = claimed when USD or donation, else server total
-- The pre-fix rule ("when the product is missing / unpriced, verify
-- nothing and trust the claim") is REMOVED: it let a client invent a
-- price for any product id. Donations stay exempt by design (the
-- route records the donor-declared amount; the donation module is
-- gated server-side in the checkout action).
--
-- p_data carries the canonical order shape the route built, with
-- timestamps already ISO strings (the route converts its
-- Timestamp.now() values for the primacy path).

-- GE AMENDMENT (vendor shop pilot, PLAN-ge Section 4.3): one new
-- parameter, p_delivery_pkr, appended after p_items so existing
-- positional callers are unaffected (the adapter calls by name; the
-- default keeps any stale caller correct for house orders). The
-- server-read delivery charge is added to the goods total BEFORE the
-- claim comparison, so the claim check and the totalPkr/total
-- overwrite both cover goods + delivery. With p_delivery_pkr = 0
-- (every house call) the function is arithmetically identical to
-- before. REPO FILE ONLY in this program (BUILD_LOG R-20): applied
-- only if store primacy is ever flipped, never in this pilot.

create or replace function tx_store_order_create(
  p_id text,
  p_data jsonb,
  p_idempotency_key text default null,
  p_product_id text default null,
  p_claimed numeric default null,
  p_quantity numeric default 1,
  p_is_donation boolean default false,
  p_is_usd boolean default false,
  p_items jsonb default null,
  p_delivery_pkr numeric default 0
) returns jsonb
language plpgsql
as $$
declare
  v_buyer text := p_data ->> 'buyerUserId';
  v_existing_id text;
  v_product jsonb;
  v_price numeric;
  v_order jsonb := p_data;
  v_item jsonb;
  v_pid text;
  v_qty numeric;
  v_total numeric := 0;
  v_lines integer := 0;
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

  -- Price re-read inside the transaction snapshot, fail closed.
  if not coalesce(p_is_donation, false) then
    if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
      for v_item in select * from jsonb_array_elements(p_items) loop
        v_pid := v_item ->> 'productId';
        if v_pid is null or v_pid = '' then
          return jsonb_build_object(
            'ok', false, 'httpStatus', 422,
            'message', 'Price verification failed: order item is missing its product reference'
          );
        end if;
        v_qty := coalesce((v_item ->> 'quantity')::numeric, 1);
        if v_qty <= 0 then
          return jsonb_build_object(
            'ok', false, 'httpStatus', 422,
            'message', 'Price verification failed: invalid item quantity'
          );
        end if;
        select data into v_product from fs_products where id = v_pid;
        if not found
           or coalesce(v_product ->> 'isActive', 'true') = 'false'
           or jsonb_typeof(v_product -> 'price') <> 'number' then
          return jsonb_build_object(
            'ok', false, 'httpStatus', 422,
            'message', 'Price verification failed: product is missing, inactive, or has no server-side price'
          );
        end if;
        v_total := v_total + (v_product ->> 'price')::numeric * v_qty;
        v_lines := v_lines + 1;
      end loop;
    elsif p_product_id is not null then
      select data into v_product from fs_products where id = p_product_id;
      if not found
         or coalesce(v_product ->> 'isActive', 'true') = 'false'
         or jsonb_typeof(v_product -> 'price') <> 'number' then
        return jsonb_build_object(
          'ok', false, 'httpStatus', 422,
          'message', 'Price verification failed: product is missing, inactive, or has no server-side price'
        );
      end if;
      v_total := (v_product ->> 'price')::numeric * coalesce(p_quantity, 1);
      v_lines := 1;
    end if;

    if v_lines = 0 then
      return jsonb_build_object(
        'ok', false, 'httpStatus', 422,
        'message', 'Price verification failed: order does not reference any product with a server-side price'
      );
    end if;
    -- GE: delivery joins the verified total before the claim check
    -- and the total overwrite below.
    v_total := v_total + coalesce(p_delivery_pkr, 0);
    if p_claimed is null or p_claimed <> v_total then
      return jsonb_build_object(
        'ok', false, 'httpStatus', 422,
        'message', 'Price verification failed: claimed amount does not match the server price'
      );
    end if;
    v_order := v_order || jsonb_build_object(
      'totalPkr', case when p_is_usd then null else v_total end,
      'total', case when p_is_usd then p_claimed else v_total end
    );
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
