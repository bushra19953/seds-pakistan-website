/**
 * Identity full build — WRITE-PRIMACY contracts (design §5, IC pins).
 *
 * Covered here (module + chokepoint + governors + lifecycle level,
 * real-adapter-shaped fakes per H-03 — flattened {exists,data}
 * answers, never Firestore-shaped):
 *   IC-01 OFF byte-identity for the chokepoint (zero adapter calls,
 *         Firestore composition unchanged — the pre-existing
 *         role-writes suite pins the payloads themselves).
 *   IC-02 both-flags rule at the identity-primary gate.
 *   IC-03 primary failure is loud: assign rejects, NO Firestore
 *         write occurs (no shadow-first commit).
 *   IC-04 chokepoint primary order roles -> users -> roleHistory;
 *         audit_logs + authority_refresh never reach the adapter.
 *   IC-05 remove parity under primacy (fs_roles deleted, mirror =
 *         member_basic with additionalRoles REMOVED on both stores).
 *   IC-07 idempotency replay under primacy writes nothing on either
 *         store (primary is the lookup source).
 *   IC-09 no FieldValue sentinel reaches the adapter (deep scan).
 *   IC-10 increment RMW equivalence (N sequential awards = N
 *         increments; mixed payload in one update).
 *   IC-11 governor previousRole round-trip on the primary; grant
 *         writes NO roleHistory row on either store.
 *   G-ROLE-7 lifecycle: depart lands on the adapter first, roles
 *         memberStatus conditional update follows the primary's
 *         existence, role_history (underscore) stays Firestore.
 *
 * Route-level groups (G-ROLE-2 definitions, G-USER-1/5 route sites)
 * share the same helper module + call pattern and are covered by
 * their existing route suites in the gates; IC-06/IC-12/IC-13/
 * IC-16..IC-20 dispositions are recorded in the section report
 * (identity-full.md), not silently claimed here.
 *
 * Zero live reads or writes: Firestore is the in-memory
 * FakeFirestore; the Supabase adapter is an injected fake.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';
import {
  __setIdentityPrimaryAdapterForTests,
  containsSentinel,
  flushPendingUsersPrimaryOps,
  identityPrimaryFlagOn,
  primaryIdentitySet,
  primaryIdentityUpdate,
  resolvePrimaryPayload,
  type IdentityPrimaryAdapter,
} from '../supa-identity-primary';
import { assignRole, removeRole, setMirror } from '../role-writes';
import {
  flushGovernorPrimaryOps,
  grantGovernorRole,
  restorePriorRole,
  stashPreviousRole,
} from '../governors/shared';
import { departUser } from '../member-lifecycle';

/* ------------------------------------------------------- fake adapter */

interface AdapterCall {
  method: 'getDoc' | 'setDoc' | 'updateDoc' | 'deleteDoc' | 'listDocs';
  collection: string;
  id?: string;
  data?: Record<string, unknown>;
}

class FakePrimaryAdapter implements IdentityPrimaryAdapter {
  store = new Map<string, Map<string, Record<string, unknown>>>();
  calls: AdapterCall[] = [];
  failOnSet = false;
  constructor(private primarySurfaces: Set<string>) {}
  isSupaPrimary = (surface: string) => this.primarySurfaces.has(surface);
  useSupa = () => true;
  seed(collection: string, id: string, data: Record<string, unknown>): void {
    if (!this.store.has(collection)) this.store.set(collection, new Map());
    this.store.get(collection)!.set(id, { ...data });
  }
  read(collection: string, id: string): Record<string, unknown> | undefined {
    const d = this.store.get(collection)?.get(id);
    return d ? { ...d } : undefined;
  }
  async getDoc(collection: string, id: string) {
    this.calls.push({ method: 'getDoc', collection, id });
    const d = this.store.get(collection)?.get(id);
    return d ? { exists: true, data: { ...d } } : { exists: false };
  }
  async setDoc(collection: string, id: string, data: Record<string, unknown>) {
    this.calls.push({ method: 'setDoc', collection, id, data: { ...data } });
    if (this.failOnSet) throw new Error('fake adapter setDoc failure');
    this.seed(collection, id, data);
  }
  async updateDoc(collection: string, id: string, data: Record<string, unknown>) {
    this.calls.push({ method: 'updateDoc', collection, id, data: { ...data } });
    const current = this.read(collection, id) ?? {};
    this.seed(collection, id, { ...current, ...data });
  }
  async deleteDoc(collection: string, id: string) {
    this.calls.push({ method: 'deleteDoc', collection, id });
    this.store.get(collection)?.delete(id);
  }
  async listDocs(collection: string) {
    this.calls.push({ method: 'listDocs', collection });
    const col = this.store.get(collection) ?? new Map();
    return [...col.entries()].map(([id, data]) => ({ id, data: { ...data } }));
  }
  writeCalls(): AdapterCall[] {
    return this.calls.filter((c) => c.method === 'setDoc' || c.method === 'updateDoc' || c.method === 'deleteDoc');
  }
}

