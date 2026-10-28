-- tx_store_create_order.sql — S-W3: the server action createOrder's
-- store-owned writes as ONE Postgres transaction. Spec:
-- store-design.md §3.3 A1+A2+A5. Flip-time APPLY artifact.
--
-- What this replaces: the action's SEQUENTIAL, non-atomic chain —
-- orders.add -> events/{id}/registrations/{uid}.set(merge) ->
-- audit_logs.add — where a failure after the first write reports
-- failure while the order persists (an orphan a retry then duplicates).
-- Inside this function the writes commit or roll back together: the
-- orphan class is dead.
--
--   A1 order insert into fs_orders (id minted app-side, Firestore
--      auto-id shape, passed in as p_order_id).
--   A2 event registration mirror into fs_group_registrations
--      (parent_path 'events/<eventId>/registrations', doc id = uid —
--      the ticket issue API looks registrations up by uid), upsert
--      with merge semantics keyed by uid, exactly as today's .set.
--   A5 audit row into fs_audit_logs (action ORDER_CREATED) — inside
--      the transaction, fail-closed (Item 7), where today its failure
--      reports failure while the order persists.
--
-- A3 REMOVED (audit item 4): this function used to auto-create a
-- product stub in fs_products for a missing / event product, priced
-- from the client-claimed order total (p_order_data.total). A
-- poisoned stub then set the server price for later buyers. A
-- checkout must never create or mutate a product: event-ticket
-- products are created by the events flow (syncEventToProduct,
-- EV-P07), and the action prices a not-yet-existing ticket product
-- from the server-side event record before calling this function.
-- The parameters p_product_id / p_generated_product_id are retained
-- (unused) so the applied function signature does not change.
--
-- NOT in this transaction, by design (§3.3 A4): the chapter
-- application link stays a post-tx best-effort Firestore update in the
-- action (applications are another cluster's primacy). The blacklist
-- and donation gates are likewise NOT re-decided here: the action
-- evaluates them exactly as today and only calls this function after
-- they pass; the price the action verified server-side (fail closed,
-- audit item 4) is carried in p_order_data.
--
-- IDEMPOTENCY (§3.5, identical to tx_store_order_create): a non-null
-- p_idempotency_key (orderData.idempotencyKey, minted per checkout
-- attempt) dedupes on (buyerUserId, key) — a hit returns
-- { created: false, orderId: <existing> } and writes nothing, so a
-- replay re-runs neither A2 nor the audit. The unique partial
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
    -- Race backstop: replay if the winner is visible, else re-raise
    -- (the caller's retry dedupes). No second order is written here.
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
    -- (A3 removed: no product stub is created here — see header.)
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
