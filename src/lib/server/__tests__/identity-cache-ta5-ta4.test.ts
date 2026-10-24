/**
 * @jest-environment node
 *
 * Read-Burn A hardening tests (TEST-TA5-TA4):
 *
 * - T-A5 extension (security review S2-8 / C-5, plan §2.4 + §5):
 *   two-concurrent-waiters rejection - two callers join ONE in-flight
 *   load, the loader rejects with RESOURCE_EXHAUSTED; BOTH waiters
 *   receive the SAME rejection, no unhandled rejection is raised, no
 *   settled entry remains, and a subsequent read retries cleanly.
 *   Plus the "waiter that never promptly handles" case: the module's
 *   internal no-op rejection branch (§2.4 item 3) must keep a rejected
 *   shared load from surfacing as an unhandled rejection even when
 *   the only waiter attaches its handler late, while the late handler
 *   still receives the rejection.
 *   Plus the custom-subject throwing-doc-get pin (S2-6 / C-5): a
 *   throwing roleDefinitions get inside hasServerPermission for a
 *   CUSTOM subject yields the static-config fallback (NOT
 *   deny-by-absence converted into a cached {exists:false}), caches
 *   nothing, and a retry after the throw clears reads the real doc.
 *
 * - T-A4 creation variant (security review S2-10 / C-6, plan §2.2 +
 *   §2.5 end + §5): a negatively-cached missing identity/role record
 *   becomes visible IMMEDIATELY after a mapped creation path
 *   (assignRole W1 creating roles/{uid}; governor grant W14 creating
 *   roles/{uid} via batch.set merge), and within the stated <=30s
 *   bound (invisible at +29s, visible at +31s, injected clock) for
 *   out-of-band creation (docs seeded directly into the store, no
 *   bust).
 *
 * Zero real Firestore access: CountingFirestore / deferred loaders /
 * the governors register fake only (jest mocks/fakes throughout).
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
  adminDb: null,
  getAdminStorage: () => null,
  getLastAdminError: () => null,
  getAdminDiagnostics: () => ({}),
}));
jest.mock('firebase/auth', () => ({ getAuth: jest.fn() }));
jest.mock('@/firebase', () => ({ getFirebaseApp: jest.fn() }));
jest.mock('@/firebase/error-emitter', () => ({ errorEmitter: { emit: jest.fn() } }));
jest.mock('@/firebase/errors', () => ({
  FirestorePermissionError: class FirestorePermissionError extends Error {
    constructor() { super('permission-error'); }
  },
}));
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));
jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn().mockResolvedValue('audit-1'),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
}));
jest.mock('@/lib/server/consent-gate', () => {
  const types = jest.requireActual('@/lib/server/consent-gate-types');
  return {
    ...types,
    assertConsentFor: jest.fn(async () => ({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' })),
    consentGateHttpError: (err: unknown) => ({
      status: 500,
      body: { error: 'CONSENT_GATE_ERROR', message: String(err) },
    }),
  };
});

import { NextRequest } from 'next/server';
import { CountingFirestore, resourceExhaustedError } from './helpers/counting-firestore';
import {
  getIdentityBundle,
  getPermissionDoc,
  resetIdentityCache,
  type IdentityBundle,
} from '../identity-cache';
import * as serverPerms from '../permissions';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assignRole } from '../role-writes';
import { FOUNDER_UID } from '@/lib/roles';

const CHAPTER = 'seds-ist-chapter';
const CUSTOM = 'custom_poster_team_lead';

function bundle(role: string, loadedAt: number): IdentityBundle {
  return {
    roles: { exists: true, role, additionalRoles: undefined, expiresAt: undefined, expiresRoleKey: undefined, chapterId: CHAPTER },
    users: { exists: true, role, displayRole: undefined, additionalRoles: undefined, isBanned: false, chapterId: CHAPTER },
    loadedAt,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Collect unhandled rejections raised while the collector is live. */
function collectUnhandledRejections() {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', handler);
  return {
    seen,
    stop: () => { process.off('unhandledRejection', handler); },
  };
}