const ADMIN = 'admin-actor-uid';
const TARGET = 'target-user-uid';
const REASON = 'Appointed by the National President, October 2026 intake';

function freshDb(): FakeFirestore {
  const db = new FakeFirestore();
  db.seed('users', TARGET, { displayName: 'Target User', chapterId: 'seds-ist-chapter' });
  return db;
}

afterEach(() => {
  __setIdentityPrimaryAdapterForTests(null);
});

/* ------------------------------------------------------------ IC-02 */

describe('IC-02 both-flags rule at the identity-primary gate', () => {
  it('flag answers come only from isSupaPrimary (both flags), per surface', async () => {
    __setIdentityPrimaryAdapterForTests(new FakePrimaryAdapter(new Set(['roles'])));
    await expect(identityPrimaryFlagOn('roles')).resolves.toBe(true);
    await expect(identityPrimaryFlagOn('users')).resolves.toBe(false);
    __setIdentityPrimaryAdapterForTests(new FakePrimaryAdapter(new Set()));
    await expect(identityPrimaryFlagOn('roles')).resolves.toBe(false);
    await expect(identityPrimaryFlagOn('users')).resolves.toBe(false);
  });
});

/* ------------------------------------------------- IC-09 / IC-10 core */

describe('IC-09/IC-10 sentinel resolution + increment RMW', () => {
  it('resolvePrimaryPayload resolves every sentinel class and drops id', () => {
    const { fields, deletes } = resolvePrimaryPayload(
      {
        id: 'must-not-land',
        at: FieldValue.serverTimestamp(),
        gone: FieldValue.delete(),
        n: FieldValue.increment(5),
        arr: FieldValue.arrayUnion('a', 'b'),
        tags: FieldValue.arrayRemove('x'),
      },
      { n: 7, arr: ['b', 'c'], tags: ['x', 'y'] },
    );
    expect(fields).not.toHaveProperty('id');
    expect(fields.at).toBeInstanceOf(Date);
    expect(fields.n).toBe(12);
    expect(fields.arr).toEqual(['b', 'c', 'a']);
    expect(fields.tags).toEqual(['y']);
    expect(deletes).toEqual(['gone']);
    expect(containsSentinel(fields)).toBe(false);
  });

  it('N sequential primary awards equal N Firestore increments; mixed payload in one update', async () => {
    const adapter = new FakePrimaryAdapter(new Set(['users']));
    __setIdentityPrimaryAdapterForTests(adapter);
    adapter.seed('users', 'u1', { points: 0, submissionsApprovedCount: 0 });
    for (let i = 0; i < 3; i++) {
      await primaryIdentitySet(
        'users',
        'users',
        'u1',
        {
          points: FieldValue.increment(10),
          submissionsApprovedCount: FieldValue.increment(1),
        },
        { merge: true },
      );
    }
    expect(adapter.read('users', 'u1')).toMatchObject({ points: 30, submissionsApprovedCount: 3 });
    for (const call of adapter.writeCalls()) {
      expect(containsSentinel(call.data ?? {})).toBe(false);
    }
  });

  it('primaryIdentityUpdate on a missing doc throws (Firestore not-found parity)', async () => {
    __setIdentityPrimaryAdapterForTests(new FakePrimaryAdapter(new Set(['users'])));
    await expect(primaryIdentityUpdate('users', 'users', 'nope', { a: 1 })).rejects.toThrow(/missing/);
  });

  it('flushPendingUsersPrimaryOps is a no-op when users is not primary (zero adapter writes)', async () => {
    const adapter = new FakePrimaryAdapter(new Set(['roles']));
    __setIdentityPrimaryAdapterForTests(adapter);
    await flushPendingUsersPrimaryOps([
      { uid: 'u1', payload: { points: FieldValue.increment(1) } },
    ]);
    expect(adapter.writeCalls()).toHaveLength(0);
  });
});

/* ------------------------------------------------- chokepoint IC pins */

