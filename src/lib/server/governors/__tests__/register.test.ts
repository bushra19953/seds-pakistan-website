/**
 * @jest-environment node
 *
 * Board of Governors register tests (spec C.7 cases 1-21) against a fake
 * Firestore. The audit writer and notification service are mocked; all
 * register logic is real.
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
// Fake Firestore
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
  get: () => Promise<{ exists: boolean; id: string; data: () => DocData | undefined }>;
  update: (data: DocData) => Promise<void>;
}

function makeDb(store: FakeStore) {
  const db = {
    __store: store,
    collection: (name: string) => ({
      doc: (id?: string) => {
        const docId = id ?? store.nextId();
        const ref: FakeRef = {
          __col: name,
          __id: docId,
          get: async () => {
            const data = store.col(name).get(docId);
            return { exists: data !== undefined, id: docId, data: () => data };
          },
          update: async (data: DocData) => {
            store.applyUpdate(name, docId, data);
          },
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
    }),
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
  return store.col('governors').get(key) as GovernorSeat;
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

async function seatFA(db: never, store: FakeStore, key: 'seat_fa_1' | 'seat_fa_2' | 'seat_fa_3', uid: string) {
  // Give the holder an account with a prior role to prove role stashing.
  store.col('users').set(uid, { role: 'member', displayName: `Holder ${uid}` });
  store.col('roles').set(uid, { role: 'member' });
  return assignSeat(
    db,
    founderActor,
    key,
    { holderUid: uid, holderName: `Holder ${uid}`, consentRequestId: `consent-${key}`, expectedVersion: 1 },
    NOW,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it('seed creates exactly nine seats, founder seated, others vacant, and is idempotent', async () => {
  const { store, db } = await seededDb();
  expect(store.col('governors').size).toBe(9);
  expect(seatOf(store, 'seat_founder').status).toBe('seated');
  expect(seatOf(store, 'seat_founder').holderUid).toBe(FOUNDER_UID);
  expect(seatOf(store, 'seat_fa_1').status).toBe('vacant');
  const again = await seedGovernors(db, founderActor, {
    founderHolder: { uid: FOUNDER_UID, name: 'The Founder' },
  });
  expect(again.created).toHaveLength(0);
  expect(again.existed).toHaveLength(9);
});

it('FA assign by the Founder with consent seats, stashes prior role, grants governor role in both stores', async () => {
  const { store, db } = await seededDb();
  const view = await seatFA(db, store, 'seat_fa_1', 'user-a');
  expect(view.status).toBe('seated');
  const expiry = view.termExpiresAt as Date;
  expect(expiry.toISOString()).toBe('2029-10-21T00:00:00.000Z');
  expect(store.col('roles').get('user-a')?.role).toBe('governor_seat_fa_1');
  expect(store.col('users').get('user-a')?.role).toBe('governor_seat_fa_1');
  expect(store.col('users').get('user-a')?.previousRole).toBe('member');
});

it('FA assign by a non-Founder is FORBIDDEN', async () => {
  const { store, db } = await seededDb();
  store.col('users').set('user-a', { role: 'member' });
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_fa_1', {
      holderUid: 'user-a',
      holderName: 'A',
      consentRequestId: 'c-1',
      expectedVersion: 1,
    }, NOW),
    'FORBIDDEN',
    403,
  );
});

it('FA assign without the consent reference is CONSENT_REQUIRED', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, founderActor, 'seat_fa_1', {
      holderUid: null,
      holderName: 'External Person',
      expectedVersion: 1,
    }, NOW),
    'CONSENT_REQUIRED',
    422,
  );
});

it('co-option under the Founder Quorum Lock seats with only the Founder seated', async () => {
  const { store, db } = await seededDb();
  const view = await assignSeat(db, founderActor, 'seat_co_1', {
    holderUid: null,
    holderName: 'Co-opted One',
    founderQuorumLock: true,
    expectedVersion: 1,
  }, NOW);
  expect(view.status).toBe('seated');
  expect(String(view.appointmentBasis)).toContain('Quorum Lock');
  // Stagger: first seating of seat_co_1 runs one year.
  expect((view.termExpiresAt as Date).toISOString()).toBe('2027-10-21T00:00:00.000Z');
  expect(store.col('governors').get('seat_co_1')?.holderName).toBe('Co-opted One');
});

it('co-option under the Lock by a non-Founder is FOUNDER_QUORUM_LOCK', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_co_1', {
      holderUid: null,
      holderName: 'Nope',
      founderQuorumLock: true,
      expectedVersion: 1,
    }, NOW),
    'FOUNDER_QUORUM_LOCK',
    422,
  );
});

it('co-option by vote needs strict majority of seated-at-open (3 of 5)', async () => {
  const { store, db } = await seededDb();
  // The Quorum Lock only exists while the Founder is the ONLY seated
  // Governor, so seat_co_1 goes in first, then the three FA seats.
  await assignSeat(db, founderActor, 'seat_co_1', {
    holderUid: null,
    holderName: 'Lock Seat',
    founderQuorumLock: true,
    expectedVersion: 1,
  }, NOW);
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  await seatFA(db, store, 'seat_fa_2', 'user-b');
  await seatFA(db, store, 'seat_fa_3', 'user-c');
  // Five seated now (founder + 3 FA + co_1). A 2-vote record fails...
  store.col('board_votes').set('vote-1', { kind: 'cooption', subjectId: 'seat_co_2', votesFor: 2 });
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_co_2', {
      holderUid: null,
      holderName: 'Voted In',
      voteRecordId: 'vote-1',
      expectedVersion: 1,
    }, NOW),
    'VOTE_INVALID',
    422,
  );
  // ...a 3-vote record passes.
  store.col('board_votes').set('vote-2', { kind: 'cooption', subjectId: 'seat_co_2', votesFor: 3 });
  const view = await assignSeat(db, ngsActor, 'seat_co_2', {
    holderUid: null,
    holderName: 'Voted In',
    voteRecordId: 'vote-2',
    expectedVersion: 1,
  }, NOW);
  expect(view.status).toBe('seated');
});

it('a vote record for a different seat is VOTE_INVALID', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  store.col('board_votes').set('vote-x', { kind: 'cooption', subjectId: 'seat_co_1', votesFor: 9 });
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_co_2', {
      holderUid: null,
      holderName: 'Wrong Seat',
      voteRecordId: 'vote-x',
      expectedVersion: 1,
    }, NOW),
    'VOTE_INVALID',
    422,
  );
});

it('Member-Elected assign with a certified result seats with a meeting-based term', async () => {
  const { db } = await seededDb();
  const view = await assignSeat(db, ngsActor, 'seat_me_1', {
    holderUid: null,
    holderName: 'Elected One',
    electionMeetingDate: '2026-10-21',
    electionVotesFor: 30,
    electionVotesCast: 50,
    electionQuorumMet: true,
    expectedVersion: 1,
  }, NOW);
  expect(view.status).toBe('seated');
  expect((view.termExpiresAt as Date).toISOString()).toBe('2029-10-21T00:00:00.000Z');
});

it('Member-Elected assign with exactly half the votes is ELECTION_INVALID (strict majority)', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_me_1', {
      holderUid: null,
      holderName: 'Half',
      electionMeetingDate: '2026-10-21',
      electionVotesFor: 25,
      electionVotesCast: 50,
      electionQuorumMet: true,
      expectedVersion: 1,
    }, NOW),
    'ELECTION_INVALID',
    422,
  );
});

it('Member-Elected assign with a past meeting date is ELECTION_INVALID', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, ngsActor, 'seat_me_1', {
      holderUid: null,
      holderName: 'Stale',
      electionMeetingDate: '2026-10-01',
      electionVotesFor: 30,
      electionVotesCast: 50,
      electionQuorumMet: true,
      expectedVersion: 1,
    }, NOW),
    'ELECTION_INVALID',
    422,
  );
});

it('an external (account-less) Governor seats with holderUid null and no role sync, never an error', async () => {
  const { store, db } = await seededDb();
  const usersBefore = store.col('users').size;
  const view = await assignSeat(db, founderActor, 'seat_fa_2', {
    holderUid: null,
    holderName: 'External Governor',
    holderExternalId: 'passport-on-file',
    consentRequestId: 'consent-ext',
    expectedVersion: 1,
  }, NOW);
  expect(view.status).toBe('seated');
  expect(view.holderUid).toBeNull();
  expect(store.col('users').size).toBe(usersBefore);
});

it('the Founder seat can never be assigned or vacated', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, founderActor, 'seat_founder', {
      holderUid: 'someone',
      holderName: 'X',
      expectedVersion: 1,
    }, NOW),
    'FOUNDER_SEAT_LOCKED',
    403,
  );
  await expectOpError(
    vacateSeat(db, founderActor, 'seat_founder', { reason: 'resigned', expectedVersion: 1 }, NOW),
    'FOUNDER_SEAT_LOCKED',
    403,
  );
});

it('vacate restores the prior role in both stores and clears previousRole', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  const view = await vacateSeat(db, ngsActor, 'seat_fa_1', {
    reason: 'resigned',
    expectedVersion: 2,
  }, NOW);
  expect(view.status).toBe('vacant');
  expect(store.col('roles').get('user-a')?.role).toBe('member');
  expect(store.col('users').get('user-a')?.role).toBe('member');
  expect(store.col('users').get('user-a')?.previousRole).toBeUndefined();
  expect(seatOf(store, 'seat_fa_1').lastHolderUid).toBe('user-a');
});

it('removal is Founder-only, needs a real note, and records removalRecord + lastHolder', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  await expectOpError(
    removeSeat(db, ngsActor, 'seat_fa_1', { note: 'Board vote 2026-10-20 ref', expectedVersion: 2 }, NOW),
    'FORBIDDEN',
    403,
  );
  await expectOpError(
    removeSeat(db, founderActor, 'seat_fa_1', { note: 'short', expectedVersion: 2 }, NOW),
    'VOTE_INVALID',
    422,
  );
  const view = await removeSeat(db, founderActor, 'seat_fa_1', {
    note: 'Removed by Board vote, record BV-2026-004',
    expectedVersion: 2,
  }, NOW);
  expect(view.status).toBe('vacant');
  const seat = seatOf(store, 'seat_fa_1');
  expect(seat.lastHolderUid).toBe('user-a');
  expect(seat.removalRecord?.reason).toBe('removed');
});

it('stale expectedVersion is a VERSION_CONFLICT', async () => {
  const { db } = await seededDb();
  await expectOpError(
    assignSeat(db, founderActor, 'seat_fa_1', {
      holderUid: null,
      holderName: 'X',
      consentRequestId: 'c',
      expectedVersion: 99,
    }, NOW),
    'VERSION_CONFLICT',
    409,
  );
});

it('assigning an occupied seat is ALREADY_SEATED', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  await expectOpError(
    assignSeat(db, founderActor, 'seat_fa_1', {
      holderUid: null,
      holderName: 'Second',
      consentRequestId: 'c',
      expectedVersion: 2,
    }, NOW),
    'ALREADY_SEATED',
    409,
  );
});

it('effectiveStatus derives term_expired at read time; the Founder seat never expires', async () => {
  const { store, db } = await seededDb();
  const seat = seatOf(store, 'seat_fa_1');
  const lapsed: GovernorSeat = {
    ...seat,
    status: 'seated',
    holderUid: 'user-z',
    holderName: 'Lapsed',
    seatedAt: new Date('2023-01-01T00:00:00Z'),
    termExpiresAt: new Date('2026-10-20T00:00:00Z'),
  };
  const view = toSeatView(lapsed, NOW);
  expect(view.status).toBe('vacant');
  expect(view.storedStatus).toBe('term_expired');
  const founderSeat = seatOf(store, 'seat_founder');
  const founderView = toSeatView(
    { ...founderSeat, termExpiresAt: new Date('2020-01-01T00:00:00Z') },
    NOW,
  );
  expect(founderView.status).toBe('seated');
  void db;
});

it('the term sweep materialises a lapsed seat and restores the holder role', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  // Force the term into the past.
  const seat = seatOf(store, 'seat_fa_1');
  store.col('governors').set('seat_fa_1', {
    ...seat,
    termExpiresAt: new Date('2026-10-01T00:00:00Z'),
  });
  const summary = await runGovernorTermSweep(db, NOW);
  expect(summary.expiredMaterialised).toContain('seat_fa_1');
  const after = seatOf(store, 'seat_fa_1');
  expect(after.status).toBe('vacant');
  expect(after.vacateRecord?.reason).toBe('term_expired');
  expect(store.col('users').get('user-a')?.role).toBe('member');
});

it('the term sweep sends the T-90 reminder once and advances the stage', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  const seat = seatOf(store, 'seat_fa_1');
  store.col('governors').set('seat_fa_1', {
    ...seat,
    termExpiresAt: new Date('2026-12-20T00:00:00Z'), // 60 days out
  });
  const summary = await runGovernorTermSweep(db, NOW);
  expect(summary.reminded).toContainEqual({ seatKey: 'seat_fa_1', stage: 1 });
  expect(seatOf(store, 'seat_fa_1').termAlertStage).toBe(1);
  const again = await runGovernorTermSweep(db, NOW);
  expect(again.reminded).toHaveLength(0);
});

it('getRegister materialises lapsed seats before reporting (admins see stored truth)', async () => {
  const { store, db } = await seededDb();
  await seatFA(db, store, 'seat_fa_1', 'user-a');
  const seat = seatOf(store, 'seat_fa_1');
  store.col('governors').set('seat_fa_1', {
    ...seat,
    termExpiresAt: new Date('2026-10-01T00:00:00Z'),
  });
  const register = await getRegister(db, NOW);
  const fa1 = register.seats.find((s) => s.seatKey === 'seat_fa_1');
  expect(fa1?.status).toBe('vacant');
  expect(register.stats.seated).toBe(1); // founder only
});
