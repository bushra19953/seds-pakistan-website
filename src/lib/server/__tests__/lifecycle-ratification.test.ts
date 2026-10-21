/**
 * Tests for lifecycle-ratification.ts (spec D.4-D.7): T5 creation,
 * T6 deeming, T8 refusal close + revocation, T9/T10 denominator basis,
 * T15 as-of reads.
 *
 * Uses a hand-rolled in-memory fake Firestore (same posture as the
 * adapters tests) extended with a synchronous runTransaction so the
 * module's transactional path is exercised, plus the sequential fallback
 * when runTransaction is removed.
 */

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP',
      },
    },
  },
}));

const mockNotificationSend = jest.fn(async () => undefined);
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: (...args: unknown[]) => mockNotificationSend(...(args as [])),
  },
}));

import { FOUNDER_UID } from '@/lib/roles';
import {
  LifecycleError,
  closeRefusalVote,
  createRatificationForAppointment,
  openRefusalVote,
  ratificationStatusAsOf,
  stampDeemedRatifications,
  toMillis,
} from '../lifecycle-ratification';

// --- Fake Firestore --------------------------------------------------------

type DocData = Record<string, unknown>;

class FakeDocSnapshot {
  constructor(
    public id: string,
    private _data: DocData | undefined,
  ) {}
  get exists() {
    return this._data !== undefined;
  }
  data() {
    return this._data;
  }
}

class FakeDocRef {
  constructor(
    private db: FakeDb,
    private collectionName: string,
    public id: string,
  ) {}
  async get() {
    return new FakeDocSnapshot(this.id, this.db.readDoc(this.collectionName, this.id));
  }
  async set(data: DocData, opts?: { merge?: boolean }) {
    this.db.writeDoc(this.collectionName, this.id, data, !!opts?.merge);
    return this;
  }
  async update(data: DocData) {
    this.db.writeDoc(this.collectionName, this.id, data, true);
    return this;
  }
}

class FakeCollectionRef {
  constructor(
    private db: FakeDb,
    private name: string,
  ) {}
  doc(id?: string) {
    return new FakeDocRef(this.db, this.name, id ?? this.db.nextId());
  }
  async add(data: DocData) {
    const ref = this.doc();
    this.db.writeDoc(this.name, ref.id, { ...data }, false);
    return ref;
  }
  where() {
    return this;
  }
  limit() {
    return this;
  }
  async get() {
    const docs = this.db
      .readCollection(this.name)
      .map(([id, data]) => new FakeDocSnapshot(id, data));
    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      forEach: (cb: (d: FakeDocSnapshot) => void) => docs.forEach(cb),
    };
  }
}

class FakeDb {
  private store = new Map<string, Map<string, DocData>>();
  private counter = 0;
  withTransactions = true;

