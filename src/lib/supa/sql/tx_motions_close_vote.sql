-- tx_motions_close_vote.sql — governance vote CLOSE + certify as
-- ONE Postgres transaction (cutover program, Option A: Supabase
-- write-primary for the 'motions' surface behind
-- isSupaPrimary('motions')).
--
-- Spec: ~/workspace/supabase-migration/cutover-sections/foundation.md
-- section 4 (Motions) + H-3 / H-5 rulings. Authoring rules:
-- ./README.md. APPLY artifact only — the coordinator applies it at
-- the motions flip, AFTER the fs_tx_idempotency table exists.
--
-- What this replaces, on the primary path ONLY: closeVote in
-- src/lib/server/governance-votes.ts. Semantics preserved EXACTLY:
--   not_found (vote row absent)
--   -> already_closed (status 'closed' with a stored result: the
--      stored result is returned UNCHANGED, no audit row is written,
--      no field is rewritten — idempotent close, result immutable)
--   -> not_open (mode <> 'ballot' or status <> 'open')
--   -> tally every ballot with tallyBallots' integer math (below)
--   -> audit row + vote update.
--
-- H-5 DELTA (primary path ONLY, deliberate and named): the Firestore
-- path commits the audit entry and the vote update in one Firestore
-- batch; the dual-write Supa path writes the audit FIRST through
-- Firestore and the vote update second, so a mid-sequence failure
-- can leave an ORPHAN audit row (F6 built dedupe machinery around
-- exactly that). Here the audit row (fs_audit_logs) and the vote
-- update are statements of THIS function, so they commit or roll
-- back together: the orphan-audit failure mode does not exist on
-- this path, and no dedupe read is needed. The OFF path keeps
-- today's ordering byte-identically.
--
-- TALLY FIDELITY (no-improvise zone): the tally below is a literal
-- transcription of tallyBallots() in governance-votes.ts — integer
-- arithmetic only, never floating point:
--   participating = for + against + abstain counts
--   basis = electorateSize when denominatorBasis = 'all_seats',
--           else participating
--   quorumMet = quorum absent, or participating >= quorum
--   passed (only when quorumMet):
--     'fraction'                      -> votesFor * denominator >= numerator * basis
--     'strict_majority_electorate'    -> votesFor >= floor(electorateSize / 2) + 1
--     'strict_majority_present_voting'-> votesFor > votesAgainst (a tie fails)
-- The result jsonb carries exactly TallyResult's fields. The H-3
-- proof harness (cutover-gates/motions-h3-proof) asserts these
-- tallies on a real database for the fraction and quorum cases.
--
-- H-09 PRESERVED: no actor / permission check on the closer is added
-- here — closeVote performs none today, by faithful-migration
-- design.
--
-- LOCK ORDER (program-wide, foundation section 3): advisory lock on
-- the ENTITY first ('vote:' || p_vote_id — the SAME key
-- tx_motions_open_vote and tx_motions_cast_vote take, so a close can
-- never interleave with a cast of the same vote in another process:
-- a cast either lands fully before the close tallies, or observes
-- the closed vote and is rejected), then the vote row FOR UPDATE,
-- then the ballot rows.
--
-- IDEMPOTENCY: close is naturally idempotent (already_closed above),
-- which is stronger than a key replay, so no fs_tx_idempotency
-- record is written; p_idempotency_key is accepted for signature
-- uniformity with the other motions tx functions and ignored.
--
-- Timestamps: closedAt / the audit row's createdAt inside `data`
-- jsonb are ISO-8601 UTC strings derived from p_timestamp.

