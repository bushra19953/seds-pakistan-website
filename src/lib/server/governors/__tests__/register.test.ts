/**
 * @jest-environment node
 *
 * Board of Governors register tests (spec C.7 cases 1-21) against a fake
 * Firestore. The audit writer and notification service are mocked; all
 * register logic - consent re-read, vote recomputation, election validation,
 * role sync - is real.
 */

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn().mockResolvedValue('audit-1'),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn().mockResolvedValue(undefined) },
}));

import { FOUNDER_UID } from '@/lib/roles';
import { toSeatView, type GovernorSeat } from '@/lib/governors';
import {
  assignSeat,
  getRegister,
  removeSeat,
  seedGovernors,
  vacateSeat,
  GovernorOpError,
  type GovernorActor,
} from '@/lib/server/governors/register';
import { runGovernorTermSweep } from '@/lib/server/governors/term-sweep';

// ---------------------------------------------------------------------------
// Fake Firestore (with subcollection support)
// ---------------------------------------------------------------------------

type DocData = Record<string, unknown>;

function isDeleteTransform(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { constructor?: { name?: string } }).constructor?.name?.includes('Transform') === true
  );
}

class FakeStore {
  data = new Map<string, Map<string, DocData>>();
  private autoId = 0;

  col(name: string): Map<string, DocData> {
    if (!this.data.has(name)) this.data.set(name, new Map());
    return this.data.get(name) as Map<string, DocData>;
  }

  nextId(): string {
    this.autoId += 1;
    return `auto-${this.autoId}`;
  }

  applySet(colName: string, id: string, data: DocData, merge: boolean) {
    const col = this.col(colName);
    const base = merge ? { ...(col.get(id) ?? {}) } : {};
    for (const [k, v] of Object.entries(data)) {
      if (isDeleteTransform(v)) delete base[k];
      else base[k] = v;
    }
    col.set(id, base);
  }

  applyUpdate(colName: string, id: string, data: DocData) {
    this.applySet(colName, id, data, true);
  }
}

interface FakeRef {
  __col: string;
  __id: string;
  id: string;
  get: () => Promise<{ exists: boolean; id: string; data: () => DocData | undefined }>;
  update: (data: DocData) => Promise<void>;
  collection: (name: string) => ReturnType<typeof makeCollection>;
}

function makeCollection(store: FakeStore, name: string) {
  return {
    doc: (id?: string) => {
      const docId = id ?? store.nextId();
      const ref: FakeRef = {
        __col: name,
        __id: docId,
        id: docId,
        get: async () => {
          const data = store.col(name).get(docId);
          return { exists: data !== undefined, id: docId, data: () => data };
        },
        update: async (data: DocData) => {
          store.applyUpdate(name, docId, data);
        },
        collection: (sub: string) => makeCollection(store, `${name}/${docId}/${sub}`),
      };
      return ref;
    },
    get: async () => {
      const docs = Array.from(store.col(name).entries()).map(([docId, data]) => ({
        id: docId,
        data: () => data,
      }));
      return { docs, empty: docs.length === 0 };
    },
    where: (field: string, _op: string, value: unknown) => {
      const run = async () => {
        const docs = Array.from(store.col(name).entries())
          .filter(([, data]) => data[field] === value)
          .map(([docId, data]) => ({ id: docId, data: () => data }));
        return { docs, empty: docs.length === 0 };
      };
      return { limit: () => ({ get: run }), get: run };
    },
  };
}

function makeDb(store: FakeStore) {
  const db = {
    __store: store,
    collection: (name: string) => makeCollection(store, name),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (ref: FakeRef, data: DocData, opts?: { merge?: boolean }) => {
          ops.push(() => store.applySet(ref.__col, ref.__id, data, opts?.merge === true));
        },
        update: (ref: FakeRef, data: DocData) => {
          ops.push(() => store.applyUpdate(ref.__col, ref.__id, data));
        },
        delete: (ref: FakeRef) => {
          ops.push(() => store.col(ref.__col).delete(ref.__id));
        },
        commit: async () => {
          ops.forEach((op) => op());
        },
      };
    },
  };
  return db as never;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-21T10:00:00Z');
