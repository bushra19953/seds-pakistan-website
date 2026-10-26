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
//
// CUTOVER (write primacy, isSupaPrimary('motions')): a THIRD path
// sits in front of both of the above. When the 'motions' token is
// primary, openVote / castVote / closeVote each run as ONE Postgres
// transaction (tx_motions_open_vote / tx_motions_cast_vote /
// tx_motions_close_vote, src/lib/supa/sql/) invoked through the
// governance adapter's tx() primitive:
// - serialisation is the cross-process advisory lock
//   'vote:<voteId>' inside each function (H-3) — the facade's
//   per-process runTransaction lock and this file's sequential Supa
//   variant are NOT used on this path; the facade lock stays as a
//   first line for the dual-write path only and is no longer
//   load-bearing for correctness;
// - the audit row and the mutation commit or roll back TOGETHER
//   inside the function (H-5 delta, this path only): the
//   orphan-audit failure mode of the audit-first dual-write path
//   (and the F6 dedupe machinery built around it) does not exist
//   here, because the audit entry lands in fs_audit_logs in the
//   same transaction as the vote write;
// - after the transaction commits, the committed shapes are mirrored
//   to Firestore best-effort (logged, never thrown), so Firestore
//   readers keep converging; Supabase is the authority;
// - an adapter/tx failure on this path PROPAGATES (never a fallback
//   to the Firestore transaction): once primacy is on, silently
//   writing Firestore would split the writer.
// H-09 is preserved on this path exactly as on the others: no
// permission gate is added anywhere (see the votes routes).
// SUPA_PRIMARY off (the default) = both pre-cutover paths,
// byte-identical.

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
import { getDb } from './firebase-admin';
import {
  govSupaAdapterFor,
  govSupaPrimaryFor,
  newFirestoreId,
} from './governance/supa-shared';
import type { GovSupaAdapter } from './governance/supa-shared';

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

/* ------------------------------------------------- cutover: motions
 * write primacy (tx_motions_*). See the header for the full contract.
 * The lock key the SQL functions take is 'vote:' || p_vote_id —
 * derived inside the functions from the vote id argument alone, so
 * open/cast/close for one vote always contend on the same key.
 */

export class MotionsPrimaryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MotionsPrimaryError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

interface MotionsTxResult {
  applied?: boolean;
  duplicate?: boolean;
  outcome?: string;
  result?: TallyResult;
  ballot_data?: { choice?: string; seatKey?: string | null; castAt?: string } | null;
  seat_key?: string | null;
  audit_log_id?: string | null;
  audit_data?: Record<string, unknown> | null;
  vote_patch?: Record<string, unknown> | null;
}

/**
 * The tx-capable adapter when isSupaPrimary('motions') is on, else
 * null. Primacy on with no adapter / no tx() is a LOUD error
 * (MotionsPrimaryError), never a silent Firestore fallback.
 */
function motionsPrimaryAdapter(): GovSupaAdapter | null {
  if (!govSupaPrimaryFor('motions')) return null;
  const adapter = govSupaAdapterFor('motions');
  if (!adapter || typeof adapter.tx !== 'function') {
    throw new MotionsPrimaryError(
      'SUPA_PRIMARY=motions is on but no tx-capable Supabase adapter resolved; refusing to fall back to a Firestore write (that would split the writer)',
    );
  }
  return adapter;
}

async function mirrorMotionsWrite(
  label: string,
  mirror: () => Promise<void>,
): Promise<void> {
  try {
    await mirror();
  } catch (err) {
    console.error(
      `[governance-votes] Firestore mirror for ${label} failed (write is committed in Supabase):`,
      err,
    );
  }
}

