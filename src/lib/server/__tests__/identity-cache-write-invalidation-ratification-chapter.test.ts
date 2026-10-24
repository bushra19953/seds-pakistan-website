/**
 * @jest-environment node
 *
 * Read-Burn A, plan §5 T-A3 (j) + (k) — write invalidation with ZERO
 * clock advance for the Rev.2-added bust rows (security review
 * S2-2 / S2-3):
 *
 *   (j) W16 — lifecycle-ratification `closeRefusalVote` revocation:
 *       warm cache → real close with the revocation armed → the
 *       revoked role is gone on immediate re-resolution, including
 *       the `founder_patron` blanket case (the blanket is fed by the
 *       cached bundle, so a stale bundle would keep EVERY permission
 *       alive). Flag-off close is a no-op: nothing is revoked and the
 *       warm cache is provably untouched (no reload on re-resolution).
 *   (k) W17/W18/W19 — the three `users/{uid}.chapterId` writers:
 *       profile-route PATCH, hierarchy add-existing POST, and
 *       chapter-applications approval (applicant + team chunk). Warm
 *       both sides → real write path → `assertChapterAccess` and the
 *       bundle reflect the NEW chapter immediately, with the
 *       cross-chapter denial flipping in both directions.
 *
 * Without the bust, every post-write assertion below fails: the
 * 30 s identity cache would keep serving the pre-write bundle.
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
import { CountingFirestore } from './helpers/counting-firestore';
import { resetIdentityCache } from '../identity-cache';
import * as serverPerms from '../permissions';
import { closeRefusalVote } from '../lifecycle-ratification';
import { FOUNDER_UID } from '@/lib/roles';
import { PATCH as profilePATCH } from '@/app/api/profile/[userId]/route';
import { POST as addExistingPOST } from '@/app/api/admin/hierarchy/add-existing/route';
import { updateChapterApplicationStatus } from '@/app/actions/chapter-applications';

const CH_A = 'seds-ist-chapter';
const CH_B = 'seds-lahore-chapter';

function req(path: string, uid: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      authorization: `Bearer tok:${uid}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  resetIdentityCache();
});

// ------------------------------------------------------------------
// T-A3(j) — W16 ratification revocation bust
// ------------------------------------------------------------------
describe('T-A3(j) W16 closeRefusalVote revocation bust', () => {
  let counting: CountingFirestore;
  let db: never;

  function seedClosable(holderUid: string, roleKey: string, armed: boolean) {
    counting = new CountingFirestore();
    mockDbHolder.db = counting.asDb();
    db = counting.asDb();
    counting.seed('governance_settings', 'phase2', { ratificationRevocationArmed: armed });
    counting.seed('ratifications', 'rat-1', {
      id: 'rat-1',
      appointmentId: 'appt-1',
      userId: holderUid,
      roleKey,
      chapterSlug: null,
      appointedBy: FOUNDER_UID,
      appointedAt: new Date('2026-10-01T09:00:00.000Z'),
      ratificationDeadline: new Date('2026-10-31T09:00:00.000Z'),
      status: 'pending',
      decidedAt: null,
      voteId: 'vote-1',
      refusalVotesFor: null,
      refusalVotesAgainst: null,
      eligibleElectors: 9,
      requiredRefusals: 6,
      thresholdMet: null,
      revocationAuditId: null,
      revokedAt: null,
      createdBy: 'applyRoleChange',
    });
    counting.seed('governance_votes', 'vote-1', {
      kind: 'ratification_refusal',
      status: 'closed',
      closedAt: new Date('2026-10-20T10:00:00.000Z'),
      tallies: { for: 6, against: 3 },
    });
    counting.seed('roles', holderUid, { role: roleKey, roleKey, chapterId: CH_A });
    counting.seed('users', holderUid, { role: roleKey, isBanned: false, chapterId: CH_A });
  }

  const CLOSER = { actorUid: FOUNDER_UID, actorRoleKeys: [] as string[], canManageRoles: false };

  it('founder_patron blanket case: revoking founder_patron takes effect immediately', async () => {
    seedClosable('holder-founder', 'founder_patron', true);

    // Warm the cache: the holder resolves as founder_patron and the
    // blanket answers a blanket-only permission true.
    const warm = await serverPerms.resolveIdentityForAuth(db, 'holder-founder');
    expect(warm.role).toBe('founder_patron');
    await expect(
      serverPerms.hasServerPermissionForUser(db, 'holder-founder', 'canManageUsers'),
    ).resolves.toBe(true);

    const result = await closeRefusalVote(db, 'rat-1', CLOSER);
    expect(result.status).toBe('refused');
    expect(result.revokedRole).toBe(true);
    // The write itself landed in both stores.
    expect(counting.read('roles', 'holder-founder')?.role).toBe('member_basic');
    expect(counting.read('users', 'holder-founder')?.role).toBe('member_basic');

    // Zero clock advance: a fresh reload must have happened (bust),
    // and re-resolution shows the role gone — through the mapped
    // path, so the founder blanket no longer fires.
    const roleGetsAfterClose = counting.docGetCount('roles', 'holder-founder');
    const after = await serverPerms.resolveIdentityForAuth(db, 'holder-founder');
    expect(after.role).toBe('member_basic');
    expect(counting.docGetCount('roles', 'holder-founder')).toBeGreaterThan(roleGetsAfterClose);
    await expect(
      serverPerms.hasServerPermissionForUser(db, 'holder-founder', 'canManageUsers'),
    ).resolves.toBe(false);
  });

  it('ordinary officer: revoked role is gone on immediate re-resolution', async () => {
    seedClosable('officer-rat', 'national_treasurer', true);

    const warm = await serverPerms.resolveIdentityForAuth(db, 'officer-rat');
    expect(warm.role).toBe('national_treasurer');

    const result = await closeRefusalVote(db, 'rat-1', CLOSER);
    expect(result.revokedRole).toBe(true);

    const after = await serverPerms.resolveIdentityForAuth(db, 'officer-rat');
    expect(after.role).toBe('member_basic');
    const bundle = await serverPerms.getIdentityBundleCached(db, 'officer-rat');
    expect(bundle.roles?.role).toBe('member_basic');
    expect(bundle.users?.role).toBe('member_basic');
  });

  it('flag-off no-op: refused vote revokes nothing and the warm cache is untouched', async () => {
    seedClosable('holder-founder', 'founder_patron', false);

    const warm = await serverPerms.resolveIdentityForAuth(db, 'holder-founder');
    expect(warm.role).toBe('founder_patron');
    await expect(
      serverPerms.hasServerPermissionForUser(db, 'holder-founder', 'canManageUsers'),
    ).resolves.toBe(true);

    const result = await closeRefusalVote(db, 'rat-1', CLOSER);
    expect(result.status).toBe('refused');
    expect(result.revokedRole).toBe(false);
    expect(result.revocationSkippedReason).toBe('revocation_not_armed');
    expect(counting.read('roles', 'holder-founder')?.role).toBe('founder_patron');

    // No bust => no behavioral change: re-resolution is served from
    // the still-warm cache (zero additional identity doc gets) and
    // every answer is identical to the warm state.
    const roleGets = counting.docGetCount('roles', 'holder-founder');
    const userGets = counting.docGetCount('users', 'holder-founder');
    const after = await serverPerms.resolveIdentityForAuth(db, 'holder-founder');
    expect(after.role).toBe('founder_patron');
    await expect(
      serverPerms.hasServerPermissionForUser(db, 'holder-founder', 'canManageUsers'),
    ).resolves.toBe(true);
    expect(counting.docGetCount('roles', 'holder-founder')).toBe(roleGets);
    expect(counting.docGetCount('users', 'holder-founder')).toBe(userGets);
  });
});

// ------------------------------------------------------------------
// T-A3(k) — W17/W18/W19 chapterId writer busts
// ------------------------------------------------------------------
describe('T-A3(k) chapterId writer busts', () => {
  let counting: CountingFirestore;
  let db: never;

  function seedChapterActors() {
    counting = new CountingFirestore();
    mockDbHolder.db = counting.asDb();
    db = counting.asDb();
    // Chapter-scoped officer of chapter A (the assertChapterAccess actor).
    counting.seed('roles', 'officer-a', { role: 'chapter_president', chapterId: CH_A });
    counting.seed('users', 'officer-a', { role: 'chapter_president', isBanned: false, chapterId: CH_A });
    // Founder (blanket) for the admin write paths.
    counting.seed('roles', FOUNDER_UID, { role: 'founder_patron', chapterId: CH_A });
    counting.seed('users', FOUNDER_UID, { role: 'founder_patron', isBanned: false, chapterId: CH_A });
  }

  function seedMember(uid: string, chapterId: string, email?: string) {
    counting.seed('roles', uid, { role: 'member', chapterId });
    counting.seed('users', uid, {
      role: 'member',
      isBanned: false,
      chapterId,
      ...(email ? { email } : {}),
    });
  }

  it('W17 profile route: self-edit of chapterId flips cross-chapter access immediately, both directions', async () => {
    seedChapterActors();
    seedMember('member-p1', CH_A);
    seedMember('member-p2', CH_B);

    // Warm both sides: p1 is in-chapter (allowed), p2 is cross-chapter (denied).
    expect((await serverPerms.getIdentityBundleCached(db, 'member-p1')).users?.chapterId).toBe(CH_A);
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'member-p1')).allowed).toBe(true);
    expect((await serverPerms.getIdentityBundleCached(db, 'member-p2')).users?.chapterId).toBe(CH_B);
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'member-p2')).allowed).toBe(false);

    // p1 moves A -> B through the real profile PATCH (owner write).
    const res1 = await profilePATCH(
      req('/api/profile/member-p1', 'member-p1', 'PATCH', { chapterId: CH_B }),
      { params: Promise.resolve({ userId: 'member-p1' }) },
    );
    expect(res1.status).toBe(200);
    expect(counting.read('users', 'member-p1')?.chapterId).toBe(CH_B);

    // Immediate re-resolution: new chapter, and the previously
    // allowed check now denies (allowed -> denied flip).
    expect((await serverPerms.getIdentityBundleCached(db, 'member-p1')).users?.chapterId).toBe(CH_B);
    const flipped = await serverPerms.assertChapterAccess(db, 'officer-a', 'member-p1');
    expect(flipped.allowed).toBe(false);
    expect(flipped.reason).toContain('cross-chapter');

    // p2 moves B -> A through the same route: denied -> allowed flip.
    const res2 = await profilePATCH(
      req('/api/profile/member-p2', 'member-p2', 'PATCH', { chapterId: CH_A }),
      { params: Promise.resolve({ userId: 'member-p2' }) },
    );
    expect(res2.status).toBe(200);
    expect((await serverPerms.getIdentityBundleCached(db, 'member-p2')).users?.chapterId).toBe(CH_A);
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'member-p2')).allowed).toBe(true);
  });

  it('W18 add-existing: admin chapter move flips cross-chapter access immediately, both directions', async () => {
    seedChapterActors();
    seedMember('member-ae1', CH_A);
    seedMember('member-ae2', CH_B);

    // Warm both sides.
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'member-ae1')).allowed).toBe(true);
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'member-ae2')).allowed).toBe(false);

    // Admin moves ae1 A -> B through the real route.
    const res1 = await addExistingPOST(
      req('/api/admin/hierarchy/add-existing', FOUNDER_UID, 'POST', { userId: 'member-ae1', chapterId: CH_B }),
    );
    expect(res1.status).toBe(200);
    expect(counting.read('users', 'member-ae1')?.chapterId).toBe(CH_B);
    expect((await serverPerms.getIdentityBundleCached(db, 'member-ae1')).users?.chapterId).toBe(CH_B);
    const flipped = await serverPerms.assertChapterAccess(db, 'officer-a', 'member-ae1');
    expect(flipped.allowed).toBe(false);
    expect(flipped.reason).toContain('cross-chapter');

    // Admin moves ae2 B -> A: denied -> allowed flip.
    const res2 = await addExistingPOST(
      req('/api/admin/hierarchy/add-existing', FOUNDER_UID, 'POST', { userId: 'member-ae2', chapterId: CH_A }),
    );
    expect(res2.status).toBe(200);
    expect((await serverPerms.getIdentityBundleCached(db, 'member-ae2')).users?.chapterId).toBe(CH_A);
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'member-ae2')).allowed).toBe(true);
  });

  it('W19 chapter-applications: approval moves applicant AND team-chunk member immediately', async () => {
    seedChapterActors();
    const NEW_CH = 'seds-new-chapter';
    seedMember('applicant-1', CH_A, 'lead@example.com');
    seedMember('mate-1', CH_A, 'mate@example.com');
    // A member already registered under the future chapter's slug:
    // the applicant is cross-chapter to them before approval.
    seedMember('pre-1', NEW_CH);

    counting.seed('chapter_applications', 'app-1', {
      proposedChapterName: 'SEDS New Chapter',
      universityName: 'New University',
      city: '',
      country: '',
      applicantId: 'applicant-1',
      applicantEmail: 'lead@example.com',
      teamMembers: [
        { name: 'Lead', email: 'lead@example.com' },
        { name: 'Mate', email: 'mate@example.com' },
      ],
      facultyAdvisor: { name: 'Dr X', email: 'adv@example.com' },
      orderId: null,
      status: 'pending_review',
    });

    // Warm both sides: officer-a reaches applicant + mate (same
    // chapter); the applicant cannot reach pre-1 (cross-chapter).
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'applicant-1')).allowed).toBe(true);
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'mate-1')).allowed).toBe(true);
    expect((await serverPerms.assertChapterAccess(db, 'applicant-1', 'pre-1')).allowed).toBe(false);
    expect((await serverPerms.getIdentityBundleCached(db, 'applicant-1')).users?.chapterId).toBe(CH_A);
    expect((await serverPerms.getIdentityBundleCached(db, 'mate-1')).users?.chapterId).toBe(CH_A);

    // Real approval path: creates the chapter, writes the applicant's
    // chapterId directly and the team member's via the chunked batch.
    const result = await updateChapterApplicationStatus('app-1', 'approved', FOUNDER_UID);
    expect(result.success).toBe(true);
    expect(result.chapterId).toBe(NEW_CH);
    expect(counting.read('users', 'applicant-1')?.chapterId).toBe(NEW_CH);
    expect(counting.read('users', 'mate-1')?.chapterId).toBe(NEW_CH);

    // Immediate re-resolution for BOTH bust subjects: new chapter in
    // the bundle, officer-a now denied against both (allowed ->
    // denied), and the applicant now reaches pre-1 in their new
    // shared chapter (denied -> allowed).
    expect((await serverPerms.getIdentityBundleCached(db, 'applicant-1')).users?.chapterId).toBe(NEW_CH);
    expect((await serverPerms.getIdentityBundleCached(db, 'mate-1')).users?.chapterId).toBe(NEW_CH);
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'applicant-1')).allowed).toBe(false);
    expect((await serverPerms.assertChapterAccess(db, 'officer-a', 'mate-1')).allowed).toBe(false);
    expect((await serverPerms.assertChapterAccess(db, 'applicant-1', 'pre-1')).allowed).toBe(true);
  });
});
