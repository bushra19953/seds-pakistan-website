/**
 * Workstream F: Departed soft-delete lifecycle (spec 2.5 conversions D1-D3).
 *
 * Uses an in-memory mock of the Admin SDK Firestore surface that
 * member-lifecycle.ts actually calls. No test touches real Firestore.
 * The central invariant: NO delete is ever issued by a lifecycle action.
 */

jest.mock('@/lib/server/hierarchy', () => ({
  syncDirectRelationship: jest.fn(async () => undefined),
}));

import {
  departUser,
  reinstateUser,
  getMemberStatus,
  isActiveMember,
  InvalidMemberTransitionError,
  MemberNotFoundError,
} from '../member-lifecycle';
import { syncDirectRelationship } from '@/lib/server/hierarchy';

// --- In-memory Firestore mock -------------------------------------------

type DocData = Record<string, unknown>;

class MockRef {
  constructor(
    private store: MockStore,
    public collectionName: string,
    public id: string,
  ) {}
  async get() {
    const data = this.store.getDoc(this.collectionName, this.id);
    return {
      exists: data !== undefined,
      id: this.id,
      ref: this,
      data: () => data,
    };
  }
  async update(fields: DocData) {
    this.store.updateDoc(this.collectionName, this.id, fields);
  }
  async delete() {
    this.store.deleteCalls.push(`${this.collectionName}/${this.id}`);
  }
}

class MockQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(
    private store: MockStore,
    private collectionName: string,
  ) {}
  where(field: string, _op: string, value: unknown) {
    this.filters.push([field, value]);
    return this;
  }
  async get() {
    const docs = this.store
      .allDocs(this.collectionName)
      .filter(([, data]) =>
        this.filters.every(([f, v]) => data[f] === v),
      )
      .map(([id, data]) => ({
        id,
        ref: new MockRef(this.store, this.collectionName, id),
        data: () => data,
      }));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class MockCollection extends MockQuery {
  doc(id: string) {
    return new MockRef(this.storeRef(), this.collectionNameRef(), id);
  }
  async add(data: DocData) {
    const id = `auto-${Math.random().toString(36).slice(2, 9)}`;
    this.storeRef().setDoc(this.collectionNameRef(), id, data);
    return { id };
  }
  // helpers to reach the store from the subclass
  private storeRef() {
    return (this as unknown as { store: MockStore }).store;
  }
  private collectionNameRef() {
    return (this as unknown as { collectionName: string }).collectionName;
  }
}

class MockStore {
  deleteCalls: string[] = [];
  private data = new Map<string, Map<string, DocData>>();
  seed(collection: string, id: string, doc: DocData) {
    this.setDoc(collection, id, doc);
  }
  setDoc(collection: string, id: string, doc: DocData) {
    if (!this.data.has(collection)) this.data.set(collection, new Map());
    this.data.get(collection)!.set(id, { ...doc });
  }
  getDoc(collection: string, id: string) {
    return this.data.get(collection)?.get(id);
  }
  updateDoc(collection: string, id: string, fields: DocData) {
    const current = this.getDoc(collection, id) ?? {};
    this.setDoc(collection, id, { ...current, ...fields });
  }
  allDocs(collection: string) {
    return Array.from(this.data.get(collection)?.entries() ?? []);
  }
  collection(name: string) {
    return new MockCollection(this, name);
  }
  batch() {
    const updates: Array<[MockRef, DocData]> = [];
    return {
      update: (ref: MockRef, fields: DocData) => {
        updates.push([ref, fields]);
      },
      commit: async () => {
        for (const [ref, fields] of updates) {
          this.updateDoc(ref.collectionName, ref.id, fields);
        }
      },
    };
  }
}

function makeDb() {
  const store = new MockStore();
  const db = {
    collection: (name: string) => store.collection(name),
    batch: () => store.batch(),
  };
  return { db: db as never, store };
}

const ACTOR = 'admin-uid';
const REASON = 'Left the society (graduated)';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getMemberStatus / isActiveMember', () => {
  it('treats a missing field and unknown values as active', () => {
    expect(getMemberStatus({})).toBe('active');
    expect(getMemberStatus({ memberStatus: 'departed' })).toBe('departed');
    expect(getMemberStatus(null)).toBe('active');
    expect(isActiveMember({ memberStatus: 'erased' })).toBe(false);
    expect(isActiveMember({})).toBe(true);
  });
});

