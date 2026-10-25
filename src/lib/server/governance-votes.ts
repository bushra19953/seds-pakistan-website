// Governance votes (spec Section 0.2): the Board decision record.
// One collection (governance_votes) for every governance vote kind, with
// ballots in the ballots/{voterUid} subcollection (doc id = voter uid,
// so one ballot per voter is structural). The electorate is a FROZEN
// snapshot taken at open: seats filled or vacated mid-vote do not
// change it. Thresholds are exact fraction pairs, tallied with integer
// math only - never floating point. The result is written once at
// close and is immutable; closeVote is idempotent.
//
// Supabase migration (elections G3): governance_votes + its ballots
// subcollection route through agm-domain-supa.ts when the 'elections'
// surface is ON. Flag OFF, unconfigured, or any Supabase bridge error
// -> the exact Firestore code path below, byte-identical shapes.
// castVote's Supabase variant is sequential (the adapter has no
// transaction primitive) with IDENTICAL validation order and error
// codes; infrastructure errors fall back to the Firestore
// transaction, exactly like G2's castBallot. The governance audit
// writer is NOT converted (shared with the governance/meetings
// family): writeGovernanceAuditOrThrow is called exactly as today
// on both paths, and its entries keep landing in Firestore
// audit_logs.

import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import {
  writeGovernanceAuditOrThrow,
  GovernanceAuditError,
} from '@/lib/server/governance-audit';
import {
  agmSupaEnabled,
  supaGetDoc as seamGetDoc,
  supaListDocs as seamListDocs,
  supaSetDoc as seamSetDoc,
  supaUpdateDoc as seamUpdateDoc,
} from './agm-domain-supa';

export type VoteSubjectType =
  | 'ratification_refusal'
  | 'strike3_expulsion'
  | 'chapter_suspend'
  | 'chapter_expel'
  | 'catalog_amendment'
  | 'board_generic'
  | 'ratification_approval'
  | 'board_appointment'
  | 'cooption'
  | 'governor_removal';

export type VoteMode = 'ballot' | 'offline_attested';
export type BallotChoice = 'for' | 'against' | 'abstain';
export type DenominatorBasis = 'all_seats' | 'present';

export interface ElectorateSeat {
  seatKey: string;
  roleKey: string;
  uid: string | null;
  vacant: boolean;
}

export interface ThresholdConfig {
  threshold: { numerator: number; denominator: number };
  isStrictMajority: boolean;
  denominatorBasis: DenominatorBasis;
  quorum?: number;
  // How the threshold is evaluated:
  // 'fraction' - votesFor * denominator >= numerator * basis
  // 'strict_majority_electorate' - votesFor >= floor(electorateSize/2)+1
  // 'strict_majority_present_voting' - votesFor > votesAgainst (tie fails)
  kind: 'fraction' | 'strict_majority_electorate' | 'strict_majority_present_voting';
}

export interface TallyResult {
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  participating: number;
  basis: number;
  threshold: { numerator: number; denominator: number };
  isStrictMajority: boolean;
  quorumMet: boolean;
  passed: boolean;
}

// Constitutional thresholds (spec 0.2). For seat-count-dependent
// presets (cooption, governor_removal), the threshold pair is resolved
// at open time from the frozen electorate size.
export function resolveThreshold(
  subjectType: VoteSubjectType,
  electorateSize: number,
  override?: Partial<ThresholdConfig>,
): ThresholdConfig {
  let base: ThresholdConfig;
  switch (subjectType) {
    case 'ratification_refusal':
      base = {
        threshold: { numerator: 2, denominator: 3 },
        isStrictMajority: false,
        denominatorBasis: 'all_seats',
        kind: 'fraction',
      };
      break;
    case 'chapter_expel':
      base = {
        threshold: { numerator: 2, denominator: 3 },
        isStrictMajority: false,
        denominatorBasis: 'all_seats',
        kind: 'fraction',
      };
      break;
    case 'strike3_expulsion':
      base = {
        threshold: { numerator: 1, denominator: 2 },
        isStrictMajority: true,
        denominatorBasis: 'present',
        quorum: 5,
        kind: 'strict_majority_present_voting',
      };
      break;
    case 'chapter_suspend':
      base = {
        threshold: { numerator: 1, denominator: 2 },
        isStrictMajority: true,
        denominatorBasis: 'present',
        kind: 'strict_majority_present_voting',
      };
      break;
    case 'cooption':
    case 'governor_removal': {
      const needed = Math.floor(electorateSize / 2) + 1;
      base = {
        threshold: { numerator: needed, denominator: Math.max(electorateSize, 1) },
        isStrictMajority: true,
        denominatorBasis: 'all_seats',
        kind: 'strict_majority_electorate',
      };
      break;
    }
    default:
      base = {
        threshold: { numerator: 1, denominator: 2 },
        isStrictMajority: true,
        denominatorBasis: 'present',
        kind: 'strict_majority_present_voting',
      };
  }
  return { ...base, ...(override ?? {}) };
}

