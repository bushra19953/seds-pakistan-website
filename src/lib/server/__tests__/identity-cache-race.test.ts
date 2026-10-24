/**
 * @jest-environment node
 *
 * Read-Burn A hardening, T-A7 (security review S2-4 / design plan
 * §2.3 C-1, §2.4): the in-flight resurrection race, for BOTH caches
 * (identity bundle cache and permission-doc cache) and BOTH orderings.
 *
 * The defect being pinned (pre-hardening): bustIdentity /
 * bustPermissionDoc delete the settled + in-flight Map entries, but
 * deleting an entry does not cancel its promise. A loader that started
 * BEFORE a write+bust and resolves AFTER it must never store its
 * pre-write result; a stale promise resolving last must never
 * overwrite a post-bust entry; and a caller arriving AFTER the bust
 * must never receive the pre-bust promise's value as a stored entry.
 * The mechanism under test is the per-key generation protocol
 * (plan §2.3 steps 1-4): capture generation before the loader starts,
 * bust increments it, a loader stores only if its captured generation
 * is still current at resolve, and in-flight cleanup on settle is
 * identity-checked so a stale promise cannot evict a newer entry.
 *
 * Disclosed softening (plan §2.3, accepted by the review): waiters who
 * joined a load BEFORE the bust may still receive that load's value
 * for their own in-progress call - the same semantics as a request
 * that had already passed verifyAuthentication when the write
 * committed. What is pinned here is that the stale value is never
 * STORED and never served to a post-bust arrival.
 *
 * All loaders are controllable deferred fakes: zero Firestore access.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        const uid = token.startsWith('tok:') ? token.slice(4) : token;
        return { uid, email: `${uid}@example.com`, email_verified: true, name: uid };
      },
    }),
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'ts',
        increment: (n: number) => ({ __increment: n }),
        delete: () => ({ __delete: true }),
      },
    },
  },
}));
jest.mock('firebase/auth', () => ({ getAuth: jest.fn() }));
jest.mock('@/firebase', () => ({ getFirebaseApp: jest.fn() }));
jest.mock('@/firebase/error-emitter', () => ({ errorEmitter: { emit: jest.fn() } }));
jest.mock('@/firebase/errors', () => ({
  FirestorePermissionError: class FirestorePermissionError extends Error {
    constructor() { super('permission-error'); }
  },
}));

import {
  getIdentityBundle,
  getPermissionDoc,
  bustIdentity,
  bustPermissionDoc,
  resetIdentityCache,
  type IdentityBundle,
  type PermissionDocEntry,
} from '../identity-cache';
import * as serverPerms from '../permissions';

// ------------------------------------------------------------------
// Deferred-loader harness
// ------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Drain pending microtasks (loader starts, finally cleanups). */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function bundle(role: string, additionalRoles?: string[]): IdentityBundle {
  return {
    roles: {
      exists: true, role,
      additionalRoles,
      expiresAt: undefined, expiresRoleKey: undefined, chapterId: null,
    },
    users: {
      exists: true, role, displayRole: undefined,
      additionalRoles,
      isBanned: false, chapterId: null,
    },
    loadedAt: Date.now(),
  };
}

function docEntry(permissions: string[]): PermissionDocEntry {
  return { exists: true, data: { permissions } };
}

beforeEach(() => {
  resetIdentityCache();
  mockDbHolder.db = null;
});

// ==================================================================
// T-A7 - identity bundle cache
// ==================================================================