  nextId() {
    this.counter += 1;
    return `auto-${this.counter}`;
  }
  collection(name: string) {
    return new FakeCollectionRef(this, name);
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    if (!this.withTransactions) throw new Error('transactions disabled');
    const tx = {
      get: (ref: FakeDocRef) => ref.get(),
      set: (ref: FakeDocRef, data: DocData) => {
        void ref.set(data);
      },
      update: (ref: FakeDocRef, data: DocData) => {
        void ref.update(data);
      },
    };
    return fn(tx);
  }
  seed(collectionName: string, id: string, data: DocData) {
    this.writeDoc(collectionName, id, data, false);
  }
  readDoc(collectionName: string, id: string): DocData | undefined {
    return this.store.get(collectionName)?.get(id);
  }
  readCollection(collectionName: string): Array<[string, DocData]> {
    return Array.from(this.store.get(collectionName)?.entries() ?? []);
  }
  writeDoc(collectionName: string, id: string, data: DocData, merge: boolean) {
    if (!this.store.has(collectionName)) this.store.set(collectionName, new Map());
    const col = this.store.get(collectionName)!;
    col.set(id, merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
  }
}

// --- Fixtures ---------------------------------------------------------------

const APPOINTED_AT = new Date('2026-10-01T09:00:00.000Z');
const DEADLINE = new Date(APPOINTED_AT.getTime() + 30 * 24 * 60 * 60 * 1000);

function seedPendingRatification(db: FakeDb, overrides: DocData = {}) {
  db.seed('ratifications', 'rat_appt-1', {
    id: 'rat_appt-1',
    appointmentId: 'appt-1',
    userId: 'officer-1',
    roleKey: 'national_treasurer',
    chapterSlug: null,
    appointedBy: FOUNDER_UID,
    appointedAt: APPOINTED_AT,
    ratificationDeadline: DEADLINE,
    status: 'pending',
    decidedAt: null,
    voteId: null,
    refusalVotesFor: null,
    refusalVotesAgainst: null,
    eligibleElectors: null,
    requiredRefusals: null,
    thresholdMet: null,
    revocationAuditId: null,
    revokedAt: null,
    createdBy: 'applyRoleChange',
    ...overrides,
  });
}

function seedSeatedGovernors(db: FakeDb, count: number) {
  for (let i = 1; i <= count; i += 1) {
    db.seed('governors', `seat-${i}`, { uid: `gov-${i}`, seatKey: `seat-${i}`, roleKey: 'governor_founder' });
  }
}

beforeEach(() => {
  mockNotificationSend.mockClear();
});

// --- T5 ---------------------------------------------------------------------

describe('T5 ratification creation', () => {
  it('founder-appointed Category B creates exactly one doc, deadline = appointedAt + 30d stored; retry does not duplicate', async () => {
    const db = new FakeDb();
    const params = {
      appointmentId: 'appt-1',
      userId: 'officer-1',
      roleKey: 'national_treasurer',
      appointedByUid: FOUNDER_UID,
      appointedAt: APPOINTED_AT,
      viaBoardVote: false,
    };
    const id1 = await createRatificationForAppointment(db, params);
    const id2 = await createRatificationForAppointment(db, params);
    expect(id1).toBe('rat_appt-1');
    expect(id2).toBe('rat_appt-1');
    const docs = db.readCollection('ratifications');
    expect(docs).toHaveLength(1);
    const data = docs[0][1];
    expect(data.status).toBe('pending');
    expect(toMillis(data.ratificationDeadline)).toBe(DEADLINE.getTime());
  });

  it('Board-appointed Category B creates none; Category C creates none', async () => {
    const db = new FakeDb();
    await expect(
      createRatificationForAppointment(db, {
        appointmentId: 'a2',
        userId: 'officer-2',
        roleKey: 'national_treasurer',
        appointedByUid: FOUNDER_UID,
        appointedAt: APPOINTED_AT,
        viaBoardVote: true,
      }),
    ).resolves.toBeNull();
    await expect(
      createRatificationForAppointment(db, {
        appointmentId: 'a3',
        userId: 'officer-3',
        roleKey: 'chapter_treasurer',
        appointedByUid: FOUNDER_UID,
        appointedAt: APPOINTED_AT,
        viaBoardVote: false,
      }),
    ).resolves.toBeNull();
    expect(db.readCollection('ratifications')).toHaveLength(0);
  });
});

// --- T6 ---------------------------------------------------------------------

describe('T6 deeming', () => {
  it('at deadline - 1s leaves pending; at deadline stamps deemed_ratified with decidedAt == deadline exactly; rerun is a no-op', async () => {
    const db = new FakeDb();
    seedPendingRatification(db);
    const before = await stampDeemedRatifications(db, new Date(DEADLINE.getTime() - 1000));
    expect(before.stamped).toBe(0);
    expect(db.readDoc('ratifications', 'rat_appt-1')!.status).toBe('pending');

    const at = await stampDeemedRatifications(db, DEADLINE);
    expect(at.stamped).toBe(1);
    const doc = db.readDoc('ratifications', 'rat_appt-1')!;
    expect(doc.status).toBe('deemed_ratified');
    expect(toMillis(doc.decidedAt)).toBe(DEADLINE.getTime());

    const rerun = await stampDeemedRatifications(db, new Date(DEADLINE.getTime() + 86400000));
    expect(rerun.stamped).toBe(0);
    expect(toMillis(db.readDoc('ratifications', 'rat_appt-1')!.decidedAt)).toBe(DEADLINE.getTime());
  });

  it('an open unclosed vote at the deadline still deems', async () => {
    const db = new FakeDb();
    seedPendingRatification(db, { voteId: 'vote-open' });
    const res = await stampDeemedRatifications(db, DEADLINE);
    expect(res.stamped).toBe(1);
    expect(db.readDoc('ratifications', 'rat_appt-1')!.status).toBe('deemed_ratified');
  });
});

// --- D.5 open + T9/T10 basis -------------------------------------------------

describe('D.5 refusal vote opening and the denominator basis (T9/T10)', () => {
  it('freezes the seated snapshot: 5 seated -> eligibleElectors 5, required 4', async () => {
    const db = new FakeDb();
    seedPendingRatification(db);
    seedSeatedGovernors(db, 5);
    const voteId = await openRefusalVote(db, 'rat_appt-1', {
      actorUid: FOUNDER_UID,
      actorRoleKeys: [],
      canManageRoles: false,
      mode: 'recorded',
      appointeeName: 'Officer One',
      roleLabel: 'National Treasurer',
      now: APPOINTED_AT,
    });
    const rat = db.readDoc('ratifications', 'rat_appt-1')!;
    expect(rat.voteId).toBe(voteId);
    expect(rat.eligibleElectors).toBe(5);
    expect(rat.requiredRefusals).toBe(4);
    expect(rat.eligibleElectorUids).toHaveLength(5);
    const vote = db.readDoc('governance_votes', voteId)!;
    expect(vote.kind).toBe('ratification_refusal');
    expect(vote.question).toBe('That the appointment of Officer One as National Treasurer be refused.');
  });

  it('statutory_nine basis: eligibleElectors 9, required 6, snapshot still the seated UIDs', async () => {
    const db = new FakeDb();
    seedPendingRatification(db);
    seedSeatedGovernors(db, 5);
    await openRefusalVote(db, 'rat_appt-1', {
      actorUid: FOUNDER_UID,
      actorRoleKeys: [],
      canManageRoles: false,
      mode: 'offline_attested',
      appointeeName: 'Officer One',
      roleLabel: 'National Treasurer',
      basis: 'statutory_nine',
      now: APPOINTED_AT,
    });
    const rat = db.readDoc('ratifications', 'rat_appt-1')!;
    expect(rat.eligibleElectors).toBe(9);
    expect(rat.requiredRefusals).toBe(6);
    expect(rat.eligibleElectorUids).toHaveLength(5);
  });

  it('the appointee may not open their own refusal vote; a late open is WINDOW_CLOSED', async () => {
    const db = new FakeDb();
    seedPendingRatification(db);
    await expect(
      openRefusalVote(db, 'rat_appt-1', {
        actorUid: 'officer-1',
        actorRoleKeys: ['national_general_secretary'],
        canManageRoles: false,
        mode: 'recorded',
        appointeeName: 'Officer One',
        roleLabel: 'National Treasurer',
        now: APPOINTED_AT,
      }),
    ).rejects.toMatchObject({ code: 'APPOINTEE_FORBIDDEN' });
    await expect(
      openRefusalVote(db, 'rat_appt-1', {
        actorUid: FOUNDER_UID,
        actorRoleKeys: [],
        canManageRoles: false,
        mode: 'recorded',
        appointeeName: 'Officer One',
        roleLabel: 'National Treasurer',
        now: DEADLINE,
      }),
    ).rejects.toMatchObject({ code: 'WINDOW_CLOSED' });
  });
});

// --- T8 ---------------------------------------------------------------------

function seedClosable(db: FakeDb, tallies: { for: number; against: number }, closedAt: Date) {
  seedPendingRatification(db, {
    voteId: 'vote-1',
    eligibleElectors: 9,
    requiredRefusals: 6,
    eligibleElectorUids: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'],
  });
  db.seed('governance_votes', 'vote-1', {
    kind: 'ratification_refusal',
    status: 'closed',
    closedAt,
    tallies,
  });
  db.seed('roles', 'officer-1', { role: 'national_treasurer', roleKey: 'national_treasurer' });
  db.seed('users', 'officer-1', { role: 'national_treasurer' });
}

const CLOSED_AT = new Date('2026-10-20T10:00:00.000Z');
const CLOSER = { actorUid: FOUNDER_UID, actorRoleKeys: [] as string[], canManageRoles: false };

describe('T8 refusal close', () => {
  it('votes at required yield refused AND revocation in the same step (armed): role + mirror changed, revokedAt set', async () => {
    const db = new FakeDb();
    db.seed('governance_settings', 'phase2', { ratificationRevocationArmed: true });
    seedClosable(db, { for: 6, against: 3 }, CLOSED_AT);
    const result = await closeRefusalVote(db, 'rat_appt-1', CLOSER);
    expect(result.status).toBe('refused');
    expect(result.revokedRole).toBe(true);
    const rat = db.readDoc('ratifications', 'rat_appt-1')!;
    expect(rat.status).toBe('refused');
    expect(toMillis(rat.decidedAt)).toBe(CLOSED_AT.getTime());
    expect(toMillis(rat.revokedAt)).toBe(CLOSED_AT.getTime());
    expect(db.readDoc('roles', 'officer-1')!.role).toBe('member_basic');
    expect(db.readDoc('users', 'officer-1')!.role).toBe('member_basic');
    // A second close attempt is refused.
    await expect(closeRefusalVote(db, 'rat_appt-1', CLOSER)).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });
  });