const founderActor: GovernorActor = { uid: FOUNDER_UID, name: 'Founder', role: 'founder', authorized: true };
const ngsActor: GovernorActor = { uid: 'ngs-1', name: 'NGS', role: 'national_general_secretary', authorized: true };

async function seededDb() {
  const store = new FakeStore();
  const db = makeDb(store);
  await seedGovernors(db, founderActor, {
    founderHolder: { uid: FOUNDER_UID, name: 'The Founder', email: 'founder@example.com' },
  });
  return { store, db };
}

function seatOf(store: FakeStore, key: string): GovernorSeat {
  return store.col('governors').get(key) as unknown as GovernorSeat;
}

async function expectOpError(promise: Promise<unknown>, code: string, httpStatus: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GovernorOpError);
  expect((err as GovernorOpError).code).toBe(code);
  expect((err as GovernorOpError).httpStatus).toBe(httpStatus);
}

function addAccount(store: FakeStore, uid: string, role = 'member') {
  store.col('users').set(uid, { role, displayName: `Holder ${uid}` });
  store.col('roles').set(uid, { role });
}

async function seatFA(db: never, store: FakeStore, key: 'seat_fa_1' | 'seat_fa_2' | 'seat_fa_3', uid: string) {
  addAccount(store, uid);
  // ADAPTER(W-A) fixture: a decided Schedule Consent in consent_requests.
  store.col('consent_requests').set(`consent-${key}`, { status: 'consented' });
  return assignSeat(
    db,
    founderActor,
    key,
    { holderUid: uid, holderName: `Holder ${uid}`, consentRequestId: `consent-${key}`, expectedVersion: 1 },
    NOW,
  );
}

function cooptionVote(store: FakeStore, id: string, seatKey: string, candidateName: string, overrides: DocData = {}) {
  store.col('governance_votes').set(id, {
    kind: 'cooption',
    seatKey,
    candidateName,
    status: 'closed',
    outcome: 'passed',
    seatedCountAtOpen: 1,
    votesFor: 1,
    founderPresent: true,
    ...overrides,
  });
}

const ELECTION = {
  electionDate: '2026-10-21',
  returningOfficerName: 'Returning Officer',
  eligibleVoterCount: 60,
  ballotsCast: 50,
  votesForHolder: 30,
  nominatedByNames: ['Nominator One', 'Nominator Two'],
  candidateConsentRef: 'consent-to-stand-1',
};

// ---------------------------------------------------------------------------
// Seed + Founder seat
// ---------------------------------------------------------------------------

it('seed creates exactly nine seats, founder seated ex officio, ME seats awaiting election, and is idempotent', async () => {
  const { store, db } = await seededDb();
  expect(store.col('governors').size).toBe(9);
  const founder = seatOf(store, 'seat_founder');
  expect(founder.status).toBe('seated');
  expect(founder.holderUid).toBe(FOUNDER_UID);
  expect(founder.appointedBy).toBe('ex_officio');
  expect(founder.termEnd).toBeNull();
  expect(seatOf(store, 'seat_fa_1').status).toBe('vacant');
  expect(seatOf(store, 'seat_me_1').status).toBe('awaiting_election');
  expect(seatOf(store, 'seat_me_1').lastVacancyReason).toBe('awaiting_election');
  const again = await seedGovernors(db, founderActor, {
    founderHolder: { uid: FOUNDER_UID, name: 'The Founder' },
  });
  expect(again.created).toHaveLength(0);
  expect(again.existed).toHaveLength(9);
});

it('history lands in the governors/{seat}/history subcollection', async () => {
  const { store } = await seededDb();
  const hist = store.col('governors/seat_fa_1/history');
  expect(hist.size).toBe(1);
  const event = Array.from(hist.values())[0] as DocData;
  expect(event.eventType).toBe('seeded');
});