describe('T-A7 identity cache - ordering 1: bust lands mid-flight, stale load resolves after', () => {
  it('the stale resolution is never stored: the next read returns post-write data', async () => {
    const uid = 'race-id-1';
    const stale = deferred<IdentityBundle>();
    let staleLoads = 0;
    const p1 = getIdentityBundle(uid, () => { staleLoads++; return stale.promise; });
    expect(staleLoads).toBe(1);

    // Write commits + bust while the pre-write load is still in flight.
    bustIdentity(uid);

    // The pre-write load now resolves with pre-write data.
    stale.resolve(bundle('member'));
    const waiterValue = await p1;
    // The pre-bust waiter itself may keep its in-progress value
    // (disclosed softening); it must not become a stored entry.
    expect(waiterValue.roles?.role).toBe('member');

    let postLoads = 0;
    const next = await getIdentityBundle(uid, async () => { postLoads++; return bundle('chapter_president'); });
    expect(postLoads).toBe(1); // a fresh load ran - the stale value was not served from cache
    expect(next.roles?.role).toBe('chapter_president');

    // And the post-write value is now the settled entry.
    const settled = await getIdentityBundle(uid, async () => { postLoads++; return bundle('member'); });
    expect(postLoads).toBe(1);
    expect(settled.roles?.role).toBe('chapter_president');
  });

  it('a post-bust arrival never receives the pre-bust promise value as a stored entry', async () => {
    const uid = 'race-id-2';
    const stale = deferred<IdentityBundle>();
    const p1 = getIdentityBundle(uid, () => stale.promise);
    void p1;

    bustIdentity(uid);

    // Arrival AFTER the bust, while the stale load is still pending:
    // it must start (or join) a post-bust load, never the pre-bust one.
    const fresh = deferred<IdentityBundle>();
    let freshLoads = 0;
    const p2 = getIdentityBundle(uid, () => { freshLoads++; return fresh.promise; });
    expect(freshLoads).toBe(1);

    // Stale resolves first, fresh second.
    stale.resolve(bundle('member'));
    await flush();

    // The stale resolution must not have become a stored entry: an
    // arrival NOW (fresh load still in flight) must join the fresh
    // load, never be served the stale value from a settled entry.
    let thirdLoads = 0;
    const p3 = getIdentityBundle(uid, async () => { thirdLoads++; return bundle('member'); });
    expect(thirdLoads).toBe(0);

    fresh.resolve(bundle('chapter_president'));

    expect((await p3).roles?.role).toBe('chapter_president');
    expect((await p2).roles?.role).toBe('chapter_president');
    // The stored entry is the post-bust value, not the stale one.
    let extraLoads = 0;
    const stored = await getIdentityBundle(uid, async () => { extraLoads++; return bundle('member'); });
    expect(extraLoads).toBe(0);
    expect(stored.roles?.role).toBe('chapter_president');
  });
});

describe('T-A7 identity cache - ordering 2: post-bust load settles first, stale load resolves last', () => {
  it('the stale resolution does not overwrite the post-bust entry', async () => {
    const uid = 'race-id-3';
    const stale = deferred<IdentityBundle>();
    const p1 = getIdentityBundle(uid, () => stale.promise);
    void p1;

    bustIdentity(uid);

    // Post-bust load starts and settles with post-write data.
    const fresh = await getIdentityBundle(uid, async () => bundle('chapter_president'));
    expect(fresh.roles?.role).toBe('chapter_president');

    // The pre-bust promise resolves LAST.
    stale.resolve(bundle('member'));
    await flush();

    let extraLoads = 0;
    const after = await getIdentityBundle(uid, async () => { extraLoads++; return bundle('member'); });
    expect(extraLoads).toBe(0); // still the settled post-bust entry
    expect(after.roles?.role).toBe('chapter_president');
  });

  it('stale settle cleanup does not evict the newer post-bust in-flight entry (S2-4)', async () => {
    const uid = 'race-id-4';
    const stale = deferred<IdentityBundle>();
    const p1 = getIdentityBundle(uid, () => stale.promise);
    void p1;

    bustIdentity(uid);

    // Post-bust load starts and is still in flight.
    const fresh = deferred<IdentityBundle>();
    let freshLoads = 0;
    const p2 = getIdentityBundle(uid, () => { freshLoads++; return fresh.promise; });
    expect(freshLoads).toBe(1);

    // The stale promise settles while the fresh load is in flight.
    // Its cleanup must be identity-checked: it must not delete the
    // fresh load's in-flight entry.
    stale.resolve(bundle('member'));
    await flush();

    // A third arrival must JOIN the fresh in-flight load, not start
    // a third loader run and not receive the stale stored value.
    let thirdLoads = 0;
    const p3 = getIdentityBundle(uid, async () => { thirdLoads++; return bundle('member'); });
    expect(thirdLoads).toBe(0);

    fresh.resolve(bundle('chapter_president'));
    expect((await p2).roles?.role).toBe('chapter_president');
    expect((await p3).roles?.role).toBe('chapter_president');
    expect(freshLoads).toBe(1);
  });
});

// ==================================================================
// T-A7 - permission-doc cache
// ==================================================================

