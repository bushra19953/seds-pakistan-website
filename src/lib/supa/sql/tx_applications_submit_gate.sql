-- tx_applications_submit_gate.sql — induction application submit gate
-- as ONE Postgres transaction (cutover program, Option A: Supabase
-- write-primary for the 'applications' surface behind
-- isSupaPrimary('applications')).
--
-- Authoring rules: ./README.md.
-- This file is an APPLY artifact: authoring it applies nothing. The
-- coordinator applies it at deploy, at the surface's flip.
--
-- What this replaces: the Firestore runTransaction SEC-RACE gate in
-- POST /api/induction/submit (src/app/api/induction/submit/route.ts),
-- which re-reads applications/{uid} + users/{uid} inside a Firestore
-- transaction to stop a double-submit racing past the check. During a
-- Firestore READ outage that gate kills every submission, which is
-- why the gate is re-homed here. The check order and the gate rule
-- (the route's isReappliableApplication) are preserved EXACTLY:
--   no prior application -> ALLOWED
--   -> else ALLOWED iff the prior application's status is terminal
--      ('rejected' or 'withdrawn', case-insensitive) AND the user
--      record does NOT carry hasApplied = true
--   -> otherwise DENIED, with NO writes.
-- A denial is a RETURN VALUE (outcome 'already_applied'), never an
-- exception; the seam maps it back to the route's 409 vocabulary.
-- Business rejections are return values throughout, per README rule 6;
-- exceptions are for corruption and invariant violations only.
--
-- NO IDEMPOTENCY RECORD (deliberate, unlike tx_events_*): the
-- fs_tx_idempotency table exists, but this function does NOT use it
-- and takes no p_idempotency_key. Three reasons:
--   1. A Postgres transaction is atomic: the advisory lock plus the
--      in-transaction state re-read fully serialise concurrent
--      submits for one applicant, so there is no race window left
--      for a recorded outcome to close.
--   2. The product contract for a re-POST against a live application
--      is a 409 (outcome 'already_applied'), NOT idempotent success.
--   3. That contract includes the lost-response retry: a client that
--      never saw the first response and POSTs again re-evaluates
--      against committed state and is denied, byte-identical to the
--      Firestore gate. A recorded-outcome replay would return the
--      recorded 'created' success instead and break that contract.
-- Re-evaluation against current state on every call IS the semantics.
--
-- LOCK ORDER: advisory lock on the applicant first
-- ('induction-submit:' || p_uid, transaction-scoped: released
-- automatically at commit / rollback, no session state to leak),
-- then the fs_applications row FOR UPDATE, then the fs_users row
-- FOR UPDATE. Decision state is re-read only AFTER the lock.
--
-- FOREIGN READ: fs_users is a foreign-cluster landing table. Its row
-- is read here, inside this transaction, under the lock — the closest
-- available snapshot of the users/{uid} document the Firestore gate
-- read. It is NEVER WRITTEN by this function (read-only snapshot, the
-- same ruling as tx_events_register_free). The hasApplied flag reaches
-- fs_users through the users mirror of the Firestore flag write, and
-- the re-apply flag clear is mirrored synchronously by the reapply
-- route; neither is this function's write.
--
-- ROW SHAPE: the upsert writes the adapter's writeRow shape for a
-- top-level collection (src/lib/supa/adapter.ts): parent_path is the
-- collection name ('applications') and firebase_uid is null
-- (firebaseUidForPath carries a uid only for users/* paths) — byte-
-- identical to what setApplicationPrimaryFirst's setDoc writes.
--
-- Timestamps: p_application arrives pre-serialized by the seam —
-- document timestamps inside it are already ISO-8601 UTC strings
-- (the adapter's storage ruling, README rule 7) — and this function
-- stores it VERBATIM as the fs_applications row's data. It derives
-- and injects no timestamps of its own; p_timestamp is accepted for
-- the seam's server-time signature convention and is not written
-- into the stored document.

create or replace function tx_applications_submit_gate(
  p_uid text,
  p_application jsonb,
  p_timestamp timestamptz default now()
) returns jsonb
language plpgsql
as $$
declare
  v_prior_app jsonb;
  v_prior_user jsonb;
  v_terminal boolean;
  v_flag_applied boolean;
  v_allowed boolean;
begin
  -- (A) Serialise per applicant FIRST, across processes, for this
  --     transaction.
  perform pg_advisory_xact_lock(hashtextextended('induction-submit:' || p_uid, 0));

  -- (B) Re-read the decision state AFTER the lock, rows FOR UPDATE,
  --     in lock order: the application row, then the user row. A
  --     missing row leaves its variable null.
  select data into v_prior_app
    from fs_applications
   where id = p_uid
   for update;

  select data into v_prior_user
    from fs_users
   where id = p_uid
   for update;

  -- (C) The gate rule, ported exactly from the route's
  --     isReappliableApplication: no prior application is allowed;
  --     otherwise the prior application must be terminal
  --     ('rejected' / 'withdrawn') and the user must not still carry
  --     hasApplied = true.
  if v_prior_app is null then
    v_allowed := true;
  else
    v_terminal :=
      lower(coalesce(v_prior_app ->> 'status', '')) in ('rejected', 'withdrawn');
    v_flag_applied :=
      coalesce((v_prior_user -> 'hasApplied') = 'true'::jsonb, false);
    v_allowed := v_terminal and not v_flag_applied;
  end if;

  -- Denied: a return value, no writes.
  if not v_allowed then
    return jsonb_build_object(
      'outcome', 'already_applied',
      'applied', false,
      'existing_status', v_prior_app ->> 'status',
      'prior_app', v_prior_app,
      'prior_user', v_prior_user
    );
  end if;

  -- (D) Allowed: the upsert of the application row IS the primary
  --     write, and the only write in this function. fs_users is
  --     never written here.
  insert into fs_applications (id, firebase_uid, parent_path, data)
  values (p_uid, null, 'applications', p_application)
  on conflict (id) do update
    set data = excluded.data,
        firebase_uid = excluded.firebase_uid;

  return jsonb_build_object(
    'outcome', 'created',
    'applied', true,
    'existing_status', null,
    'prior_app', v_prior_app,
    'prior_user', v_prior_user
  );
end;
$$;
