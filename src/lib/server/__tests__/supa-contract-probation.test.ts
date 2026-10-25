/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT — COMPLIANCE/DISCIPLINE, cluster 5.
 *
 * Invariant 5 (PROBATION): restore semantics pinned from
 * src/lib/server/lifecycle-probation.ts (Section D.10 owner) and
 * src/lib/server/discipline/adapters-probation.ts (Section E adapter
 * consumed by the clear-probation cron):
 *  - CAPTURE (lifecycle-probation.ts:71-124): probation_restores/
 *    {warningId} is written ONCE (an existing doc is returned
 *    unchanged); the pre-warning role is read SERVER-SIDE from
 *    roles/{uid}; a client-supplied role is ignored and audit-logged;
 *    restoreMode is the SNAPSHOT of settings.probationRestoreMode at
 *    capture (absent settings doc -> 'reappoint', the D.10 ship
 *    default in lifecycle-adapters getLifecycleSettings).
 *  - EXPIRY (processProbationRestore :235ff): a pending doc whose
 *    probationEndsAt is still in the future is left alone; a
 *    non-pending doc is a no-op (idempotent); a missing doc throws
 *    NOT_FOUND. 'reappoint' NEVER writes a role: it tasks the catalog
 *    appointer (fallback: National Membership Director, then the
 *    Founder) and moves the doc to 'reappointment_tasked'. 'auto'
 *    re-checks eligibility at restore time and restores through the
 *    single role-write path. A banned (isBanned) target is neither
 *    restored nor tasked: the doc escalates with 'target_banned'.
 *  - This module NEVER writes warningCount and NEVER writes
 *    isBlacklisted (in either direction) — pinned by seeding both
 *    fields and asserting they survive every path byte-identical.
 *  - ADAPTER (adapters-probation.ts:18-73): consumes pending docs of
 *    shape {uid, roleToRestore}; not-yet-due docs stay pending; a
 *    successful restore marks the doc 'restored' with restoredAt; a
 *    doc without roleToRestore counts as failed; an empty/absent
 *    collection is a clean {0,0,0} no-op.
 */

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } } },
}));

const mockNotificationSend = jest.fn(async () => undefined);
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: (...args: unknown[]) => mockNotificationSend(...(args as [])) },
}));

import { FOUNDER_UID } from '@/lib/roles';
import {
  captureProbationRestore,
  processProbationRestore,
  retryProbationRestores,
} from '../lifecycle-probation';
import { processProbationRestores } from '@/lib/server/discipline/adapters-probation';

// --- Fake Firestore (same posture as lifecycle-probation.test.ts,
// extended with == filtering and snapshot refs for the E adapter) ----

type DocData = Record<string, any>;

class FakeDocSnapshot {
  constructor(public id: string, private _data: DocData | undefined, public ref?: FakeDocRef) {}
  get exists() { return this._data !== undefined; }
  data() { return this._data; }
}

class FakeDocRef {
  constructor(private db: FakeDb, private collectionName: string, public id: string) {}
  async get() { return new FakeDocSnapshot(this.id, this.db.readDoc(this.collectionName, this.id), this); }
  async set(data: DocData, opts?: { merge?: boolean }) { this.db.writeDoc(this.collectionName, this.id, data, !!opts?.merge); return this; }
  async update(data: DocData) { this.db.writeDoc(this.collectionName, this.id, data, true); return this; }
  async delete() { this.db.deleteDoc(this.collectionName, this.id); return this; }
}

class FakeBatch {
  private ops: Array<() => Promise<unknown>> = [];
  set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) { this.ops.push(() => ref.set(data, opts)); return this; }
  update(ref: FakeDocRef, data: DocData) { this.ops.push(() => ref.update(data)); return this; }
  delete(ref: FakeDocRef) { this.ops.push(() => ref.delete()); return this; }
  async commit() { for (const op of this.ops) await op(); }
}

