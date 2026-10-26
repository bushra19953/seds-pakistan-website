-- tx_events_register_free.sql — E2-TX-2: free event registration as ONE
-- Postgres transaction (cutover program, Option A: Supabase
-- write-primary for the 'events' surface behind
-- isSupaPrimary('events')).
--
-- Spec: ~/workspace/supabase-migration/events-cluster/MANUAL_LIST.md
-- E2-TX-2 (the Postgres equivalent recorded there) +
-- ~/workspace/supabase-migration/cutover-sections/foundation.md
-- section 4 (Events guidance). Authoring rules: ./README.md.
-- This file is an APPLY artifact: authoring it applies nothing. The
-- coordinator applies it at the surface's flip, AFTER the
-- fs_tx_idempotency table exists (flip-time schema step, foundation
-- section 3).
--
-- What this replaces: the Firestore runTransaction in
-- runFreeRegistrationTransaction (src/lib/supa-events/registrations.ts),
-- whose check order is preserved EXACTLY:
--   not-found -> deleted (reported as not-found)
--   -> blacklist (users.isBlacklisted while warningConfig/global
--      enforcement is enabled)
--   -> published/open (status 'published' or legacy published flag,
--      and registrationOpen not explicitly false)
--   -> duplicate (a live, non-'cancelled' registration is an
--      idempotent success with NO writes)
--   -> capacity (capacity > 0 and attendeeIds.length >= capacity)
--   -> writes: EV-P06 counter triple on the event + registration
--      insert, in this one transaction.
-- Business rejections are RETURN VALUES (outcome / reason), never
-- exceptions; the seam maps them back to the route's RegistrationError
-- vocabulary byte-identically (code, HTTP status, message).
--
-- FOREIGN READS (the accepted, flagged weakening recorded in
-- MANUAL_LIST E2-TX-2): the users blacklist flag and the
-- warningConfig enforcement flag are foreign-cluster data. They are
-- read here, inside this transaction, from their Supabase landing
-- tables (fs_users, fs_warningConfig) — the closest available snapshot,
-- taken under the event lock. They are never WRITTEN here. The
-- event+registration pair itself stays fully transactional; nothing
-- about this function de-transactionalizes it further.
--
-- LOCK ORDER (program-wide, foundation section 3): advisory lock on
-- the ENTITY first ('event:' || p_event_id — the same key
-- tx_events_register_paid uses, so a paid and a free registration for
-- one event serialise across processes), then the idempotency record,
-- then the event row FOR UPDATE, then the registration row FOR UPDATE.
-- The fs_users / fs_warningConfig reads take no row locks (read-only
-- foreign snapshots).
--
-- IDEMPOTENCY: p_idempotency_key is minted at the operation's origin
-- by the seam as 'free:<eventId>:<uid>' (a free registration's natural
-- identity IS the (event, uid) pair — its document id) and reused
-- across every retry. Replay rule: a recorded outcome is returned
-- verbatim (applied=false, duplicate=true) ONLY while the registration
-- it created is still live; a cancelled registration is a new logical
-- operation (today's Firestore flow replaces it), so the body re-runs
-- and the key's record is upserted. Rejections are NOT recorded under
-- the key — a retry re-evaluates them against current state, exactly
-- as a Firestore retry does.
--
-- Timestamps: document timestamps inside `data` jsonb are ISO-8601 UTC
-- strings derived from p_timestamp (the adapter's storage ruling).

create or replace function tx_events_register_free(
  p_event_id text,
  p_uid text,
  p_whatsapp_e164 text default null,
  p_payment_method text default null,
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
  v_user jsonb;
  v_config jsonb;
  v_config_found boolean;
  v_enforcement boolean;
  v_is_published boolean;
  v_registration_open boolean;
  v_attendee_ids jsonb;
  v_registered_uids jsonb;
  v_next_attendees jsonb;
  v_next_registered jsonb;
  v_capacity numeric;
  v_is_paid boolean;
  v_registration jsonb;
  v_counters jsonb;
  v_result jsonb;
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
        return v_prior || jsonb_build_object(
          'applied', false, 'duplicate', true, 'already_registered', false
        );
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
      'outcome', 'not_found', 'reason', 'not_found',
      'already_registered', false
    );
  end if;

  -- A soft-deleted event is not registerable and reports as not-found,
  -- exactly as the Firestore body does.
  if coalesce((v_event ->> 'deleted')::boolean, false) then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'not_found', 'reason', 'event_deleted',
      'already_registered', false
    );
  end if;

  -- Foreign snapshots (read-only, inside the transaction): the user
  -- profile and the global warning config. A missing config doc means
  -- enforcement defaults ON (the Firestore body's fallback); a present
  -- config doc without the flag means OFF (Firestore reads the field
  -- as undefined/falsy) — preserved exactly.
  select data into v_user from fs_users where id = p_uid;
  if not found then
    v_user := '{}'::jsonb;
  end if;

  select data into v_config from "fs_warningConfig" where id = 'global';
  v_config_found := found;
  if not v_config_found then
    v_enforcement := true;
  else
    v_enforcement := coalesce((v_config ->> 'enforcementEnabled')::boolean, false);
  end if;

  if v_enforcement and coalesce((v_user ->> 'isBlacklisted')::boolean, false) then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'blacklisted', 'reason', 'blacklisted',
      'already_registered', false
    );
  end if;

  v_is_published :=
    coalesce(v_event ->> 'status', '') = 'published'
    or coalesce((v_event ->> 'published')::boolean, false);
  v_registration_open := coalesce((v_event ->> 'registrationOpen')::boolean, true);
  if not v_is_published or not v_registration_open then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'registration_closed', 'reason', 'registration_closed',
      'already_registered', false
    );
  end if;

  select data into v_reg
    from fs_group_registrations
   where parent_path = v_parent_path and id = p_uid
   for update;

  -- Duplicate = idempotent success with NO writes (checked before
  -- capacity, as in the Firestore body).
  if found and coalesce(v_reg ->> 'status', '') <> 'cancelled' then
    return jsonb_build_object(
      'applied', false, 'duplicate', true,
      'outcome', 'already_registered', 'reason', 'already_registered',
      'already_registered', true
    );
  end if;

  -- Capacity check INSIDE the transaction, against attendeeIds — the
  -- canonical counter (audit EV-P03).
  v_attendee_ids := case
    when jsonb_typeof(v_event -> 'attendeeIds') = 'array' then v_event -> 'attendeeIds'
    else '[]'::jsonb
  end;
  v_capacity := coalesce(nullif(v_event ->> 'capacity', '')::numeric, 0);
  if v_capacity > 0 and jsonb_array_length(v_attendee_ids) >= v_capacity then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'full', 'reason', 'sold_out',
      'already_registered', false
    );
  end if;

  -- (D) Apply every effect in this one transaction: counter triple
  --     first, then the registration — the Firestore body's order.
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

  v_is_paid := coalesce((v_event -> 'paymentDetails' ->> 'isPaid')::boolean, false);
  v_registration := jsonb_build_object(
    'uid', p_uid,
    'eventId', p_event_id,
    'displayName', v_user -> 'displayName',
    'email', v_user -> 'email',
    'whatsappE164', to_jsonb(p_whatsapp_e164),
    'status', 'pending',
    'paymentStatus', case when v_is_paid then 'unpaid' else 'verified' end,
    'paymentMethod', to_jsonb(coalesce(p_payment_method, v_event -> 'paymentDetails' ->> 'method')),
    'paymentRef', null,
    'createdAt', v_now_iso,
    'updatedAt', v_now_iso
  );

  insert into fs_group_registrations (id, firebase_uid, parent_path, data)
  values (p_uid, null, v_parent_path, v_registration)
  on conflict (parent_path, id) do update set data = excluded.data;

  v_result := jsonb_build_object(
    'applied', true, 'duplicate', false,
    'outcome', 'created', 'reason', null,
    'already_registered', false,
    'registration_data', v_registration,
    'counters', v_counters
  );

  -- (E) Record the outcome under the idempotency key, last, in the
  --     same transaction, so key and effects commit or roll back
  --     together. Upsert: a re-run after cancellation replaces the
  --     stale record for the reused origin key.
  if p_idempotency_key is not null then
    insert into fs_tx_idempotency (key, fn, result)
    values (p_idempotency_key, 'tx_events_register_free', v_result)
    on conflict (key) do update
      set fn = excluded.fn, result = excluded.result;
  end if;

  return v_result;
end;
$$;
