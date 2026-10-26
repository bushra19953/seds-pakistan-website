-- tx_motions_cast_vote.sql — governance ballot CAST as ONE Postgres
-- transaction (cutover program, Option A: Supabase write-primary for
-- the 'motions' surface behind isSupaPrimary('motions')).
--
-- Spec: ~/workspace/supabase-migration/cutover-sections/foundation.md
-- section 4 (Motions) + the H-3 ruling (DEPLOY_READY_REPORT): the
-- governance facade's per-process mutex does NOT meet the H-3 bar;
-- this function does, because the check-and-write below runs under
-- pg_advisory_xact_lock, which serialises across PROCESSES.
-- Authoring rules: ./README.md. APPLY artifact only — the
-- coordinator applies it at the motions flip, AFTER the
-- fs_tx_idempotency table exists.
--
-- What this replaces, on the primary path ONLY: castVote's Firestore
-- runTransaction in src/lib/server/governance-votes.ts (and the
-- facade's per-process serialisation of the same body on the
-- dual-write path). The VALIDATION ORDER and outcome vocabulary are
-- preserved EXACTLY:
--   not_found (vote row absent)
--   -> not_open (mode <> 'ballot' or status <> 'open')
--   -> not_in_electorate (no non-vacant seat with uid = voter)
--   -> ballot upsert (ballots/{voterUid}: one ballot per voter is
--      structural, and a re-cast OVERWRITES — pinned semantics).
-- The choice-value validation (422 VOTE_VALIDATION) stays in the
-- seam, before any call, exactly as today. Business rejections are
-- RETURN VALUES (outcome), never exceptions.
--
-- H-09 PRESERVED: no actor / permission check is added here. The
-- only membership check is the frozen-electorate check the service
-- has always performed.
--
-- LOCK ORDER (program-wide, foundation section 3): advisory lock on
-- the ENTITY first ('vote:' || p_vote_id — the SAME key
-- tx_motions_open_vote and tx_motions_close_vote take, so a cast can
-- never interleave with a close of the same vote in another
-- process), then the idempotency record, then the vote row
-- FOR UPDATE, then the ballot row FOR UPDATE.
--
-- IDEMPOTENCY: the ballot document's identity — (vote, voter) — IS
-- the natural key, so the side table is used in its replay-aware
-- form: the seam passes 'vote:<voteId>:<voterUid>'; a replay with the
-- SAME choice returns the recorded outcome verbatim (no second
-- effect — the upsert would be identical anyway), while a replay
-- with a DIFFERENT choice is a new logical operation (today's
-- overwrite semantics) and re-runs the body, replacing the record.
-- Rejections are NOT recorded — a retry re-evaluates them against
-- current state, exactly as a Firestore retry does.
--
-- Timestamps: the ballot's castAt inside `data` jsonb is an ISO-8601
-- UTC string derived from p_timestamp.

create or replace function tx_motions_cast_vote(
  p_vote_id text,
  p_voter_uid text,
  p_choice text,
  p_idempotency_key text default null,
  p_timestamp timestamptz default now()
) returns jsonb
language plpgsql
as $$
declare
  v_parent_path text := 'governance_votes/' || p_vote_id || '/ballots';
  v_now_iso text := to_char(p_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_prior jsonb;
  v_vote jsonb;
  v_seat jsonb;
  v_ballot jsonb;
  v_result jsonb;
begin
  -- (A) Serialise per vote, across processes, for this transaction.
  perform pg_advisory_xact_lock(hashtextextended('vote:' || p_vote_id, 0));

  -- (B) Idempotency: same-choice replay short-circuits BEFORE any
  --     effect; a different choice falls through and overwrites.
  if p_idempotency_key is not null then
    select result into v_prior
      from fs_tx_idempotency
     where key = p_idempotency_key;
    if found and coalesce(v_prior ->> 'choice', '') = p_choice then
      return v_prior || jsonb_build_object('applied', false, 'duplicate', true);
    end if;
  end if;

  -- (C) Re-read the decision state AFTER the lock, row FOR UPDATE.
  select data into v_vote
    from fs_governance_votes
   where id = p_vote_id
   for update;
  if not found then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'not_found', 'reason', 'not_found'
    );
  end if;

  if coalesce(v_vote ->> 'mode', '') <> 'ballot'
     or coalesce(v_vote ->> 'status', '') <> 'open' then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'not_open', 'reason', 'not_open'
    );
  end if;

  -- Frozen-electorate membership: a non-vacant seat held by the voter.
  select seat into v_seat
    from jsonb_array_elements(
           case when jsonb_typeof(v_vote -> 'electorate') = 'array'
                then v_vote -> 'electorate' else '[]'::jsonb end
         ) as seat
   where seat ->> 'uid' = p_voter_uid
     and coalesce((seat ->> 'vacant')::boolean, false) = false
   limit 1;
  if v_seat is null then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'not_in_electorate', 'reason', 'not_in_electorate'
    );
  end if;

  -- (D) Apply the one effect: the ballot upsert, keyed by voter uid.
  v_ballot := jsonb_build_object(
    'choice', p_choice,
    'seatKey', v_seat ->> 'seatKey',
    'castAt', v_now_iso
  );

  insert into fs_group_ballots (id, firebase_uid, parent_path, data)
  values (p_voter_uid, null, v_parent_path, v_ballot)
  on conflict (parent_path, id) do update set data = excluded.data;

  v_result := jsonb_build_object(
    'applied', true, 'duplicate', false,
    'outcome', 'cast', 'reason', null,
    'choice', p_choice,
    'seat_key', v_seat ->> 'seatKey',
    'ballot_data', v_ballot
  );

  -- (E) Record / replace the outcome under the idempotency key, last,
  --     in the same transaction.
  if p_idempotency_key is not null then
    insert into fs_tx_idempotency (key, fn, result)
    values (p_idempotency_key, 'tx_motions_cast_vote', v_result)
    on conflict (key) do update
      set fn = excluded.fn, result = excluded.result;
  end if;

  return v_result;
end;
$$;