create or replace function tx_motions_close_vote(
  p_vote_id text,
  p_actor_uid text,
  p_audit_id text,
  p_idempotency_key text default null,
  p_timestamp timestamptz default now()
) returns jsonb
language plpgsql
as $$
declare
  v_parent_path text := 'governance_votes/' || p_vote_id || '/ballots';
  v_now_iso text := to_char(p_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_vote jsonb;
  v_for int := 0;
  v_against int := 0;
  v_abstain int := 0;
  v_participating int := 0;
  v_electorate_size int := 0;
  v_basis int := 0;
  v_quorum int;
  v_quorum_met boolean := true;
  v_passed boolean := false;
  v_kind text;
  v_result jsonb;
  v_audit jsonb;
  v_patch jsonb;
begin
  -- (A) Serialise per vote, across processes, for this transaction.
  perform pg_advisory_xact_lock(hashtextextended('vote:' || p_vote_id, 0));

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

  -- Idempotent close: the stored result is returned unchanged and
  -- NOTHING is written (in particular, no second audit row).
  if coalesce(v_vote ->> 'status', '') = 'closed'
     and (v_vote -> 'result') is not null
     and jsonb_typeof(v_vote -> 'result') <> 'null' then
    return jsonb_build_object(
      'applied', false, 'duplicate', true,
      'outcome', 'already_closed', 'reason', null,
      'result', v_vote -> 'result',
      'audit_log_id', null
    );
  end if;

  if coalesce(v_vote ->> 'mode', '') <> 'ballot'
     or coalesce(v_vote ->> 'status', '') <> 'open' then
    return jsonb_build_object(
      'applied', false, 'duplicate', false,
      'outcome', 'not_open', 'reason', 'not_open'
    );
  end if;

  -- Tally: exact integer transcription of tallyBallots().
  select
    coalesce(sum(case when data ->> 'choice' = 'for' then 1 else 0 end), 0),
    coalesce(sum(case when data ->> 'choice' = 'against' then 1 else 0 end), 0),
    coalesce(sum(case when data ->> 'choice' = 'abstain' then 1 else 0 end), 0)
    into v_for, v_against, v_abstain
    from fs_group_ballots
   where parent_path = v_parent_path;

  v_participating := v_for + v_against + v_abstain;

  v_electorate_size := coalesce(
    nullif(v_vote ->> 'electorateSize', '')::int,
    case when jsonb_typeof(v_vote -> 'electorate') = 'array'
         then jsonb_array_length(v_vote -> 'electorate') else 0 end
  );

  v_basis := case
    when coalesce(v_vote ->> 'denominatorBasis', '') = 'all_seats'
      then v_electorate_size
    else v_participating
  end;

  v_quorum := nullif(v_vote ->> 'quorum', '')::int;
  v_quorum_met := v_quorum is null or v_participating >= v_quorum;

  v_kind := coalesce(v_vote ->> 'thresholdKind', '');
  if v_quorum_met then
    if v_kind = 'fraction' then
      v_passed := v_for * coalesce(nullif(v_vote -> 'threshold' ->> 'denominator', '')::int, 0)
               >= coalesce(nullif(v_vote -> 'threshold' ->> 'numerator', '')::int, 0) * v_basis;
    elsif v_kind = 'strict_majority_electorate' then
      v_passed := v_for >= floor(v_electorate_size / 2) + 1;
    else
      -- strict_majority_present_voting (and the default arm): a tie fails.
      v_passed := v_for > v_against;
    end if;
  end if;

  v_result := jsonb_build_object(
    'votesFor', v_for,
    'votesAgainst', v_against,
    'votesAbstain', v_abstain,
    'participating', v_participating,
    'basis', v_basis,
    'threshold', coalesce(v_vote -> 'threshold', 'null'::jsonb),
    'isStrictMajority', coalesce((v_vote ->> 'isStrictMajority')::boolean, false),
    'quorumMet', v_quorum_met,
    'passed', v_passed
  );

  -- (D) Apply every effect in this one transaction (H-5: the audit
  --     row and the vote update are atomic here).
  v_audit := jsonb_build_object(
    'action', 'governance_vote_closed',
    'actorUid', p_actor_uid,
    'targetType', 'governance_vote',
    'targetId', p_vote_id,
    'details', jsonb_build_object(
      'passed', v_passed,
      'votesFor', v_for,
      'votesAgainst', v_against
    ),
    'governance', true,
    'createdAt', v_now_iso
  );

  insert into fs_audit_logs (id, firebase_uid, parent_path, data)
  values (p_audit_id, null, 'audit_logs', v_audit);

  v_patch := jsonb_build_object(
    'status', 'closed',
    'result', v_result,
    'closedAt', v_now_iso,
    'closedByUid', p_actor_uid
  );

  update fs_governance_votes
     set data = data || v_patch
   where id = p_vote_id;

  return jsonb_build_object(
    'applied', true, 'duplicate', false,
    'outcome', 'closed', 'reason', null,
    'result', v_result,
    'audit_log_id', p_audit_id,
    'audit_data', v_audit,
    'vote_patch', v_patch
  );
end;
$$;