describe('T-A7 permission-doc cache - ordering 1: bust lands mid-flight, stale load resolves after', () => {
  it('the stale resolution is never stored: the next read returns post-write data', async () => {
    const stale = deferred<PermissionDocEntry>();
    let staleLoads = 0;
    const p1 = getPermissionDoc('roleDefinitions', 'race_slug', () => { staleLoads++; return stale.promise; });
    expect(staleLoads).toBe(1);

    // Definition edit commits + bust while the pre-edit load is in flight.
    bustPermissionDoc('roleDefinitions', 'race_slug');

    stale.resolve(docEntry(['canManageTasks']));
    const waiterValue = await p1;
    expect(waiterValue.data?.permissions).toEqual(['canManageTasks']); // in-progress waiter only

    let postLoads = 0;
    const next = await getPermissionDoc('roleDefinitions', 'race_slug', async () => {
      postLoads++;
      return docEntry(['canManageTasks', 'canManageUsers']);
    });
    expect(postLoads).toBe(1);
    expect(next.data?.permissions).toEqual(['canManageTasks', 'canManageUsers']);

    const settled = await getPermissionDoc('roleDefinitions', 'race_slug', async () => { postLoads++; return docEntry([]); });
    expect(postLoads).toBe(1);
    expect(settled.data?.permissions).toEqual(['canManageTasks', 'canManageUsers']);
  });

  it('a post-bust arrival never receives the pre-bust promise value as a stored entry', async () => {
    const stale = deferred<PermissionDocEntry>();
    const p1 = getPermissionDoc('permissions', 'race_slug', () => stale.promise);
    void p1;

    bustPermissionDoc('permissions', 'race_slug');

    const fresh = deferred<PermissionDocEntry>();
    let freshLoads = 0;
    const p2 = getPermissionDoc('permissions', 'race_slug', () => { freshLoads++; return fresh.promise; });
    expect(freshLoads).toBe(1); // did not join the pre-bust promise

    stale.resolve(docEntry([]));
    await flush();

    // Same stored-entry pin as the identity cache: an arrival after
    // the stale resolution (fresh load still in flight) must join the
    // fresh load, not be served the stale entry.
    let thirdLoads = 0;
    const p3 = getPermissionDoc('permissions', 'race_slug', async () => { thirdLoads++; return docEntry([]); });
    expect(thirdLoads).toBe(0);

    fresh.resolve(docEntry(['canManageUsers']));

    expect((await p3).data?.permissions).toEqual(['canManageUsers']);
    expect((await p2).data?.permissions).toEqual(['canManageUsers']);
    let extraLoads = 0;
    const stored = await getPermissionDoc('permissions', 'race_slug', async () => { extraLoads++; return docEntry([]); });
    expect(extraLoads).toBe(0);
    expect(stored.data?.permissions).toEqual(['canManageUsers']);
  });
});

describe('T-A7 permission-doc cache - ordering 2: post-bust load settles first, stale load resolves last', () => {
  it('the stale resolution does not overwrite the post-bust entry', async () => {
    const stale = deferred<PermissionDocEntry>();
    const p1 = getPermissionDoc('roleDefinitions', 'race_slug_2', () => stale.promise);
    void p1;

    bustPermissionDoc('roleDefinitions', 'race_slug_2');

    const fresh = await getPermissionDoc('roleDefinitions', 'race_slug_2', async () => docEntry(['canManageUsers']));
    expect(fresh.data?.permissions).toEqual(['canManageUsers']);

    stale.resolve(docEntry([]));
    await flush();

    let extraLoads = 0;
    const after = await getPermissionDoc('roleDefinitions', 'race_slug_2', async () => { extraLoads++; return docEntry([]); });
    expect(extraLoads).toBe(0);
    expect(after.data?.permissions).toEqual(['canManageUsers']);
  });

  it('stale settle cleanup does not evict the newer post-bust in-flight entry (S2-4)', async () => {
    const stale = deferred<PermissionDocEntry>();
    const p1 = getPermissionDoc('permissions', 'race_slug_2', () => stale.promise);
    void p1;

    bustPermissionDoc('permissions', 'race_slug_2');

    const fresh = deferred<PermissionDocEntry>();
    let freshLoads = 0;
    const p2 = getPermissionDoc('permissions', 'race_slug_2', () => { freshLoads++; return fresh.promise; });
    expect(freshLoads).toBe(1);

    stale.resolve(docEntry([]));
    await flush();

    let thirdLoads = 0;
    const p3 = getPermissionDoc('permissions', 'race_slug_2', async () => { thirdLoads++; return docEntry([]); });
    expect(thirdLoads).toBe(0); // joined the fresh in-flight load

    fresh.resolve(docEntry(['canManageUsers']));
    expect((await p2).data?.permissions).toEqual(['canManageUsers']);
    expect((await p3).data?.permissions).toEqual(['canManageUsers']);
    expect(freshLoads).toBe(1);
  });
});