type Filter = [string, string, unknown];
class FakeCollectionRef {
  constructor(private db: FakeDb, private name: string, private filters: Filter[] = []) {}
  doc(id?: string) { return new FakeDocRef(this.db, this.name, id ?? this.db.nextId()); }
  async add(data: DocData) { const ref = this.doc(); this.db.writeDoc(this.name, ref.id, { ...data }, false); return ref; }
  where(field: string, op: string, value: unknown) { return new FakeCollectionRef(this.db, this.name, [...this.filters, [field, op, value]]); }
  limit() { return this; }
  async get() {
    const docs = this.db.readCollection(this.name)
      .filter(([, data]) => this.filters.every(([f, op, v]) => (op === '==' ? data[f] === v : true)))
      .map(([id, data]) => new FakeDocSnapshot(id, data, new FakeDocRef(this.db, this.name, id)));
    return { docs, empty: docs.length === 0, size: docs.length, forEach: (cb: (d: FakeDocSnapshot) => void) => docs.forEach(cb) };
  }
}

class FakeDb {
  private store = new Map<string, Map<string, DocData>>();
  private counter = 0;
  nextId() { this.counter += 1; return `auto-${this.counter}`; }
  collection(name: string) { return new FakeCollectionRef(this, name); }
  batch() { return new FakeBatch(); }
  deleteDoc(c: string, id: string) { this.store.get(c)?.delete(id); }
  seed(c: string, id: string, data: DocData) { this.writeDoc(c, id, data, false); }
  readDoc(c: string, id: string): DocData | undefined { return this.store.get(c)?.get(id); }
  readCollection(c: string): Array<[string, DocData]> { return Array.from(this.store.get(c)?.entries() ?? []); }
  writeDoc(c: string, id: string, data: DocData, merge: boolean) {
    if (!this.store.has(c)) this.store.set(c, new Map());
    const col = this.store.get(c)!;
    col.set(id, merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
  }
}

const PAST = new Date('2026-10-10T00:00:00.000Z');
const FUTURE = new Date('2027-01-01T00:00:00.000Z');
const NOW = new Date('2026-10-20T00:00:00.000Z');

function seedRestoreDoc(db: FakeDb, id: string, overrides: DocData = {}) {
  db.seed('probation_restores', id, {
    id, warningId: id, userId: 'u-x',
    preWarningRoleKey: 'national_treasurer', preWarningChapterSlug: null,
    demotedToRoleKey: 'member_basic', probationEndsAt: PAST,
    status: 'pending', restoreMode: 'auto', ...overrides,
  });
}

beforeEach(() => { mockNotificationSend.mockClear(); });

describe('CONTRACT 5a: capture writes the restore row once, server-side, with a mode snapshot', () => {
  it('captures the server role, ignores + audits a client-supplied role, defaults mode to reappoint', async () => {
    const db = new FakeDb();
    db.seed('roles', 'u1', { role: 'chapter_treasurer', chapterSlug: 'ist' });
    const id = await captureProbationRestore(db, {
      warningId: 'w1', userId: 'u1', demotedToRoleKey: 'member_basic',
      probationEndsAt: FUTURE, clientSuppliedRoleKey: 'president_national',
    });
    expect(id).toBe('w1');
    const doc = db.readDoc('probation_restores', 'w1')!;
    expect(doc.preWarningRoleKey).toBe('chapter_treasurer');
    expect(doc.preWarningChapterSlug).toBe('ist');
    expect(doc.demotedToRoleKey).toBe('member_basic');
    expect(doc.status).toBe('pending');
    expect(doc.restoreMode).toBe('reappoint');
    const audits = db.readCollection('audit_logs').map(([, d]) => d);
    expect(audits.some((a) => a.action === 'probation_restore_client_role_ignored' && a.clientSuppliedRoleKey === 'president_national')).toBe(true);
  });

  it('mode snapshot follows settings at capture time (auto when settings say auto)', async () => {
    const db = new FakeDb();
    db.seed('governance_settings', 'phase2', { probationRestoreMode: 'auto' });
    db.seed('roles', 'u1', { role: 'member' });
    await captureProbationRestore(db, { warningId: 'w-auto', userId: 'u1', demotedToRoleKey: 'member_basic', probationEndsAt: FUTURE });
    expect(db.readDoc('probation_restores', 'w-auto')?.restoreMode).toBe('auto');
  });

  it('capture is idempotent: an existing row is returned unchanged even if the role has since changed', async () => {
    const db = new FakeDb();
    db.seed('roles', 'u1', { role: 'chapter_treasurer' });
    await captureProbationRestore(db, { warningId: 'w1', userId: 'u1', demotedToRoleKey: 'member_basic', probationEndsAt: FUTURE });
    db.seed('roles', 'u1', { role: 'national_treasurer' });
    const again = await captureProbationRestore(db, { warningId: 'w1', userId: 'u1', demotedToRoleKey: 'member_basic', probationEndsAt: FUTURE });
    expect(again).toBe('w1');
    expect(db.readDoc('probation_restores', 'w1')?.preWarningRoleKey).toBe('chapter_treasurer');
  });
});

describe('CONTRACT 5b: expiry processing (lifecycle owner)', () => {
  it('unexpired pending row: acted=false, nothing written, no task', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w-future', { userId: 'u-f', probationEndsAt: FUTURE });
    const r = await processProbationRestore(db, 'w-future', NOW);
    expect(r).toEqual({ warningId: 'w-future', status: 'pending', acted: false });
    expect(db.readCollection('tasks')).toHaveLength(0);
  });

  it('missing row throws NOT_FOUND; an already-processed row is a no-op', async () => {
    const db = new FakeDb();
    await expect(processProbationRestore(db, 'nope', NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    seedRestoreDoc(db, 'w-done', { status: 'restored_automatic' });
    const r = await processProbationRestore(db, 'w-done', NOW);
    expect(r.acted).toBe(false);
    expect(r.status).toBe('restored_automatic');
  });

  it('reappoint expiry: NO role write, appointer tasked, warningCount + isBlacklisted byte-identical', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w5', { userId: 'u5', preWarningRoleKey: 'chapter_treasurer', preWarningChapterSlug: 'ist', restoreMode: 'reappoint' });
    const userSeed = { role: 'member_basic', name: 'Test User', warningCount: 2, isBlacklisted: true };
    db.seed('users', 'u5', { ...userSeed });
    db.seed('roles', 'u5', { role: 'member_basic', chapterSlug: 'ist' });
    db.seed('roles', 'cp-1', { role: 'chapter_president', chapterSlug: 'ist' });
    const r = await processProbationRestore(db, 'w5', NOW);
    expect(r.status).toBe('reappointment_tasked');
    expect(db.readDoc('probation_restores', 'w5')?.status).toBe('reappointment_tasked');
    expect(db.readDoc('roles', 'u5')?.role).toBe('member_basic');
    expect(db.readDoc('users', 'u5')).toEqual(userSeed);
    const tasks = db.readCollection('tasks').map(([, d]) => d);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigneeIds).toEqual(['cp-1']);
  });

  it('reappoint with no appointer and no Membership Director falls back to the Founder', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w-fb', { userId: 'u-fb', preWarningRoleKey: 'member', restoreMode: 'reappoint' });
    db.seed('users', 'u-fb', { role: 'member_basic' });
    const r = await processProbationRestore(db, 'w-fb', NOW);
    expect(r.status).toBe('reappointment_tasked');
    const tasks = db.readCollection('tasks').map(([, d]) => d);
    expect(tasks[0].assigneeIds).toEqual([FOUNDER_UID]);
  });

