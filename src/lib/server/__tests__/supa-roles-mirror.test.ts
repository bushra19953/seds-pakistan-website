/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION — ROLES cluster, chokepoint mirror port.
 *
 * The mirror under test is mirrorRoleWriteToSupa in
 * src/lib/server/role-writes.ts, ported from the roles G2 reference
 * (feat/supa-roles-2, BUILDOUT_REPORT.md §G2) onto the LANDED
 * architecture: the roles-1 seam (src/lib/server/supa-roles-seam.ts,
 * R19 shape-translating shim) plus the landed route helpers
 * (src/lib/server/supa-roles-route.ts, Date -> ISO mirror wrappers).
 * The adapter is injected AT THE LANDED SEAM BOUNDARY
 * (__setSupaAdapterForTests on supa-roles-seam, whose SupaAdapter is
 * the seam-shaped { exists, data } interface), exactly as
 * supa-roles-seam.test.ts / supa-roles-flag-states.test.ts inject.
 *
 * Pins (modeled on the reference branch's mirror cases):
 *   - flag ON, assign: post-commit mirror of BOTH docs (roles +
 *     users, exact post-write Firestore state) + the roleHistory
 *     entry, its serverTimestamp createdAt mirrored as ISO string;
 *   - flag ON, remove: roles doc delete-mirrored, users + history
 *     set-mirrored;
 *   - doc absent -> delete-mirror (direct mirror call, both docs);
 *   - adapter mirror throws -> swallowed by the seam, the primary
 *     Firestore write still succeeds; a re-read failure inside the
 *     mirror is swallowed (logged) and never throws;
 *   - flag OFF -> adapter NEVER called (byte-identical behaviour);
 *   - no adapter -> mirror disabled, write succeeds;
 *   - audit_logs / authority_refresh are NEVER mirrored;
 *   - idempotent replay (no commit) does not mirror; setMirror
 *     (repair path, not an assign/remove commit) does not mirror.
 *
 * ZERO live reads: Firestore is the in-memory FakeFirestore and the
 * adapter is an in-memory fake.
 */
import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';
import {
  assignRole,
  mirrorRoleWriteToSupa,
  removeRole,
  setMirror,
} from '../role-writes';
import {
  __setSupaAdapterForTests,
  type SupaAdapter,
} from '../supa-roles-seam';

const ADMIN = 'admin-actor-uid';
const TARGET = 'target-user-uid';
const REASON = 'Appointed by the National President, October 2026 intake';

interface FakeAdapter {
  useSupa: jest.Mock;
  getDoc: jest.Mock;
  listDocs: jest.Mock;
  setDoc: jest.Mock;
  updateDoc: jest.Mock;
  deleteDoc: jest.Mock;
}

function makeAdapter(over: Partial<FakeAdapter> = {}): FakeAdapter {
  return {
    useSupa: jest.fn(() => true),
    getDoc: jest.fn(async () => ({ exists: false })),
    listDocs: jest.fn(async () => []),
    setDoc: jest.fn(async () => undefined),
    updateDoc: jest.fn(async () => undefined),
    deleteDoc: jest.fn(async () => undefined),
    ...over,
  } as FakeAdapter;
}

function inject(adapter: FakeAdapter | null): void {
  __setSupaAdapterForTests(adapter as unknown as SupaAdapter | null);
}

/** [collection, id, data] triples for every adapter setDoc call. */
function setCalls(adapter: FakeAdapter): Array<[string, string, Record<string, unknown>]> {
  return adapter.setDoc.mock.calls as Array<[string, string, Record<string, unknown>]>;
}

function freshDb(): FakeFirestore {
  const db = new FakeFirestore();
  db.seed('users', TARGET, { displayName: 'Target User', chapterId: 'seds-ist-chapter' });
  return db;
}

beforeEach(() => {
  inject(null);
});
afterEach(() => {
  inject(null);
  jest.restoreAllMocks();
});

describe('flag ON: assign mirrors post-commit state', () => {
  it('mirrors roles + users full docs and the roleHistory entry (ISO createdAt)', async () => {
    const db = freshDb();
    const adapter = makeAdapter();
    inject(adapter);

    const result = await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'chapter_president',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      claimsAuth: null,
    });
    expect(result.alreadyApplied).toBe(false);

    const calls = setCalls(adapter);
    const byCollection = new Map(calls.map(([c, id, d]) => [c, { id, d }]));

    // roles: the exact post-write Firestore doc.
    const fsRole = db.read('roles', TARGET)!;
    expect(byCollection.get('roles')?.id).toBe(TARGET);
    expect(byCollection.get('roles')?.d).toMatchObject({
      role: 'chapter_president',
      chapterId: 'seds-ist-chapter',
      schemaVersion: 2,
    });
    expect(byCollection.get('roles')?.d.role).toBe(fsRole.role);

    // users: the exact post-write mirror doc.
    expect(byCollection.get('users')?.id).toBe(TARGET);
    expect(byCollection.get('users')?.d).toMatchObject({
      role: 'chapter_president',
      displayRole: 'chapter_president',
      displayName: 'Target User',
    });

    // roleHistory: same id as the Firestore entry, payload mirrored,
    // createdAt carried as an ISO string (Firestore holds the
    // serverTimestamp sentinel, which must NOT leak into the mirror).
    const history = db.all('roleHistory');
    expect(history).toHaveLength(1);
    expect(typeof history[0].data.createdAt).not.toBe('string');
    const histCall = byCollection.get('roleHistory');
    expect(histCall?.id).toBe(history[0].id);
    expect(histCall?.d).toMatchObject({
      uid: TARGET,
      newRole: 'chapter_president',
      action: 'grant',
    });
    expect(typeof histCall?.d.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(histCall?.d.createdAt as string))).toBe(false);

    // Nothing else is mirrored: audit_logs / authority_refresh stay
    // Firestore-only, and a pure set-mirror run deletes nothing.
    expect([...byCollection.keys()].sort()).toEqual(['roleHistory', 'roles', 'users']);
    expect(adapter.deleteDoc).not.toHaveBeenCalled();
  });

  it('remove: roles delete-mirrored, users + history set-mirrored', async () => {
    const db = freshDb();
    db.seed('roles', TARGET, {
      role: 'chapter_president',
      additionalRoles: [],
      chapterId: 'seds-ist-chapter',
      schemaVersion: 2,
    });
    const adapter = makeAdapter();
    inject(adapter);

    const result = await removeRole(db.asDb(), {
      uid: TARGET,
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      claimsAuth: null,
    });
    expect(result.alreadyApplied).toBe(false);
    expect(db.read('roles', TARGET)).toBeUndefined();

    expect(adapter.deleteDoc).toHaveBeenCalledWith('roles', TARGET);
    const calls = setCalls(adapter);
    const usersCall = calls.find(([c]) => c === 'users');
    expect(usersCall?.[1]).toBe(TARGET);
    expect(usersCall?.[2]).toMatchObject({ role: 'member_basic', displayRole: 'member_basic' });
    const histCall = calls.find(([c]) => c === 'roleHistory');
    expect(histCall?.[2]).toMatchObject({ uid: TARGET, action: 'delete' });
    expect(typeof histCall?.[2].createdAt).toBe('string');
    // users doc exists post-write, so it is never delete-mirrored here.
    expect(adapter.deleteDoc).not.toHaveBeenCalledWith('users', TARGET);
  });
});

