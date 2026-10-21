/**
 * Board of Governors register - the only writers (Phase 2, spec C.1/C.2).
 *
 * Every mutation is compare-and-swap on the seat doc's `version`, writes
 * exactly one history event (governors/{seatKey}/history) in the same batch,
 * and writes the throwing governance audit. Audit failure = the operation
 * fails (substrate contract 4). Nothing anywhere else writes `governors`.
 *
 * Role sync uses the P2-SYNC adapter (shared.ts): plain batch writes against
 * BOTH role stores with the category Governor key. It deliberately does NOT
 * call Phase 1's resolver or the consent-gated assign route, and it never
 * touches a Governor whose holderUid is null (external Governors).
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/lib/roles';
import {
  GOVERNORS_COLLECTION,
  SEAT_KEYS,
  SEAT_ORDER,
  addCalendarYears,
  effectiveStatus,
  holderRoleKeyFor,
  karachiMidnight,
  requiredVotes,
  seatCategory,
  seedTermYears,
  toJsDate,
  toSeatView,
  type ElectionResult,
  type GovernorSeat,
  type GovernorSeatView,
  type SeatKey,
} from '@/lib/governors';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { notificationService } from '@/lib/server/notification-service';
import { runGovernorTermSweep } from '@/lib/server/governors/term-sweep';
import {
  GovernorOpError,
  grantGovernorRole,
  historyEvent,
  historyRef,
  opError,
  readRoleStores,
  restorePriorRole,
  seatRef,
} from '@/lib/server/governors/shared';

export { GovernorOpError } from '@/lib/server/governors/shared';

export interface GovernorActor {
  uid: string;
  name?: string | null;
  role?: string | null;
  /** True when the actor may manage the register at all (route-checked). */
  authorized: boolean;
}

export interface RegisterView {
  seats: GovernorSeatView[];
  summary: {
    seatedCount: number;
    vacantCount: number;
    expiringWithin90Days: number;
    quorum: string;
  };
}

export interface GovernorFixtures {
  founderHolder: { uid: string; name: string; email?: string | null };
}

function vacantSeat(seatKey: SeatKey): GovernorSeat {
  const category = seatCategory(seatKey);
  const isMember = category === 'member_elected';
  return {
    seatKey,
    seatOrder: SEAT_ORDER[seatKey],
    category,
    status: isMember ? 'awaiting_election' : 'vacant',
    holderUid: null,
    holderName: null,
    holderEmail: null,
    holderExternalId: null,
    holderRoleKey: null,
    isExternal: false,
    publicBio: null,
    photoUrl: null,
    termStart: null,
    termEnd: null,
    termYears: null,
    isInitialStaggerTerm: false,
    seatedAt: null,
    vacatedAt: null,
    vacancySince: null,
    lastVacancyReason: isMember ? 'awaiting_election' : 'never_filled',
    lastHolderName: null,
    lastHolderUid: null,
    appointedBy: null,
    appointedByName: null,
    appointmentRecordRef: null,
    consentRequestId: null,
    voteRecordId: null,
    electionResult: null,
    removalRecord: null,
    vacateRecord: null,
    notes: null,
    termAlertStage: 'none',
    version: 1,
  };
}

async function readSeat(db: Firestore, seatKey: SeatKey): Promise<GovernorSeat> {
  const snap = await seatRef(db, seatKey).get();
  if (!snap.exists) {
    throw opError('SEAT_NOT_FOUND', `Seat ${seatKey} does not exist; run the register seed`);
  }
  return snap.data() as GovernorSeat;
}

async function readAllSeats(db: Firestore): Promise<GovernorSeat[]> {
  const snap = await db.collection(GOVERNORS_COLLECTION).get();
  const byKey = new Map<string, GovernorSeat>();
  snap.docs.forEach((d) => byKey.set(d.id, d.data() as GovernorSeat));
  const seats: GovernorSeat[] = [];
  for (const key of SEAT_KEYS) {
    const seat = byKey.get(key);
    if (!seat) {
      throw opError('SEAT_NOT_FOUND', `Seat ${key} is missing from the register; run the seed`);
    }
    seats.push(seat);
  }
  return seats;
}

// ---------------------------------------------------------------------------
// Register read
// ---------------------------------------------------------------------------

