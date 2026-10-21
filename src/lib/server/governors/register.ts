/**
 * Board of Governors register - the only writers (Phase 2, spec C.2/C.3).
 *
 * Every mutation here is compare-and-swap on the seat doc's `version`,
 * writes a governors_history entry in the same WriteBatch, and writes the
 * throwing governance audit. Audit failure = the operation fails
 * (substrate contract 4). Nothing anywhere else writes `governors`.
 *
 * Role sync on assign/vacate/remove uses plain batch writes against BOTH
 * role stores - the P2-SYNC role-sync ADAPTER (spec C.2.2): it deliberately
 * does NOT call Phase 1's resolver or the consent-gated assign route, and it
 * never touches a Governor whose holderUid is null (external Governors have
 * no account, so role cleanup is definitionally skipped for them).
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/lib/roles';
import {
  GOVERNORS_COLLECTION,
  GOVERNORS_HISTORY_COLLECTION,
  SEAT_KEYS,
  addCalendarYears,
  cooptionOpenState,
  karachiMidnight,
  seatCategory,
  seedTermYears,
  toJsDate,
  toSeatView,
  type GovernorSeat,
  type GovernorSeatView,
  type SeatKey,
} from '@/lib/governors';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { runGovernorTermSweep } from '@/lib/server/governors/term-sweep';

import {
  grantGovernorRole,
  historyEntry,
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
  stats: {
    total: number;
    seated: number;
    vacant: number;
    quorum: string;
    byCategory: Record<string, { seated: number; total: number }>;
  };
}

export interface GovernorFixtures {
  founderHolder: { uid: string; name: string; email?: string | null };
}

function vacantSeat(seatKey: SeatKey): GovernorSeat {
  return {
    seatKey,
    category: seatCategory(seatKey),
    status: 'vacant',
    holderUid: null,
    holderName: null,
    holderEmail: null,
    holderExternalId: null,
    publicBio: null,
    photoUrl: null,
    seatedAt: null,
    termExpiresAt: null,
    appointmentBasis: null,
    consentRequestId: null,
    voteRecordId: null,
    electionResult: null,
    appointedBy: null,
    appointedByName: null,
    notes: null,
    termAlertStage: 0,
    version: 1,
    lastHolderName: null,
    lastHolderUid: null,
    vacateRecord: null,
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
  const seatedViews = views.filter((s) => s.status === 'seated');
  const founderSeated = seatedViews.some((s) => s.seatKey === 'seat_founder');
  const byCategory: Record<string, { seated: number; total: number }> = {};
  for (const view of views) {
    const entry = (byCategory[view.category] ??= { seated: 0, total: 0 });
    entry.total += 1;
    if (view.status === 'seated') entry.seated += 1;
  }
  return {
    seats: views,
    stats: {
      total: views.length,
      seated: seatedViews.length,
      vacant: views.length - seatedViews.length,
      quorum: founderSeated
        ? seatedViews.length >= 2
          ? 'quorate (Founder plus at least one Governor seated)'
          : 'Founder Quorum Lock available (Founder alone is quorate)'
        : 'inquorate (Founder Governor not seated)',
      byCategory,
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
    if (seatKey === 'seat_founder') {
      seat.status = 'seated';
      seat.holderUid = fixtures.founderHolder.uid;
      seat.holderName = fixtures.founderHolder.name;
      seat.holderEmail = fixtures.founderHolder.email ?? null;
      seat.seatedAt = FieldValue.serverTimestamp();
      seat.termExpiresAt = null;
      seat.appointmentBasis = 'Constitution: the Founder holds seat_founder ex officio';
      seat.appointedBy = actor.uid;
    }
    batch.set(seatRef(db, seatKey), seat as unknown as Record<string, unknown>);
    batch.set(db.collection(GOVERNORS_HISTORY_COLLECTION).doc(), historyEntry({
      seatKey,
      event: seatKey === 'seat_founder' ? 'seeded_founder_seated' : 'seeded_vacant',
      actorUid: actor.uid,
      actorName: actor.name,
      details: {},
    }));
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
  electionMeetingDate?: string | null;
  electionVotesFor?: number | null;
  electionVotesCast?: number | null;
  electionQuorumMet?: boolean | null;
  founderQuorumLock?: boolean;
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
  const seat = await readSeat(db, seatKey);
  const view = toSeatView(seat, now);
  if (view.status !== 'vacant') {
    throw opError('ALREADY_SEATED', `Seat ${seatKey} is already seated`);
  }
  if (args.expectedVersion !== seat.version) {
    throw opError('VERSION_CONFLICT', `Seat ${seatKey} changed since it was loaded (version ${seat.version})`);
  }

  const category = seat.category;
  const isFounder = actor.uid === FOUNDER_UID;
  const termYears = seedTermYears(seatKey, Boolean(seat.lastHolderUid) || seat.version > 1);
  const seatedDate = karachiMidnight(now);
  const termExpiresAt =
    category === 'Member-Elected' || termYears == null
      ? null
      : addCalendarYears(seatedDate, termYears);

  const update: Record<string, unknown> = {
    status: 'seated',
    holderName: args.holderName,
    holderEmail: args.holderEmail ?? null,
    holderExternalId: args.holderExternalId ?? null,
    publicBio: args.publicBio ?? null,
    photoUrl: args.photoUrl ?? null,
    seatedAt: seatedDate,
    termExpiresAt,
    termAlertStage: 0,
    vacateRecord: null,
    appointedBy: actor.uid,
    appointedByName: actor.name ?? null,
    version: seat.version + 1,
  };

  if (category === 'Founder-Appointed') {
    if (!isFounder) {
      throw opError('FORBIDDEN', 'Founder-Appointed seats are filled by the Founder alone');
    }
    if (!args.consentRequestId || typeof args.consentRequestId !== 'string') {
      throw opError('CONSENT_REQUIRED', 'Founder-Appointed seats require the Schedule Consent reference for this appointment');
    }
    update.consentRequestId = args.consentRequestId;
    update.appointmentBasis =
      'Founder appointment under the Reserved Powers Schedule s.3.2(b), Consent on file';
  } else if (category === 'Co-opted') {
    const seats = await readAllSeats(db);
    const views = seats.map((s) => toSeatView(s, now));
    const openState = cooptionOpenState(views);
    if (openState.method === 'founder_quorum_lock') {
      if (!isFounder) {
        throw opError('FOUNDER_QUORUM_LOCK', 'Only the Founder is seated; the Founder alone fills this seat under the Quorum Lock');
      }
      if (args.founderQuorumLock !== true) {
        throw opError('FOUNDER_QUORUM_LOCK', 'Declare founderQuorumLock: true to fill this seat under the Founder Quorum Lock');
      }
      update.appointmentBasis = 'Founder Quorum Lock (Constitution art. 17)';
    } else {
      if (!args.voteRecordId) {
        throw opError('VOTE_INVALID', 'Co-option requires the Board vote record reference');
      }
      const voteSnap = await db.collection('board_votes').doc(args.voteRecordId).get();
      if (!voteSnap.exists) {
        throw opError('VOTE_INVALID', `Vote record ${args.voteRecordId} not found`);
      }
      const vote = voteSnap.data() as Record<string, unknown>;
      const kind = (vote.kind as string) ?? (vote.type as string) ?? (vote.subjectType as string);
      const subjectId =
        (vote.subjectId as string) ?? (vote.seatKey as string) ?? (vote.subject as string);
      const votesFor = typeof vote.votesFor === 'number' ? vote.votesFor : null;
      if (kind !== 'cooption' || subjectId !== seatKey || votesFor == null) {
        throw opError('VOTE_INVALID', 'Vote record does not record a co-option for this seat');
      }
      if (votesFor < (openState.requiredVotes ?? Number.POSITIVE_INFINITY)) {
        throw opError(
          'VOTE_INVALID',
          `Co-option needs ${openState.requiredVotes} votes of ${openState.seatedAtOpen} seated Governors; the record shows ${votesFor}`,
        );
      }
      update.appointmentBasis = `Co-opted by Board vote ${args.voteRecordId} (${votesFor} of ${openState.seatedAtOpen} seated)`;
    }
    update.voteRecordId = args.voteRecordId ?? null;
  } else if (category === 'Member-Elected') {
    const meeting = args.electionMeetingDate ? toJsDate(args.electionMeetingDate) : null;
    const electionValid =
      meeting != null &&
      meeting.getTime() >= seatedDate.getTime() &&
      typeof args.electionVotesFor === 'number' &&
      typeof args.electionVotesCast === 'number' &&
      args.electionVotesCast > 0 &&
      args.electionVotesFor * 2 > args.electionVotesCast &&
      args.electionQuorumMet === true;
    if (!electionValid) {
      throw opError(
        'ELECTION_INVALID',
        'Member-Elected seats require the certified general-meeting result: meeting on or after today, a strict majority of votes cast, and quorum met',
      );
    }
    // Member terms run from the general meeting that elected them, 3 years.
    update.termExpiresAt = addCalendarYears(karachiMidnight(meeting as Date), 3);
    update.electionResult = {
      meetingDate: args.electionMeetingDate,
      votesFor: args.electionVotesFor,
      votesCast: args.electionVotesCast,
      quorumMet: true,
    };
    update.appointmentBasis = 'Certified result of the general meeting (manual entry; the platform does not run Member elections)';
  }

  const batch = db.batch();
  // Account-backed holder: stash the prior role and grant the Governor role.
  // External (account-less) holders skip role sync entirely - never an error.
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

  batch.update(seatRef(db, seatKey), update);
  batch.set(
    db.collection(GOVERNORS_HISTORY_COLLECTION).doc(),
    historyEntry({
      seatKey,
      event: 'seated',
      actorUid: actor.uid,
      actorName: actor.name,
      details: {
        holderName: args.holderName,
        holderUid: args.holderUid ?? null,
        appointmentBasis: update.appointmentBasis ?? null,
        consentRequestId: args.consentRequestId ?? null,
        voteRecordId: args.voteRecordId ?? null,
      },
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
      appointmentBasis: update.appointmentBasis ?? null,
      consentRequestId: args.consentRequestId ?? null,
      voteRecordId: args.voteRecordId ?? null,
    },
  });
  await batch.commit();
  return toSeatView({ ...seat, ...update } as GovernorSeat, now);
}

// ---------------------------------------------------------------------------
// Vacate / remove / notes
// ---------------------------------------------------------------------------

export interface VacateSeatArgs {
  reason: 'resigned' | 'term_expired' | 'deceased' | 'other';
  note?: string | null;
  expectedVersion: number;
}

export interface RemoveSeatArgs {
  note: string;
  expectedVersion: number;
}

async function vacateInternal(
  db: Firestore,
  actor: GovernorActor,
  seatKey: SeatKey,
  args: { reason: string; note?: string | null; expectedVersion: number; removal: boolean },
  now: Date,
): Promise<GovernorSeatView> {
  if (!actor.authorized) throw opError('FORBIDDEN', 'Not authorized to manage the register');
  if (seatKey === 'seat_founder') {
    throw opError('FOUNDER_SEAT_LOCKED', 'The Founder seat can never be vacated or removed');
  }
  const seat = await readSeat(db, seatKey);
  const view = toSeatView(seat, now);
  if (view.status !== 'seated') {
    throw opError('SEAT_NOT_VACANT', `Seat ${seatKey} is not seated`);
  }
  if (args.expectedVersion !== seat.version) {
    throw opError('VERSION_CONFLICT', `Seat ${seatKey} changed since it was loaded (version ${seat.version})`);
  }
  if (args.removal && actor.uid !== FOUNDER_UID) {
    throw opError('FORBIDDEN', 'Only the Founder records a removal from the Board');
  }
  if (args.removal && (!args.note || args.note.trim().length < 10)) {
    throw opError('VOTE_INVALID', 'A removal requires a note of at least 10 characters stating the Board vote reference');
  }

  const holderUid = seat.holderUid;
  const vacateRecord = {
    reason: args.removal ? 'removed' : args.reason,
    at: FieldValue.serverTimestamp(),
    by: actor.uid,
    byName: actor.name ?? null,
    note: args.note ?? null,
  };

  const batch = db.batch();
  if (holderUid) {
    const { userData, userExists, rolesData } = await readRoleStores(db, holderUid);
    if (userExists) {
      restorePriorRole(batch, db, holderUid, userData, rolesData, actor.uid);
    }
  }
  // Decision (spec C.2.2 ambiguity): removal returns the seat to 'vacant'
  // with the complete removal record; no transitional 'removed' status.
  batch.update(seatRef(db, seatKey), {
    status: 'vacant',
    holderUid: null,
    holderName: null,
    holderEmail: null,
    holderExternalId: null,
    publicBio: null,
    photoUrl: null,
    seatedAt: null,
    termExpiresAt: null,
    appointmentBasis: null,
    consentRequestId: null,
    voteRecordId: null,
    electionResult: null,
    termAlertStage: 0,
    lastHolderName: seat.holderName,
    lastHolderUid: seat.holderUid,
    vacateRecord,
    removalRecord: args.removal ? vacateRecord : null,
    version: seat.version + 1,
  });
  batch.set(
    db.collection(GOVERNORS_HISTORY_COLLECTION).doc(),
    historyEntry({
      seatKey,
      event: args.removal ? 'removed' : 'vacated',
      actorUid: actor.uid,
      actorName: actor.name,
      details: {
        reason: vacateRecord.reason,
        note: args.note ?? null,
        lastHolderName: seat.holderName,
        lastHolderUid: seat.holderUid,
      },
    }),
  );
  await writeGovernanceAuditOrThrow(db, {
    action: args.removal ? 'governor_removed' : 'governor_vacated',
    actorUid: actor.uid,
    actorRole: actor.role ?? null,
    targetType: 'governor_seat',
    targetId: seatKey,
    details: {
      reason: vacateRecord.reason,
      note: args.note ?? null,
      lastHolderName: seat.holderName,
      lastHolderUid: seat.holderUid,
    },
  });
  await batch.commit();
  const updated = await readSeat(db, seatKey);
  return toSeatView(updated, now);
}

export async function vacateSeat(
  db: Firestore,
  actor: GovernorActor,
  seatKey: SeatKey,
  args: VacateSeatArgs,
  now: Date = new Date(),
): Promise<GovernorSeatView> {
  return vacateInternal(db, actor, seatKey, { ...args, removal: false }, now);
}

export async function removeSeat(
  db: Firestore,
  actor: GovernorActor,
  seatKey: SeatKey,
  args: RemoveSeatArgs,
  now: Date = new Date(),
): Promise<GovernorSeatView> {
  return vacateInternal(
    db,
    actor,
    seatKey,
    { reason: 'removed', note: args.note, expectedVersion: args.expectedVersion, removal: true },
    now,
  );
}

export async function updateSeatNotes(
  db: Firestore,
  actor: GovernorActor,
  seatKey: SeatKey,
  notes: string | null,
  expectedVersion: number,
): Promise<GovernorSeatView> {
  if (!actor.authorized) throw opError('FORBIDDEN', 'Not authorized to manage the register');
  const seat = await readSeat(db, seatKey);
  if (expectedVersion !== seat.version) {
    throw opError('VERSION_CONFLICT', `Seat ${seatKey} changed since it was loaded (version ${seat.version})`);
  }
  const batch = db.batch();
  batch.update(seatRef(db, seatKey), { notes, version: seat.version + 1 });
  batch.set(
    db.collection(GOVERNORS_HISTORY_COLLECTION).doc(),
    historyEntry({
      seatKey,
      event: 'notes_updated',
      actorUid: actor.uid,
      actorName: actor.name,
      details: {},
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