describe('G-ROLE-1 chokepoint primacy', () => {
  it('IC-01: OFF — assign writes Firestore only, zero adapter calls', async () => {
    const adapter = new FakePrimaryAdapter(new Set());
    __setIdentityPrimaryAdapterForTests(adapter);
    const db = freshDb();
    const result = await assignRole(db.asDb(), {
      uid: TARGET, role: 'chapter_president', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
    });
    expect(result.alreadyApplied).toBe(false);
    expect(adapter.calls).toHaveLength(0);
    expect(db.read('roles', TARGET)?.role).toBe('chapter_president');
  });

  it('IC-04: ON — adapter order roles -> users -> roleHistory; audit/authority never reach the adapter; Firestore mirror matches', async () => {
    const adapter = new FakePrimaryAdapter(new Set(['roles']));
    __setIdentityPrimaryAdapterForTests(adapter);
    const db = freshDb();
    const result = await assignRole(db.asDb(), {
      uid: TARGET, role: 'chapter_president', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
    });
    expect(result.alreadyApplied).toBe(false);
    const writes = adapter.writeCalls();
    expect(writes.map((w) => w.collection)).toEqual(['roles', 'users', 'roleHistory']);
    expect(writes.some((w) => w.collection === 'audit_logs' || w.collection === 'authority_refresh')).toBe(false);
    for (const w of writes) expect(containsSentinel(w.data ?? {})).toBe(false);
    // Primary rows carry the post-write state.
    expect(adapter.read('roles', TARGET)).toMatchObject({ role: 'chapter_president', schemaVersion: 2 });
    expect(adapter.read('users', TARGET)).toMatchObject({ role: 'chapter_president', displayRole: 'chapter_president', roleSource: 'roles' });
    // Reverse mirror: Firestore docs deep-equal modulo timestamp representation.
    expect(db.read('roles', TARGET)?.role).toBe('chapter_president');
    expect(db.read('users', TARGET)?.role).toBe('chapter_president');
    expect(db.all('roleHistory')).toHaveLength(1);
    expect(db.all('audit_logs')).toHaveLength(1);
    expect(db.read('authority_refresh', TARGET)).toBeDefined();
  });

  it('IC-03: ON + adapter failure — assign rejects and NO Firestore write occurs', async () => {
    const adapter = new FakePrimaryAdapter(new Set(['roles']));
    adapter.failOnSet = true;
    __setIdentityPrimaryAdapterForTests(adapter);
    const db = freshDb();
    await expect(
      assignRole(db.asDb(), {
        uid: TARGET, role: 'chapter_president', actorUid: ADMIN, reason: REASON, source: 'admin_ui',
      }),
    ).rejects.toThrow(/fake adapter setDoc failure/);
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.all('roleHistory')).toHaveLength(0);
    expect(db.all('audit_logs')).toHaveLength(0);
  });

  it('IC-07: ON replay — idempotency hit on the primary writes nothing on either store', async () => {
    const adapter = new FakePrimaryAdapter(new Set(['roles']));
    adapter.seed('roleHistory', 'hist-1', { uid: TARGET, idempotencyKey: 'idem-on-1' });
    adapter.seed('roles', TARGET, {
      role: 'chapter_secretary', additionalRoles: [], chapterId: 'seds-ist-chapter',
      lastChangedBy: ADMIN, source: 'admin_ui', schemaVersion: 2,
    });
    __setIdentityPrimaryAdapterForTests(adapter);
    const db = freshDb();
    const replay = await assignRole(db.asDb(), {
      uid: TARGET, role: 'chapter_secretary', actorUid: ADMIN, reason: REASON,
      source: 'admin_ui', idempotencyKey: 'idem-on-1', claimsAuth: null,
    });
    expect(replay.alreadyApplied).toBe(true);
    expect(adapter.writeCalls()).toHaveLength(0);
    expect(db.read('roles', TARGET)).toBeUndefined();
    expect(db.all('roleHistory')).toHaveLength(0);
  });

  it('IC-05: ON remove — fs_roles deleted, users mirror member_basic + additionalRoles removed on BOTH stores', async () => {
    const adapter = new FakePrimaryAdapter(new Set(['roles']));
    const db = freshDb();
    db.seed('roles', TARGET, {
      role: 'chapter_secretary', additionalRoles: ['chapter_events_chair'], chapterId: 'seds-ist-chapter',
    });
    db.seed('users', TARGET, {
      displayName: 'Target User', chapterId: 'seds-ist-chapter',
      role: 'chapter_events_chair', displayRole: 'chapter_events_chair', additionalRoles: ['chapter_events_chair'],
    });
    adapter.seed('roles', TARGET, {
      role: 'chapter_secretary', additionalRoles: ['chapter_events_chair'], chapterId: 'seds-ist-chapter',
    });
    adapter.seed('users', TARGET, {
      role: 'chapter_events_chair', displayRole: 'chapter_events_chair', additionalRoles: ['chapter_events_chair'],
    });
    __setIdentityPrimaryAdapterForTests(adapter);
    const result = await removeRole(db.asDb(), {
      uid: TARGET, actorUid: ADMIN, reason: REASON, source: 'admin_ui', claimsAuth: null,
    });
    expect(result.alreadyApplied).toBe(false);
    expect(adapter.calls.some((c) => c.method === 'deleteDoc' && c.collection === 'roles' && c.id === TARGET)).toBe(true);
    expect(adapter.read('roles', TARGET)).toBeUndefined();
    const primaryMirror = adapter.read('users', TARGET);
    expect(primaryMirror).toMatchObject({ role: 'member_basic', displayRole: 'member_basic' });
    expect(primaryMirror).not.toHaveProperty('additionalRoles');
    expect(db.read('roles', TARGET)).toBeUndefined();
    const fsMirror = db.read('users', TARGET);
    expect(fsMirror).toMatchObject({ role: 'member_basic', displayRole: 'member_basic' });
    expect(fsMirror).not.toHaveProperty('additionalRoles');
  });

  it('U-03 setMirror ON: the users mirror gains a primary write (Supa first), Firestore set is the reverse mirror', async () => {
    const adapter = new FakePrimaryAdapter(new Set(['roles']));
    adapter.seed('roles', TARGET, { role: 'chapter_treasurer', additionalRoles: [] });
    __setIdentityPrimaryAdapterForTests(adapter);
    const db = freshDb();
    await expect(setMirror(db.asDb(), TARGET)).resolves.toBe(true);
    expect(adapter.read('users', TARGET)).toMatchObject({ role: 'chapter_treasurer', roleSource: 'roles' });
    expect(db.read('users', TARGET)).toMatchObject({ role: 'chapter_treasurer', roleSource: 'roles' });
  });
});