export const VOTE_THRESHOLDS = {
  ratification_refusal: (n: number) => resolveThreshold('ratification_refusal', n),
  strike3_expulsion: (n: number) => resolveThreshold('strike3_expulsion', n),
  chapter_suspend: (n: number) => resolveThreshold('chapter_suspend', n),
  chapter_expel: (n: number) => resolveThreshold('chapter_expel', n),
  cooption: (n: number) => resolveThreshold('cooption', n),
  governor_removal: (n: number) => resolveThreshold('governor_removal', n),
};

// Pure tally. Exact integer arithmetic only.
export function tallyBallots(
  ballots: Array<{ choice: BallotChoice }>,
  config: ThresholdConfig & { electorateSize: number },
): TallyResult {
  let votesFor = 0;
  let votesAgainst = 0;
  let votesAbstain = 0;
  for (const ballot of ballots) {
    if (ballot.choice === 'for') votesFor += 1;
    else if (ballot.choice === 'against') votesAgainst += 1;
    else if (ballot.choice === 'abstain') votesAbstain += 1;
  }
  const participating = votesFor + votesAgainst + votesAbstain;
  const basis =
    config.denominatorBasis === 'all_seats'
      ? config.electorateSize
      : participating;
  const quorumMet =
    config.quorum === undefined ? true : participating >= config.quorum;

  let passed = false;
  if (quorumMet) {
    if (config.kind === 'fraction') {
      passed =
        votesFor * config.threshold.denominator >=
        config.threshold.numerator * basis;
    } else if (config.kind === 'strict_majority_electorate') {
      passed = votesFor >= Math.floor(config.electorateSize / 2) + 1;
    } else {
      // strict majority of present and voting; a tie fails.
      passed = votesFor > votesAgainst;
    }
  }

  return {
    votesFor,
    votesAgainst,
    votesAbstain,
    participating,
    basis,
    threshold: config.threshold,
    isStrictMajority: config.isStrictMajority,
    quorumMet,
    passed,
  };
}

export class VoteError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'VoteError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Data-access helpers: the ONLY branch point between Firestore and
// Supabase for governance_votes and its ballots subcollection. Each
// helper tries the seam when the surface is ON and falls through to
// the Firestore operation on ANY seam error (fallback contract).
// castVote / closeVote / getVote do NOT use these helpers for their
// main flow: they run an explicit Supabase variant (below) so domain
// errors (VoteError) never trigger a fallback and infrastructure
// errors fall back as one operation, like G2's castBallot.
// ---------------------------------------------------------------------------

function ballotsPath(voteId: string): string {
  return `governance_votes/${voteId}/ballots`;
}

