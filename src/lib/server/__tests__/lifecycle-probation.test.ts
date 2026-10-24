/**
 * T13 (spec D.9/D.10): probation restore.
 *
 * - demotion capture stores the pre-warning role SERVER-SIDE (a
 *   client-supplied role is ignored and audit-logged);
 * - expiry in auto mode restores roles + mirror and never touches
 *   warningCount;
 * - seat taken meanwhile -> converts to a re-appointment task, no
 *   overwrite; target banned -> escalated, no restore, no task;
 * - reappoint mode at expiry writes NO role change and tasks the catalog
 *   appointer;
 * - a role no longer in the catalog -> task to the Membership Director;
 * - processing is idempotent; the retry stanza and the legacy backfill
 *   behave per D.10.
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

import {
  backfillLegacyProbationRestores,
  captureProbationRestore,
  processProbationRestore,
  retryProbationRestores,
} from '../lifecycle-probation';

// --- Fake Firestore (same posture as the other lifecycle suites) -----------

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
  async delete() {
    this.db.deleteDoc(this.collectionName, this.id);
    return this;
  }
}

// WriteBatch double (same posture as the shared FakeFirestore helper):
// ops queue as thunks over the doc refs and apply in order on commit.
// Needed since the E6 conversion routed the auto-restore through
// role-writes' assignRole, which composes its writes in one batch.
class FakeBatch {
  private ops: Array<() => Promise<unknown>> = [];
  set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) {
    this.ops.push(() => ref.set(data, opts));
    return this;
  }
  update(ref: FakeDocRef, data: DocData) {
    this.ops.push(() => ref.update(data));
    return this;
  }
  delete(ref: FakeDocRef) {
    this.ops.push(() => ref.delete());
    return this;
  }
  async commit() {
    for (const op of this.ops) await op();
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
  nextId() {
    this.counter += 1;
    return `auto-${this.counter}`;
  }
  collection(name: string) {
    return new FakeCollectionRef(this, name);
  }
  deleteDoc(collectionName: string, id: string) {
    this.store.get(collectionName)?.delete(id);
  }
  batch() {
    return new FakeBatch();
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

const PAST = new Date('2026-10-10T00:00:00.000Z');
const FUTURE = new Date('2027-01-01T00:00:00.000Z');
const NOW = new Date('2026-10-20T00:00:00.000Z');

function seedRestoreDoc(db: FakeDb, id: string, overrides: DocData = {}) {
  db.seed('probation_restores', id, {
    id,
    warningId: id,
    userId: 'u-x',
    preWarningRoleKey: 'national_treasurer',
    preWarningChapterSlug: null,
    demotedToRoleKey: 'member_basic',
    probationEndsAt: PAST,
    status: 'pending',
    restoreMode: 'auto',
    ...overrides,
  });
}

beforeEach(() => {
  mockNotificationSend.mockClear();
});

describe('T13 capture', () => {
  it('captures the pre-warning role server-side; a client-supplied role is ignored and audit-logged', async () => {
    const db = new FakeDb();
    db.seed('roles', 'u1', { role: 'chapter_treasurer', chapterSlug: 'ist' });
    await captureProbationRestore(db, {
      warningId: 'w1',
      userId: 'u1',
      demotedToRoleKey: 'member_basic',
      probationEndsAt: FUTURE,
      clientSuppliedRoleKey: 'president_national',
    });
    const doc = db.readDoc('probation_restores', 'w1')!;
    expect(doc.preWarningRoleKey).toBe('chapter_treasurer');
    expect(doc.preWarningChapterSlug).toBe('ist');
    expect(doc.restoreMode).toBe('reappoint'); // ship default snapshot
    expect(doc.status).toBe('pending');
    const audits = db.readCollection('audit_logs').map(([, d]) => d);
    expect(
      audits.some(
        (a) =>
          a.action === 'probation_restore_client_role_ignored' &&
          a.clientSuppliedRoleKey === 'president_national' &&
          a.serverCapturedRoleKey === 'chapter_treasurer',
      ),
    ).toBe(true);
  });
});

describe('T13 expiry processing', () => {
  it('auto mode restores roles + mirror and does NOT touch warningCount', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w2', { userId: 'u2' });
    // Full Member under the canonical derivation (GOV-03): the subject's
    // primary role is `member`; no stored membershipClass is read.
    db.seed('users', 'u2', { role: 'member', warningCount: 1 });
    db.seed('roles', 'u2', { role: 'member' });
    const r = await processProbationRestore(db, 'w2', NOW);
    expect(r.status).toBe('restored_automatic');
    expect(db.readDoc('roles', 'u2')!.role).toBe('national_treasurer');
    expect(db.readDoc('users', 'u2')!.role).toBe('national_treasurer');
    expect(db.readDoc('users', 'u2')!.warningCount).toBe(1);
    // Idempotent: a second run changes nothing.
    const again = await processProbationRestore(db, 'w2', NOW);
    expect(again.acted).toBe(false);
  });

  it('seat taken meanwhile converts to a task for the appointer, no overwrite', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w3', {
      userId: 'u3',
      preWarningRoleKey: 'chapter_treasurer',
      preWarningChapterSlug: 'ist',
    });
    db.seed('users', 'u3', { role: 'member_basic' });
    db.seed('roles', 'u3', { role: 'member_basic', chapterSlug: 'ist' });
    db.seed('roles', 'other-1', { role: 'chapter_treasurer', chapterSlug: 'ist' });
    db.seed('roles', 'cp-1', { role: 'chapter_president', chapterSlug: 'ist' });
    const r = await processProbationRestore(db, 'w3', NOW);
    expect(r.status).toBe('reappointment_tasked');
    expect(r.fellBackToReappointReason).toBe('seat_occupied');
    expect(db.readDoc('roles', 'u3')!.role).toBe('member_basic');
    const tasks = db.readCollection('tasks').map(([, d]) => d);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigneeIds).toEqual(['cp-1']);
  });

  it('banned target: no restore, no task, escalated with target_banned', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w4', { userId: 'u4' });
    db.seed('users', 'u4', { role: 'member_basic', isBanned: true });
    db.seed('roles', 'u4', { role: 'member_basic' });
    const r = await processProbationRestore(db, 'w4', NOW);
    expect(r.status).toBe('escalated');
    expect(r.escalationReason).toBe('target_banned');
    expect(db.readDoc('roles', 'u4')!.role).toBe('member_basic');
    expect(db.readCollection('tasks')).toHaveLength(0);
  });

  it('reappoint mode writes NO role change and tasks the catalog appointer', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w5', {
      userId: 'u5',
      preWarningRoleKey: 'chapter_treasurer',
      preWarningChapterSlug: 'ist',
      restoreMode: 'reappoint',
    });
    db.seed('users', 'u5', { role: 'member_basic', name: 'Test User' });
    db.seed('roles', 'u5', { role: 'member_basic', chapterSlug: 'ist' });
    db.seed('roles', 'cp-1', { role: 'chapter_president', chapterSlug: 'ist' });
    const r = await processProbationRestore(db, 'w5', NOW);
    expect(r.status).toBe('reappointment_tasked');
    expect(db.readDoc('roles', 'u5')!.role).toBe('member_basic');
    const tasks = db.readCollection('tasks').map(([, d]) => d);
    expect(tasks).toHaveLength(1);
    expect(String(tasks[0].title)).toContain('Re-appointment decision: Test User, chapter_treasurer');
    expect(tasks[0].assigneeIds).toEqual(['cp-1']);
  });

  it('role no longer in the catalog: task goes to the Membership Director, audit code recorded', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w6', { userId: 'u6', preWarningRoleKey: 'ghost_role' });
    db.seed('users', 'u6', { role: 'member_basic' });
    db.seed('roles', 'nmd-1', { role: 'national_membership_director' });
    const r = await processProbationRestore(db, 'w6', NOW);
    expect(r.status).toBe('reappointment_tasked');
    expect(r.fellBackToReappointReason).toBe('role_no_longer_in_catalog');
    const tasks = db.readCollection('tasks').map(([, d]) => d);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigneeIds).toEqual(['nmd-1']);
    const audits = db.readCollection('audit_logs').map(([, d]) => d);
    expect(audits.some((a) => a.code === 'ROLE_NO_LONGER_IN_CATALOG')).toBe(true);
  });

  it('unexpired probation is left pending', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w7', { userId: 'u7', probationEndsAt: FUTURE });
    const r = await processProbationRestore(db, 'w7', NOW);
    expect(r.acted).toBe(false);
    expect(db.readDoc('probation_restores', 'w7')!.status).toBe('pending');
  });
});

describe('T13 retry stanza and backfill', () => {
  it('retry processes only expired pending records', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w8', { userId: 'u8', restoreMode: 'reappoint', preWarningRoleKey: 'member' });
    seedRestoreDoc(db, 'w9', { userId: 'u9', probationEndsAt: FUTURE });
    db.seed('users', 'u8', { role: 'member_basic' });
    const r = await retryProbationRestores(db, NOW);
    expect(r.scanned).toBe(1);
    expect(r.acted).toBe(1);
    expect(db.readDoc('probation_restores', 'w8')!.status).toBe('reappointment_tasked');
    expect(db.readDoc('probation_restores', 'w9')!.status).toBe('pending');
  });

  it('backfill derives the role from the audit trail, and escalates honestly where none exists', async () => {
    const db = new FakeDb();
    db.seed('users', 'legacy1', {
      isOnProbation: true,
      probationEndsAt: FUTURE,
      warningId: 'wl1',
      role: 'member_basic',
    });
    db.seed('audit_logs', 'a1', {
      action: 'role_demoted',
      targetUid: 'legacy1',
      fromRole: 'chapter_secretary',
      createdAt: PAST,
    });
    db.seed('users', 'legacy2', { isOnProbation: true, probationEndsAt: FUTURE, role: 'member_basic' });
    const r = await backfillLegacyProbationRestores(db, NOW);
    expect(r.created).toBe(2);
    expect(r.escalated).toBe(1);
    const derived = db.readDoc('probation_restores', 'wl1')!;
    expect(derived.status).toBe('pending');
    expect(derived.preWarningRoleKey).toBe('chapter_secretary');
    const honest = db.readDoc('probation_restores', 'legacy_legacy2')!;
    expect(honest.status).toBe('escalated');
    expect(honest.preWarningRoleKey).toBeNull();
    expect(honest.escalationReason).toBe('legacy_no_pre_warning_role');
  });
});