export async function getRegister(db: Firestore, now: Date = new Date()): Promise<RegisterView> {
  // Materialise any lapsed terms first so editors see stored truth.
  await runGovernorTermSweep(db, now);
  const seats = await readAllSeats(db);
  const views = seats.map((s) => toSeatView(s, now));
  const seated = views.filter((s) => s.effectiveStatus === 'seated');
  const founderSeated = seated.some((s) => s.seatKey === 'seat_founder');
  return {
    seats: views,
    summary: {
      seatedCount: seated.length,
      vacantCount: views.length - seated.length,
      expiringWithin90Days: seated.filter(
        (s) => s.daysToTermEnd != null && s.daysToTermEnd <= 90,
      ).length,
      quorum: founderSeated
        ? seated.length >= 2
          ? 'quorate (Founder plus at least one Governor seated)'
          : 'Founder Quorum Lock available (Founder alone is quorate)'
        : 'inquorate (Founder Governor not seated)',
    },
  };
}

// ---------------------------------------------------------------------------
// Seed (code + fixtures ONLY - NEVER run against production data)
// ---------------------------------------------------------------------------

export async function seedGovernors(
  db: Firestore,
  actor: GovernorActor,
  fixtures: GovernorFixtures,
): Promise<{ created: string[]; existed: string[] }> {
  const created: string[] = [];
  const existed: string[] = [];
  const batch = db.batch();
  const snaps = await Promise.all(SEAT_KEYS.map((k) => seatRef(db, k).get()));
  snaps.forEach((snap, i) => {
    const seatKey = SEAT_KEYS[i];
    if (snap.exists) {
      existed.push(seatKey);
      return;
    }
    const seat = vacantSeat(seatKey);
    seat.vacancySince = FieldValue.serverTimestamp();
    seat.createdAt = FieldValue.serverTimestamp();
    seat.updatedAt = FieldValue.serverTimestamp();
    seat.updatedBy = actor.uid;
    if (seatKey === 'seat_founder') {
      seat.status = 'seated';
      seat.holderUid = fixtures.founderHolder.uid;
      seat.holderName = fixtures.founderHolder.name;
      seat.holderEmail = fixtures.founderHolder.email ?? null;
      seat.holderRoleKey = holderRoleKeyFor(seatKey);
      seat.seatedAt = FieldValue.serverTimestamp();
      seat.termStart = FieldValue.serverTimestamp();
      seat.appointedBy = 'ex_officio';
      seat.appointmentRecordRef = {
        kind: 'ex_officio',
        id: null,
        label: 'Founder seat, held ex officio',
      };
      seat.lastVacancyReason = null;
      seat.vacancySince = null;
    }
    batch.set(seatRef(db, seatKey), seat as unknown as Record<string, unknown>);
    batch.set(
      historyRef(db, seatKey),
      historyEvent({
        eventType: seatKey === 'seat_founder' ? 'seeded_founder_seated' : 'seeded',
        actorUid: actor.uid,
        actorRole: actor.role,
        before: null,
        after: seat,
        recordRef: null,
        reason: null,
      }),
    );
    created.push(seatKey);
  });
  await writeGovernanceAuditOrThrow(db, {
    action: 'governors_seeded',
    actorUid: actor.uid,
    actorRole: actor.role ?? null,
    targetType: 'governors',
    targetId: 'register',
    details: { created, existed },
  });
  await batch.commit();
  return { created, existed };
}

// ---------------------------------------------------------------------------
// Evidence validation
// ---------------------------------------------------------------------------

/**
 * ADAPTER(W-A): Founder-Appointed appointments re-read the Schedule s.3.2(b)
 * Consent from Workstream A's consent_requests collection. Field reads are
 * tolerant because A's schema is not on this branch: status from `status`,
 * seat link from `seatKey` / `subject.seatKey` / `subjectId` when present.
 * Until A lands, every referenced doc is missing here and the path answers
 * CONSENT_NOT_AVAILABLE, exactly the spec's interim state (C.2).
 */