  it('votes at required - 1 yield ratified and no revocation', async () => {
    const db = new FakeDb();
    db.seed('governance_settings', 'phase2', { ratificationRevocationArmed: true });
    seedClosable(db, { for: 5, against: 4 }, CLOSED_AT);
    const result = await closeRefusalVote(db, 'rat_appt-1', CLOSER);
    expect(result.status).toBe('ratified');
    expect(result.revokedRole).toBe(false);
    expect(db.readDoc('ratifications', 'rat_appt-1')!.status).toBe('ratified');
    expect(db.readDoc('roles', 'officer-1')!.role).toBe('national_treasurer');
  });

  it('refusal where the appointee already moved roles leaves the current role untouched and stamps role_no_longer_held', async () => {
    const db = new FakeDb();
    db.seed('governance_settings', 'phase2', { ratificationRevocationArmed: true });
    seedClosable(db, { for: 7, against: 2 }, CLOSED_AT);
    db.seed('roles', 'officer-1', { role: 'chapter_president', roleKey: 'chapter_president' });
    const result = await closeRefusalVote(db, 'rat_appt-1', CLOSER);
    expect(result.status).toBe('refused');
    expect(result.revokedRole).toBe(false);
    expect(result.revocationSkippedReason).toBe('role_no_longer_held');
    expect(db.readDoc('roles', 'officer-1')!.role).toBe('chapter_president');
    expect(db.readDoc('ratifications', 'rat_appt-1')!.revokedAt).toBeNull();
  });