it('the Founder seat can never be assigned or vacated', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, founderActor, 'seat_founder', { holderUid: 'x', holderName: 'X', expectedVersion: 1 }, NOW),
    'FOUNDER_SEAT_LOCKED',
    403,
  );
  await expectOpError(
    vacateSeat(db, founderActor, 'seat_founder', { reason: 'resigned', detail: 'n/a', recordRef: 'r', expectedVersion: 1 }, NOW),
    'FOUNDER_SEAT_LOCKED',
    403,
  );
});

// ---------------------------------------------------------------------------
// Founder-Appointed
// ---------------------------------------------------------------------------

it('FA assign by the Founder with a decided Consent seats with NO term and grants governor_founder (case 4)', async () => {
  const { store, db } = await seededDb();
  const view = await seatFA(db, store, 'seat_fa_1', 'user-a');
  expect(view.effectiveStatus).toBe('seated');
  expect(view.termEnd).toBeNull();
  expect(view.termYears).toBeNull();
  expect(view.holderRoleKey).toBe('governor_founder');
  expect(store.col('roles').get('user-a')?.role).toBe('governor_founder');
  expect(store.col('users').get('user-a')?.role).toBe('governor_founder');
  expect(store.col('users').get('user-a')?.previousRole).toBe('member');
});

it('FA assign by a non-Founder is FORBIDDEN (case 26)', async () => {
  const { store, db } = await seededDb();
  store.col('consent_requests').set('c-1', { status: 'consented' });
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_fa_1', { holderUid: null, holderName: 'A', consentRequestId: 'c-1', expectedVersion: 1 }, NOW),
    'FORBIDDEN',
    403,
  );
});

it('FA assign without a consent id is CONSENT_REQUIRED; with an unknown id is CONSENT_NOT_AVAILABLE', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, founderActor, 'seat_fa_1', { holderUid: null, holderName: 'A', expectedVersion: 1 }, NOW),
    'CONSENT_REQUIRED',
    422,
  );
  await expectOpError(
    assignSeat(db, founderActor, 'seat_fa_1', { holderUid: null, holderName: 'A', consentRequestId: 'missing', expectedVersion: 1 }, NOW),
    'CONSENT_NOT_AVAILABLE',
    422,
  );
});

it('FA assign with an undecided consent is CONSENT_INVALID', async () => {
  const { store, db } = await seededDb();
  store.col('consent_requests').set('c-pending', { status: 'pending' });
  await expectOpError(
    assignSeat(db, founderActor, 'seat_fa_1', { holderUid: null, holderName: 'A', consentRequestId: 'c-pending', expectedVersion: 1 }, NOW),
    'CONSENT_INVALID',
    422,
  );
});

// ---------------------------------------------------------------------------
// Co-opted
// ---------------------------------------------------------------------------

it('co-option at bootstrap passes on a 1-of-1 Founder-present vote; stagger gives seat_co_1 one year', async () => {
  const { store, db } = await seededDb();
  cooptionVote(store, 'vote-co1', 'seat_co_1', 'Co-opted One');
  const view = await assignSeat(db, ngsActor, 'seat_co_1', {
    holderUid: null,
    holderName: 'Co-opted One',
    voteRecordId: 'vote-co1',
    expectedVersion: 1,
  }, NOW);
  expect(view.effectiveStatus).toBe('seated');
  expect((view.termEnd as Date).toISOString()).toBe('2027-10-21T00:00:00.000Z');
  expect(view.isInitialStaggerTerm).toBe(true);
  expect(view.holderRoleKey).toBe('governor_coopted');
});

