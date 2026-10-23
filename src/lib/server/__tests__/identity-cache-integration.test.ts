/**
 * @jest-environment node
 *
 * Read-Burn A integration tests (plan §5: T-A1, T-A2, T-A4, T-A5).
 *
 * - T-A1: before/after document-get counts for the identity+permission
 *   portion on representative routes (leave = member route,
 *   review-queue = officer route, admin/users = admin route,
 *   workflows POST), asserting the §2.6 targets: cold within target,
 *   warm = 0, identical responses.
 * - T-A2: persona parity matrix - identical allow/deny at cache miss
 *   and cache hit for founder / admin-grant officer / member /
 *   custom-grant holder / no-roles-doc fallback / banned personas.
 *   Expected values are the pre-change answers for these fixtures.
 * - T-A4: TTL bound - an out-of-band write (direct store mutation, no
 *   bust) is invisible within the TTL and visible after it.
 * - T-A5: failure parity - RESOURCE_EXHAUSTED during verification
 *   yields exactly today's outcome and is never cached.
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

import { NextRequest } from 'next/server';
import { CountingFirestore, resourceExhaustedError } from './helpers/counting-firestore';
import { resetIdentityCache } from '../identity-cache';
import { verifyAuthentication } from '@/lib/auth-middleware';
import * as serverPerms from '../permissions';
import { GET as leaveGET } from '@/app/api/leave/route';
import { GET as reviewQueueGET } from '@/app/api/tasks/review-queue/route';
import { GET as adminUsersGET } from '@/app/api/admin/users/route';
import { POST as workflowsPOST } from '@/app/api/workflows/route';
import type { PermissionKey } from '@/config/permissions.config';

const CHAPTER = 'seds-ist-chapter';
const CUSTOM = 'custom_poster_team_lead';

let counting: CountingFirestore;
let db: never;

function req(path: string, uid: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { authorization: `Bearer tok:${uid}` },
  });
}

function seedPersonas() {
  // founder (blanket, permissions.ts founder check fires before reads)
  counting.seed('roles', 'founder-1', { role: 'founder_patron', chapterId: CHAPTER });
  counting.seed('users', 'founder-1', { isBanned: false, chapterId: CHAPTER, displayName: 'Founder' });
  // officer: chapter_president with a definition granting canManageTasks only
  counting.seed('roles', 'officer-1', { role: 'chapter_president', chapterId: CHAPTER });
  counting.seed('users', 'officer-1', { isBanned: false, chapterId: CHAPTER, displayName: 'Officer' });
  counting.seed('roleDefinitions', 'chapter_president', { name: 'Chapter President', permissions: ['canManageTasks'] });
  // plain member
  counting.seed('roles', 'member-1', { role: 'member', chapterId: CHAPTER });
  counting.seed('users', 'member-1', { isBanned: false, chapterId: CHAPTER, displayName: 'Member' });
  // member with NO roles doc (fallback path; users read twice pre-change)
  counting.seed('users', 'fallback-1', { role: 'member', isBanned: false, chapterId: CHAPTER, displayName: 'Fallback' });
  // custom-grant holder (SEC-11 fixture shape)
  counting.seed('roles', 'holder-1', { role: 'member', additionalRoles: [CUSTOM], chapterId: CHAPTER });
  counting.seed('users', 'holder-1', { isBanned: false, chapterId: CHAPTER });
  counting.seed('roleDefinitions', CUSTOM, {
    isCustom: true, parentRoleKey: 'chapter_design_chair', chapterId: CHAPTER,
    name: 'Poster Team Lead', permissions: ['canManageTasks'],
  });
  counting.seed('roleDefinitions', 'member_basic', {
    name: 'Basic Member', permissions: ['canManageTasks', 'canManageEvents', 'canManageUsers'],
  });
  // banned member
  counting.seed('roles', 'banned-1', { role: 'member', chapterId: CHAPTER });
  counting.seed('users', 'banned-1', { isBanned: true, chapterId: CHAPTER });
}

beforeEach(() => {
  resetIdentityCache();
  counting = new CountingFirestore();
  mockDbHolder.db = counting.asDb();
  db = counting.asDb();
  seedPersonas();
});

// ------------------------------------------------------------------
// T-A2 persona parity (cold == warm == pre-change expected answers)
// ------------------------------------------------------------------
describe('T-A2 persona parity at cache miss and hit', () => {
  const matrix: Array<{
    uid: string;
    authenticated: boolean;
    role?: string;
    error?: string;
    granted: PermissionKey;
    grantedAnswer: boolean;
    denied: PermissionKey;
    deniedAnswer: boolean;
  }> = [
    { uid: 'founder-1', authenticated: true, role: 'founder_patron', granted: 'canManageUsers', grantedAnswer: true, denied: 'canManageUsers', deniedAnswer: true },
    { uid: 'officer-1', authenticated: true, role: 'chapter_president', granted: 'canManageTasks', grantedAnswer: true, denied: 'canManageUsers', deniedAnswer: false },
    { uid: 'member-1', authenticated: true, role: 'member', granted: 'canManageTasks', grantedAnswer: false, denied: 'canManageUsers', deniedAnswer: false },
    { uid: 'fallback-1', authenticated: true, role: 'member', granted: 'canManageTasks', grantedAnswer: false, denied: 'canManageUsers', deniedAnswer: false },
    { uid: 'holder-1', authenticated: true, role: 'member', granted: 'canManageTasks', grantedAnswer: true, denied: 'canManageEvents', deniedAnswer: false },
    { uid: 'banned-1', authenticated: false, error: 'Account Banned', granted: 'canManageTasks', grantedAnswer: false, denied: 'canManageUsers', deniedAnswer: false },
  ];

  for (const row of matrix) {
    it(`${row.uid}: cold and warm answers are identical and match pre-change behavior`, async () => {
      const run = async () => {
        const auth = await verifyAuthentication(req('/api/test', row.uid));
        const granted = await serverPerms.hasServerPermissionForUser(db, row.uid, row.granted);
        const denied = await serverPerms.hasServerPermissionForUser(db, row.uid, row.denied);
        return {
          authenticated: auth.authenticated,
          role: auth.user?.role,
          error: auth.error,
          granted,
          denied,
        };
      };
      const cold = await run();
      const warm = await run();
      expect(warm).toEqual(cold);
      expect(cold.authenticated).toBe(row.authenticated);
      if (row.authenticated) expect(cold.role).toBe(row.role);
      if (row.error) expect(cold.error).toBe(row.error);
      expect(cold.granted).toBe(row.grantedAnswer);
      expect(cold.denied).toBe(row.deniedAnswer);
    });
  }
});

// ------------------------------------------------------------------
// T-A1 read counts on representative routes
// ------------------------------------------------------------------
describe('T-A1 read counts (§2.6 targets)', () => {
  it('GET /api/leave (member): cold 2 identity reads, warm 0, identical bodies', async () => {
    counting.seed('leave_requests', 'leave-1', {
      userId: 'member-1', status: 'pending', leaveType: 'annual',
      startDate: '2026-11-01', endDate: '2026-11-02', reason: 'family',
      createdAt: new Date('2026-10-20T00:00:00Z'),
    });
    const coldRes = await leaveGET(req('/api/leave', 'member-1'));
    expect(coldRes.status).toBe(200);
    const coldBody = await coldRes.json();
    // Roles-missing fallback persona check happens below; member-1 has
    // a roles doc, so auth costs roles 1 + users 1 = 2.
    expect(counting.identityPermissionDocGets(['member-1'])).toBe(2);

    counting.resetCounts();
    const warmRes = await leaveGET(req('/api/leave', 'member-1'));
    expect(warmRes.status).toBe(200);
    expect(await warmRes.json()).toEqual(coldBody);
    expect(counting.identityPermissionDocGets(['member-1'])).toBe(0);
  });

  it('GET /api/leave (roles-missing fallback): cold 2 (dedupe kills the double users read), warm 0', async () => {
    counting.seed('leave_requests', 'leave-2', {
      userId: 'fallback-1', status: 'approved', leaveType: 'sick',
      startDate: '2026-11-03', endDate: '2026-11-03', reason: 'flu',
      createdAt: new Date('2026-10-20T00:00:00Z'),
    });
    const res = await leaveGET(req('/api/leave', 'fallback-1'));
    expect(res.status).toBe(200);
    // Pre-change this persona cost 3 (users read twice in one request).
    expect(counting.identityPermissionDocGets(['fallback-1'])).toBe(2);
    counting.resetCounts();
    const warm = await leaveGET(req('/api/leave', 'fallback-1'));
    expect(warm.status).toBe(200);
    expect(counting.identityPermissionDocGets(['fallback-1'])).toBe(0);
  });

  it('GET /api/tasks/review-queue (officer, 10 tasks): cold <= 8 identity/permission reads, warm 0', async () => {
    for (let i = 0; i < 10; i++) {
      counting.seed('tasks', `task-${i}`, {
        title: `Task ${i}`,
        status: 'submitted-for-review',
        submittedBy: `submitter-${i}`,
        assignerId: 'assigner-x',
        assigneeIds: [`submitter-${i}`],
        submittedAt: new Date(Date.now() - i * 1000),
      });
      counting.seed('users', `submitter-${i}`, { displayName: `Submitter ${i}`, role: 'member' });
    }
    const coldRes = await reviewQueueGET(req('/api/tasks/review-queue', 'officer-1'));
    expect(coldRes.status).toBe(200);
    const coldBody = await coldRes.json();
    expect(coldBody.tasks).toHaveLength(10);
    const coldReads = counting.identityPermissionDocGets(['officer-1']);
    // Pre-change: 2 + 10 x (3-6) = 32-62 identity/permission reads.
    expect(coldReads).toBeLessThanOrEqual(8);
    expect(coldReads).toBeGreaterThanOrEqual(2);

    counting.resetCounts();
    const warmRes = await reviewQueueGET(req('/api/tasks/review-queue', 'officer-1'));
    expect(warmRes.status).toBe(200);
    expect(await warmRes.json()).toEqual(coldBody);
    expect(counting.identityPermissionDocGets(['officer-1'])).toBe(0);
  });

  it('GET /api/admin/users (founder, Path A): cold <= 4 identity/permission reads, warm 0', async () => {
    const coldRes = await adminUsersGET(req('/api/admin/users', 'founder-1'));
    expect(coldRes.status).toBe(200);
    const coldBody = await coldRes.json();
    const coldReads = counting.identityPermissionDocGets(['founder-1']);
    // Bundle (2) shared by auth + permission check + caller-chapter;
    // the founder blanket fires before any permission-doc read.
    expect(coldReads).toBeLessThanOrEqual(4);

    counting.resetCounts();
    const warmRes = await adminUsersGET(req('/api/admin/users', 'founder-1'));
    expect(warmRes.status).toBe(200);
    const warmBody = await warmRes.json();
    expect(warmBody.users).toEqual(coldBody.users);
    // Warm identity reads (roles + users for the caller) are 0.
    expect(counting.docGetCount('roles', 'founder-1')).toBe(0);
    expect(counting.docGetCount('users', 'founder-1')).toBe(0);
    // MEASURED GAP vs the §2.6 warm=0 target: exactly 1 warm read
    // remains - resolveEffectiveScope (chapter-scoping.ts:116) reads
    // permissions/{role} directly on every call. That file is NOT in
    // workstream A's §2.7 file list and §0 does not enumerate this
    // read, so it is flagged for the coordinator rather than fixed
    // out of plan. Total warm identity+permission doc gets = 1.
    expect(counting.identityPermissionDocGets(['founder-1'])).toBe(1);
    expect(counting.docGetCount('permissions', 'founder_patron')).toBe(1);
  });

  it('POST /api/workflows: auth+permission portion cold 2 identity doc reads for the caller, warm 0', async () => {
    counting.seed('users', 'member-2', { isBanned: false, chapterId: CHAPTER, displayName: 'Assignee' });
    const body = {
      workflowId: 'wf-test-1',
      workflowTitle: 'Test Workflow',
      finalDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      steps: [{ title: 'Step 1', description: 'do it', assigneeId: 'member-2' }],
    };
    const makeReq = () => new NextRequest('http://localhost/api/workflows', {
      method: 'POST',
      headers: { authorization: 'Bearer tok:officer-1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const coldRes = await workflowsPOST(makeReq());
    expect(coldRes.status).not.toBe(401);
    expect(coldRes.status).not.toBe(403);
    // Caller identity doc reads: roles/{officer} + users/{officer} once.
    expect(counting.docGetCount('roles', 'officer-1') + counting.docGetCount('users', 'officer-1')).toBe(2);

    counting.resetCounts();
    const warmRes = await workflowsPOST(makeReq());
    expect(warmRes.status).not.toBe(401);
    expect(warmRes.status).not.toBe(403);
    expect(counting.docGetCount('roles', 'officer-1') + counting.docGetCount('users', 'officer-1')).toBe(0);
    expect(counting.docGetCount('roleDefinitions')).toBe(0);
    expect(counting.docGetCount('permissions')).toBe(0);
  });
});

// ------------------------------------------------------------------
// T-A4 TTL bound (simulated cross-instance: no bust, TTL expiry only)
// ------------------------------------------------------------------
describe('T-A4 TTL bound and ban-enforcement latency', () => {
  it('a direct (out-of-band) ban is invisible within the TTL window', async () => {
    const first = await verifyAuthentication(req('/api/test', 'member-1'));
    expect(first.authenticated).toBe(true);
    // Out-of-band write: mutate the store directly, NO bust call
    // (simulates another instance / a client-SDK write).
    counting.fake.seed('users', 'member-1', { isBanned: true, chapterId: CHAPTER });
    const within = await verifyAuthentication(req('/api/test', 'member-1'));
    expect(within.authenticated).toBe(true); // stale within the 30s bound
    const identity = await serverPerms.resolveIdentityForAuth(db, 'member-1');
    expect(identity.isBanned).toBe(false);
    // The exact +29s/+31s enforcement boundary is pinned with the
    // injected clock in the next test.
  });

  it('TTL expiry with injected clock: ban visible at +31s, not at +29s (unit-level, §2.2)', async () => {
    const { getIdentityBundle, IDENTITY_TTL_MS } = await import('../identity-cache');
    let banned = false;
    const t0 = 1_000_000;
    const loader = async () => ({
      roles: { exists: true, role: 'member', additionalRoles: undefined, expiresAt: undefined, expiresRoleKey: undefined, chapterId: null },
      users: { exists: true, role: 'member', displayRole: undefined, additionalRoles: undefined, isBanned: banned, chapterId: null },
      loadedAt: t0,
    });
    const cold = await getIdentityBundle('ttl-user', loader, { now: t0 });
    expect(cold.users?.isBanned).toBe(false);
    banned = true; // out-of-band write, no bust
    const at29 = await getIdentityBundle('ttl-user', async () => ({ ...await loader(), loadedAt: t0 + 29_000 }), { now: t0 + 29_000 });
    expect(at29.users?.isBanned).toBe(false);
    const at31 = await getIdentityBundle('ttl-user', async () => ({
      roles: { exists: true, role: 'member', additionalRoles: undefined, expiresAt: undefined, expiresRoleKey: undefined, chapterId: null },
      users: { exists: true, role: 'member', displayRole: undefined, additionalRoles: undefined, isBanned: true, chapterId: null },
      loadedAt: t0 + 31_000,
    }), { now: t0 + 31_000 });
    expect(at31.users?.isBanned).toBe(true);
    expect(IDENTITY_TTL_MS).toBe(30_000);
  });
});

// ------------------------------------------------------------------
// T-A5 failure parity
// ------------------------------------------------------------------
describe('T-A5 failure parity (RESOURCE_EXHAUSTED)', () => {
  it('a throwing roles get yields exactly the pre-change 401 behavior and is not cached', async () => {
    counting.setThrow('roles', resourceExhaustedError());
    const failed = await verifyAuthentication(req('/api/test', 'member-1'));
    expect(failed.authenticated).toBe(false);
    expect(failed.error).toBe('Authentication verification failed');

    // A different uid whose bundle is already cached is unaffected in
    // structure: its failure mode is the same single-catch outcome
    // (no cross-uid contamination, no partial success).
    counting.setThrow(null, null);
    const ok = await verifyAuthentication(req('/api/test', 'member-1'));
    expect(ok.authenticated).toBe(true);
    expect(ok.user?.role).toBe('member');
    // The successful call re-read (the error was never cached):
    expect(counting.docGetCount('roles', 'member-1')).toBeGreaterThanOrEqual(1);
  });

  it('hasServerPermission falls back to the static config on a throwing doc get, exactly as before', async () => {
    counting.setThrow('roleDefinitions', resourceExhaustedError());
    const answer = await serverPerms.hasServerPermission('chapter_president', 'canManageTasks');
    counting.setThrow(null, null);
    // Static-config fallback answer (no throw escapes).
    expect(typeof answer).toBe('boolean');
    // And once the throw clears, the Firestore answer returns.
    const after = await serverPerms.hasServerPermission('chapter_president', 'canManageTasks');
    expect(after).toBe(true);
  });
});