async function assertFounderAppointmentConsent(
  db: Firestore,
  seatKey: SeatKey,
  consentRequestId: string | null | undefined,
): Promise<void> {
  if (!consentRequestId) {
    throw opError(
      'CONSENT_REQUIRED',
      'Founder-Appointed seats require the Schedule s.3.2(b) Consent reference for this appointment',
    );
  }
  const snap = await db.collection('consent_requests').doc(consentRequestId).get();
  if (!snap.exists) {
    throw opError(
      'CONSENT_NOT_AVAILABLE',
      `Consent ${consentRequestId} was not found; Founder-Appointed appointments stay blocked until the Consent record exists`,
    );
  }
  const doc = snap.data() as Record<string, unknown>;
  const status =
    (typeof doc.status === 'string' && doc.status) ||
    ((doc.decision as Record<string, unknown> | undefined)?.status as string) ||
    '';
  const decided = ['consented', 'given', 'decided', 'conditional_met'].includes(status);
  const conditionalOk = status === 'conditional' && doc.conditionsMet === true;
  if (!decided && !conditionalOk) {
    throw opError(
      'CONSENT_INVALID',
      `Consent ${consentRequestId} is not in a decided state (status: ${status || 'unknown'})`,
    );
  }
  const subject = doc.subject as Record<string, unknown> | undefined;
  const linkedSeat =
    (typeof doc.seatKey === 'string' && doc.seatKey) ||
    (typeof subject?.seatKey === 'string' && (subject.seatKey as string)) ||
    (typeof doc.subjectId === 'string' && doc.subjectId) ||
    null;
  if (linkedSeat && linkedSeat !== seatKey) {
    throw opError('CONSENT_INVALID', `Consent ${consentRequestId} names seat ${linkedSeat}, not ${seatKey}`);
  }
}

interface ValidatedVote {
  votesFor: number;
  seatedCountAtOpen: number;
}

/**
 * Recompute a Board vote from its snapshot (spec C.2/C.3): the vote doc is
 * evidence, never trusted - kind, seat, candidate, closed/passed state, the
 * strict-majority threshold against seatedCountAtOpen, and (for co-options)
 * the Founder-presence quorum lock are all re-derived here.
 */
async function validateBoardVote(
  db: Firestore,
  voteRecordId: string | null | undefined,
  expected: { kind: 'cooption' | 'governor_removal'; seatKey: SeatKey; candidateName?: string },
): Promise<ValidatedVote> {
  if (!voteRecordId) {
    throw opError(
      'VOTE_INVALID',
      expected.kind === 'cooption'
        ? 'Co-option requires the Board vote record reference'
        : 'Removal requires the Board removal vote record reference',
    );
  }
  const snap = await db.collection('governance_votes').doc(voteRecordId).get();
  if (!snap.exists) {
    throw opError('VOTE_INVALID', `Vote record ${voteRecordId} not found`);
  }
  const vote = snap.data() as Record<string, unknown>;
  const kind = (vote.kind as string) ?? (vote.type as string) ?? (vote.subjectType as string);
  const seatKey =
    (vote.seatKey as string) ?? (vote.subjectId as string) ?? (vote.subject as string);
  const status = typeof vote.status === 'string' ? vote.status : null;
  const outcome = typeof vote.outcome === 'string' ? vote.outcome : null;
  const votesFor = typeof vote.votesFor === 'number' ? vote.votesFor : null;
  const seatedCountAtOpen =
    typeof vote.seatedCountAtOpen === 'number' ? vote.seatedCountAtOpen : null;
  if (kind !== expected.kind || seatKey !== expected.seatKey) {
    throw opError('VOTE_INVALID', `Vote record ${voteRecordId} does not record a ${expected.kind} for this seat`);
  }
  if (status !== null && status !== 'closed') {
    throw opError('VOTE_INVALID', `Vote record ${voteRecordId} is not closed`);
  }
  if (outcome !== null && outcome !== 'passed') {
    throw opError('VOTE_INVALID', `Vote record ${voteRecordId} did not pass`);
  }
  if (
    expected.candidateName &&
    typeof vote.candidateName === 'string' &&
    vote.candidateName !== expected.candidateName
  ) {
    throw opError('VOTE_INVALID', 'Vote record names a different candidate than the holder being seated');
  }
  if (votesFor == null || seatedCountAtOpen == null) {
    throw opError('VOTE_INVALID', 'Vote record lacks votesFor / seatedCountAtOpen; the threshold cannot be recomputed');
  }
  if (votesFor < requiredVotes(seatedCountAtOpen)) {
    throw opError(
      'VOTE_INVALID',
      `Passage needs ${requiredVotes(seatedCountAtOpen)} of ${seatedCountAtOpen} seated Governors; the record shows ${votesFor}`,
    );
  }
  if (expected.kind === 'cooption') {
    const founderPresent = vote.founderPresent === true;
    const waiver =
      typeof vote.founderWaiverRef === 'string' && vote.founderWaiverRef.length > 0;
    if (!founderPresent && !waiver) {
      throw opError(
        'FOUNDER_QUORUM_LOCK',
        'The vote record carries neither founderPresent nor a founderWaiverRef; the Founder Quorum Lock bars recording this co-option',
      );
    }
  }
  return { votesFor, seatedCountAtOpen };
}