it('co-option needs strict majority of seated-at-open: 2 of 5 fails, 3 of 5 passes (cases 5, 6, 8)', async () => {
  const { store, db } = await seededDb();
  cooptionVote(store, 'vote-co1', 'seat_co_1', 'Lock Seat');
  await assignSeat(db, founderActor, 'seat_co_1', { holderUid: null, holderName: 'Lock Seat', voteRecordId: 'vote-co1', expectedVersion: 1 }, NOW);
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  await seatFA(db, store, 'seat_fa_2', 'user-b');
  await seatFA(db, store, 'seat_fa_3', 'user-c');
  cooptionVote(store, 'vote-co2-weak', 'seat_co_2', 'Voted In', { seatedCountAtOpen: 5, votesFor: 2 });
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_co_2', { holderUid: null, holderName: 'Voted In', voteRecordId: 'vote-co2-weak', expectedVersion: 1 }, NOW),
    'VOTE_INVALID',
    422,
  );
  cooptionVote(store, 'vote-co2', 'seat_co_2', 'Voted In', { seatedCountAtOpen: 5, votesFor: 3 });
  const view = await assignSeat(db, ngsActor, 'seat_co_2', { holderUid: null, holderName: 'Voted In', voteRecordId: 'vote-co2', expectedVersion: 1 }, NOW);
  expect(view.effectiveStatus).toBe('seated');
});

it('co-option without founderPresent and without a waiver is FOUNDER_QUORUM_LOCK (case 7)', async () => {
  const { store, db } = await seededDb();
  cooptionVote(store, 'vote-nolock', 'seat_co_1', 'No Founder', { founderPresent: false });
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_co_1', { holderUid: null, holderName: 'No Founder', voteRecordId: 'vote-nolock', expectedVersion: 1 }, NOW),
    'FOUNDER_QUORUM_LOCK',
    422,
  );
  // A recorded waiver satisfies the lock instead.
  cooptionVote(store, 'vote-waiver', 'seat_co_1', 'Waived In', { founderPresent: false, founderWaiverRef: 'waiver-doc-1' });
  const view = await assignSeat(db, ngsActor, 'seat_co_1', { holderUid: null, holderName: 'Waived In', voteRecordId: 'vote-waiver', expectedVersion: 1 }, NOW);
  expect(view.effectiveStatus).toBe('seated');
});

it('a vote record for a different seat or candidate is VOTE_INVALID', async () => {
  const { store, db } = await seededDb();
  cooptionVote(store, 'vote-x', 'seat_co_1', 'Someone Else');
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_co_2', { holderUid: null, holderName: 'Someone Else', voteRecordId: 'vote-x', expectedVersion: 1 }, NOW),
    'VOTE_INVALID',
    422,
  );
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_co_1', { holderUid: null, holderName: 'Different Person', voteRecordId: 'vote-x', expectedVersion: 1 }, NOW),
    'VOTE_INVALID',
    422,
  );
});

// ---------------------------------------------------------------------------
// Member-Elected
// ---------------------------------------------------------------------------

it('ME assign with a certified result seats; first seating of seat_me_1 carries the 2-year stagger', async () => {
  const { db } = await seededDb();
  const view = await assignSeat(db, ngsActor, 'seat_me_1', {
    holderUid: null,
    holderName: 'Elected One',
    electionResult: { ...ELECTION },
    expectedVersion: 1,
  }, NOW);
  expect(view.effectiveStatus).toBe('seated');
  expect((view.termEnd as Date).toISOString()).toBe('2028-10-21T00:00:00.000Z');
  expect(view.isInitialStaggerTerm).toBe(true);
  expect(view.holderRoleKey).toBe('governor_member');
  expect(view.appointmentRecordRef?.kind).toBe('election_result');
});

it('ME assign rejects ballotsCast above eligibleVoterCount (case 9)', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_me_1', {
      holderUid: null,
      holderName: 'Elected One',
      electionResult: { ...ELECTION, ballotsCast: 61 },
      expectedVersion: 1,
    }, NOW),
    'ELECTION_INVALID',
    422,
  );
});

it('ME assign rejects the Returning Officer as the holder (case 10)', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_me_1', {
      holderUid: null,
      holderName: 'Returning Officer',
      electionResult: { ...ELECTION },
      expectedVersion: 1,
    }, NOW),
    'ELECTION_INVALID',
    422,
  );
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

