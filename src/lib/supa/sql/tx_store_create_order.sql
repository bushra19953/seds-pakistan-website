-- tx_store_create_order.sql — S-W3: the server action createOrder's
-- store-owned writes as ONE Postgres transaction. Spec:
-- store-design.md §3.3 A1+A2+A3+A5. Flip-time APPLY artifact.
--
-- What this replaces: the action's SEQUENTIAL, non-atomic chain —
-- orders.add -> events/{id}/registrations/{uid}.set(merge) ->
-- product stub set/add -> audit_logs.add — where a failure after the
-- first write reports failure while the order persists (an orphan a
-- retry then duplicates). Inside this function the four writes commit
-- or roll back together: the orphan class is dead.
--
--   A1 order insert into fs_orders (id minted app-side, Firestore
--      auto-id shape, passed in as p_order_id).
--   A2 event registration mirror into fs_group_registrations
--      (parent_path 'events/<eventId>/registrations', doc id = uid —
--      the ticket issue API looks registrations up by uid), upsert
--      with merge semantics keyed by uid, exactly as today's .set.
--   A3 product auto-create stub, decided against the TRANSACTION
--      snapshot (not a caller snapshot): with a productId, insert the
--      stub only when fs_products has no such id; without one, insert
--      only when no product carries this eventId. The stub body is
--      built from the fs_events row (title / image) with the same
--      field values the action builds today.
--   A5 audit row into fs_audit_logs (action ORDER_CREATED) — inside
--      the transaction, fail-closed (Item 7), where today its failure
--      reports failure while the order persists.
--
-- NOT in this transaction, by design (§3.3 A4): the chapter
-- application link stays a post-tx best-effort Firestore update in the
-- action (applications are another cluster's primacy). The blacklist
-- and donation gates are likewise NOT re-decided here: the action
-- evaluates them exactly as today and only calls this function after
-- they pass; the price the action verified is carried in p_order_data.
--
-- IDEMPOTENCY (§3.5, identical to tx_store_order_create): a non-null
-- p_idempotency_key (orderData.idempotencyKey, minted per checkout
-- attempt) dedupes on (buyerUserId, key) — a hit returns
-- { created: false, orderId: <existing> } and writes nothing, so a
-- replay re-runs neither A2/A3 nor the audit. The unique partial
-- index (store_keyset_indexes.sql) is the race backstop, converted
-- the same way. No key -> today's behaviour, byte-identical.
--
-- p_order_data / p_registration carry document timestamps as ISO
-- strings already (the action converts its FieldValue.serverTimestamp
-- sentinels for the primacy path). NO stock decrement or balance
-- mutation exists in this flow and none is invented here (design
-- §3.3 negative finding, open question Q1).

create or replace function tx_store_create_order(
  p_order_id text,
  p_order_data jsonb,
  p_event_id text default null,
  p_registration jsonb default null,
  p_product_id text default null,
  p_generated_product_id text default null,
  p_audit jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_timestamp timestamptz default now()
) returns jsonb
language plpgsql
as $$
declare
  v_now_iso text := to_char(p_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_buyer text := p_order_data ->> 'buyerUserId';
  v_uid text := p_order_data ->> 'userId';
  v_existing_id text;
  v_order jsonb := p_order_data;
  v_event jsonb;
  v_stub jsonb;
begin
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

  -- (A1) The order itself. The insert is the transaction's first
  -- write; the unique-violation catch is scoped to it alone.
  begin
    insert into fs_orders (id, firebase_uid, parent_path, data)
    values (p_order_id, null, 'orders', v_order);
  exception when unique_violation then
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

  if p_event_id is not null then
    -- (A2) Registration mirror, keyed by uid (merge upsert).
    if p_registration is not null then
      insert into fs_group_registrations (id, firebase_uid, parent_path, data)
      values (
        v_uid,
        null,
        'events/' || p_event_id || '/registrations',
        p_registration
      )
      on conflict (parent_path, id) do update
        set data = fs_group_registrations.data || excluded.data;
    end if;

    -- (A3) Product stub for a missing / event product.
    select data into v_event from fs_events where id = p_event_id;
    if not found then
      v_event := '{}'::jsonb;
    end if;
    v_stub := jsonb_build_object(
      'name', coalesce(v_event ->> 'title', 'Event') || ' — Ticket',
      'description', 'Auto-created from checkout. Event: ' || p_event_id,
      'price', coalesce((p_order_data ->> 'total')::numeric, 0),
      'currency', coalesce(p_order_data ->> 'currency', 'PKR'),
      'category', 'event_ticket',
      'eventId', p_event_id,
      'isActive', true,
      'stock', 999,
      'imageUrl', coalesce(v_event ->> 'imageUrl', v_event ->> 'image', ''),
      'autoCreated', true,
      'createdAt', v_now_iso,
      'updatedAt', v_now_iso
    );
    if p_product_id is not null then
      if not exists (select 1 from fs_products where id = p_product_id) then
        insert into fs_products (id, firebase_uid, parent_path, data)
        values (p_product_id, null, 'products', v_stub);
      end if;
    elsif p_generated_product_id is not null then
      if not exists (select 1 from fs_products where data ->> 'eventId' = p_event_id) then
        insert into fs_products (id, firebase_uid, parent_path, data)
        values (p_generated_product_id, null, 'products', v_stub);
      end if;
    end if;
  end if;

  -- (A5) Audit, inside the transaction (fail-closed).
  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (gen_random_uuid()::text, null, 'audit_logs', jsonb_build_object(
    'action', 'ORDER_CREATED',
    'actorUid', v_buyer,
    'targetUidOrResource', p_order_id,
    'payload', coalesce(p_audit -> 'payload', '{}'::jsonb),
    'timestamp', to_jsonb(p_timestamp),
    'source', 'server-action'
  ));

  return jsonb_build_object('ok', true, 'created', true, 'orderId', p_order_id);
end;
$$;