function isoToDate(value: unknown): Date {
  const d = typeof value === 'string' ? new Date(value) : new Date(NaN);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Primary open: ONE tx (vote row + audit row + auditLogId stamp). */
async function openVotePrimary(
  adapter: GovSupaAdapter,
  voteId: string,
  data: Record<string, unknown>,
  input: OpenVoteInput,
): Promise<void> {
  const auditId = newFirestoreId();
  const now = new Date();
  const supaData: Record<string, unknown> = {
    ...data,
    createdAt: now,
    ...(data.attestedAt !== undefined ? { attestedAt: now } : {}),
  };
  const auditData: Record<string, unknown> = {
    action: 'governance_vote_opened',
    actorUid: input.createdByUid,
    targetType: 'governance_vote',
    targetId: voteId,
    details: { subjectType: input.subjectType, mode: data.mode },
    governance: true,
    createdAt: now,
  };
  const raw = await adapter.tx<MotionsTxResult>(
    'tx_motions_open_vote',
    {
      p_vote_id: voteId,
      p_vote_data: supaData,
      p_audit_id: auditId,
      p_audit_data: auditData,
    },
    { idempotencyKey: `open:${voteId}` },
  );
  if (!raw || (raw.outcome !== 'created' && !raw.duplicate)) {
    throw new MotionsPrimaryError(
      `tx_motions_open_vote returned an unexpected result: ${JSON.stringify(raw)}`,
    );
  }
  const committedAuditId = raw.audit_log_id ?? auditId;
  const real = getDb();
  if (real) {
    await mirrorMotionsWrite(`governance_votes/${voteId} (open)`, async () => {
      await real
        .collection('governance_votes')
        .doc(voteId)
        .set({ ...data, auditLogId: committedAuditId });
      await real
        .collection('audit_logs')
        .doc(committedAuditId)
        .set({ ...auditData, createdAt: FieldValue.serverTimestamp() });
    });
  }
}

/** Primary cast: ONE tx (lock -> validate -> ballot upsert). */
async function castVotePrimary(
  adapter: GovSupaAdapter,
  voteId: string,
  voterUid: string,
  choice: BallotChoice,
): Promise<void> {
  const raw = await adapter.tx<MotionsTxResult>(
    'tx_motions_cast_vote',
    { p_vote_id: voteId, p_voter_uid: voterUid, p_choice: choice },
    { idempotencyKey: `vote:${voteId}:${voterUid}` },
  );
  switch (raw?.outcome) {
    case 'cast': {
      const real = getDb();
      if (real) {
        await mirrorMotionsWrite(`governance_votes/${voteId}/ballots/${voterUid}`, async () => {
          await real
            .collection('governance_votes')
            .doc(voteId)
            .collection('ballots')
            .doc(voterUid)
            .set({
              choice,
              seatKey: raw.ballot_data?.seatKey ?? raw.seat_key ?? null,
              castAt: isoToDate(raw.ballot_data?.castAt),
            });
        });
      }
      return;
    }
    case 'not_found':
      throw new VoteError('VOTE_NOT_FOUND', 404, 'Vote not found');
    case 'not_open':
      throw new VoteError('VOTE_NOT_OPEN', 409, 'This vote is not open for ballots');
    case 'not_in_electorate':
      throw new VoteError(
        'VOTER_NOT_IN_ELECTORATE',
        403,
        'Voter is not in the frozen electorate for this vote',
      );
    default:
      throw new MotionsPrimaryError(
        `tx_motions_cast_vote returned an unexpected result: ${JSON.stringify(raw)}`,
      );
  }
}

/** Primary close: ONE tx (lock -> tally -> audit + vote update). */
async function closeVotePrimary(
  adapter: GovSupaAdapter,
  voteId: string,
  actorUid: string,
): Promise<TallyResult> {
  const auditId = newFirestoreId();
  const raw = await adapter.tx<MotionsTxResult>('tx_motions_close_vote', {
    p_vote_id: voteId,
    p_actor_uid: actorUid,
    p_audit_id: auditId,
  });
  switch (raw?.outcome) {
    case 'closed': {
      const result = raw.result as TallyResult;
      const real = getDb();
      if (real && raw.vote_patch) {
        const patch = raw.vote_patch;
        const committedAuditId = raw.audit_log_id ?? auditId;
        await mirrorMotionsWrite(`governance_votes/${voteId} (close)`, async () => {
          await real
            .collection('governance_votes')
            .doc(voteId)
            .set(
              {
                status: 'closed',
                result,
                closedAt: isoToDate(patch.closedAt),
                closedByUid: actorUid,
              },
              { merge: true },
            );
          if (raw.audit_data) {
            await real
              .collection('audit_logs')
              .doc(committedAuditId)
              .set({ ...raw.audit_data, createdAt: isoToDate(raw.audit_data.createdAt) });
          }
        });
      }
      return result;
    }
    case 'already_closed':
      // Idempotent close: the stored result, unchanged; nothing was
      // written by the tx, so there is nothing to mirror.
      return raw.result as TallyResult;
    case 'not_found':
      throw new VoteError('VOTE_NOT_FOUND', 404, 'Vote not found');
    case 'not_open':
      throw new VoteError('VOTE_NOT_OPEN', 409, 'This vote cannot be closed');
    default:
      throw new MotionsPrimaryError(
        `tx_motions_close_vote returned an unexpected result: ${JSON.stringify(raw)}`,
      );
  }
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
  const primaryAdapter = motionsPrimaryAdapter();
  if (primaryAdapter) {
    await openVotePrimary(primaryAdapter, ref.id, data, input);
    return ref.id;
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
  const primaryAdapter = motionsPrimaryAdapter();
  if (primaryAdapter) {
    await castVotePrimary(primaryAdapter, voteId, voterUid, choice);
    return;
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
 * Infrastructure-class failure of the Supa close AFTER its audit
 * entry exists (F6). Deliberately NOT a VoteError: closeVote must
 * surface it as an infrastructure failure, never as a domain result
 * (in particular never as VOTE_NOT_FOUND for a Supa-only vote), and
 * must not attempt a Firestore fallback close for that vote.
 */
export class CloseVoteInfraError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CloseVoteInfraError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * F6 dedupe read: is there already a `governance_vote_closed` audit
 * entry for this vote in Firestore audit_logs? A previous Supa close
 * attempt that wrote its audit entry and then lost the bridge before
 * the vote update landed leaves exactly such an orphan; a retry must
 * REUSE it instead of writing a second one. A failed lookup is an
 * audit-subsystem failure (GovernanceAuditError): the close aborts
 * without falling back, because the audit state is unknown and a
 * governance close must never proceed on an unknown audit state.
 */
async function closeAuditEntryExists(
  db: Firestore,
  voteId: string,
): Promise<boolean> {
  let snap: { docs: unknown[] };
  try {
    snap = await db
      .collection('audit_logs')
      .where('action', '==', 'governance_vote_closed')
      .where('targetId', '==', voteId)
      .get();
  } catch (err) {
    throw new GovernanceAuditError(
      'Failed to read governance audit entries for close dedupe',
      err,
    );
  }
  return snap.docs.length > 0;
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
 *
 * F6 (BUILDOUT_AUDIT §5) — orphan-audit handling. The audit-first
 * order above has one bad interleaving: the audit entry lands, then
 * the bridge fails before the vote update. The mechanics here pin
 * five outcome properties:
 *   P1  If the vote update does not land, closeVote does not return
 *       success and never throws VOTE_NOT_FOUND for a vote that
 *       exists on the Supa backend.
 *   P2  That failure surfaces as infrastructure-class
 *       (CloseVoteInfraError, a non-domain error), like other bridge
 *       infrastructure errors.
 *   P3  After a post-audit bridge failure, closeVote attempts NO
 *       Firestore fallback close for the vote (it rethrows
 *       CloseVoteInfraError; see the catch in closeVote).
 *   P4  A retry after bridge recovery converges to exactly ONE
 *       governance_vote_closed audit entry: before writing, the
 *       close reuses an existing entry for this vote
 *       (closeAuditEntryExists) instead of writing a second, then
 *       lands the vote update, so getCertifiedResult works.
 *   P5  No-unaudited-close invariant: success is returned only
 *       after BOTH the audit entry exists AND the vote update has
 *       landed — the update is the last write, and its failure is
 *       never reported as success.
 * Bridge failures BEFORE the audit phase (vote read, ballot list)
 * keep the original whole-operation fallback contract, exactly as
 * the pre-F6 code behaved.
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
  // Audit phase (F6): reuse an orphan entry left by a previous
  // post-audit failure instead of writing a second one (P4); write
  // the entry only when none exists yet. A GovernanceAuditError from
  // either step propagates — never a fallback trigger.
  if (!(await closeAuditEntryExists(db, voteId))) {
    await writeGovernanceAuditOrThrow(db, {
      action: 'governance_vote_closed',
      actorUid,
      targetType: 'governance_vote',
      targetId: voteId,
      details: { passed: result.passed, votesFor: result.votesFor, votesAgainst: result.votesAgainst },
    });
  }
  // The audit entry now exists. From here the close must either land
  // the vote update or fail as infrastructure (P1/P2/P3/P5): a bridge
  // failure is wrapped in CloseVoteInfraError so closeVote rethrows
  // it instead of falling back to a Firestore close that would
  // report VOTE_NOT_FOUND for this Supa-only vote.
  try {
    await seamUpdateDoc('governance_votes', voteId, {
      status: 'closed',
      result,
      closedAt: FieldValue.serverTimestamp(),
      closedByUid: actorUid,
    });
  } catch (err) {
    throw new CloseVoteInfraError(
      `closeVote: Supabase vote update failed after the governance_vote_closed audit entry was written for vote ${voteId}; not falling back to Firestore`,
      err,
    );
  }
  return result;
}

export async function closeVote(
  db: Firestore,
  voteId: string,
  actorUid: string,
): Promise<TallyResult> {
  const primaryAdapter = motionsPrimaryAdapter();
  if (primaryAdapter) {
    return closeVotePrimary(primaryAdapter, voteId, actorUid);
  }
  if (agmSupaEnabled()) {
    try {
      return await closeVoteSupa(db, voteId, actorUid);
    } catch (err) {
      if (
        err instanceof VoteError ||
        err instanceof GovernanceAuditError ||
        err instanceof CloseVoteInfraError
      ) {
        // CloseVoteInfraError (F6): the Supa close got past its audit
        // write, so a Firestore fallback close is forbidden — it
        // would misreport a Supa-only vote as VOTE_NOT_FOUND and
        // could double-close. Surface the infrastructure error.
        throw err;
      }
      // Supabase infrastructure error before the audit phase: fall
      // back to the Firestore path below (fallback contract).
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
  if (govSupaPrimaryFor('motions')) {
    const adapter = govSupaAdapterFor('motions');
    if (adapter) {
      const doc = await adapter.getDoc('governance_votes', voteId);
      if (!doc) {
        throw new VoteError('VOTE_NOT_FOUND', 404, 'Vote not found');
      }
      const ballotDocs = await adapter.listDocs(ballotsPath(voteId));
      const { id: _docId, ...data } = doc as Record<string, unknown>;
      void _docId;
      // ISO-SHAPE DELTA (pinned, plan §2-G2, re-checked on the
      // primary path): stored timestamps return as ISO-8601 strings
      // here, NOT Firestore Timestamp JSON — the adapter's storage
      // ruling, deliberately not faked back into Timestamp shape.
      // Individual ballots are never exposed (ballotCount only).
      return { id: voteId, ...data, ballotCount: ballotDocs.length };
    }
  }
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