describe('mirrorRoleWriteToSupa direct behaviour', () => {
  it('absent docs are delete-mirrored (both roles and users)', async () => {
    const db = new FakeFirestore();
    const adapter = makeAdapter();
    inject(adapter);

    await mirrorRoleWriteToSupa(db.asDb(), 'ghost-uid', null);

    expect(adapter.deleteDoc).toHaveBeenCalledWith('roles', 'ghost-uid');
    expect(adapter.deleteDoc).toHaveBeenCalledWith('users', 'ghost-uid');
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });

  it('a re-read failure is swallowed (logged) and never throws', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = makeAdapter();
    inject(adapter);
    const brokenDb = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw new Error('firestore re-read boom');
          },
        }),
      }),
    };

    await expect(
      mirrorRoleWriteToSupa(brokenDb as never, TARGET, null),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });
});

describe('best-effort contract', () => {
  it('adapter mirror throws are swallowed: the Firestore write still succeeds', async () => {
    const db = freshDb();
    const boom = jest.fn(async () => {
      throw new Error('supabase down');
    });
    const adapter = makeAdapter({ setDoc: boom, deleteDoc: boom });
    inject(adapter);

    const result = await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'chapter_secretary',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      claimsAuth: null,
    });
    expect(result.alreadyApplied).toBe(false);
    expect(result.newEffectiveRole).toBe('chapter_secretary');
    expect(db.read('roles', TARGET)?.role).toBe('chapter_secretary');
    // The mirror WAS attempted (flag ON) — it just cannot fail the write.
    expect(adapter.setDoc).toHaveBeenCalled();
  });

  it('flag OFF: adapter is never called on assign or remove', async () => {
    const db = freshDb();
    const adapter = makeAdapter({ useSupa: jest.fn(() => false) });
    inject(adapter);

    await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'chapter_secretary',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      claimsAuth: null,
    });
    await removeRole(db.asDb(), {
      uid: TARGET,
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      claimsAuth: null,
    });

    expect(adapter.getDoc).not.toHaveBeenCalled();
    expect(adapter.listDocs).not.toHaveBeenCalled();
    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(adapter.updateDoc).not.toHaveBeenCalled();
    expect(adapter.deleteDoc).not.toHaveBeenCalled();
  });

  it('no adapter available: mirror disabled, write succeeds byte-identically', async () => {
    const db = freshDb();
    inject(null);

    const result = await assignRole(db.asDb(), {
      uid: TARGET,
      role: 'chapter_secretary',
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      claimsAuth: null,
    });
    expect(result.alreadyApplied).toBe(false);
    expect(db.read('roles', TARGET)?.role).toBe('chapter_secretary');
    expect(db.all('roleHistory')).toHaveLength(1);
  });

  it('idempotent replay (no commit) does not mirror', async () => {
    const db = freshDb();
    const adapter = makeAdapter();
    inject(adapter);
    const input = {
      uid: TARGET,
      role: 'chapter_secretary' as const,
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui' as const,
      idempotencyKey: 'mirror-idem-1',
      claimsAuth: null,
    };
    await assignRole(db.asDb(), input);
    const callsAfterFirst = adapter.setDoc.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const replay = await assignRole(db.asDb(), input);
    expect(replay.alreadyApplied).toBe(true);
    expect(adapter.setDoc.mock.calls.length).toBe(callsAfterFirst);
    expect(adapter.deleteDoc).not.toHaveBeenCalled();
  });

  it('setMirror (repair path) does not engage the supa mirror', async () => {
    const db = freshDb();
    db.seed('roles', TARGET, {
      role: 'chapter_secretary',
      additionalRoles: [],
      chapterId: 'seds-ist-chapter',
      schemaVersion: 2,
    });
    const adapter = makeAdapter();
    inject(adapter);

    await expect(setMirror(db.asDb(), TARGET)).resolves.toBe(true);
    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(adapter.deleteDoc).not.toHaveBeenCalled();
  });
});
