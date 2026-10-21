// Governance votes (spec Section 0.2): the Board decision record.
// One collection (governance_votes) for every governance vote kind, with
// ballots in the ballots/{voterUid} subcollection (doc id = voter uid,
// so one ballot per voter is structural). The electorate is a FROZEN
// snapshot taken at open: seats filled or vacated mid-vote do not
// change it. Thresholds are exact fraction pairs, tallied with integer
// math only - never floating point. The result is written once at
// close and is immutable; closeVote is idempotent.

import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';

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
  await ref.set(data);
  const auditLogId = await writeGovernanceAuditOrThrow(db, {
    action: 'governance_vote_opened',
    actorUid: input.createdByUid,
    targetType: 'governance_vote',
    targetId: ref.id,
    details: { subjectType: input.subjectType, mode },
  });
  await ref.update({ auditLogId });
  return ref.id;
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

export async function closeVote(
  db: Firestore,
  voteId: string,
  actorUid: string,
): Promise<TallyResult> {
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
  const snap = await db.collection('governance_votes').doc(voteId).get();
  if (!snap || !snap.exists) return null;
  const vote = snap.data() as Record<string, any>;
  return (vote.result as TallyResult | null) ?? null;
}

export async function getVote(
  db: Firestore,
  voteId: string,
): Promise<Record<string, unknown>> {
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