async function setVoteDoc(
  db: Firestore,
  voteId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (agmSupaEnabled()) {
    try {
      await seamSetDoc('governance_votes', voteId, data);
      return;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  await db.collection('governance_votes').doc(voteId).set(data);
}

async function updateVoteDoc(
  db: Firestore,
  voteId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (agmSupaEnabled()) {
    try {
      await seamUpdateDoc('governance_votes', voteId, updates);
      return;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  await db.collection('governance_votes').doc(voteId).update(updates);
}

export interface OpenVoteInput {
  subjectType: VoteSubjectType;
  mode?: VoteMode;
  electorate: ElectorateSeat[];
  createdByUid: string;
  linkedConsentRequestId?: string | null;
  thresholdOverride?: Partial<ThresholdConfig>;
  // offline_attested records only:
  deciders?: string[];
  attestedBy?: string;
  meetingRef?: string;
  attestedResult?: TallyResult;
}

export async function openVote(
  db: Firestore,
  input: OpenVoteInput,
): Promise<string> {
  if (!Array.isArray(input.electorate)) {
    throw new VoteError('VOTE_VALIDATION', 422, 'electorate must be an array');
  }
  // Freeze the snapshot: deep-copy so later mutation of the caller's
  // array cannot change the stored electorate.
  const electorate: ElectorateSeat[] = input.electorate.map((seat) => ({
    seatKey: seat.seatKey,
    roleKey: seat.roleKey,
    uid: seat.uid ?? null,
    vacant: seat.vacant === true,
  }));
  const config = resolveThreshold(
    input.subjectType,
    electorate.length,
    input.thresholdOverride,
  );
  const mode: VoteMode = input.mode ?? 'ballot';
  const ref = db.collection('governance_votes').doc();
  const data: Record<string, unknown> = {
    subjectType: input.subjectType,
    mode,
    electorate,
    electorateSize: electorate.length,
    denominatorBasis: config.denominatorBasis,
    threshold: config.threshold,
    isStrictMajority: config.isStrictMajority,
    thresholdKind: config.kind,
    ...(config.quorum !== undefined ? { quorum: config.quorum } : {}),
    linkedConsentRequestId: input.linkedConsentRequestId ?? null,
    createdByUid: input.createdByUid,
    createdAt: FieldValue.serverTimestamp(),
    result: null,
  };
  if (mode === 'offline_attested') {
    // An attested record is a RECORD of an offline decision; it is never
    // rendered as an on-platform vote (spec 0.2).
    data.status = 'recorded';
    data.deciders = input.deciders ?? [];
    data.attestedBy = input.attestedBy ?? input.createdByUid;
    data.attestedAt = FieldValue.serverTimestamp();
    data.meetingRef = input.meetingRef ?? null;
    if (input.attestedResult) data.result = input.attestedResult;
  } else {
    data.status = 'open';
  }
  await setVoteDoc(db, ref.id, data);
  const auditLogId = await writeGovernanceAuditOrThrow(db, {
    action: 'governance_vote_opened',
    actorUid: input.createdByUid,
    targetType: 'governance_vote',
    targetId: ref.id,
    details: { subjectType: input.subjectType, mode },
  });
  await updateVoteDoc(db, ref.id, { auditLogId });
  return ref.id;
}

/**
 * Supabase variant of castVote (used only when the 'elections'
 * surface is ON). The adapter has no transaction primitive, so the
 * read-validate-write runs sequentially; the VALIDATION ORDER and
 * every error are identical to the transactional path below: vote
 * existence, open/ballot-mode check, frozen-electorate membership,
 * then the ballot write (doc id = voter uid, so one ballot per voter
 * stays structural). Atomicity is the one property that differs
 * (adapter read-modify-write race, noted in the adapter contract);
 * a Supabase infrastructure error rethrows so castVote can fall back
 * to the Firestore transaction. VoteError is never a fallback
 * trigger.
 */
async function castVoteSupa(
  voteId: string,
  voterUid: string,
  choice: BallotChoice,
): Promise<void> {
  const doc = await seamGetDoc('governance_votes', voteId);
  if (!doc) {
    throw new VoteError('VOTE_NOT_FOUND', 404, 'Vote not found');
  }
  const vote = doc.data as Record<string, any>;
  if (vote.mode !== 'ballot' || vote.status !== 'open') {
    throw new VoteError('VOTE_NOT_OPEN', 409, 'This vote is not open for ballots');
  }
  const seat = (vote.electorate as ElectorateSeat[]).find(
    (s) => s.uid === voterUid && !s.vacant,
  );
  if (!seat) {
    throw new VoteError(
      'VOTER_NOT_IN_ELECTORATE',
      403,
      'Voter is not in the frozen electorate for this vote',
    );
  }
  await seamSetDoc(ballotsPath(voteId), voterUid, {
    choice,
    seatKey: seat.seatKey,
    castAt: FieldValue.serverTimestamp(),
  });
}

export async function castVote(
  db: Firestore,
  voteId: string,
  voterUid: string,
  choice: BallotChoice,
): Promise<void> {
  if (choice !== 'for' && choice !== 'against' && choice !== 'abstain') {
    throw new VoteError('VOTE_VALIDATION', 422, 'choice must be for, against, or abstain');
  }
  if (agmSupaEnabled()) {
    try {
      await castVoteSupa(voteId, voterUid, choice);
      return;
    } catch (err) {
      if (err instanceof VoteError) throw err;
      // Supabase infrastructure error: fall back to the Firestore
      // transaction below (fallback contract).
    }
  }
  const ref = db.collection('governance_votes').doc(voteId);
  await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (!snap || !snap.exists) {
      throw new VoteError('VOTE_NOT_FOUND', 404, 'Vote not found');
    }
    const vote = snap.data() as Record<string, any>;
    if (vote.mode !== 'ballot' || vote.status !== 'open') {
      throw new VoteError('VOTE_NOT_OPEN', 409, 'This vote is not open for ballots');
    }
    const seat = (vote.electorate as ElectorateSeat[]).find(
      (s) => s.uid === voterUid && !s.vacant,
    );
    if (!seat) {
      throw new VoteError(
        'VOTER_NOT_IN_ELECTORATE',
        403,
        'Voter is not in the frozen electorate for this vote',
      );
    }
    tx.set(ref.collection('ballots').doc(voterUid), {
      choice,
      seatKey: seat.seatKey,
      castAt: FieldValue.serverTimestamp(),
    });
  });
}

/**
 * Supabase variant of closeVote (used only when the 'elections'
 * surface is ON). Sequential, with IDENTICAL semantics to the
 * Firestore path below: a closed vote returns its stored result
 * unchanged (idempotent close, result written once and immutable);
 * a non-open ballot-mode vote is rejected; ballots are tallied with
 * the same pure integer tallyBallots(). The one structural
 * difference: the Firestore path adds the governance audit entry to
 * the same batch as the vote update, while here the audit is
 * written FIRST through the unchanged writeGovernanceAuditOrThrow
 * (no batch) so a close never lands unaudited, and only then is the
 * vote doc updated. A GovernanceAuditError propagates (never a
 * fallback trigger); a bridge error before the audit rethrows so
 * closeVote can fall back to the Firestore path.
 */
async function closeVoteSupa(
  db: Firestore,
  voteId: string,
  actorUid: string,
): Promise<TallyResult> {
  const doc = await seamGetDoc('governance_votes', voteId);
  if (!doc) {
    throw new VoteError('VOTE_NOT_FOUND', 404, 'Vote not found');
  }
  const vote = doc.data as Record<string, any>;
  // Idempotent close: the stored result is returned unchanged.
  if (vote.status === 'closed' && vote.result) {
    return vote.result as TallyResult;
  }
  if (vote.mode !== 'ballot' || vote.status !== 'open') {
    throw new VoteError('VOTE_NOT_OPEN', 409, 'This vote cannot be closed');
  }
  const ballotDocs = await seamListDocs(ballotsPath(voteId));
  const ballots = ballotDocs.map(
    (d) => d.data as { choice: BallotChoice },
  );
  const result = tallyBallots(ballots, {
    threshold: vote.threshold,
    isStrictMajority: vote.isStrictMajority,
    denominatorBasis: vote.denominatorBasis,
    quorum: vote.quorum,
    kind: vote.thresholdKind,
    electorateSize: vote.electorateSize ?? (vote.electorate as unknown[]).length,
  });
  await writeGovernanceAuditOrThrow(db, {
    action: 'governance_vote_closed',
    actorUid,
    targetType: 'governance_vote',
    targetId: voteId,
    details: { passed: result.passed, votesFor: result.votesFor, votesAgainst: result.votesAgainst },
  });
  await seamUpdateDoc('governance_votes', voteId, {
    status: 'closed',
    result,
    closedAt: FieldValue.serverTimestamp(),
    closedByUid: actorUid,
  });
  return result;
}

export async function closeVote(
  db: Firestore,
  voteId: string,
  actorUid: string,
): Promise<TallyResult> {
  if (agmSupaEnabled()) {
    try {
      return await closeVoteSupa(db, voteId, actorUid);
    } catch (err) {
      if (err instanceof VoteError || err instanceof GovernanceAuditError) {
        throw err;
      }
      // Supabase infrastructure error: fall back to the Firestore
      // path below (fallback contract).
    }
  }
  const ref = db.collection('governance_votes').doc(voteId);
  const snap = await ref.get();
  if (!snap || !snap.exists) {
    throw new VoteError('VOTE_NOT_FOUND', 404, 'Vote not found');
  }
  const vote = snap.data() as Record<string, any>;
  // Idempotent close: the stored result is returned unchanged.
  if (vote.status === 'closed' && vote.result) {
    return vote.result as TallyResult;
  }
  if (vote.mode !== 'ballot' || vote.status !== 'open') {
    throw new VoteError('VOTE_NOT_OPEN', 409, 'This vote cannot be closed');
  }
  const ballotsSnap = await ref.collection('ballots').get();
  const ballots = ballotsSnap.docs.map(
    (doc: any) => doc.data() as { choice: BallotChoice },
  );
  const result = tallyBallots(ballots, {
    threshold: vote.threshold,
    isStrictMajority: vote.isStrictMajority,
    denominatorBasis: vote.denominatorBasis,
    quorum: vote.quorum,
    kind: vote.thresholdKind,
    electorateSize: vote.electorateSize ?? (vote.electorate as unknown[]).length,
  });
  const batch = db.batch();
  batch.update(ref, {
    status: 'closed',
    result,
    closedAt: FieldValue.serverTimestamp(),
    closedByUid: actorUid,
  });
  await writeGovernanceAuditOrThrow(
    db,
    {
      action: 'governance_vote_closed',
      actorUid,
      targetType: 'governance_vote',
      targetId: voteId,
      details: { passed: result.passed, votesFor: result.votesFor, votesAgainst: result.votesAgainst },
    },
    { batch },
  );
  await batch.commit();
  return result;
}

export async function getCertifiedResult(
  db: Firestore,
  voteId: string,
): Promise<TallyResult | null> {
  if (agmSupaEnabled()) {
    try {
      const doc = await seamGetDoc('governance_votes', voteId);
      if (!doc) return null;
      const vote = doc.data as Record<string, any>;
      return (vote.result as TallyResult | null) ?? null;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await db.collection('governance_votes').doc(voteId).get();
  if (!snap || !snap.exists) return null;
  const vote = snap.data() as Record<string, any>;
  return (vote.result as TallyResult | null) ?? null;
}

export async function getVote(
  db: Firestore,
  voteId: string,
): Promise<Record<string, unknown>> {
  if (agmSupaEnabled()) {
    try {
      const doc = await seamGetDoc('governance_votes', voteId);
      if (!doc) {
        throw new VoteError('VOTE_NOT_FOUND', 404, 'Vote not found');
      }
      const ballotDocs = await seamListDocs(ballotsPath(voteId));
      const { ...data } = doc.data as Record<string, any>;
      // Individual ballots are never exposed through the read API.
      return { id: voteId, ...data, ballotCount: ballotDocs.length };
    } catch (err) {
      if (err instanceof VoteError) throw err;
      // Fall through to Firestore (fallback contract).
    }
  }
  const ref = db.collection('governance_votes').doc(voteId);
  const snap = await ref.get();
  if (!snap || !snap.exists) {
    throw new VoteError('VOTE_NOT_FOUND', 404, 'Vote not found');
  }
  const ballotsSnap = await ref.collection('ballots').get();
  const { ...data } = snap.data() as Record<string, any>;
  // Individual ballots are never exposed through the read API.
  return { id: voteId, ...data, ballotCount: ballotsSnap.docs.length };
}