  it('auto expiry restores the role and never touches warningCount or isBlacklisted', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w2', { userId: 'u2' });
    db.seed('users', 'u2', { role: 'member', warningCount: 1, isBlacklisted: true });
    db.seed('roles', 'u2', { role: 'member' });
    const r = await processProbationRestore(db, 'w2', NOW);
    expect(r.status).toBe('restored_automatic');
    expect(db.readDoc('probation_restores', 'w2')?.status).toBe('restored_automatic');
    expect(db.readDoc('roles', 'u2')?.role).toBe('national_treasurer');
    expect(db.readDoc('users', 'u2')?.role).toBe('national_treasurer');
    expect(db.readDoc('users', 'u2')?.warningCount).toBe(1);
    expect(db.readDoc('users', 'u2')?.isBlacklisted).toBe(true);
  });

  it('banned target: escalated target_banned, no restore, no task, Founder notified', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w4', { userId: 'u4' });
    db.seed('users', 'u4', { role: 'member_basic', isBanned: true, isBlacklisted: true });
    db.seed('roles', 'u4', { role: 'member_basic' });
    const r = await processProbationRestore(db, 'w4', NOW);
    expect(r).toMatchObject({ status: 'escalated', acted: true, escalationReason: 'target_banned' });
    expect(db.readDoc('probation_restores', 'w4')?.status).toBe('escalated');
    expect(db.readDoc('roles', 'u4')?.role).toBe('member_basic');
    expect(db.readCollection('tasks')).toHaveLength(0);
    expect(db.readDoc('users', 'u4')?.isBlacklisted).toBe(true);
  });

  it('retry stanza scans only expired pending rows', async () => {
    const db = new FakeDb();
    seedRestoreDoc(db, 'w8', { userId: 'u8', restoreMode: 'reappoint', preWarningRoleKey: 'member' });
    seedRestoreDoc(db, 'w9', { userId: 'u9', probationEndsAt: FUTURE });
    seedRestoreDoc(db, 'w10', { userId: 'u10', status: 'restored_automatic' });
    db.seed('users', 'u8', { role: 'member_basic' });
    const r = await retryProbationRestores(db, NOW);
    expect(r).toEqual({ scanned: 1, acted: 1, skipped: 0, errors: 0 });
    expect(db.readDoc('probation_restores', 'w9')?.status).toBe('pending');
  });
});

