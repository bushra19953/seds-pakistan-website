-- tx_elections_cast_ballot.sql — elections WRITE PRIMACY (cutover wave).
--
-- ONE call casts ONE ballot on the Supabase-primary path
-- (SUPA_SURFACES=elections AND SUPA_PRIMARY=elections). It closes the
-- HIGH-severity F3 flaw class (BUILDOUT_AUDIT §5 / FIX_REPORT F3):
-- the pre-cutover Supa cast was a sequence of separate seam writes
-- (marker claim -> conditional token redemption -> ballot -> counters)
-- that a mid-sequence failure could split; here every step runs inside
-- this function's single implicit Postgres transaction, so the cast
-- applies entirely or not at all. There is no Firestore write anywhere
-- in this path.
--
-- Lock order (program-wide, stated per sql/README rule 5):
--   1. advisory lock on the ENTITY: 'election:' || p_election_id
--      (taken first, before any read the decision depends on);
--   2. idempotency record lookup (fs_tx_idempotency) under that lock;
--   3. election row FOR UPDATE, then token / marker rows under the
--      same advisory lock (the lock, not row order, is what serialises
--      concurrent casts of one election across processes).
--
-- Validation order mirrors the TypeScript cast EXACTLY (F3-pinned
-- sequence: bad_token 401 -> poll_closed 410 -> poll_closed 410 ->
-- already_cast 409 -> invalid_choice 422), with ONE deliberate
-- primacy difference, applied first per the foundation tx template:
-- an idempotency REPLAY of an already-applied cast for the same
-- deterministic key short-circuits as (applied=false, duplicate=true,
-- reason='already_cast') before the token checks — a sequential
-- re-presentment of the same voter's redeemed token therefore reads
-- already_cast on this path instead of bad_token. Business
-- rejections are RETURN VALUES, never exceptions (README rule 6);
-- exceptions are invariant violations and roll back every write.
--
-- ANONYMITY (hard constraint, foundation §4 elections):
--   - The caller passes NO voter uid and NO plaintext token to this
--     function: the voter arrives only as p_marker_id (one-way HMAC)
--     and the token only as p_token_hash (sha256).
--   - p_ballot is the exact anonymous ballot payload of the Firestore
--     path ({ electionId, choices, castDay, isBlank }) — it contains
--     no uid, no token, no marker id, no ballot id.
--   - The idempotency record written at the end stores ONLY
--     { applied: true, duplicate: false } as its result: never the
--     choices, never the ballot id, never anything that links the
--     deterministic key (which names the voter, per foundation) to
--     ballot content. The marker row and the ballot row share no id
--     and no field value beyond electionId / castDay, exactly as on
--     the Firestore path.
--
-- F2: counters are RE-DERIVED at write time from the election row
-- locked FOR UPDATE inside this transaction (its CURRENT counters
-- + 1 on each of ballotsCast / markersCast / tokensRedeemed) — never
-- from a caller-supplied snapshot, so concurrent casts lose no
-- increments.
--
-- Timestamp ruling: instants arrive as arguments; document
-- timestamps inside `data` jsonb are stored as ISO-8601 UTC strings.
-- The stored election timetable is read in that same ISO form.
--
-- APPLY: coordinator flip-time step, together with the
-- fs_tx_idempotency DDL (foundation §3). Authoring never applies.

create or replace function tx_elections_cast_ballot(
  p_election_id text,
  p_token_hash text,               -- sha256(electionId:token); never the plaintext token
  p_marker_id text,                -- HMAC marker id; never the voter uid
  p_marker jsonb,                  -- { electionId, castDay, pollWindow } — no identity, no choice
  p_ballot_id text,                -- caller-minted randomUUID
  p_ballot jsonb,                  -- { electionId, choices, castDay, isBlank } — no identity
  p_certified_candidate_uids text[],
  p_seats integer,
  p_now timestamptz,               -- the caller's logical cast instant
  p_cast_day text,
  p_idempotency_key text           -- deterministic: ballot:<electionId>:<voterUid> (foundation §4)
) returns table (applied boolean, duplicate boolean, reason text)
language plpgsql
as $$
declare
  v_parent_tokens text := 'elections/' || p_election_id || '/eligibility_tokens';
  v_parent_markers text := 'elections/' || p_election_id || '/cast_markers';
  v_parent_ballots text := 'elections/' || p_election_id || '/ballots';
  v_prior jsonb;
  v_election jsonb;
  v_token jsonb;
  v_claimed integer;
  v_redeemed integer;
  v_choices text[];
  v_counters jsonb;
