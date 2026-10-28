-- tx_events_register_paid.sql — E2-TX-1: paid event registration as ONE
-- Postgres transaction (cutover program, Option A: Supabase write-primary
-- for the 'events' surface behind isSupaPrimary('events')).
--
-- Spec: ~/workspace/supabase-migration/events-cluster/MANUAL_LIST.md
-- E2-TX-1 (the Postgres equivalent recorded there) +
-- ~/workspace/supabase-migration/cutover-sections/foundation.md
-- section 4 (Events guidance). Authoring rules: ./README.md.
-- This file is an APPLY artifact: authoring it applies nothing. The
-- coordinator applies it at the surface's flip, AFTER the
-- fs_tx_idempotency table exists (flip-time schema step, foundation
-- section 3).
--
-- What this replaces: the Firestore runTransaction in
-- runPaidRegistrationTransaction (src/lib/supa-events/registrations.ts),
-- whose check order is preserved, with ONE deliberate addition from
-- the audit item-4 fix (the amount check the route also performs
-- pre-transaction, so both paths present the same order):
--   event exists (else 'not_found', no writes)
--   -> amount: client amount vs the locked event's
--      paymentDetails.amount ('price_mismatch', no writes)
--   -> duplicate: a live (non-'cancelled') registration returns
--      'already_registered', NO writes
--   -> capacity: capacity > 0 and attendeeIds.length >= capacity
--      returns 'full' (reason 'sold_out'), NO writes
--   -> writes: registration upsert + EV-P06 counter triple on the event
--      + the orders row, all in this one transaction.
-- The route's deadline check stays PRE-transaction (from the
-- flag-selected store), exactly as MANUAL_LIST E2-TX-1 records; it is
-- NOT re-checked here.
--
-- AMOUNT VERIFICATION (audit item 4): the route compares the
-- client-sent amount to the event's paymentDetails.amount before
-- calling this function and passes the verified amount in. This
-- function RE-CHECKS it here, against the event row locked FOR
-- UPDATE, so a price change (or a caller that bypasses the route)
-- cannot slip a tampered amount through: when the event carries a
-- numeric paymentDetails.amount, p_amount must equal it exactly,
-- and the stored registration (and the order row's amount) use the
-- SERVER amount. A paid event (paymentDetails.isPaid) with no
-- numeric amount is rejected as 'price_mismatch' /
-- 'price_not_configured' — fail closed. An event not marked paid
-- and carrying no amount has no server price to compare (the legacy
-- free-event proof quirk) and is not checked. A price rejection is
-- a RETURN VALUE like the other business rejections, never an
-- exception, and is NOT recorded under the idempotency key.
--
-- LOCK ORDER (program-wide, foundation section 3): advisory lock on
-- the ENTITY first ('event:' || p_event_id — the same key
-- tx_events_register_free and any future tx_events_cancel_registration
-- use, so register/cancel on one event serialise across processes),
-- then the idempotency record, then the event row FOR UPDATE, then the
-- registration row FOR UPDATE.
--
-- IDEMPOTENCY: p_idempotency_key is minted at the operation's origin
-- by the seam as 'pay:<eventId>:<uid>:<transactionId>' (the payment
-- transaction id names the one logical submission) and reused across
-- every retry of that submission. Replay rule: a recorded outcome is
-- returned verbatim (applied=false, duplicate=true) ONLY while the
-- registration it created is still live; if that registration has
-- since been cancelled (or removed), the submission is a NEW logical
-- operation (today's Firestore flow replaces a cancelled registration
-- and mints exactly one new order), so the body re-runs and the key's
-- record is upserted. Business rejections (not_found /
-- already_registered / sold_out) are RETURN VALUES, never exceptions,
-- and are NOT recorded under the key — a retry re-evaluates them
-- against current state, exactly as a Firestore retry does.
--
-- Timestamps: document timestamps inside `data` jsonb are ISO-8601 UTC
-- strings derived from p_timestamp (the adapter's storage ruling).

create or replace function tx_events_register_paid(
  p_event_id text,
  p_uid text,
  p_transaction_id text,
  p_screenshot_link text default '',
  p_payment_method text default 'manual',
  p_amount double precision default 0,
  p_currency text default 'PKR',
  p_display_name text default '',
  p_email text default '',
  p_order_id text default null,
  p_order_data jsonb default null,
  p_idempotency_key text default null,
  p_timestamp timestamptz default now()
) returns jsonb
language plpgsql
as $$
declare
  v_parent_path text := 'events/' || p_event_id || '/registrations';
  v_now_iso text := to_char(p_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_prior jsonb;
  v_event jsonb;
  v_reg jsonb;
  v_attendee_ids jsonb;
  v_registered_uids jsonb;
  v_next_attendees jsonb;
  v_next_registered jsonb;
  v_capacity numeric;
  v_registration jsonb;
  v_counters jsonb;
  v_result jsonb;
  v_payment_details jsonb;
  v_expected_amount numeric;
  v_order_data jsonb;
begin
  -- (A) Serialise per event, across processes, for this transaction.
  perform pg_advisory_xact_lock(hashtextextended('event:' || p_event_id, 0));

  -- (B) Idempotency: replay short-circuit BEFORE any effect, while the
  --     registration the recorded operation created is still live.
  if p_idempotency_key is not null then
    select result into v_prior
      from fs_tx_idempotency
     where key = p_idempotency_key;
    if found then
      select data into v_reg
        from fs_group_registrations
       where parent_path = v_parent_path and id = p_uid;
      if found and coalesce(v_reg ->> 'status', '') <> 'cancelled' then
        return v_prior || jsonb_build_object('applied', false, 'duplicate', true);
      end if;
      v_reg := null;
    end if;
  end if;

  -- (C) Re-read the decision state AFTER the lock, rows FOR UPDATE.
  select data into v_event
    from fs_events
   where id = p_event_id
   for update;
  if not found then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'not_found', 'reason', 'not_found'
    );
  end if;

  select data into v_reg
    from fs_group_registrations
   where parent_path = v_parent_path and id = p_uid
   for update;

  -- Amount verification against the LOCKED event row (audit item 4;
  -- see header). Runs before any write and before the duplicate /
  -- capacity outcomes, mirroring the route's pre-transaction check.
  v_payment_details := case
    when jsonb_typeof(v_event -> 'paymentDetails') = 'object'
      then v_event -> 'paymentDetails'
    else '{}'::jsonb
  end;
  v_expected_amount := case
    when jsonb_typeof(v_payment_details -> 'amount') = 'number'
      then (v_payment_details ->> 'amount')::numeric
    else null
  end;
  if v_expected_amount is not null then
    if p_amount is null or p_amount::numeric <> v_expected_amount then
      return jsonb_build_object(
        'applied', false, 'duplicate', false,
        'outcome', 'price_mismatch', 'reason', 'price_mismatch'
      );
    end if;
  elsif coalesce(v_payment_details ->> 'isPaid', '') = 'true' then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'price_mismatch', 'reason', 'price_not_configured'
    );
  end if;

  -- Duplicate check FIRST (a re-post by an existing registrant is never
  -- blocked by a full event — same order as the Firestore body).
  if found and coalesce(v_reg ->> 'status', '') <> 'cancelled' then
    return jsonb_build_object(
      'applied', false, 'duplicate', true,
      'outcome', 'already_registered', 'reason', 'already_registered'
    );
  end if;

  -- Capacity check INSIDE the transaction, against attendeeIds — the
  -- canonical counter (EV-P06).
  v_attendee_ids := case
    when jsonb_typeof(v_event -> 'attendeeIds') = 'array' then v_event -> 'attendeeIds'
    else '[]'::jsonb
  end;
  v_capacity := coalesce(nullif(v_event ->> 'capacity', '')::numeric, 0);
  if v_capacity > 0 and jsonb_array_length(v_attendee_ids) >= v_capacity then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'full', 'reason', 'sold_out'
    );
  end if;

  -- (D) Apply every effect in this one transaction.
  v_registration := jsonb_build_object(
    'uid', p_uid,
    'eventId', p_event_id,
    'transactionId', p_transaction_id,
    'screenshotLink', coalesce(p_screenshot_link, ''),
    'displayName', coalesce(p_display_name, ''),
    'email', coalesce(p_email, ''),
    'status', 'under_review',
    'paymentStatus', 'pending',
    'paymentMethod', coalesce(nullif(p_payment_method, ''), 'manual'),
    'amount', coalesce(v_expected_amount, coalesce(p_amount, 0)),
    'currency', coalesce(nullif(p_currency, ''), 'PKR'),
    'createdAt', v_now_iso,
    'updatedAt', v_now_iso
  );

  insert into fs_group_registrations (id, firebase_uid, parent_path, data)
  values (p_uid, null, v_parent_path, v_registration)
  on conflict (parent_path, id) do update set data = excluded.data;

  v_registered_uids := case
    when jsonb_typeof(v_event -> 'registered_attendees_uids') = 'array'
      then v_event -> 'registered_attendees_uids'
    else '[]'::jsonb
  end;
  v_next_attendees := v_attendee_ids;
  if not (v_next_attendees ? p_uid) then
    v_next_attendees := v_next_attendees || jsonb_build_array(p_uid);
  end if;
  v_next_registered := v_registered_uids;
  if not (v_next_registered ? p_uid) then
    v_next_registered := v_next_registered || jsonb_build_array(p_uid);
  end if;

  v_counters := jsonb_build_object(
    'attendeeIds', v_next_attendees,
    'registered_attendees_uids', v_next_registered,
    'registrationsCount', jsonb_array_length(v_next_attendees),
    'updatedAt', v_now_iso
  );

  update fs_events
     set data = data || v_counters
   where id = p_event_id;

  -- The orders row joins this transaction (MANUAL_LIST E2-TX-1: the
  -- store cluster's fs_orders landing table already exists, so the
  -- paid flow's order write CAN join at cutover; the order id and the
  -- serialized order payload are minted/built by the route+seam, the
  -- origin). A replay that short-circuited above never reaches this
  -- insert, and do-nothing makes a re-run after cancellation mint
  -- exactly one NEW order (the caller passes a fresh p_order_id).
  if p_order_id is not null then
    -- The order row's amount is likewise the SERVER amount when the
    -- event carries one, whatever the caller put in the payload.
    v_order_data := coalesce(p_order_data, '{}'::jsonb);
    if v_expected_amount is not null then
      v_order_data := v_order_data || jsonb_build_object('amount', v_expected_amount);
    end if;
    insert into fs_orders (id, firebase_uid, parent_path, data)
    values (p_order_id, null, 'orders', v_order_data)
    on conflict (id) do nothing;
  end if;

  v_result := jsonb_build_object(
    'applied', true, 'duplicate', false,
    'outcome', 'created', 'reason', null,
    'registration_data', v_registration,
    'counters', v_counters,
    'order_id', p_order_id
  );

  -- (E) Record the outcome under the idempotency key, last, in the
  --     same transaction, so key and effects commit or roll back
  --     together. Upsert: a re-run after cancellation replaces the
  --     stale record for the reused origin key.
  if p_idempotency_key is not null then
    insert into fs_tx_idempotency (key, fn, result)
    values (p_idempotency_key, 'tx_events_register_paid', v_result)
    on conflict (key) do update
      set fn = excluded.fn, result = excluded.result;
  end if;

  return v_result;
end;
$$;