  it('record-only posture (revocation not armed, the ship default): tallies recorded, nobody demoted', async () => {
    const db = new FakeDb();
    seedClosable(db, { for: 8, against: 1 }, CLOSED_AT);
    const result = await closeRefusalVote(db, 'rat_appt-1', CLOSER);
    expect(result.status).toBe('refused');
    expect(result.revocationArmed).toBe(false);
    expect(result.revokedRole).toBe(false);
    expect(result.revocationSkippedReason).toBe('revocation_not_armed');
    const rat = db.readDoc('ratifications', 'rat_appt-1')!;
    expect(rat.refusalVotesFor).toBe(8);
    expect(db.readDoc('roles', 'officer-1')!.role).toBe('national_treasurer');
  });

  it('works through the sequential fallback when runTransaction is unavailable', async () => {
    const db = new FakeDb();
    db.withTransactions = false;
    // Force the fallback path: withLifecycleStore checks typeof runTransaction.
    (db as unknown as Record<string, unknown>).runTransaction = undefined;
    db.seed('governance_settings', 'phase2', { ratificationRevocationArmed: true });
    seedClosable(db, { for: 6, against: 3 }, CLOSED_AT);
    const result = await closeRefusalVote(db, 'rat_appt-1', CLOSER);
    expect(result.status).toBe('refused');
    expect(result.revokedRole).toBe(true);
  });

  it('close errors are LifecycleError instances with stable codes', async () => {
    const db = new FakeDb();
    seedPendingRatification(db);
    await expect(closeRefusalVote(db, 'rat_appt-1', CLOSER)).rejects.toBeInstanceOf(LifecycleError);
    await expect(closeRefusalVote(db, 'rat_appt-1', CLOSER)).rejects.toMatchObject({
      code: 'NO_VOTE_OPEN',
    });
  });
});

// --- T15 --------------------------------------------------------------------

describe('T15 as-of reads', () => {
  it('a refusal closed after t does not appear at t', () => {
    const doc = { status: 'refused', decidedAt: CLOSED_AT };
    expect(ratificationStatusAsOf(doc, new Date(CLOSED_AT.getTime() - 1))).toBe('pending');
    expect(ratificationStatusAsOf(doc, CLOSED_AT)).toBe('refused');
    expect(ratificationStatusAsOf({ status: 'pending', decidedAt: null }, CLOSED_AT)).toBe('pending');
  });
});