/* ------------------------------------------------------------ IC-11 */

describe('IC-11 governor previousRole round-trip under primacy', () => {
  it('stash -> grant -> restore on the primary; no roleHistory anywhere', async () => {
    const adapter = new FakePrimaryAdapter(new Set(['roles']));
    __setIdentityPrimaryAdapterForTests(adapter);
    const db = freshDb();
    db.seed('roles', TARGET, { role: 'chapter_secretary' });
    adapter.seed('roles', TARGET, { role: 'chapter_secretary' });
    adapter.seed('users', TARGET, { role: 'chapter_secretary', displayRole: 'chapter_secretary' });

    const batch1 = db.batch();
    stashPreviousRole(batch1 as never, db.asDb(), TARGET, 'chapter_secretary');
    grantGovernorRole(batch1 as never, db.asDb(), 'seat_fa_1' as never, TARGET, ADMIN);
    await flushGovernorPrimaryOps(batch1 as never);
    expect(adapter.read('roles', TARGET)).toMatchObject({ role: 'governor_founder', previousRole: 'chapter_secretary' });
    expect(adapter.read('users', TARGET)).toMatchObject({ role: 'governor_founder', previousRole: 'chapter_secretary' });

    const batch2 = db.batch();
    restorePriorRole(
      batch2 as never,
      db.asDb(),
      TARGET,
      adapter.read('users', TARGET),
      adapter.read('roles', TARGET),
      ADMIN,
    );
    await flushGovernorPrimaryOps(batch2 as never);
    expect(adapter.read('roles', TARGET)?.role).toBe('chapter_secretary');
    expect(adapter.read('roles', TARGET)).not.toHaveProperty('previousRole');
    expect(adapter.read('users', TARGET)?.role).toBe('chapter_secretary');
    expect(adapter.writeCalls().some((c) => c.collection === 'roleHistory')).toBe(false);
    expect(db.all('roleHistory')).toHaveLength(0);
  });
});

/* --------------------------------------------------------- G-ROLE-7 */

describe('G-ROLE-7 lifecycle primacy', () => {
  it('depart: users + roles memberStatus land on the adapter; role_history stays Firestore-only', async () => {
    const adapter = new FakePrimaryAdapter(new Set(['users', 'roles']));
    adapter.seed('users', TARGET, { memberStatus: 'active' });
    adapter.seed('roles', TARGET, { role: 'member', memberStatus: 'active' });
    __setIdentityPrimaryAdapterForTests(adapter);
    const db = freshDb();
    db.seed('roles', TARGET, { role: 'member' });
    const result = await departUser(db.asDb(), TARGET, ADMIN, 'Leaving the society for a year abroad');
    expect(result.memberStatus).toBe('departed');
    expect(adapter.read('users', TARGET)).toMatchObject({ memberStatus: 'departed', departedBy: ADMIN });
    expect(adapter.read('roles', TARGET)).toMatchObject({ memberStatus: 'departed' });
    expect(db.read('users', TARGET)).toMatchObject({ memberStatus: 'departed' });
    // G-ROLE-8 residue: the underscore history add is Firestore-only.
    expect(db.all('role_history')).toHaveLength(1);
    expect(adapter.calls.some((c) => c.collection === 'role_history')).toBe(false);
  });
});