function validateElectionResult(
  result: ElectionResult | null | undefined,
  holderName: string,
  holderUid: string | null,
): ElectionResult {
  const bad = (msg: string) => opError('ELECTION_INVALID', msg);
  if (!result) throw bad('Member-Elected seats require the certified election result record');
  const meeting = result.electionDate ? toJsDate(result.electionDate) : null;
  if (!meeting) throw bad('electionResult.electionDate is required and must be a valid date');
  if (!result.returningOfficerName || !result.returningOfficerName.trim()) {
    throw bad('electionResult.returningOfficerName is required');
  }
  if (
    typeof result.eligibleVoterCount !== 'number' ||
    typeof result.ballotsCast !== 'number' ||
    typeof result.votesForHolder !== 'number' ||
    result.eligibleVoterCount <= 0
  ) {
    throw bad('electionResult requires numeric eligibleVoterCount (> 0), ballotsCast and votesForHolder');
  }
  if (result.ballotsCast > result.eligibleVoterCount) {
    throw bad('ballotsCast exceeds eligibleVoterCount');
  }
  if (result.votesForHolder > result.ballotsCast) {
    throw bad('votesForHolder exceeds ballotsCast');
  }
  if (
    result.returningOfficerName.trim().toLowerCase() === holderName.trim().toLowerCase() ||
    (result.returningOfficerUid && holderUid && result.returningOfficerUid === holderUid)
  ) {
    throw bad('The Returning Officer cannot be the holder they certified');
  }
  if (
    !Array.isArray(result.nominatedByNames) ||
    result.nominatedByNames.length !== 2 ||
    result.nominatedByNames.some((n) => typeof n !== 'string' || !n.trim())
  ) {
    throw bad('electionResult.nominatedByNames must name the two Full Member nominators');
  }
  if (!result.candidateConsentRef || !result.candidateConsentRef.trim()) {
    throw bad('electionResult.candidateConsentRef is required');
  }
  if (result.tieBreakByLot === true && !(result.tieBreakNote && result.tieBreakNote.trim())) {
    throw bad('electionResult.tieBreakNote is required when the result was decided by lot');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

export interface AssignSeatArgs {
  holderUid?: string | null;
  holderName: string;
  holderEmail?: string | null;
  holderExternalId?: string | null;
  publicBio?: string | null;
  photoUrl?: string | null;
  consentRequestId?: string | null;
  voteRecordId?: string | null;
  electionResult?: ElectionResult | null;
  expectedVersion: number;
}

export async function assignSeat(
  db: Firestore,
  actor: GovernorActor,
  seatKey: SeatKey,
  args: AssignSeatArgs,
  now: Date = new Date(),
): Promise<GovernorSeatView> {
  if (!actor.authorized) throw opError('FORBIDDEN', 'Not authorized to manage the register');
  if (seatKey === 'seat_founder') {
    throw opError('FOUNDER_SEAT_LOCKED', 'The Founder seat is seated ex officio and never assigned');
  }
  // Materialise lapsed terms so an expired seat can be re-seated cleanly.
  await runGovernorTermSweep(db, now);
  const seat = await readSeat(db, seatKey);
  const eff = effectiveStatus(seat, now);
  if (eff !== 'vacant' && eff !== 'awaiting_election') {
    throw opError('ALREADY_SEATED', `Seat ${seatKey} is already seated`);
  }
  if (args.expectedVersion !== seat.version) {
    throw opError('VERSION_CONFLICT', `Seat ${seatKey} changed since it was loaded (version ${seat.version})`);
  }

  // Uniqueness guard (spec C.2): one person, one seat.
  const allSeats = await readAllSeats(db);
  const norm = (s: string) => s.trim().toLowerCase();
  for (const other of allSeats) {
    if (other.seatKey === seatKey) continue;
    if (effectiveStatus(other, now) !== 'seated') continue;
    if (args.holderUid && other.holderUid === args.holderUid) {
      throw opError('ALREADY_SEATED', `That account already holds seat ${other.seatKey}`);
    }
    if (
      args.holderEmail &&
      other.holderName &&
      norm(other.holderName) === norm(args.holderName) &&
      other.holderEmail &&
      norm(other.holderEmail) === norm(args.holderEmail)
    ) {
      throw opError('ALREADY_SEATED', `That person already holds seat ${other.seatKey}`);
    }
  }

  const category = seat.category;
  const everSeated = Boolean(seat.lastHolderUid) || seat.version > 1;
  const { years, isStagger } = seedTermYears(seatKey, everSeated);
  const termStart = karachiMidnight(now);
  // The history ref is minted first: a Member-Elected appointmentRecordRef
  // points at the seating's own history event (spec C.2).
  const histRef = historyRef(db, seatKey);

  const update: Record<string, unknown> = {
    status: 'seated',
    holderName: args.holderName,
    holderEmail: args.holderEmail ?? null,
    holderExternalId: args.holderExternalId ?? null,
    holderRoleKey: holderRoleKeyFor(seatKey),
    isExternal: !args.holderUid,
    publicBio: args.publicBio ?? null,
    photoUrl: args.photoUrl ?? null,
    seatedAt: now,
    termStart,
    vacatedAt: null,
    vacancySince: null,
    lastVacancyReason: null,
    removalRecord: null,
    vacateRecord: null,
    termAlertStage: 'none',
    appointedByName: actor.name ?? null,
    version: seat.version + 1,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actor.uid,
  };

  if (category === 'founder_appointed') {
    if (actor.uid !== FOUNDER_UID) {
      throw opError('FORBIDDEN', 'Founder-Appointed seats are filled by the Founder alone');
    }
    await assertFounderAppointmentConsent(db, seatKey, args.consentRequestId);
    update.consentRequestId = args.consentRequestId ?? null;
    update.appointedBy = actor.uid;
    update.appointmentRecordRef = {
      kind: 'consent',
      id: args.consentRequestId ?? null,
      label: 'Schedule s.3.2(b) Consent',
    };
    // Art. 5: Founder-Appointed Governors have no fixed term.
    update.termYears = null;
    update.termEnd = null;
    update.isInitialStaggerTerm = false;
  } else if (category === 'co_opted') {
    const vote = await validateBoardVote(db, args.voteRecordId, {
      kind: 'cooption',
      seatKey,
      candidateName: args.holderName,
    });
    update.voteRecordId = args.voteRecordId ?? null;
    update.appointedBy = 'board';
    update.appointmentRecordRef = {
      kind: 'board_vote',
      id: args.voteRecordId ?? null,
      label: `Board co-option vote (${vote.votesFor} of ${vote.seatedCountAtOpen} seated)`,
    };
    update.termYears = years;
    update.isInitialStaggerTerm = isStagger;
    update.termEnd = years != null ? addCalendarYears(termStart, years) : null;
  } else if (category === 'member_elected') {
    const result = validateElectionResult(args.electionResult, args.holderName, args.holderUid ?? null);
    const electionDay = karachiMidnight(toJsDate(result.electionDate) as Date);
    update.electionResult = { ...result, recordedByUid: actor.uid };
    update.appointedBy = 'general_body';
    update.appointmentRecordRef = {
      kind: 'election_result',
      id: histRef.id,
      label: `Election result recorded ${result.electionDate}`,
    };
    update.termStart = electionDay;
    update.termYears = years;
    update.isInitialStaggerTerm = isStagger;
    update.termEnd = years != null ? addCalendarYears(electionDay, years) : null;
  }

  const batch = db.batch();
  if (args.holderUid) {
    const { userData, userExists, rolesData } = await readRoleStores(db, args.holderUid);
    if (userExists) {
      const currentRole =
        (typeof rolesData?.role === 'string' && (rolesData.role as string)) ||
        (typeof userData?.role === 'string' && (userData.role as string)) ||
        'member';
      batch.set(
        db.collection('users').doc(args.holderUid),
        { previousRole: currentRole, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      batch.set(
        db.collection('roles').doc(args.holderUid),
        { previousRole: currentRole },
        { merge: true },
      );
      grantGovernorRole(batch, db, seatKey, args.holderUid, actor.uid);
    }
    update.holderUid = args.holderUid;
  } else {
    update.holderUid = null;
  }

  const afterSeat = { ...seat, ...update } as GovernorSeat;
  batch.update(seatRef(db, seatKey), update);
  batch.set(
    histRef,
    historyEvent({
      eventType: 'seated',
      actorUid: actor.uid,
      actorRole: actor.role,
      before: seat,
      after: afterSeat,
      recordRef:
        (update.appointmentRecordRef as { id: string | null } | undefined)?.id ?? null,
      reason: null,
    }),
  );
  await writeGovernanceAuditOrThrow(db, {
    action: 'governor_seated',
    actorUid: actor.uid,
    actorRole: actor.role ?? null,
    targetType: 'governor_seat',
    targetId: seatKey,
    details: {
      holderName: args.holderName,
      holderUid: args.holderUid ?? null,
      holderRoleKey: update.holderRoleKey,
      appointmentBasis:
        (update.appointmentRecordRef as { label: string } | undefined)?.label ?? null,
      consentRequestId: args.consentRequestId ?? null,
      voteRecordId: args.voteRecordId ?? null,
    },
  });
  await batch.commit();
  return toSeatView(afterSeat, now);
}

// ---------------------------------------------------------------------------
// Vacate / remove / notes
// ---------------------------------------------------------------------------

export interface VacateSeatArgs {
  reason: 'resigned' | 'deceased' | 'incapacitated' | 'other';
  detail: string;
  recordRef?: string | null;
  markAwaitingElection?: boolean;
  expectedVersion: number;
}

export interface RemoveSeatArgs {
  removal: {
    cause?: string | null;
    causeDetail?: string | null;
    noticeDate?: string | null;
    replyRef?: string | null;
    voteRecordId?: string | null;
    effectiveAt?: string | null;
  };
  expectedVersion: number;
}

function clearedSeatUpdate(seat: GovernorSeat, actor: GovernorActor, now: Date) {
  return {
    status: 'vacant' as const,
    holderUid: null,
    holderName: null,
    holderEmail: null,
    holderExternalId: null,
    holderRoleKey: null,
    isExternal: false,
    publicBio: null,
    photoUrl: null,
    termStart: null,
    termEnd: null,
    termYears: null,
    isInitialStaggerTerm: false,
    vacatedAt: now,
    vacancySince: now,
    consentRequestId: null,
    voteRecordId: null,
    electionResult: null,
    appointmentRecordRef: null,
    appointedBy: null,
    lastHolderName: seat.holderName,
    lastHolderUid: seat.holderUid,
    version: seat.version + 1,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actor.uid,
  };
}

async function restoreHolderRole(
  batch: FirebaseFirestore.WriteBatch,
  db: Firestore,
  seat: GovernorSeat,
  actorUid: string,
) {
  if (!seat.holderUid) return;
  const { userData, userExists, rolesData } = await readRoleStores(db, seat.holderUid);
  if (userExists) {
    restorePriorRole(batch, db, seat.holderUid, userData, rolesData, actorUid);
  }
}

export async function vacateSeat(
  db: Firestore,
  actor: GovernorActor,
  seatKey: SeatKey,
  args: VacateSeatArgs,
  now: Date = new Date(),
): Promise<GovernorSeatView> {
  if (!actor.authorized) throw opError('FORBIDDEN', 'Not authorized to manage the register');
  if (seatKey === 'seat_founder') {
    throw opError('FOUNDER_SEAT_LOCKED', 'The Founder seat can never be vacated or removed');
  }
  const seat = await readSeat(db, seatKey);
  if (effectiveStatus(seat, now) !== 'seated') {
    throw opError('SEAT_NOT_VACANT', `Seat ${seatKey} is not seated`);
  }
  if (args.expectedVersion !== seat.version) {
    throw opError('VERSION_CONFLICT', `Seat ${seatKey} changed since it was loaded (version ${seat.version})`);
  }
  if (!args.detail || !args.detail.trim()) {
    throw opError('DETAIL_REQUIRED', 'A vacate requires a detail note');
  }
  if (args.reason === 'resigned' && !(args.recordRef && args.recordRef.trim())) {
    throw opError('RECORD_REQUIRED', 'A resignation vacate requires the resignation record reference');
  }

  const awaiting = args.markAwaitingElection === true && seat.category === 'member_elected';
  const vacateRecord = {
    reason: args.reason,
    at: FieldValue.serverTimestamp(),
    by: actor.uid,
    byName: actor.name ?? null,
    note: args.detail,
    recordRef: args.recordRef ?? null,
  };
  const update: Record<string, unknown> = {
    ...clearedSeatUpdate(seat, actor, now),
    status: awaiting ? 'awaiting_election' : 'vacant',
    lastVacancyReason: awaiting ? 'awaiting_election' : args.reason,
    vacateRecord,
    removalRecord: null,
    termAlertStage: 'none',
  };

  const batch = db.batch();
  await restoreHolderRole(batch, db, seat, actor.uid);
  batch.update(seatRef(db, seatKey), update);
  batch.set(
    historyRef(db, seatKey),
    historyEvent({
      eventType: 'vacated',
      actorUid: actor.uid,
      actorRole: actor.role,
      before: seat,
      after: { ...seat, ...update } as GovernorSeat,
      recordRef: args.recordRef ?? null,
      reason: args.reason,
    }),
  );
  await writeGovernanceAuditOrThrow(db, {
    action: 'governor_vacated',
    actorUid: actor.uid,
    actorRole: actor.role ?? null,
    targetType: 'governor_seat',
    targetId: seatKey,
    details: {
      reason: args.reason,
      detail: args.detail,
      lastHolderName: seat.holderName,
      lastHolderUid: seat.holderUid,
    },
  });
  await batch.commit();
  const updated = await readSeat(db, seatKey);
  return toSeatView(updated, now);
}

export async function removeSeat(
  db: Firestore,
  actor: GovernorActor,
  seatKey: SeatKey,
  args: RemoveSeatArgs,
  now: Date = new Date(),
): Promise<GovernorSeatView> {
  if (!actor.authorized) throw opError('FORBIDDEN', 'Not authorized to manage the register');
  if (seatKey === 'seat_founder') {
    throw opError('FOUNDER_SEAT_LOCKED', 'The Founder seat can never be vacated or removed');
  }
  const seat = await readSeat(db, seatKey);
  if (effectiveStatus(seat, now) !== 'seated') {
    throw opError('SEAT_NOT_VACANT', `Seat ${seatKey} is not seated`);
  }
  if (args.expectedVersion !== seat.version) {
    throw opError('VERSION_CONFLICT', `Seat ${seatKey} changed since it was loaded (version ${seat.version})`);
  }

  const removal = args.removal ?? {};
  let cause: string;
  let voteRecordId: string | null = null;
  if (seat.category === 'founder_appointed') {
    // Founder removal of his own appointee: cause is founder_discretion with
    // a required detail note (spec C.1); no Board vote.
    if (actor.uid !== FOUNDER_UID) {
      throw opError('FORBIDDEN', 'Only the Founder removes a Founder-Appointed Governor');
    }
    cause = 'founder_discretion';
    if (!removal.causeDetail || removal.causeDetail.trim().length < 10) {
      throw opError('CAUSE_DETAIL_REQUIRED', 'A Founder removal records cause founder_discretion with a detail note of at least 10 characters');
    }
  } else {
    // Co-opted / Member-Elected: a passing Board removal vote, recorded.
    await validateBoardVote(db, removal.voteRecordId, {
      kind: 'governor_removal',
      seatKey,
    });
    voteRecordId = removal.voteRecordId ?? null;
    if (!removal.cause || !removal.cause.trim()) {
      throw opError('CAUSE_REQUIRED', 'A removal requires a Cause from the closed Constitution Art. 16 list');
    }
    cause = removal.cause;
    if (!removal.noticeDate || !toJsDate(removal.noticeDate)) {
      throw opError('NOTICE_REQUIRED', 'A removal requires the 7-day notice date');
    }
    if (!removal.replyRef || !removal.replyRef.trim()) {
      throw opError('REPLY_REF_REQUIRED', 'A removal requires the member reply reference, or the recorded value "no reply by deadline"');
    }
  }

  const effectiveAt = removal.effectiveAt ? (toJsDate(removal.effectiveAt) ?? now) : now;
  const removalRecord = {
    removedByUid: seat.holderUid,
    removedByRole: seat.holderRoleKey,
    cause,
    causeDetail: removal.causeDetail ?? null,
    noticeDate: removal.noticeDate ?? null,
    replyRef: removal.replyRef ?? null,
    voteRecordId,
    effectiveAt,
    recordedByUid: actor.uid,
  };
  const vacateRecord = {
    reason: 'removed',
    at: FieldValue.serverTimestamp(),
    by: actor.uid,
    byName: actor.name ?? null,
    note: removal.causeDetail ?? null,
    recordRef: voteRecordId,
  };
  const update: Record<string, unknown> = {
    ...clearedSeatUpdate(seat, actor, now),
    status: 'vacant',
    lastVacancyReason: 'removed',
    vacateRecord,
    removalRecord,
    termAlertStage: 'none',
  };

  const batch = db.batch();
  await restoreHolderRole(batch, db, seat, actor.uid);
  batch.update(seatRef(db, seatKey), update);
  batch.set(
    historyRef(db, seatKey),
    historyEvent({
      eventType: 'removed',
      actorUid: actor.uid,
      actorRole: actor.role,
      before: seat,
      after: { ...seat, ...update } as GovernorSeat,
      recordRef: voteRecordId,
      reason: cause,
    }),
  );
  await writeGovernanceAuditOrThrow(db, {
    action: 'governor_removed',
    actorUid: actor.uid,
    actorRole: actor.role ?? null,
    targetType: 'governor_seat',
    targetId: seatKey,
    details: {
      cause,
      voteRecordId,
      lastHolderName: seat.holderName,
      lastHolderUid: seat.holderUid,
    },
  });
  await batch.commit();

  // Neutral notification to the removed holder (spec C.2): seat, effective
  // date, recording officer - never the cause. Best effort.
  if (seat.holderUid) {
    try {
      await notificationService.send(
        seat.holderUid,
        {
          type: 'governor_removal',
          title: 'Board of Governors - seat change',
          body: `Your seat on the Board of Governors (${seatKey}) ends effective ${effectiveAt.toISOString().slice(0, 10)}, recorded by ${actor.name ?? 'the register keeper'}.`,
          link: '/admin/governors',
          metadata: { seatKey },
        },
        'P1',
      );
    } catch (err) {
      console.error('[governors] removal notification failed', err);
    }
  }

  const updated = await readSeat(db, seatKey);
  return toSeatView(updated, now);
}

export async function updateSeatNotes(
  db: Firestore,
  actor: GovernorActor,
  seatKey: SeatKey,
  notes: string | null,
  expectedVersion: number,
): Promise<GovernorSeatView> {
  if (!actor.authorized) throw opError('FORBIDDEN', 'Not authorized to manage the register');
  if (notes != null && notes.length > 2000) {
    throw opError('NOTES_TOO_LONG', 'Register notes are limited to 2000 characters');
  }
  const seat = await readSeat(db, seatKey);
  if (expectedVersion !== seat.version) {
    throw opError('VERSION_CONFLICT', `Seat ${seatKey} changed since it was loaded (version ${seat.version})`);
  }
  const batch = db.batch();
  batch.update(seatRef(db, seatKey), {
    notes,
    version: seat.version + 1,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actor.uid,
  });
  batch.set(
    historyRef(db, seatKey),
    historyEvent({
      eventType: 'notes_updated',
      actorUid: actor.uid,
      actorRole: actor.role,
      before: seat,
      after: seat,
      recordRef: null,
      reason: null,
    }),
  );
  await writeGovernanceAuditOrThrow(db, {
    action: 'governor_notes_updated',
    actorUid: actor.uid,
    actorRole: actor.role ?? null,
    targetType: 'governor_seat',
    targetId: seatKey,
    details: {},
  });
  await batch.commit();
  const updated = await readSeat(db, seatKey);
  return toSeatView(updated, new Date());
}