/** A manually-released gate so concurrent waiters deterministically
 * join the SAME in-flight load before it settles. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function req(path: string, uid: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { authorization: `Bearer tok:${uid}` },
  });
}

beforeEach(() => {
  resetIdentityCache();
  mockDbHolder.db = null;
});

// ==================================================================
// T-A5 extension - two concurrent waiters, shared rejection (C-5)
// ==================================================================
describe('T-A5 concurrent waiters - identity bundle rejection (S2-8/C-5)', () => {
  it('both waiters on one in-flight load receive the SAME rejection; nothing settled remains; retry is clean', async () => {
    const collector = collectUnhandledRejections();
    try {
      const quota = resourceExhaustedError();
      const g = gate();
      let loads = 0;
      const loader = async (): Promise<IdentityBundle> => {
        loads++;
        await g.promise;
        throw quota;
      };
      const p1 = getIdentityBundle('waiter-1', loader);
      const p2 = getIdentityBundle('waiter-1', loader);
      // Let both callers join the in-flight load, then fail it once.
      await sleep(0);
      g.release();
      const [r1, r2] = await Promise.allSettled([p1, p2]);
      // One loader run served both waiters (in-flight dedupe held).
      expect(loads).toBe(1);
      expect(r1.status).toBe('rejected');
      expect(r2.status).toBe('rejected');
      if (r1.status === 'rejected' && r2.status === 'rejected') {
        // The SAME rejection object reaches every waiter.
        expect(r1.reason).toBe(quota);
        expect(r2.reason).toBe(quota);
      }
      // No unhandled rejection from either waiter path.
      await sleep(25);
      expect(collector.seen).toEqual([]);
      // No settled entry remains: the next read starts a FRESH load
      // (loader runs again) and succeeds once the outage clears.
      const ok = await getIdentityBundle('waiter-1', async () => {
        loads++;
        return bundle('member', Date.now());
      });
      expect(loads).toBe(2);
      expect(ok.roles?.role).toBe('member');
      // ...and that successful retry IS cached (sanity: the rejection
      // did not poison the key in either direction).
      const warm = await getIdentityBundle('waiter-1', async () => {
        loads++;
        return bundle('admin', Date.now());
      });
      expect(loads).toBe(2);
      expect(warm.roles?.role).toBe('member');
    } finally {
      collector.stop();
    }
  });

  it('a waiter that attaches its handler LATE still gets the rejection, and no unhandled rejection is raised in between (§2.4 item 3)', async () => {
    const collector = collectUnhandledRejections();
    try {
      const quota = resourceExhaustedError();
      let attempts = 0;
      // Deliberately do NOT attach any handler yet: this is the
      // "waiter that has already returned" corner - only the module's
      // internal no-op rejection branch can keep this from becoming
      // an unhandled rejection.
      const p = getIdentityBundle('late-1', async (): Promise<IdentityBundle> => {
        attempts++;
        throw quota;
      });
      await sleep(50);
      expect(collector.seen).toEqual([]);
      // The original promise still delivers the rejection to the
      // (late) waiter.
      await expect(p).rejects.toBe(quota);
      expect(attempts).toBe(1);
      // Nothing settled: a retry runs the loader again and succeeds.
      const ok = await getIdentityBundle('late-1', async () => {
        attempts++;
        return bundle('member', Date.now());
      });
      expect(attempts).toBe(2);
      expect(ok.roles?.role).toBe('member');
    } finally {
      collector.stop();
    }
  });

  it('permission-doc tier: both waiters receive the same rejection; nothing is cached as {exists:false}; retry reads the real doc', async () => {
    const collector = collectUnhandledRejections();
    try {
      const quota = resourceExhaustedError();
      const g = gate();
      let loads = 0;
      const loader = async () => {
        loads++;
        await g.promise;
        throw quota;
      };
      const p1 = getPermissionDoc('roleDefinitions', 'waiter_role', loader);
      const p2 = getPermissionDoc('roleDefinitions', 'waiter_role', loader);
      await sleep(0);
      g.release();
      const [r1, r2] = await Promise.allSettled([p1, p2]);
      expect(loads).toBe(1);
      expect(r1.status).toBe('rejected');
      expect(r2.status).toBe('rejected');
      if (r1.status === 'rejected' && r2.status === 'rejected') {
        expect(r1.reason).toBe(quota);
        expect(r2.reason).toBe(quota);
      }
      await sleep(25);
      expect(collector.seen).toEqual([]);
      // A throwing get was NOT stored as a missing doc: the retry
      // runs the loader and returns the doc that actually exists.
      const ok = await getPermissionDoc('roleDefinitions', 'waiter_role', async () => {
        loads++;
        return { exists: true, data: { permissions: ['canManageTasks'] } };
      });
      expect(loads).toBe(2);
      expect(ok.exists).toBe(true);
      expect(ok.data?.permissions).toEqual(['canManageTasks']);
    } finally {
      collector.stop();
    }
  });

  it('permission-doc tier: a late-handled rejection raises no unhandled rejection (§2.4 item 3)', async () => {
    const collector = collectUnhandledRejections();
    try {
      const quota = resourceExhaustedError();
      const p = getPermissionDoc('permissions', 'late_role', async () => { throw quota; });
      await sleep(50);
      expect(collector.seen).toEqual([]);
      await expect(p).rejects.toBe(quota);
    } finally {
      collector.stop();
    }
  });

  it('integration: two concurrent verifyAuthentication calls for one uid BOTH land in the identical 401 outcome; a third call after the outage succeeds', async () => {
    const collector = collectUnhandledRejections();
    try {
      const counting = new CountingFirestore();
      mockDbHolder.db = counting.asDb();
      counting.seed('roles', 'member-1', { role: 'member', chapterId: CHAPTER });
      counting.seed('users', 'member-1', { isBanned: false, chapterId: CHAPTER });

      counting.setThrow('roles', resourceExhaustedError());
      const [a, b] = await Promise.all([
        verifyAuthentication(req('/api/test', 'member-1')),
        verifyAuthentication(req('/api/test', 'member-1')),
      ]);
      // Identical pre-change outcome for BOTH waiters: each call's
      // own catch converts the shared rejection into the same 401.
      expect(a.authenticated).toBe(false);
      expect(b.authenticated).toBe(false);
      expect(a.error).toBe('Authentication verification failed');
      expect(b.error).toBe('Authentication verification failed');
      await sleep(25);
      expect(collector.seen).toEqual([]);

      // The rejected promise was not retained: once the throw clears,
      // a fresh call re-reads and succeeds.
      counting.setThrow(null, null);
      const third = await verifyAuthentication(req('/api/test', 'member-1'));
      expect(third.authenticated).toBe(true);
      expect(third.user?.role).toBe('member');
      expect(counting.docGetCount('roles', 'member-1')).toBeGreaterThanOrEqual(1);
    } finally {
      collector.stop();
    }
  });
});

// ==================================================================
// T-A5 pin - custom-subject throwing doc get (S2-6/C-5)
// ==================================================================
describe('T-A5 pin - custom subject, throwing roleDefinitions get (S2-6/C-5)', () => {
  it('yields the static-config fallback (NOT deny-by-absence), caches nothing, and the retry answers from the real doc', async () => {
    const counting = new CountingFirestore();
    mockDbHolder.db = counting.asDb();
    const db = counting.asDb();
    void db;
    // The custom definition EXISTS in the store and grants the key.
    counting.seed('roleDefinitions', CUSTOM, {
      isCustom: true, parentRoleKey: 'chapter_design_chair', chapterId: CHAPTER,
      name: 'Poster Team Lead', permissions: ['canManageTasks'],
    });

    counting.setThrow('roleDefinitions', resourceExhaustedError());
    const duringOutage = await serverPerms.hasServerPermission(CUSTOM, 'canManageTasks');
    counting.setThrow(null, null);
    // Static-config fallback: a custom_* slug has no static-config
    // grant, so the fallback answer is false. NOTE (honest scope):
    // deny-by-absence for a missing custom definition is ALSO false,
    // so this answer alone cannot distinguish the two paths - the
    // distinguishing assertion is the retry below: had the throw
    // been converted into a CACHED {exists:false}, the retry would
    // still answer false without ever reading the real doc.
    expect(duringOutage).toBe(false);

    const after = await serverPerms.hasServerPermission(CUSTOM, 'canManageTasks');
    expect(after).toBe(true);
    // The retry really read the doc (the throw was never cached as
    // an absence, and no stale absence entry answered for it).
    expect(counting.docGetCount('roleDefinitions', CUSTOM)).toBeGreaterThanOrEqual(1);

    // Sanity: the successful read is now cached - a repeat call
    // answers true with no further doc gets for that slug.
    counting.resetCounts();
    const warm = await serverPerms.hasServerPermission(CUSTOM, 'canManageTasks');
    expect(warm).toBe(true);
    expect(counting.docGetCount('roleDefinitions', CUSTOM)).toBe(0);
  });
});

// ==================================================================
// T-A4 creation variant - mapped paths are immediate (C-6)
// ==================================================================
describe('T-A4 creation variant - mapped creation paths (S2-10/C-6)', () => {
  it('W1 assignRole: a negatively-cached unknown uid becomes visible immediately after its first assignRole creates roles/{uid}', async () => {
    const counting = new CountingFirestore();
    mockDbHolder.db = counting.asDb();
    const db = counting.asDb();
    counting.seed('roles', FOUNDER_UID, { role: 'founder_patron', chapterId: CHAPTER });
    counting.seed('users', FOUNDER_UID, { isBanned: false, chapterId: CHAPTER });
    // NOTE: no roles/{new-1} and no users/{new-1} docs exist at all.

    // Warm the NEGATIVE bundle: both docs missing is a cached answer.
    const negative = await serverPerms.getIdentityBundleCached(db, 'new-1');
    expect(negative.roles?.exists).toBe(false);
    expect(negative.users?.exists).toBe(false);
    const floored = await serverPerms.resolveIdentityForAuth(db, 'new-1');
    expect(floored.role).toBe('member_basic'); // the §2.2 floor
    expect(floored.isBanned).toBe(false);
    // The negative bundle really is cached (no re-read on repeat).
    counting.resetCounts();
    const warmNegative = await serverPerms.getIdentityBundleCached(db, 'new-1');
    expect(warmNegative.roles?.exists).toBe(false);
    expect(counting.docGetCount('roles', 'new-1')).toBe(0);
    expect(counting.docGetCount('users', 'new-1')).toBe(0);

    // Mapped creation: the FIRST assignRole creates roles/{uid}
    // (and the users mirror) in its batch and busts after commit (W1).
    await assignRole(db, {
      uid: 'new-1',
      role: 'chapter_president',
      chapterId: CHAPTER,
      actorUid: FOUNDER_UID,
      reason: 'first role granted after signup',
      source: 'admin_ui',
      idempotencyKey: 'ta4-create-w1-1',
    });
    expect(counting.read('roles', 'new-1')?.role).toBe('chapter_president');

    // Visible IMMEDIATELY, zero clock advance, no manual bust.
    const after = await serverPerms.resolveIdentityForAuth(db, 'new-1');
    expect(after.role).toBe('chapter_president');
    const afterBundle = await serverPerms.getIdentityBundleCached(db, 'new-1');
    expect(afterBundle.roles?.exists).toBe(true);
    expect(afterBundle.users?.exists).toBe(true);
  });
});

// ------------------------------------------------------------------
// W14 governor grant - uses the governors register test fake (the
// register's own store shape), copied from
// governors/__tests__/register.test.ts. The SAME fake db object is
// passed to the permissions bundle reads, so the cache scope and the
// write path share one store, exactly like production's one handle.
// ------------------------------------------------------------------
type GovDocData = Record<string, unknown>;

function govIsDeleteTransform(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { constructor?: { name?: string } }).constructor?.name?.includes('Transform') === true
  );
}

class GovFakeStore {
  data = new Map<string, Map<string, GovDocData>>();
  private autoId = 0;
  col(name: string): Map<string, GovDocData> {
    if (!this.data.has(name)) this.data.set(name, new Map());
    return this.data.get(name) as Map<string, GovDocData>;
  }
  nextId(): string {
    this.autoId += 1;
    return `auto-${this.autoId}`;
  }
  applySet(colName: string, id: string, data: GovDocData, merge: boolean) {
    const col = this.col(colName);
    const base = merge ? { ...(col.get(id) ?? {}) } : {};
    for (const [k, v] of Object.entries(data)) {
      if (govIsDeleteTransform(v)) delete base[k];
      else base[k] = v;
    }
    col.set(id, base);
  }
  applyUpdate(colName: string, id: string, data: GovDocData) {
    this.applySet(colName, id, data, true);
  }
}

interface GovFakeRef {
  __col: string;
  __id: string;
  id: string;
  get: () => Promise<{ exists: boolean; id: string; data: () => GovDocData | undefined }>;
  update: (data: GovDocData) => Promise<void>;
  collection: (name: string) => ReturnType<typeof govMakeCollection>;
}

function govMakeCollection(store: GovFakeStore, name: string) {
  return {
    doc: (id?: string) => {
      const docId = id ?? store.nextId();
      const ref: GovFakeRef = {
        __col: name,
        __id: docId,
        id: docId,
        get: async () => {
          const data = store.col(name).get(docId);
          return { exists: data !== undefined, id: docId, data: () => data };
        },
        update: async (data: GovDocData) => {
          store.applyUpdate(name, docId, data);
        },
        collection: (sub: string) => govMakeCollection(store, `${name}/${docId}/${sub}`),
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

function govMakeDb(store: GovFakeStore) {
  const db = {
    __store: store,
    collection: (name: string) => govMakeCollection(store, name),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (ref: GovFakeRef, data: GovDocData, opts?: { merge?: boolean }) => {
          ops.push(() => store.applySet(ref.__col, ref.__id, data, opts?.merge === true));
        },
        update: (ref: GovFakeRef, data: GovDocData) => {
          ops.push(() => store.applyUpdate(ref.__col, ref.__id, data));
        },
        delete: (ref: GovFakeRef) => {
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

describe('T-A4 creation variant - W14 governor grant (S2-10/C-6)', () => {
  it('a negatively-cached missing roles/{uid} is created by the governor grant and visible immediately', async () => {
    const { assignSeat, seedGovernors } = await import('../governors/register');
    const { FOUNDER_UID: govFounderUid } = await import('@/lib/roles');
    const store = new GovFakeStore();
    const db = govMakeDb(store);
    const founderActor = { uid: govFounderUid, name: 'Founder', role: 'founder', authorized: true };
    await seedGovernors(db, founderActor, {
      founderHolder: { uid: govFounderUid, name: 'The Founder', email: 'founder@example.com' },
    });
    // The holder-to-be has a users/{uid} doc (the grant block requires
    // it) but NO roles/{uid} doc - the negative-caching creation case
    // for W14: grantGovernorRole's batch.set(..., {merge:true})
    // CREATES roles/{uid}.
    store.col('users').set('gov-new-1', { role: 'member', displayName: 'Holder gov-new-1' });
    expect(store.col('roles').has('gov-new-1')).toBe(false);

    // Warm the negative-for-roles bundle.
    const negative = await serverPerms.getIdentityBundleCached(db, 'gov-new-1');
    expect(negative.roles?.exists).toBe(false);
    expect(negative.users?.exists).toBe(true);
    const floored = await serverPerms.resolveIdentityForAuth(db, 'gov-new-1');
    expect(floored.role).toBe('member');

    store.col('consent_requests').set('consent-seat_fa_1', { status: 'consented' });
    const view = await assignSeat(
      db,
      founderActor,
      'seat_fa_1',
      { holderUid: 'gov-new-1', holderName: 'Holder gov-new-1', consentRequestId: 'consent-seat_fa_1', expectedVersion: 1 },
      new Date('2026-10-21T10:00:00Z'),
    );
    expect(view.effectiveStatus).toBe('seated');
    // The grant really created both role stores' docs.
    expect(store.col('roles').get('gov-new-1')?.role).toBe('governor_founder');
    expect(store.col('users').get('gov-new-1')?.role).toBe('governor_founder');

    // Visible IMMEDIATELY after the mapped creation path (W14 bust
    // after the committing batch), zero clock advance, no manual bust.
    const afterBundle = await serverPerms.getIdentityBundleCached(db, 'gov-new-1');
    expect(afterBundle.roles?.exists).toBe(true);
    expect(afterBundle.roles?.role).toBe('governor_founder');
    const after = await serverPerms.resolveIdentityForAuth(db, 'gov-new-1');
    expect(after.role).toBe('governor_founder');
  });
});

// ==================================================================
// T-A4 creation variant - out-of-band creation, <=30s bound (C-6)
// ==================================================================
describe('T-A4 creation variant - out-of-band creation is TTL-bound (S2-10/C-6)', () => {
  it('identity: a directly-created roles+users pair is still floored at +29s and fully visible at +31s (injected clock)', async () => {
    const counting = new CountingFirestore();
    const t0 = 3_000_000;
    let simNow = t0;
    let loaderRuns = 0;
    // Loader mirrors loadIdentityBundle's projection, reading the
    // fake store directly; its loadedAt is the simulated store time.
    const loader = async (): Promise<IdentityBundle> => {
      loaderRuns++;
      const roleData = counting.read('roles', 'oob-1');
      const userData = counting.read('users', 'oob-1');
      return {
        roles: {
          exists: roleData !== undefined,
          role: roleData?.role,
          additionalRoles: roleData?.additionalRoles,
          expiresAt: undefined,
          expiresRoleKey: undefined,
          chapterId: roleData?.chapterId ?? null,
        },
        users: {
          exists: userData !== undefined,
          role: userData?.role,
          displayRole: userData?.displayRole,
          additionalRoles: userData?.additionalRoles,
          isBanned: userData?.isBanned === true,
          chapterId: userData?.chapterId ?? null,
        },
        loadedAt: simNow,
      };
    };

    const cold = await getIdentityBundle('oob-1', loader, { now: t0 });
    expect(cold.roles?.exists).toBe(false);
    expect(cold.users?.exists).toBe(false);
    expect(loaderRuns).toBe(1);

    // OUT-OF-BAND creation: docs written directly into the store
    // (client signup / Console / another instance) - NO bust call.
    counting.seed('roles', 'oob-1', { role: 'chapter_president', chapterId: CHAPTER });
    counting.seed('users', 'oob-1', { role: 'chapter_president', isBanned: false, chapterId: CHAPTER });

    simNow = t0 + 29_000;
    const at29 = await getIdentityBundle('oob-1', loader, { now: simNow });
    expect(at29.roles?.exists).toBe(false); // still the negative bundle
    expect(at29.users?.exists).toBe(false);
    expect(loaderRuns).toBe(1); // served from cache, no reload

    simNow = t0 + 31_000;
    const at31 = await getIdentityBundle('oob-1', loader, { now: simNow });
    expect(loaderRuns).toBe(2); // TTL expired -> fresh load
    expect(at31.roles?.exists).toBe(true);
    expect(at31.roles?.role).toBe('chapter_president');
    expect(at31.users?.exists).toBe(true);
  });

  it('permission doc: a directly-created roleDefinitions doc is invisible at +29s and visible at +31s (injected clock)', async () => {
    const counting = new CountingFirestore();
    // Anchored at the real clock: the permission-doc tier stamps
    // loadedAt with the real store-time Date.now() (C-3 pin), so the
    // injected comparison clock must start at real now for the
    // +29s/+31s ages to mean what they say.
    const t0 = Date.now();
    let loaderRuns = 0;
    const loader = async () => {
      loaderRuns++;
      const data = counting.read('roleDefinitions', 'brand_new_role');
      return { exists: data !== undefined, data };
    };

    const cold = await getPermissionDoc('roleDefinitions', 'brand_new_role', loader, { now: t0 });
    expect(cold.exists).toBe(false);
    expect(loaderRuns).toBe(1);

    // Out-of-band creation, no bust.
    counting.seed('roleDefinitions', 'brand_new_role', { name: 'Brand New', permissions: ['canManageTasks'] });

    const at29 = await getPermissionDoc('roleDefinitions', 'brand_new_role', loader, { now: t0 + 29_000 });
    expect(at29.exists).toBe(false);
    expect(loaderRuns).toBe(1);

    const at31 = await getPermissionDoc('roleDefinitions', 'brand_new_role', loader, { now: t0 + 31_000 });
    expect(at31.exists).toBe(true);
    expect(at31.data?.permissions).toEqual(['canManageTasks']);
    expect(loaderRuns).toBe(2);
  });

  it('integration (real clock): an out-of-band creation is NOT visible immediately - the floored answer persists within the TTL', async () => {
    const counting = new CountingFirestore();
    mockDbHolder.db = counting.asDb();
    const db = counting.asDb();
    // Unknown uid: negative bundle, floored.
    const floored = await serverPerms.resolveIdentityForAuth(db, 'oob-live-1');
    expect(floored.role).toBe('member_basic');
    // Direct store creation, no bust (simulates the client signup
    // setDoc at mandatory-profile-check.tsx:69 landing AFTER an early
    // authenticated request already cached the negative bundle).
    counting.seed('roles', 'oob-live-1', { role: 'chapter_president', chapterId: CHAPTER });
    counting.seed('users', 'oob-live-1', { role: 'chapter_president', isBanned: false, chapterId: CHAPTER });
    const within = await serverPerms.resolveIdentityForAuth(db, 'oob-live-1');
    expect(within.role).toBe('member_basic'); // stale within the 30s bound
    // (The +31s side of this same bound is pinned with the injected
    // clock in the unit case above, per plan §5 T-A4.)
  });
});