it('assign rejects a holderUid already seated on another seat (case 11)', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  store.col('consent_requests').set('consent-seat_fa_2', { status: 'consented' });
  await expectOpError(
    assignSeat(db, founderActor, 'seat_fa_2', { holderUid: 'user-a', holderName: 'Holder user-a', consentRequestId: 'consent-seat_fa_2', expectedVersion: 1 }, NOW),
    'ALREADY_SEATED',
    409,
  );
});

it('an external (account-less) Governor seats with holderUid null and no role sync, never an error', async () => {
  const { store, db } = await seededDb();
  store.col('consent_requests').set('consent-ext', { status: 'consented' });
  const usersBefore = store.col('users').size;
  const view = await assignSeat(db, founderActor, 'seat_fa_2', {
    holderUid: null,
    holderName: 'External Governor',
    holderEmail: 'ext@example.com',
    consentRequestId: 'consent-ext',
    expectedVersion: 1,
  }, NOW);
  expect(view.effectiveStatus).toBe('seated');
  expect(view.holderUid).toBeNull();
  expect(view.isExternal).toBe(true);
  expect(store.col('users').size).toBe(usersBefore);
});

it('stale expectedVersion is a VERSION_CONFLICT; an occupied seat is ALREADY_SEATED', async () => {
  const { store, db } = await seededDb();
  await expectOpError(
    assignSeat(db, founderActor, 'seat_fa_1', { holderUid: null, holderName: 'X', consentRequestId: 'c', expectedVersion: 99 }, NOW),
    'VERSION_CONFLICT',
    409,
  );
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  await expectOpError(
    assignSeat(db, founderActor, 'seat_fa_1', { holderUid: null, holderName: 'Second', consentRequestId: 'c', expectedVersion: 2 }, NOW),
    'ALREADY_SEATED',
    409,
  );
});

// ---------------------------------------------------------------------------
// Vacate / remove
// ---------------------------------------------------------------------------

it('vacate restores the prior role, clears previousRole, and preserves the holder snapshot in history (case 14)', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  const view = await vacateSeat(db, ngsActor, 'seat_fa_1', {
    reason: 'resigned',
    detail: 'Resigned by letter dated 2026-10-20',
    recordRef: 'resignation-letter-1',
    expectedVersion: 2,
  }, NOW);
  expect(view.effectiveStatus).toBe('vacant');
  expect(store.col('roles').get('user-a')?.role).toBe('member');
  expect(store.col('users').get('user-a')?.role).toBe('member');
  expect(store.col('users').get('user-a')?.previousRole).toBeUndefined();
  const seat = seatOf(store, 'seat_fa_1');
  expect(seat.lastHolderUid).toBe('user-a');
  expect(seat.lastVacancyReason).toBe('resigned');
  const events = Array.from(store.col('governors/seat_fa_1/history').values()) as DocData[];
  const vacated = events.find((e) => e.eventType === 'vacated');
  expect((vacated?.before as DocData)?.holderName).toBe('Holder user-a');
});

it('a resignation vacate without the record reference is RECORD_REQUIRED', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  await expectOpError(
    vacateSeat(db, ngsActor, 'seat_fa_1', { reason: 'resigned', detail: 'Resigned', expectedVersion: 2 }, NOW),
    'RECORD_REQUIRED',
    422,
  );
});

it('removal of an FA Governor: non-Founder is 403, missing detail is 422, Founder records founder_discretion (case 13)', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  await expectOpError(
    removeSeat(db, ngsActor, 'seat_fa_1', { removal: { causeDetail: 'A sufficiently long detail' }, expectedVersion: 2 }, NOW),
    'FORBIDDEN',
    403,
  );
  await expectOpError(
    removeSeat(db, founderActor, 'seat_fa_1', { removal: { causeDetail: 'short' }, expectedVersion: 2 }, NOW),
    'CAUSE_DETAIL_REQUIRED',
    422,
  );
  const view = await removeSeat(db, founderActor, 'seat_fa_1', {
    removal: { causeDetail: 'Removed at the Founder discretion after review' },
    expectedVersion: 2,
  }, NOW);
  expect(view.effectiveStatus).toBe('vacant');
  const seat = seatOf(store, 'seat_fa_1');
  expect(seat.lastVacancyReason).toBe('removed');
  expect(seat.removalRecord?.cause).toBe('founder_discretion');
  expect(seat.removalRecord?.removedByUid).toBe('user-a');
  expect(store.col('users').get('user-a')?.role).toBe('member');
});