begin
  -- (A) Serialise per election, across processes, for this transaction.
  perform pg_advisory_xact_lock(hashtextextended('election:' || p_election_id, 0));

  -- (B) Idempotency replay short-circuit BEFORE any effect and before
  --     any decision read (foundation template). The recorded result
  --     contains only { applied, duplicate } — the reason returned
  --     here is derived from the duplicate fact, never stored.
  if p_idempotency_key is not null then
    select result into v_prior
      from fs_tx_idempotency
     where key = p_idempotency_key;
    if found then
      return query select false, true, 'already_cast'::text;
      return;
    end if;
  end if;

  -- (C) Re-read the state the decision depends on — after the lock.
  select data into v_election
    from fs_elections
   where id = p_election_id
   for update;
  if not found then
    return query select false, false, 'election_not_found'::text;
    return;
  end if;

  -- Validation 1: token must exist, be unredeemed, and be unexpired.
  select data into v_token
    from fs_group_eligibility_tokens
   where parent_path = v_parent_tokens and id = p_token_hash;
  if not found then
    return query select false, false, 'bad_token'::text;
    return;
  end if;
  if v_token ->> 'redeemedAt' is not null then
    return query select false, false, 'bad_token'::text;
    return;
  end if;
  if p_now > (v_token ->> 'expiresAt')::timestamptz then
    return query select false, false, 'poll_closed'::text;
    return;
  end if;

  -- Validation 2: poll window, from the locked election row.
  if (v_election ->> 'status') is distinct from 'poll_open'
     or p_now < (v_election -> 'timetable' ->> 'pollOpenAt')::timestamptz
     or p_now > (v_election -> 'timetable' ->> 'pollCloseAt')::timestamptz then
    return query select false, false, 'poll_closed'::text;
    return;
  end if;

  -- Validation 3: double-vote fast path against the marker (the
  -- atomic claim below is the authoritative check).
  if exists (
    select 1 from fs_group_cast_markers
     where parent_path = v_parent_markers and id = p_marker_id
  ) then
    return query select false, false, 'already_cast'::text;
    return;
  end if;

  -- Validation 4: choices — distinct, at most p_seats, every one a
  -- certified candidate. Choices live only inside p_ballot.
  select coalesce(array_agg(value), '{}'::text[])
    into v_choices
    from jsonb_array_elements_text(coalesce(p_ballot -> 'choices', '[]'::jsonb));
  if coalesce(array_length(v_choices, 1), 0) > p_seats
     or (select count(*) from (select distinct unnest(v_choices)) d) <> coalesce(array_length(v_choices, 1), 0)
     or exists (
       select 1 from unnest(v_choices) c
        where not (c = any (coalesce(p_certified_candidate_uids, '{}'::text[])))
     ) then
    return query select false, false, 'invalid_choice'::text;
    return;
  end if;

  -- (D) Apply every effect, in the F3 order, all in this transaction.

  -- D1. Marker claim FIRST (atomic insert-if-absent on the
  --     (parent_path, id) key). Losing the claim is already_cast.
  insert into fs_group_cast_markers (id, firebase_uid, parent_path, data)
  values (p_marker_id, null, v_parent_markers, p_marker)
  on conflict (parent_path, id) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return query select false, false, 'already_cast'::text;
    return;
  end if;

  -- D2. Token redemption SECOND (conditional: only while redeemedAt
  --     is still null in the stored jsonb). Losing it is bad_token;
  --     the marker claim from D1 is released inside the same
  --     transaction, so the committed state carries neither write.
  update fs_group_eligibility_tokens
     set data = data || jsonb_build_object(
           'redeemedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'redeemedDay', p_cast_day)
   where parent_path = v_parent_tokens
     and id = p_token_hash
     and (data ->> 'redeemedAt') is null;
  get diagnostics v_redeemed = row_count;
  if v_redeemed = 0 then
    delete from fs_group_cast_markers
     where parent_path = v_parent_markers and id = p_marker_id;
    return query select false, false, 'bad_token'::text;
    return;
  end if;

  -- D3. Ballot write THIRD (caller-minted randomUUID id, the exact
  --     anonymous payload; shares no id with marker or token).
  insert into fs_group_ballots (id, firebase_uid, parent_path, data)
  values (p_ballot_id, null, v_parent_ballots, p_ballot);

  -- D4. Counters LAST, re-derived from the locked election row (F2).
  v_counters := coalesce(v_election -> 'counters', '{}'::jsonb);
  update fs_elections
     set data = data || jsonb_build_object('counters', jsonb_build_object(
           'ballotsCast', coalesce((v_counters ->> 'ballotsCast')::integer, 0) + 1,
           'markersCast', coalesce((v_counters ->> 'markersCast')::integer, 0) + 1,
           'tokensRedeemed', coalesce((v_counters ->> 'tokensRedeemed')::integer, 0) + 1))
   where id = p_election_id;

  -- (E) Record the outcome under the idempotency key, last, in the
  --     same transaction. ONLY the outcome — never the choices, the
  --     ballot id, the token hash, or the marker id (anonymity).
  if p_idempotency_key is not null then
    insert into fs_tx_idempotency (key, fn, result)
    values (
      p_idempotency_key,
      'tx_elections_cast_ballot',
      jsonb_build_object('applied', true, 'duplicate', false)
    );
  end if;

  return query select true, false, null::text;
end;
$$;