// ==================================================================
// T-A7 - end-to-end through permissions.ts against a deferred fake
// ==================================================================

/**
 * Minimal Firestore-shaped stub whose doc gets capture the store
 * contents at CALL time and stay pending until the test resolves them
 * - the exact shape of "Firestore get in flight while a write commits".
 */
class DeferredStore {
  private docs = new Map<string, Record<string, unknown>>();
  pending: Array<{ key: string; resolve: () => void }> = [];

  seed(collection: string, id: string, data: Record<string, unknown>): void {
    this.docs.set(`${collection}/${id}`, { ...data });
  }

  collection(name: string) {
    const self = this;
    return {
      doc(id: string) {
        return {
          async get() {
            const captured = self.docs.get(`${name}/${id}`);
            const snapshot = captured ? { ...captured } : undefined;
            const d = deferred<{ exists: boolean; id: string; data: () => Record<string, unknown> | undefined }>();
            self.pending.push({
              key: `${name}/${id}`,
              resolve: () => d.resolve({
                exists: snapshot !== undefined,
                id,
                data: () => snapshot,
              }),
            });
            return d.promise;
          },
        };
      },
    };
  }

  /** Resolve every currently-pending get with its captured snapshot. */
  resolvePending(): void {
    const batch = this.pending.splice(0, this.pending.length);
    for (const p of batch) p.resolve();
  }

  asDb(): never {
    return this as unknown as never;
  }
}

/** Keep resolving gets (sequential slug walks) until none are pending. */
async function drainGets(store: DeferredStore): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await flush(3);
    if (store.pending.length === 0) return;
    store.resolvePending();
  }
  throw new Error('drainGets: gets still pending after 30 rounds');
}

describe('T-A7 end-to-end - identity race through resolveCanonicalRole (ordering 1)', () => {
  it('a role write + bust racing an in-flight bundle load: the next resolution is post-write', async () => {
    const store = new DeferredStore();
    const db = store.asDb();
    store.seed('roles', 'race-user', { role: 'member', chapterId: 'seds-ist-chapter' });
    store.seed('users', 'race-user', { role: 'member', isBanned: false, chapterId: 'seds-ist-chapter' });

    // Load starts; both doc gets are in flight with pre-write snapshots.
    const p1 = serverPerms.resolveCanonicalRole(db, 'race-user');
    await flush();
    expect(store.pending.map((p) => p.key).sort()).toEqual(['roles/race-user', 'users/race-user']);

    // The write commits and busts mid-flight.
    store.seed('roles', 'race-user', { role: 'chapter_president', chapterId: 'seds-ist-chapter' });
    bustIdentity('race-user');

    // The in-flight gets resolve with the pre-write snapshots.
    store.resolvePending();
    expect(await p1).toBe('member'); // in-progress waiter semantics only

    // The NEXT resolution must re-read and return the post-write role.
    const p2 = serverPerms.resolveCanonicalRole(db, 'race-user');
    await drainGets(store);
    expect(await p2).toBe('chapter_president');
  });
});

describe('T-A7 end-to-end - permission-doc race through hasServerPermission (ordering 1)', () => {
  it('a definition edit + bust racing an in-flight doc load: the next check uses the edited definition', async () => {
    const store = new DeferredStore();
    mockDbHolder.db = store.asDb();
    store.seed('roleDefinitions', 'chapter_president', { name: 'Chapter President', permissions: ['canManageTasks'] });

    // Check starts; the roleDefinitions get is in flight (pre-edit snapshot).
    const p1 = serverPerms.hasServerPermission('chapter_president', 'canManageUsers');
    await flush();
    expect(store.pending.length).toBeGreaterThanOrEqual(1);
    expect(store.pending[0].key).toBe('roleDefinitions/chapter_president');

    // The definition edit commits and busts mid-flight.
    store.seed('roleDefinitions', 'chapter_president', {
      name: 'Chapter President', permissions: ['canManageTasks', 'canManageUsers'],
    });
    bustPermissionDoc('roleDefinitions', 'chapter_president');
    bustPermissionDoc('permissions', 'chapter_president');

    // The in-flight check finishes on its pre-edit snapshot.
    const draining = drainGets(store);
    expect(await p1).toBe(false);
    await draining;

    // The NEXT check must re-read and honor the edited definition -
    // the stale pre-edit doc must not have been stored by the race.
    const p2 = serverPerms.hasServerPermission('chapter_president', 'canManageUsers');
    await drainGets(store);
    expect(await p2).toBe(true);
  });
});