it('removal of a co-opted Governor without a passing removal vote is rejected (case 12)', async () => {
  const { store, db } = await seededDb();
  cooptionVote(store, 'vote-co1', 'seat_co_1', 'Co-opted One');
  await assignSeat(db, founderActor, 'seat_co_1', { holderUid: null, holderName: 'Co-opted One', voteRecordId: 'vote-co1', expectedVersion: 1 }, NOW);
  await expectOpError(
    removeSeat(db, ngsActor, 'seat_co_1', {
      removal: { cause: 'gross_misconduct', noticeDate: '2026-10-14', replyRef: 'no reply by deadline' },
      expectedVersion: 2,
    }, NOW),
    'VOTE_INVALID',
    422,
  );
  store.col('governance_votes').set('vote-removal', {
    kind: 'governor_removal',
    seatKey: 'seat_co_1',
    status: 'closed',
    outcome: 'passed',
    seatedCountAtOpen: 2,
    votesFor: 2,
  });
  const view = await removeSeat(db, ngsActor, 'seat_co_1', {
    removal: {
      cause: 'gross_misconduct',
      causeDetail: 'As minuted',
      noticeDate: '2026-10-14',
      replyRef: 'no reply by deadline',
      voteRecordId: 'vote-removal',
    },
    expectedVersion: 2,
  }, NOW);
  expect(view.effectiveStatus).toBe('vacant');
  expect(seatOf(store, 'seat_co_1').removalRecord?.voteRecordId).toBe('vote-removal');
});

// ---------------------------------------------------------------------------
// Expiry, sweep, register
// ---------------------------------------------------------------------------

it('effectiveStatus: term_expired at now == termEnd, seated at termEnd minus 1ms (case 19); FA seats never expire (case 20)', async () => {
  const { store } = await seededDb();
  const base = seatOf(store, 'seat_co_1');
  const termed: GovernorSeat = {
    ...base,
    status: 'seated',
    holderUid: null,
    holderName: 'Termed',
    termStart: new Date('2023-10-21T00:00:00Z'),
    termEnd: new Date('2026-10-21T00:00:00Z'),
  };
  expect(toSeatView(termed, new Date('2026-10-21T00:00:00Z')).effectiveStatus).toBe('term_expired');
  expect(toSeatView(termed, new Date('2026-10-20T23:59:59.999Z')).effectiveStatus).toBe('seated');
  const fa = seatOf(store, 'seat_fa_1');
  const faView = toSeatView(
    { ...fa, status: 'seated', holderName: 'FA Holder', termEnd: null },
    new Date('2035-01-01T00:00:00Z'),
  );
  expect(faView.effectiveStatus).toBe('seated');
});

it('the term sweep materialises a lapsed seat, restores the role, and stamps expired_sent', async () => {
  const { store, db } = await seededDb();
  cooptionVote(store, 'vote-co1', 'seat_co_1', 'Co-opted One');
  addAccount(store, 'user-co');
  const seated = await assignSeat(db, founderActor, 'seat_co_1', { holderUid: 'user-co', holderName: 'Co-opted One', voteRecordId: 'vote-co1', expectedVersion: 1 }, NOW);
  expect(seated.effectiveStatus).toBe('seated');
  const seat = seatOf(store, 'seat_co_1');
  store.col('governors').set('seat_co_1', { ...seat, termEnd: new Date('2026-10-01T00:00:00Z') });
  const summary = await runGovernorTermSweep(db, NOW);
  expect(summary.expiredMaterialised).toContain('seat_co_1');
  const after = seatOf(store, 'seat_co_1');
  expect(after.status).toBe('vacant');
  expect(after.lastVacancyReason).toBe('term_expired');
  expect(after.termAlertStage).toBe('expired_sent');
  expect(store.col('users').get('user-co')?.role).toBe('member');
});