describe('CONTRACT 5c: discipline adapter consumed by the clear-probation cron', () => {
  it('empty collection is a clean no-op', async () => {
    const db = new FakeDb();
    await expect(processProbationRestores(db as any, NOW)).resolves.toEqual({ restored: 0, pending: 0, failed: 0 });
  });

  it('a due pending row is restored via the write path and marked restored with restoredAt', async () => {
    const db = new FakeDb();
    db.seed('probation_restores', 'restore-1', {
      uid: 'u-r', roleToRestore: 'chapter_president', status: 'pending',
      dueAt: '2026-10-01T00:00:00.000Z',
    });
    db.seed('users', 'u-r', { displayName: 'R', role: 'member', chapterId: 'seds-ist-chapter' });
    db.seed('roles', 'u-r', { role: 'member' });
    const r = await processProbationRestores(db as any, NOW);
    expect(r).toEqual({ restored: 1, pending: 0, failed: 0 });
    const doc = db.readDoc('probation_restores', 'restore-1')!;
    expect(doc.status).toBe('restored');
    expect(doc.restoredAt).toBe(NOW.toISOString());
    expect(db.readDoc('roles', 'u-r')?.role).toBe('chapter_president');
  });

  it('a not-yet-due row stays pending and the role is untouched', async () => {
    const db = new FakeDb();
    db.seed('probation_restores', 'restore-2', {
      uid: 'u-r2', roleToRestore: 'chapter_president', status: 'pending',
      dueAt: '2027-01-01T00:00:00.000Z',
    });
    db.seed('users', 'u-r2', { displayName: 'R2', role: 'member', chapterId: 'seds-ist-chapter' });
    db.seed('roles', 'u-r2', { role: 'member' });
    const r = await processProbationRestores(db as any, NOW);
    expect(r).toEqual({ restored: 0, pending: 1, failed: 0 });
    expect(db.readDoc('probation_restores', 'restore-2')?.status).toBe('pending');
    expect(db.readDoc('roles', 'u-r2')?.role).toBe('member');
  });

  it('a pending row without roleToRestore counts as failed and is not marked restored', async () => {
    const db = new FakeDb();
    db.seed('probation_restores', 'restore-3', { uid: 'u-r3', status: 'pending' });
    const r = await processProbationRestores(db as any, NOW);
    expect(r).toEqual({ restored: 0, pending: 0, failed: 1 });
    expect(db.readDoc('probation_restores', 'restore-3')?.status).toBe('pending');
  });
});