describe('departUser', () => {
  it('soft-deletes: status set, cascade run, NOTHING deleted', async () => {
    const { db, store } = makeDb();
    store.seed('users', 'u1', { displayName: 'Member One' });
    store.seed('users', 'report1', { managerId: 'u1' });
    store.seed('users', 'report2', { managerId: 'u1' });
    store.seed('positions', 'p1', { userId: 'u1', endDate: null });
    store.seed('positions', 'p2', { userId: 'u1', endDate: new Date() });
    store.seed('roles', 'u1', { role: 'member' });

    const result = await departUser(db, 'u1', ACTOR, REASON);
    expect(result).toEqual({ uid: 'u1', memberStatus: 'departed' });

    const user = store.getDoc('users', 'u1')!;
    expect(user.memberStatus).toBe('departed');
    expect(user.departedBy).toBe(ACTOR);
    expect(user.departReason).toBe(REASON);
    expect(user.displayName).toBe('Member One'); // doc retained in full

    // D1 cascade: direct reports unlinked + mirrored to relationships.
    expect(store.getDoc('users', 'report1')!.managerId).toBeNull();
    expect(store.getDoc('users', 'report2')!.managerId).toBeNull();
    expect(syncDirectRelationship).toHaveBeenCalledWith(
      'report1',
      null,
      ACTOR,
    );

    // Open position ENDED, not deleted; already-ended one untouched.
    expect(store.getDoc('positions', 'p1')!.endDate).toBeInstanceOf(Date);
    expect(
      (store.getDoc('positions', 'p1') as DocData).endedReason,
    ).toBe('member_departed');

    // Role store adapter: roles doc mirrored, never deleted; history added.
    expect(store.getDoc('roles', 'u1')!.memberStatus).toBe('departed');
    expect(
      store.allDocs('role_history').some(([, d]) => d.action === 'departed'),
    ).toBe(true);

    // Audit written; and the core invariant: no delete anywhere.
    expect(
      store
        .allDocs('audit_logs')
        .some(([, d]) => d.action === 'MEMBER_DEPARTED'),
    ).toBe(true);
    expect(store.deleteCalls).toEqual([]);
  });

  it('rejects departing a non-active member and unknown users', async () => {
    const { db, store } = makeDb();
    store.seed('users', 'gone', { memberStatus: 'erased' });
    await expect(departUser(db, 'gone', ACTOR, REASON)).rejects.toBeInstanceOf(
      InvalidMemberTransitionError,
    );
    await expect(departUser(db, 'nope', ACTOR, REASON)).rejects.toBeInstanceOf(
      MemberNotFoundError,
    );
  });

  it('requires a reason of at least 10 characters', async () => {
    const { db, store } = makeDb();
    store.seed('users', 'u1', {});
    await expect(departUser(db, 'u1', ACTOR, 'short')).rejects.toThrow(
      /minimum 10 characters/,
    );
  });
});

describe('reinstateUser', () => {
  it('restores active, archives the departure in departedHistory', async () => {
    const { db, store } = makeDb();
    store.seed('users', 'u1', {
      memberStatus: 'departed',
      departedAt: new Date('2026-09-01T00:00:00Z'),
      departedBy: 'someone',
      departReason: REASON,
    });
    store.seed('roles', 'u1', { role: 'member', memberStatus: 'departed' });

    const result = await reinstateUser(db, 'u1', ACTOR);
    expect(result).toEqual({ uid: 'u1', memberStatus: 'active' });
    const user = store.getDoc('users', 'u1')!;
    expect(user.memberStatus).toBe('active');
    expect(user.departedAt).toBeNull();
    const history = user.departedHistory as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0].departReason).toBe(REASON);
    expect(store.getDoc('roles', 'u1')!.memberStatus).toBe('active');
    expect(
      store
        .allDocs('audit_logs')
        .some(([, d]) => d.action === 'MEMBER_REINSTATED'),
    ).toBe(true);
    expect(store.deleteCalls).toEqual([]);
  });

  it('rejects reinstating an active member', async () => {
    const { db, store } = makeDb();
    store.seed('users', 'u1', {});
    await expect(reinstateUser(db, 'u1', ACTOR)).rejects.toBeInstanceOf(
      InvalidMemberTransitionError,
    );
  });
});