it('the sweep sends T-30 then T-7 alerts; a seat first seen inside 7 days gets T-7 only (case C.6)', async () => {
  const { store, db } = await seededDb();
  cooptionVote(store, 'vote-co1', 'seat_co_1', 'Co-opted One');
  await assignSeat(db, founderActor, 'seat_co_1', { holderUid: null, holderName: 'Co-opted One', voteRecordId: 'vote-co1', expectedVersion: 1 }, NOW);
  const seat = seatOf(store, 'seat_co_1');
  store.col('governors').set('seat_co_1', { ...seat, termEnd: new Date('2026-11-10T00:00:00Z') }); // 20 days out
  const first = await runGovernorTermSweep(db, NOW);
  expect(first.reminded).toContainEqual({ seatKey: 'seat_co_1', stage: 't30_sent' });
  expect(seatOf(store, 'seat_co_1').termAlertStage).toBe('t30_sent');
  const atT7 = new Date('2026-11-05T10:00:00Z'); // 5 days out
  const second = await runGovernorTermSweep(db, atT7);
  expect(second.reminded).toContainEqual({ seatKey: 'seat_co_1', stage: 't7_sent' });

  // Fresh seat first seen inside the T-7 window: T-7 only, never a late T-30.
  const seat2 = seatOf(store, 'seat_co_2');
  store.col('governors').set('seat_co_2', {
    ...seat2,
    status: 'seated',
    holderName: 'Late Seen',
    holderUid: null,
    termStart: new Date('2026-10-01T00:00:00Z'),
    termEnd: new Date('2026-11-08T00:00:00Z'), // 3 days after atT7
    termAlertStage: 'none',
  });
  const third = await runGovernorTermSweep(db, atT7);
  expect(third.reminded).toContainEqual({ seatKey: 'seat_co_2', stage: 't7_sent' });
  expect(third.reminded.filter((r) => r.seatKey === 'seat_co_2')).toHaveLength(1);
});

it('re-seating after a stagger seed uses a full 3-year term and clears isInitialStaggerTerm (case 18)', async () => {
  const { store, db } = await seededDb();
  cooptionVote(store, 'vote-co1', 'seat_co_1', 'First Holder');
  await assignSeat(db, founderActor, 'seat_co_1', { holderUid: null, holderName: 'First Holder', voteRecordId: 'vote-co1', expectedVersion: 1 }, NOW);
  await vacateSeat(db, ngsActor, 'seat_co_1', { reason: 'resigned', detail: 'Stepping down', recordRef: 'res-1', expectedVersion: 2 }, NOW);
  cooptionVote(store, 'vote-co1-b', 'seat_co_1', 'Second Holder', { seatedCountAtOpen: 1, votesFor: 1 });
  const view = await assignSeat(db, ngsActor, 'seat_co_1', { holderUid: null, holderName: 'Second Holder', voteRecordId: 'vote-co1-b', expectedVersion: 3 }, NOW);
  expect(view.isInitialStaggerTerm).toBe(false);
  expect(view.termYears).toBe(3);
  expect((view.termEnd as Date).toISOString()).toBe('2029-10-21T00:00:00.000Z');
  expect(view.termAlertStage).toBe('none');
});

it('getRegister materialises lapsed seats and reports the summary', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  const register = await getRegister(db, NOW);
  expect(register.summary.seatedCount).toBe(2);
  expect(register.summary.vacantCount).toBe(7);
  const fa1 = register.seats.find((s) => s.seatKey === 'seat_fa_1');
  expect(fa1?.effectiveStatus).toBe('seated');
  expect(fa1?.daysToTermEnd).toBeNull(); // FA seats are termless
});

it('notes over 2000 characters are rejected', async () => {
  const { db } = await seededDb();
  const { updateSeatNotes } = await import('@/lib/server/governors/register');
  await expectOpError(
    updateSeatNotes(db, ngsActor, 'seat_fa_1', 'x'.repeat(2001), 1),
    'NOTES_TOO_LONG',
    422,
  );
});
